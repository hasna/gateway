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
});
