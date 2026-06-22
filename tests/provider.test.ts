import { describe, expect, test } from "bun:test";
import {
  AnthropicMessagesAdapter,
  GoogleGeminiAdapter,
  googleGeminiOpenAIBaseUrl,
  OpenAICompatibleAdapter,
  toAnthropicMessagesBody,
  toOpenAIChatCompletionResponse,
  toProviderChatBody,
} from "../src/providers";
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

describe("Anthropic Messages provider adapter", () => {
  test("translates OpenAI chat request shape to Anthropic Messages", () => {
    const body = toAnthropicMessagesBody(
      {
        model: "anthropic-coding",
        messages: [
          { role: "system", content: "Answer tersely." },
          { role: "developer", content: "Prefer JSON when asked." },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: [{ type: "text", text: "continue" }] },
        ],
        max_completion_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
        stop: "DONE",
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a record",
              parameters: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "lookup" } },
        gateway: { routing: "fallback" },
        provider_options: { ignored: true },
      },
      "claude-3-5-sonnet-latest",
    );

    expect(body).toEqual({
      model: "claude-3-5-sonnet-latest",
      max_tokens: 256,
      system: "Answer tersely.\n\nPrefer JSON when asked.",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ["DONE"],
      tools: [
        {
          name: "lookup",
          description: "Look up a record",
          input_schema: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
      tool_choice: { type: "tool", name: "lookup" },
    });
  });

  test("builds Anthropic x-api-key request with default base URL", () => {
    const adapter = new AnthropicMessagesAdapter();
    const request = adapter.buildRequest({
      provider: {
        id: "anthropic",
        displayName: "Anthropic",
        kind: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      model: {
        id: "anthropic/claude-3-5-sonnet",
        providerId: "anthropic",
        providerModel: "claude-3-5-sonnet-latest",
        capabilities: ["chat"],
      },
      request: {
        model: "anthropic-coding",
        messages: [{ role: "user", content: "hi" }],
      },
      apiKey: "secret",
      timeoutMs: 1000,
    });

    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect((request.init.headers as Record<string, string>)["x-api-key"]).toBe("secret");
    expect((request.init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      model: "claude-3-5-sonnet-latest",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("normalizes Anthropic response to OpenAI chat completion shape", () => {
    const body = toOpenAIChatCompletionResponse(
      {
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet-latest",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " there" },
        ],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          cache_read_input_tokens: 2,
        },
      },
      "claude-3-5-sonnet-latest",
    );

    expect(body).toEqual({
      id: "msg_123",
      object: "chat.completion",
      created: expect.any(Number),
      model: "claude-3-5-sonnet-latest",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello there" },
          finish_reason: "stop",
        },
      ],
      usage: {
        input_tokens: 8,
        output_tokens: 3,
        cache_read_input_tokens: 2,
      },
    });
  });

  test("round-trips tool calls and tool results", () => {
    const body = toAnthropicMessagesBody(
      {
        model: "anthropic-coding",
        messages: [
          { role: "user", content: "look up id 7" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "toolu_1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"id\":\"7\"}",
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "toolu_1",
            content: "record 7",
          },
        ],
      },
      "claude-3-5-sonnet-latest",
    );

    expect(body.messages).toEqual([
      { role: "user", content: "look up id 7" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { id: "7" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "record 7" }],
      },
    ]);

    const response = toOpenAIChatCompletionResponse(
      {
        id: "msg_456",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_2", name: "lookup", input: { id: "8" } }],
        usage: { input_tokens: 12, output_tokens: 5 },
      },
      "claude-3-5-sonnet-latest",
    );

    expect(response.choices).toEqual([
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "toolu_2",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{\"id\":\"8\"}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ]);
  });

  test("returns clean unsupported responses for streaming and response_format", async () => {
    const adapter = new AnthropicMessagesAdapter();
    const responseFormatResponse = await adapter.send({
      provider: {
        id: "anthropic",
        displayName: "Anthropic",
        kind: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      model: {
        id: "anthropic/claude-3-5-sonnet",
        providerId: "anthropic",
        providerModel: "claude-3-5-sonnet-latest",
        capabilities: ["chat"],
      },
      request: {
        model: "anthropic-coding",
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_object" },
      },
      apiKey: "secret",
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      },
    });
    const streamResponse = await adapter.stream();

    expect(responseFormatResponse.status).toBe(400);
    expect((await responseFormatResponse.json()).error.code).toBe("provider_unsupported_feature");
    expect(streamResponse.status).toBe(400);
    expect((await streamResponse.json()).error.code).toBe("provider_unsupported_feature");
  });
});

describe("Google Gemini provider adapter", () => {
  test("builds a Gemini OpenAI-compatible bearer request", () => {
    const adapter = new GoogleGeminiAdapter();
    const request = adapter.buildRequest({
      provider: {
        id: "google",
        displayName: "Google Gemini",
        kind: "google",
        apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
      },
      model: {
        id: "google/gemini-3.5-flash",
        providerId: "google",
        providerModel: "gemini-3.5-flash",
        aliases: ["gemini"],
        capabilities: ["chat", "streaming", "tools", "json"],
      },
      request: {
        model: "gemini",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "hi" },
        ],
        gateway: { routing: "explicit" },
      },
      apiKey: "google-key",
      timeoutMs: 1000,
    });

    expect(request.url).toBe(`${googleGeminiOpenAIBaseUrl}/chat/completions`);
    expect((request.init.headers as Record<string, string>).authorization).toBe("Bearer google-key");
    expect(JSON.parse(String(request.init.body))).toEqual({
      model: "gemini-3.5-flash",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "hi" },
      ],
    });
  });
});
