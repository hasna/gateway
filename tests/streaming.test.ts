import { describe, expect, test } from "bun:test";
import { transformOpenAICompatibleStream } from "../src/streaming";
import { testConfig } from "./helpers";

describe("streaming", () => {
  test("normalizes OpenAI-compatible SSE chunks", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const response = transformOpenAICompatibleStream(
      new Response('data: {"id":"chunk","object":"chat.completion.chunk","model":"gpt-4.1-mini","choices":[]}\n\ndata: [DONE]\n\n'),
      {
        provider,
        model,
        includeGatewayMetadata: true,
        decision: {
          requested_model: "coding",
          resolved_candidates: [model.id],
          selected: model.id,
          mode: "fallback",
          policy: { allow_training: false, allow_chinese_providers: false },
          reason: "test",
          attempts: [{ provider: "openai", model: model.id, providerModel: model.providerModel, status: "selected" }],
        },
      },
    );

    const text = await response.text();
    expect(text).toContain('"model":"openai/gpt-4.1-mini"');
    expect(text).toContain('"provider":"openai"');
    expect(text).toContain("data: [DONE]");
  });

  test("handles CRLF event boundaries without duplicating DONE", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const response = transformOpenAICompatibleStream(
      new Response(': comment\r\ndata: {"id":"chunk","object":"chat.completion.chunk","choices":[]}\r\n\r\ndata: [DONE]\r\n\r\n'),
      {
        provider,
        model,
        includeGatewayMetadata: false,
        decision: {
          requested_model: "coding",
          resolved_candidates: [model.id],
          selected: model.id,
          mode: "fallback",
          policy: { allow_training: false, allow_chinese_providers: false },
          reason: "test",
          attempts: [{ provider: "openai", model: model.id, providerModel: model.providerModel, status: "selected" }],
        },
      },
    );

    const text = await response.text();
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).toContain('"model":"openai/gpt-4.1-mini"');
  });

  test("turns malformed provider chunks into stream errors", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const response = transformOpenAICompatibleStream(new Response("data: not-json\n\n"), {
      provider,
      model,
      includeGatewayMetadata: false,
      decision: {
        requested_model: "coding",
        resolved_candidates: [model.id],
        selected: model.id,
        mode: "fallback",
        policy: { allow_training: false, allow_chinese_providers: false },
        reason: "test",
        attempts: [{ provider: "openai", model: model.id, providerModel: model.providerModel, status: "selected" }],
      },
    });

    const text = await response.text();
    expect(text).toContain('"type":"provider_stream_error"');
    expect(text).toContain("data: [DONE]");
  });

  test("returns DONE when provider response has no body", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const response = transformOpenAICompatibleStream(new Response(null), {
      provider,
      model,
      includeGatewayMetadata: false,
      decision: {
        requested_model: "coding",
        resolved_candidates: [model.id],
        selected: model.id,
        mode: "fallback",
        policy: { allow_training: false, allow_chinese_providers: false },
        reason: "test",
        attempts: [],
      },
    });
    expect(await response.text()).toBe("data: [DONE]\n\n");
  });

  test("returns DONE when provider body has no reader", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const body = { getReader: () => undefined };
    const response = transformOpenAICompatibleStream(new Response(body as unknown as ReadableStream), {
      provider,
      model,
      includeGatewayMetadata: false,
      decision: {
        requested_model: "coding",
        resolved_candidates: [model.id],
        selected: model.id,
        mode: "fallback",
        policy: { allow_training: false, allow_chinese_providers: false },
        reason: "test",
        attempts: [],
      },
    });
    expect(await response.text()).toBe("data: [DONE]\n\n");
  });

  test("surfaces onUsage callback failures as stream errors", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const response = transformOpenAICompatibleStream(
      new Response(
        'data: {"id":"chunk","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
      ),
      {
        provider,
        model,
        includeGatewayMetadata: false,
        decision: {
          requested_model: "coding",
          resolved_candidates: [model.id],
          selected: model.id,
          mode: "fallback",
          policy: { allow_training: false, allow_chinese_providers: false },
          reason: "test",
          attempts: [],
        },
        onUsage: async () => {
          throw new Error("usage accounting failed");
        },
      },
    );
    const text = await response.text();
    expect(text).toContain('"type":"gateway_stream_error"');
    expect(text).toContain("data: [DONE]");
  });

  test("surfaces onComplete callback failures as stream errors", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const response = transformOpenAICompatibleStream(
      new Response('data: {"id":"chunk","object":"chat.completion.chunk","choices":[]}\n\ndata: [DONE]\n\n'),
      {
        provider,
        model,
        includeGatewayMetadata: false,
        decision: {
          requested_model: "coding",
          resolved_candidates: [model.id],
          selected: model.id,
          mode: "fallback",
          policy: { allow_training: false, allow_chinese_providers: false },
          reason: "test",
          attempts: [],
        },
        onComplete: async (result) => {
          if (result.status === "success") throw new Error("completion hook failed");
        },
      },
    );
    const text = await response.text();
    expect(text).toContain('"type":"gateway_stream_error"');
    expect(text).toContain("data: [DONE]");
  });

  test("flushes trailing buffer without a final DONE event", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"id":"chunk","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"tail"}}]}',
          ),
        );
        controller.close();
      },
    });
    const response = transformOpenAICompatibleStream(new Response(stream), {
      provider,
      model,
      includeGatewayMetadata: false,
      decision: {
        requested_model: "coding",
        resolved_candidates: [model.id],
        selected: model.id,
        mode: "fallback",
        policy: { allow_training: false, allow_chinese_providers: false },
        reason: "test",
        attempts: [],
      },
    });
    const text = await response.text();
    expect(text).toContain('"content":"tail"');
    expect(text).toContain("data: [DONE]");
  });

  test("prefers the earlier LF boundary when both LF and CRLF are present", async () => {
    const config = testConfig();
    const provider = config.providers.find((candidate) => candidate.id === "openai")!;
    const model = config.models.find((candidate) => candidate.id === "openai/gpt-4.1-mini")!;
    const response = transformOpenAICompatibleStream(
      new Response(
        'data: {"id":"lf","object":"chat.completion.chunk","choices":[]}\n\ndata: {"id":"crlf","object":"chat.completion.chunk","choices":[]}\r\n\r\ndata: [DONE]\n\n',
      ),
      {
        provider,
        model,
        includeGatewayMetadata: false,
        decision: {
          requested_model: "coding",
          resolved_candidates: [model.id],
          selected: model.id,
          mode: "fallback",
          policy: { allow_training: false, allow_chinese_providers: false },
          reason: "test",
          attempts: [],
        },
      },
    );
    const text = await response.text();
    expect(text).toContain('"id":"lf"');
    expect(text).toContain('"id":"crlf"');
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
  });
});
