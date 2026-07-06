import { unlink } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { createChatCompletion, createChatCompletionStream } from "../src/gateway";
import { readUsageLedgerRecords } from "../src/storage";
import { jsonResponse, testConfig, testEnv } from "./helpers";

async function removeSqliteFiles(path: string): Promise<void> {
  await Promise.all([
    unlink(path).catch(() => undefined),
    unlink(`${path}-shm`).catch(() => undefined),
    unlink(`${path}-wal`).catch(() => undefined),
  ]);
}

describe("usage ledger", () => {
  test("writes sanitized local JSONL records when enabled", async () => {
    const path = `/tmp/hasna-gateway-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;

    await createChatCompletion(
      {
        config,
        env: testEnv(),
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
        env: testEnv(),
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
        env: testEnv(),
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

  test("writes cloud sqlite ledger records across reopened configs when enabled", async () => {
    const sqlitePath = `/tmp/hasna-gateway-ledger-${crypto.randomUUID()}.sqlite`;
    const config = testConfig();
    config.storage.cloud = { backend: "sqlite", sqlitePath };

    await createChatCompletion(
      {
        config,
        env: testEnv(),
        fetchImpl: async () =>
          jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "do not write this cloud prompt" }],
      },
    );

    const reopenedConfig = testConfig();
    reopenedConfig.storage.cloud = { backend: "sqlite", sqlitePath };
    const records = await readUsageLedgerRecords(reopenedConfig);
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("openai");
    expect(records[0]?.usage?.totalTokens).toBe(5);
    expect(JSON.stringify(records)).not.toContain("do not write this cloud prompt");
    await removeSqliteFiles(sqlitePath);
  });

  test("keeps a successful provider response when cloud ledger append fails", async () => {
    const config = testConfig();
    config.storage.cloud = { backend: "postgres", connectionStringEnv: "MISSING_LEDGER_DATABASE_URL" };
    let providerCalls = 0;

    const result = await createChatCompletion(
      {
        config,
        env: testEnv(),
        fetchImpl: async () => {
          providerCalls += 1;
          return jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          });
        },
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "do not leak failed cloud prompt" }],
      },
    );

    expect(providerCalls).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    });
    expect(JSON.stringify(result.body)).not.toContain("do not leak failed cloud prompt");
    expect(JSON.stringify(result.body)).not.toContain("MISSING_LEDGER_DATABASE_URL");
  });
});
