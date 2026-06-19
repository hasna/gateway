import { unlink } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { createChatCompletion, createChatCompletionStream } from "../src/gateway";
import { jsonResponse, testConfig } from "./helpers";

describe("usage ledger", () => {
  test("writes sanitized local JSONL records when enabled", async () => {
    const path = `/tmp/hasna-gateway-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;

    await createChatCompletion(
      {
        config,
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        fetchImpl: async () =>
          jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "do not write this prompt" }],
      },
    );

    const text = await Bun.file(path).text();
    const record = JSON.parse(text.trim());
    expect(record.provider).toBe("openai");
    expect(record.usage.totalTokens).toBe(6);
    expect(text).not.toContain("do not write this prompt");
    await unlink(path);
  });

  test("writes streaming usage records when provider emits final usage", async () => {
    const path = `/tmp/hasna-gateway-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;

    const response = await createChatCompletionStream(
      {
        config,
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        fetchImpl: async () =>
          new Response(
            [
              'data: {"id":"chunk","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}',
              'data: {"id":"chunk","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "do not write streamed prompt" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    );

    await response.text();
    const text = await Bun.file(path).text();
    const record = JSON.parse(text.trim());
    expect(record.status).toBe("success");
    expect(record.provider).toBe("openai");
    expect(record.usage.totalTokens).toBe(7);
    expect(record.estimatedCostUsd).toBeGreaterThan(0);
    expect(text).not.toContain("do not write streamed prompt");
    await unlink(path);
  });

  test("writes streaming error records for malformed provider chunks", async () => {
    const path = `/tmp/hasna-gateway-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;

    const response = await createChatCompletionStream(
      {
        config,
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        fetchImpl: async () => new Response("data: not-json\n\n", { headers: { "content-type": "text/event-stream" } }),
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "do not write malformed prompt" }],
        stream: true,
      },
    );

    await response.text();
    const text = await Bun.file(path).text();
    const record = JSON.parse(text.trim());
    expect(record.status).toBe("error");
    expect(record.errorType).toBe("provider_stream_error");
    expect(record.errorCode).toBe("provider_stream_invalid_chunk");
    expect(text).not.toContain("do not write malformed prompt");
    await unlink(path);
  });
});
