import { describe, expect, test } from "bun:test";
import { createChatCompletion } from "../src/gateway";
import { testConfig, jsonResponse } from "./helpers";

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
});
