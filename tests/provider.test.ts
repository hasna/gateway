import { describe, expect, test } from "bun:test";
import { OpenAICompatibleAdapter, toProviderChatBody } from "../src/providers";
import { testConfig } from "./helpers";

describe("OpenAI-compatible provider adapter", () => {
  test("strips gateway-only fields and swaps provider model", () => {
    const body = toProviderChatBody(
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
        parallel_tool_calls: true,
        metadata: { request_id: "req_1" },
        max_completion_tokens: 128,
        gateway: { routing: "fallback" },
        provider_options: { ignored: true },
      },
      "gpt-4.1-mini",
    );

    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.gateway).toBeUndefined();
    expect(body.provider_options).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.metadata).toEqual({ request_id: "req_1" });
    expect(body.max_completion_tokens).toBe(128);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("does not send stream_options on non-streaming provider requests", () => {
    const body = toProviderChatBody(
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        stream_options: { include_usage: true },
      },
      "gpt-4.1-mini",
    );

    expect(body.stream_options).toBeUndefined();
  });

  test("builds bearer request", () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const adapter = new OpenAICompatibleAdapter();
    const request = adapter.buildRequest({
      provider,
      model,
      request: {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
      },
      apiKey: "secret",
      timeoutMs: 1000,
    });

    expect(request.url).toBe("https://api.openai.test/v1/chat/completions");
    expect((request.init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(request.init.body)).model).toBe("gpt-4.1-mini");
  });

  test("builds custom auth and env-derived headers", () => {
    const config = testConfig();
    const provider = {
      ...config.providers[0]!,
      id: "portkey",
      baseUrl: undefined,
      baseUrlEnv: "PORTKEY_BASE_URL",
      apiKeyEnv: undefined,
      auth: {
        type: "header" as const,
        apiKeyEnv: "PORTKEY_API_KEY",
        headerName: "x-portkey-api-key",
        prefix: "",
      },
      headers: {
        "x-portkey-config": { env: "PORTKEY_CONFIG_ID" },
        "x-static": "static-value",
      },
    };
    const model = { ...config.models[0]!, providerId: "portkey" };
    const adapter = new OpenAICompatibleAdapter();

    const request = adapter.buildRequest({
      provider,
      model,
      request: {
        model: "portkey-coding",
        messages: [{ role: "user", content: "hi" }],
      },
      apiKey: "pk-key",
      timeoutMs: 1000,
      env: {
        PORTKEY_BASE_URL: "https://portkey.test/v1",
        PORTKEY_CONFIG_ID: "pc-test",
      },
    });

    expect(request.url).toBe("https://portkey.test/v1/chat/completions");
    expect((request.init.headers as Record<string, string>)["x-portkey-api-key"]).toBe("pk-key");
    expect((request.init.headers as Record<string, string>)["x-portkey-config"]).toBe("pc-test");
    expect((request.init.headers as Record<string, string>)["x-static"]).toBe("static-value");
    expect((request.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("maps only supported OpenRouter provider and auto-router options", () => {
    const config = testConfig();
    const provider = {
      ...config.providers[0]!,
      id: "openrouter",
      kind: "openai-compatible" as const,
    };
    const body = toProviderChatBody(
      {
        model: "openrouter-auto",
        messages: [{ role: "user", content: "hi" }],
        gateway: {
          provider_order: ["anthropic", "openai"],
          provider_only: ["anthropic", "openai"],
          provider_ignore: ["bad-provider"],
          provider_sort: "latency",
          allow_fallbacks: false,
          zero_data_retention_required: true,
          allow_logging: false,
          max_price: { prompt: 1, completion: 2 },
          cost_quality_tradeoff: 3,
          sticky_session_id: "session-1",
        },
        provider_options: {
          openrouter: {
            allowed_models: ["anthropic/*"],
            provider: {
              ignore: ["deepinfra"],
              zdr: false,
              data_collection: "allow",
              unsupported_secret: "drop-me",
            },
            apiKey: "drop-me-too",
          },
        },
      },
      "openrouter/auto",
      provider,
    );

    expect(body.model).toBe("openrouter/auto");
    expect(body.provider).toEqual({
      order: ["anthropic", "openai"],
      only: ["anthropic", "openai"],
      ignore: ["deepinfra"],
      sort: "latency",
      allow_fallbacks: false,
      zdr: true,
      data_collection: "deny",
      max_price: { prompt: 1, completion: 2 },
    });
    expect(body.plugins).toEqual([
      {
        id: "auto-router",
        allowed_models: ["anthropic/*"],
        cost_quality_tradeoff: 3,
      },
    ]);
    expect(body.session_id).toBe("session-1");
    expect(body.provider_options).toBeUndefined();
  });

  test("maps only Vercel AI Gateway provider options", () => {
    const config = testConfig();
    const provider = {
      ...config.providers[0]!,
      id: "vercel-ai-gateway",
    };
    const body = toProviderChatBody(
      {
        model: "vercel-coding",
        messages: [{ role: "user", content: "hi" }],
        gateway: {
          provider_order: ["bedrock", "anthropic"],
          provider_only: ["bedrock", "anthropic"],
          caching: "auto",
          provider_timeouts: { byok: { anthropic: 3000 } },
        },
        providerOptions: {
          vercel: {
            gateway: {
              only: ["anthropic"],
              byok: { openai: "drop-secret" },
            },
          },
        },
      },
      "openai/gpt-4.1-mini",
      provider,
    );

    expect(body.providerOptions).toEqual({
      gateway: {
        only: ["anthropic"],
        order: ["bedrock", "anthropic"],
        caching: "auto",
        providerTimeouts: { byok: { anthropic: 3000 } },
      },
    });
    expect(body.provider_options).toBeUndefined();
    expect((body.providerOptions as Record<string, Record<string, unknown>>).gateway.byok).toBeUndefined();
  });
});
