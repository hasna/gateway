import { describe, expect, test } from "bun:test";
import { createChatCompletion } from "../src/gateway";
import { testConfig, jsonResponse } from "./helpers";

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
        },
      });
    };

    const result = await createChatCompletion(
      {
        config: anthropicTestConfig(),
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
      prompt_tokens: 11,
      completion_tokens: 4,
      total_tokens: 15,
      prompt_tokens_details: {
        cached_tokens: 3,
      },
    });
    expect((result.body.gateway as Record<string, unknown>).provider).toBe("anthropic");
  });
});
