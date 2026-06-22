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
});
