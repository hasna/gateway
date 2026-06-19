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
});
