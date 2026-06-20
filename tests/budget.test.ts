import { unlink, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { getBudgetStatuses } from "../src/budget";
import { GatewayHttpError } from "../src/errors";
import { createChatCompletion, createChatCompletionStream } from "../src/gateway";
import { jsonResponse, testConfig } from "./helpers";

describe("gateway budgets", () => {
  test("reports remaining money and tokens from the local usage ledger", async () => {
    const path = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.budgets = [
      {
        id: "tenant-daily",
        window: "daily",
        mode: "hard",
        scope: { tenant: "acme", modelAlias: "coding" },
        maxUsd: 0.05,
        maxTotalTokens: 100,
      },
    ];

    await writeFile(
      path,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        status: "success",
        provider: "openai",
        model: "openai/gpt-4.1-mini",
        providerModel: "gpt-4.1-mini",
        routeMode: "fallback",
        attempts: [],
        context: { tenant: "acme", requestedModel: "coding", selectedModel: "openai/gpt-4.1-mini" },
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        estimatedCostUsd: 0.01,
      })}\n`,
      "utf8",
    );

    const [status] = await getBudgetStatuses(config, {
      tenant: "acme",
      requestedModel: "coding",
      selectedModel: "openai/gpt-4.1-mini",
    });

    expect(status?.budget.id).toBe("tenant-daily");
    expect(status?.spent.totalTokens).toBe(25);
    expect(status?.spent.usd).toBe(0.01);
    expect(status?.remaining.totalTokens).toBe(75);
    expect(status?.remaining.usd).toBe(0.04);
    await unlink(path);
  });

  test("blocks a second request before provider fetch when a hard token budget is exhausted", async () => {
    const path = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.budgets = [
      {
        id: "tiny-tenant",
        window: "lifetime",
        mode: "hard",
        scope: { tenant: "acme", modelAlias: "coding" },
        maxTotalTokens: 2,
        maxUsd: 0.01,
      },
    ];

    let providerCalls = 0;
    const runtime = {
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    };

    await createChatCompletion(runtime, {
      model: "coding",
      messages: [{ role: "user", content: "first" }],
      gateway: { tenant: "acme" },
    });

    await expect(createChatCompletion(runtime, {
      model: "coding",
      messages: [{ role: "user", content: "second" }],
      gateway: { tenant: "acme" },
    })).rejects.toMatchObject({
      status: 402,
      type: "gateway_budget_error",
      code: "budget_exceeded",
    });
    expect(providerCalls).toBe(1);
    await unlink(path);
  });

  test("rejects an over-budget non-streaming response and records the spend", async () => {
    const path = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.budgets = [
      {
        id: "per-request",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "coding" },
        maxTotalTokens: 1,
      },
    ];

    let thrown: unknown;
    try {
      await createChatCompletion(
        {
          config,
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
          fetchImpl: async () =>
            jsonResponse({
              choices: [{ index: 0, message: { role: "assistant", content: "too much" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
        },
        {
          model: "coding",
          messages: [{ role: "user", content: "hi" }],
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GatewayHttpError);
    expect(thrown).toMatchObject({ status: 402, code: "budget_exceeded" });
    const ledgerText = await Bun.file(path).text();
    expect(ledgerText).toContain('"totalTokens":2');
    await unlink(path);
  });

  test("rejects cumulative budgets without a usage ledger before provider fetch", async () => {
    const config = testConfig();
    config.budgets = [
      {
        id: "daily-without-ledger",
        window: "daily",
        mode: "hard",
        scope: { modelAlias: "coding" },
        maxTotalTokens: 10,
      },
    ];

    let providerCalls = 0;
    await expect(createChatCompletion(
      {
        config,
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        fetchImpl: async () => {
          providerCalls += 1;
          return jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
      },
    )).rejects.toMatchObject({
      status: 500,
      type: "gateway_config_error",
      code: "budget_ledger_missing",
    });
    expect(providerCalls).toBe(0);
  });

  test("fails closed for hard USD budgets when selected model pricing is unknown", async () => {
    const path = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.budgets = [
      {
        id: "money-needs-price",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "china-coding" },
        maxUsd: 0.01,
      },
    ];

    let thrown: unknown;
    try {
      await createChatCompletion(
        {
          config,
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
          fetchImpl: async () =>
            jsonResponse({
              choices: [{ index: 0, message: { role: "assistant", content: "unpriced" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
        },
        {
          model: "china-coding",
          messages: [{ role: "user", content: "hi" }],
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GatewayHttpError);
    expect(thrown).toMatchObject({ status: 402, code: "budget_exceeded" });
    const ledgerText = await Bun.file(path).text();
    expect(ledgerText).toContain("USD budget cannot be verified because model pricing is missing");
    await unlink(path);
  });

  test("turns streaming usage that exceeds a hard budget into a stream error and records spend", async () => {
    const path = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.budgets = [
      {
        id: "stream-per-request",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "coding" },
        maxTotalTokens: 1,
      },
    ];

    const response = await createChatCompletionStream(
      {
        config,
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        fetchImpl: async () =>
          new Response(
            [
              'data: {"id":"chunk","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}',
              'data: {"id":"chunk","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    );

    const streamText = await response.text();
    expect(streamText).toContain('"type":"gateway_budget_error"');
    expect(streamText).toContain('"code":"budget_exceeded"');
    const ledgerText = await Bun.file(path).text();
    expect(ledgerText).toContain('"totalTokens":2');
    await unlink(path);
  });
});
