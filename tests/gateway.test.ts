import { unlink } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { GatewayHttpError } from "../src/errors";
import {
  createChatCompletion,
  createChatCompletionStream,
  createEmbeddings,
  providerErrorMessageFromBody,
} from "../src/gateway";
import { testConfig, jsonResponse } from "./helpers";

const env = {
  GATEWAY_API_KEY: "gateway",
  OPENAI_API_KEY: "openai",
  DEEPSEEK_API_KEY: "deepseek",
};

function providerResponse(content: string): Response {
  return jsonResponse({
    id: `provider-${content}`,
    object: "chat.completion",
    created: 1,
    model: "gpt-4.1-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  });
}

function anthropicTestConfig() {
  const config = testConfig();
  config.providers.push({
    id: "anthropic",
    displayName: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    enabled: true,
    regions: ["us"],
    dataPolicy: {
      allowTraining: false,
      allowLogging: false,
      byokOnly: true,
      zeroDataRetentionAvailable: false,
    },
  });
  config.models.push({
    id: "anthropic/claude-3-5-sonnet",
    providerId: "anthropic",
    providerModel: "claude-3-5-sonnet-latest",
    aliases: ["anthropic-coding"],
    capabilities: ["chat", "tools", "vision"],
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
  });
  config.routes.push({
    id: "anthropic-coding",
    mode: "fallback",
    modelAliases: ["anthropic-coding"],
    fallbackModelIds: ["anthropic/claude-3-5-sonnet"],
    dataPolicy: {
      allowTraining: false,
      allowChineseProviders: false,
      blockedRegions: ["cn"],
    },
  });
  return config;
}

describe("chat completion lifecycle", () => {
  test("normalizes provider response with gateway metadata and usage", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push(String(url));
      expect(JSON.parse(String(init?.body)).model).toBe("gpt-4.1-mini");
      return jsonResponse({
        id: "provider-id",
        object: "chat.completion",
        created: 1,
        model: "gpt-4.1-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });
    };

    const result = await createChatCompletion(
      {
        config: testConfig(),
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
          DEEPSEEK_API_KEY: "deepseek",
        },
        fetchImpl,
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
      },
    );

    expect(calls).toEqual(["https://api.openai.test/v1/chat/completions"]);
    expect(result.body.model).toBe("openai/gpt-4.1-mini");
    expect(result.body.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect((result.body.gateway as Record<string, unknown>).provider).toBe("openai");
  });

  test("falls back after retryable provider error", async () => {
    const config = testConfig();
    config.routes[0] = {
      ...config.routes[0],
      dataPolicy: {
        allowTraining: false,
        allowLogging: true,
        allowChineseProviders: true,
        allowedRegions: ["cn", "us"],
      },
    };

    let callCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse({ error: { message: "rate limited" } }, 429);
      }
      return jsonResponse({
        choices: [{ index: 0, message: { role: "assistant", content: "fallback" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      });
    };

    const result = await createChatCompletion(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
          DEEPSEEK_API_KEY: "deepseek",
        },
        fetchImpl,
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
      },
    );

    expect(callCount).toBe(2);
    expect((result.body.gateway as Record<string, unknown>).provider).toBe("openai");
  });

  test("completes an Anthropic-backed alias and normalizes usage", async () => {
    const calls: string[] = [];
    const config = anthropicTestConfig();
    config.budgets = [
      {
        id: "anthropic-per-request",
        window: "per-request",
        mode: "soft",
        scope: { modelAlias: "anthropic-coding" },
        maxTotalTokens: 40,
      },
    ];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push(String(url));
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("anthropic");
      expect((init?.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "claude-3-5-sonnet-latest",
        system: "Use compact answers.",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      });
      return jsonResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet-latest",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 11,
          output_tokens: 4,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 6,
        },
      });
    };

    const result = await createChatCompletion(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          ANTHROPIC_API_KEY: "anthropic",
        },
        fetchImpl,
      },
      {
        model: "anthropic-coding",
        messages: [
          { role: "system", content: "Use compact answers." },
          { role: "user", content: "hi" },
        ],
        max_completion_tokens: 64,
      },
    );

    expect(calls).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(result.body.model).toBe("anthropic/claude-3-5-sonnet");
    expect(result.body.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ]);
    expect(result.body.usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
      prompt_tokens_details: {
        cached_tokens: 3,
      },
    });
    const gateway = result.body.gateway as Record<string, unknown>;
    expect(gateway.provider).toBe("anthropic");
    expect(gateway.estimated_cost_usd).toBe(0.000111);
    expect(gateway.budgets).toEqual([
      {
        id: "anthropic-per-request",
        mode: "soft",
        remaining: {
          totalTokens: 16,
        },
        warnings: [],
      },
    ]);
  });

  test("routes a Gemini alias through the Google adapter and normalizes usage", async () => {
    const config = testConfig();
    config.providers.push({
      id: "google",
      displayName: "Google Gemini",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
      enabled: true,
      regions: ["global"],
      dataPolicy: {
        allowTraining: true,
        allowLogging: true,
        byokOnly: true,
        zeroDataRetentionAvailable: false,
      },
    });
    config.models.push({
      id: "google/gemini-3.5-flash",
      providerId: "google",
      providerModel: "gemini-3.5-flash",
      aliases: ["gemini"],
      capabilities: ["chat", "streaming", "tools", "json"],
    });
    config.routes.push({
      id: "gemini",
      mode: "fallback",
      modelAliases: ["gemini"],
      fallbackModelIds: ["google/gemini-3.5-flash"],
      dataPolicy: {
        allowTraining: true,
        allowLogging: true,
        allowedRegions: ["global"],
      },
    });

    const calls: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        authorization: (init?.headers as Record<string, string>)?.authorization,
      });
      return jsonResponse({
        id: "gemini-response",
        object: "chat.completion",
        created: 2,
        model: "gemini-3.5-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello from gemini" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      });
    };

    const result = await createChatCompletion(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
          DEEPSEEK_API_KEY: "deepseek",
          GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
        },
        fetchImpl,
      },
      {
        model: "gemini",
        messages: [{ role: "user", content: "hi" }],
      },
    );

    expect(calls).toEqual([
      {
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        body: {
          model: "gemini-3.5-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        },
        authorization: "Bearer google-key",
      },
    ]);
    expect(result.body.model).toBe("google/gemini-3.5-flash");
    expect(result.body.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    const gateway = result.body.gateway as Record<string, unknown>;
    const decision = gateway.route_decision as { policy: Record<string, unknown> };
    expect(gateway.provider).toBe("google");
    expect(decision.policy.allow_training).toBe(true);
    expect(decision.policy.allow_logging).toBe(true);
  });

  test("does not silently route Gemini under default no-training policy", async () => {
    const config = testConfig();
    config.providers.push({
      id: "google",
      displayName: "Google Gemini",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
      enabled: true,
      regions: ["global"],
      dataPolicy: {
        allowTraining: true,
        allowLogging: true,
        byokOnly: true,
        zeroDataRetentionAvailable: false,
      },
    });
    config.models.push({
      id: "google/gemini-3.5-flash",
      providerId: "google",
      providerModel: "gemini-3.5-flash",
      aliases: ["gemini"],
      capabilities: ["chat", "streaming", "tools", "json"],
    });

    await expect(
      createChatCompletion(
        {
          config,
          env: {
            GATEWAY_API_KEY: "gateway",
            GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
          },
          fetchImpl: async () => {
            throw new Error("Gemini should be skipped before provider fetch.");
          },
        },
        {
          model: "gemini",
          messages: [{ role: "user", content: "hi" }],
        },
      ),
    ).rejects.toThrow("No allowed provider can satisfy model 'gemini'.");
  });

  test("does not cache responses by default", async () => {
    const config = testConfig();
    let callCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1;
      return providerResponse(`fresh-${callCount}`);
    };
    const request = {
      model: "coding",
      messages: [{ role: "user" as const, content: "hi" }],
    };

    const first = await createChatCompletion({ config, env, fetchImpl }, request);
    const second = await createChatCompletion({ config, env, fetchImpl }, request);

    expect(callCount).toBe(2);
    expect(first.body.id).toBe("provider-fresh-1");
    expect(second.body.id).toBe("provider-fresh-2");
  });

  test("caches identical non-streaming responses within TTL", async () => {
    const config = testConfig();
    config.server.responseCache = {
      ...config.server.responseCache,
      enabled: true,
      ttlMs: 60_000,
    };
    let callCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1;
      return providerResponse(`cached-${callCount}`);
    };
    const request = {
      model: "coding",
      messages: [{ role: "user" as const, content: "same prompt" }],
    };
    const options = {
      config,
      env,
      fetchImpl,
      budgetContext: { gatewayKey: "key-a", tenant: "tenant-a" },
    };

    const first = await createChatCompletion(options, request);
    first.body.id = "mutated-by-caller";
    const second = await createChatCompletion(options, request);

    expect(callCount).toBe(1);
    expect(second.body.id).toBe("provider-cached-1");
  });

  test("normalizes message object key order for cache keys", async () => {
    const config = testConfig();
    config.server.responseCache = {
      ...config.server.responseCache,
      enabled: true,
      ttlMs: 60_000,
    };
    let callCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1;
      return providerResponse(`normalized-${callCount}`);
    };
    const options = {
      config,
      env,
      fetchImpl,
      budgetContext: { gatewayKey: "key-a", tenant: "tenant-a" },
    };

    const first = await createChatCompletion(options, {
      model: "coding",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const second = await createChatCompletion(options, {
      model: "coding",
      messages: [{ role: "user", content: [{ text: "hi", type: "text" }] }],
    });

    expect(callCount).toBe(1);
    expect(first.body.id).toBe("provider-normalized-1");
    expect(second.body.id).toBe("provider-normalized-1");
  });

  test("does not reuse cached metadata across requested routing options", async () => {
    const config = testConfig();
    config.server.responseCache = {
      ...config.server.responseCache,
      enabled: true,
      ttlMs: 60_000,
    };
    let callCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1;
      return providerResponse(`routing-${callCount}`);
    };
    const options = {
      config,
      env,
      fetchImpl,
      budgetContext: { gatewayKey: "key-a", tenant: "tenant-a" },
    };

    const fallback = await createChatCompletion(options, {
      model: "coding",
      messages: [{ role: "user", content: "same prompt" }],
      gateway: { routing: "fallback" },
    });
    const cheapest = await createChatCompletion(options, {
      model: "coding",
      messages: [{ role: "user", content: "same prompt" }],
      gateway: { routing: "cheapest" },
    });

    expect(callCount).toBe(2);
    expect((fallback.body.gateway as { route_decision: { mode: string } }).route_decision.mode).toBe("fallback");
    expect((cheapest.body.gateway as { route_decision: { mode: string } }).route_decision.mode).toBe("cheapest");
  });

  test("expires cached responses after TTL", async () => {
    const config = testConfig();
    config.server.responseCache = {
      ...config.server.responseCache,
      enabled: true,
      ttlMs: 1,
    };
    let callCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1;
      return providerResponse(`ttl-${callCount}`);
    };
    const request = {
      model: "coding",
      messages: [{ role: "user" as const, content: "expiring prompt" }],
    };
    const options = {
      config,
      env,
      fetchImpl,
      budgetContext: { gatewayKey: "key-a", tenant: "tenant-a" },
    };

    const first = await createChatCompletion(options, request);
    await Bun.sleep(5);
    const second = await createChatCompletion(options, request);

    expect(callCount).toBe(2);
    expect(first.body.id).toBe("provider-ttl-1");
    expect(second.body.id).toBe("provider-ttl-2");
  });

  test("isolates response cache by tenant and gateway key", async () => {
    const config = testConfig();
    config.server.responseCache = {
      ...config.server.responseCache,
      enabled: true,
      ttlMs: 60_000,
    };
    let callCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1;
      return providerResponse(`isolated-${callCount}`);
    };
    const request = {
      model: "coding",
      messages: [{ role: "user" as const, content: "shared prompt" }],
    };

    const tenantAFirst = await createChatCompletion(
      { config, env, fetchImpl, budgetContext: { gatewayKey: "key-a", tenant: "tenant-a" } },
      request,
    );
    const tenantASecond = await createChatCompletion(
      { config, env, fetchImpl, budgetContext: { gatewayKey: "key-a", tenant: "tenant-a" } },
      request,
    );
    const tenantB = await createChatCompletion(
      { config, env, fetchImpl, budgetContext: { gatewayKey: "key-a", tenant: "tenant-b" } },
      request,
    );
    const gatewayKeyB = await createChatCompletion(
      { config, env, fetchImpl, budgetContext: { gatewayKey: "key-b", tenant: "tenant-a" } },
      request,
    );

    expect(callCount).toBe(3);
    expect(tenantAFirst.body.id).toBe("provider-isolated-1");
    expect(tenantASecond.body.id).toBe("provider-isolated-1");
    expect(tenantB.body.id).toBe("provider-isolated-2");
    expect(gatewayKeyB.body.id).toBe("provider-isolated-3");
  });

  test("extracts provider error messages from response bodies", () => {
    expect(providerErrorMessageFromBody({ error: { message: "rate limited" } })).toBe("rate limited");
    expect(providerErrorMessageFromBody({ message: "plain message" })).toBe("plain message");
    expect(providerErrorMessageFromBody(null)).toBeUndefined();
  });

  test("throws provider_invalid_json when provider response is not JSON", async () => {
    const config = testConfig();
    config.server.maxFallbackAttempts = 1;
    try {
      await createChatCompletion(
        {
          config,
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
          fetchImpl: async () => new Response("not-json", { status: 200 }),
        },
        { model: "coding", messages: [{ role: "user", content: "hi" }] },
      );
      throw new Error("expected completion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayHttpError);
      expect((error as GatewayHttpError).code).toBe("provider_invalid_json");
    }
  });

  test("throws provider_key_missing when provider env is unset", async () => {
    await expect(
      createChatCompletion(
        {
          config: testConfig(),
          env: { GATEWAY_API_KEY: "gateway" },
        },
        { model: "coding", messages: [{ role: "user", content: "hi" }] },
      ),
    ).rejects.toMatchObject({ code: "no_route" });
  });

  test("does not retry non-retryable provider errors", async () => {
    let calls = 0;
    await expect(
      createChatCompletion(
        {
          config: testConfig(),
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
          fetchImpl: async () => {
            calls += 1;
            return jsonResponse({ error: { message: "bad request" } }, 400);
          },
        },
        { model: "coding", messages: [{ role: "user", content: "hi" }] },
      ),
    ).rejects.toMatchObject({ code: "provider_bad_request", retryable: false });
    expect(calls).toBe(1);
  });

  test("exhausts fallback candidates when every provider fails retryably", async () => {
    const config = testConfig();
    config.server.maxFallbackAttempts = 2;
    config.routes[0] = {
      ...config.routes[0],
      dataPolicy: {
        allowTraining: false,
        allowLogging: true,
        allowChineseProviders: true,
        allowedRegions: ["cn", "us"],
      },
    };
    try {
      await createChatCompletion(
        {
          config,
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
          fetchImpl: async () => jsonResponse({ error: { message: "rate limited" } }, 429),
        },
        { model: "coding", messages: [{ role: "user", content: "hi" }] },
      );
      throw new Error("expected completion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayHttpError);
      const attempts = ((error as GatewayHttpError).raw as { attempts: Array<{ status: string }> }).attempts;
      expect(attempts.filter((attempt) => attempt.status === "failed").length).toBeGreaterThan(1);
    }
  });

  test("retries when fetch throws a retryable error", async () => {
    const config = testConfig();
    config.routes[0] = {
      ...config.routes[0],
      dataPolicy: {
        allowTraining: false,
        allowLogging: true,
        allowChineseProviders: true,
        allowedRegions: ["cn", "us"],
      },
    };
    let calls = 0;
    const result = await createChatCompletion(
      {
        config,
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) throw new Error("network reset");
          return jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
      },
      { model: "coding", messages: [{ role: "user", content: "hi" }] },
    );
    expect(calls).toBe(2);
    expect((result.body.gateway as Record<string, unknown>).provider).toBe("openai");
  });

  test("suppresses gateway metadata under strict_openai_compatibility", async () => {
    const result = await createChatCompletion(
      {
        config: testConfig(),
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        fetchImpl: async () =>
          jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
        gateway: { strict_openai_compatibility: true },
      },
    );
    expect(result.body.gateway).toBeUndefined();
  });

  test("falls back on stream retry after 429", async () => {
    const config = testConfig();
    config.routes[0] = {
      ...config.routes[0],
      dataPolicy: {
        allowTraining: false,
        allowLogging: true,
        allowChineseProviders: true,
        allowedRegions: ["cn", "us"],
      },
    };
    let calls = 0;
    const response = await createChatCompletionStream(
      {
        config,
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return jsonResponse({ error: { message: "rate limited" } }, 429);
          return new Response(
            [
              'data: {"id":"chunk","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
      { model: "coding", messages: [{ role: "user", content: "hi" }], stream: true },
    );
    expect(calls).toBe(2);
    const text = await response.text();
    expect(text).toContain("data: [DONE]");
  });

  test("throws all_routes_failed for streams when every candidate fails", async () => {
    const config = testConfig();
    config.server.maxFallbackAttempts = 2;
    await expect(
      createChatCompletionStream(
        {
          config,
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
          fetchImpl: async () => jsonResponse({ error: { message: "rate limited" } }, 429),
        },
        { model: "coding", messages: [{ role: "user", content: "hi" }], stream: true },
      ),
    ).rejects.toBeInstanceOf(GatewayHttpError);
  });

  test("forwards effective route policy to OpenRouter option mapping", async () => {
    const config = testConfig();
    config.providers.push({
      id: "openrouter",
      displayName: "OpenRouter",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.test/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      enabled: true,
      regions: ["global"],
      dataPolicy: {
        allowTraining: false,
        allowLogging: false,
        byokOnly: true,
        zeroDataRetentionAvailable: true,
      },
    });
    config.models.push({
      id: "openrouter/auto",
      providerId: "openrouter",
      providerModel: "openrouter/auto",
      aliases: ["or-auto"],
      capabilities: ["chat", "streaming", "tools", "json"],
    });
    config.routes.push({
      id: "or-auto",
      mode: "fallback",
      modelAliases: ["or-auto"],
      fallbackModelIds: ["openrouter/auto"],
      dataPolicy: {
        allowTraining: false,
        allowLogging: false,
        zeroDataRetentionRequired: true,
        allowedRegions: ["global"],
      },
    });

    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      expect(body.provider).toEqual({
        zdr: true,
        data_collection: "deny",
      });
      return jsonResponse({
        id: "provider-id",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };

    await createChatCompletion(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENROUTER_API_KEY: "openrouter",
        },
        fetchImpl,
      },
      {
        model: "or-auto",
        messages: [{ role: "user", content: "hi" }],
        provider_options: {
          openrouter: {
            provider: {
              zdr: false,
              data_collection: "allow",
            },
          },
        },
      },
    );
  });

  test("normalizes embeddings response with gateway metadata and ledger usage", async () => {
    const path = `/tmp/hasna-gateway-embeddings-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.budgets = [
      {
        id: "embedding-request",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "embeddings" },
        maxTotalTokens: 10,
      },
    ];

    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push(String(url));
      const providerBody = JSON.parse(String(init?.body));
      expect(providerBody).toEqual({
        model: "text-embedding-3-small",
        input: "do not write embedding input",
      });
      return jsonResponse({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        model: "text-embedding-3-small",
        usage: {
          prompt_tokens: 4,
          total_tokens: 4,
        },
      });
    };

    const result = await createEmbeddings(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
        },
        fetchImpl,
      },
      {
        model: "embeddings",
        input: "do not write embedding input",
      },
    );

    expect(calls).toEqual(["https://api.openai.test/v1/embeddings"]);
    expect(result.body.object).toBe("list");
    expect(result.body.model).toBe("openai/text-embedding-3-small");
    expect(result.body.usage).toEqual({
      prompt_tokens: 4,
      total_tokens: 4,
    });
    expect((result.body.gateway as Record<string, unknown>).provider).toBe("openai");
    expect(((result.body.gateway as Record<string, unknown>).budgets as Array<{ remaining: { totalTokens: number } }>)[0]?.remaining.totalTokens).toBe(6);

    const ledgerText = await Bun.file(path).text();
    const record = JSON.parse(ledgerText.trim());
    expect(record.provider).toBe("openai");
    expect(record.model).toBe("openai/text-embedding-3-small");
    expect(record.usage).toEqual({
      inputTokens: 4,
      outputTokens: 0,
      totalTokens: 4,
    });
    expect(ledgerText).not.toContain("do not write embedding input");
    await unlink(path);
  });

  test("rejects over-budget embeddings responses after recording usage", async () => {
    const path = `/tmp/hasna-gateway-embeddings-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.budgets = [
      {
        id: "tiny-embedding-request",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "embeddings" },
        maxTotalTokens: 1,
      },
    ];

    let thrown: unknown;
    try {
      await createEmbeddings(
        {
          config,
          env: {
            GATEWAY_API_KEY: "gateway",
            OPENAI_API_KEY: "openai",
          },
          fetchImpl: async () =>
            jsonResponse({
              object: "list",
              data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
              usage: {
                prompt_tokens: 2,
                total_tokens: 2,
              },
            }),
        },
        {
          model: "embeddings",
          input: "too many tokens",
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GatewayHttpError);
    expect(thrown).toMatchObject({ status: 402, code: "budget_exceeded" });
    const ledgerText = await Bun.file(path).text();
    expect(ledgerText).toContain('"totalTokens":2');
    await unlink(path);
  });
});
