import { unlink, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { getBudgetStatuses } from "../src/budget";
import { GatewayHttpError } from "../src/errors";
import { createChatCompletion, createChatCompletionStream } from "../src/gateway";
import { jsonResponse, testConfig, testEnv } from "./helpers";

async function removeSqliteFiles(path: string): Promise<void> {
  await Promise.all([
    unlink(path).catch(() => undefined),
    unlink(`${path}-shm`).catch(() => undefined),
    unlink(`${path}-wal`).catch(() => undefined),
  ]);
}

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

  test("reports remaining money and tokens from a cloud sqlite usage ledger across reopened configs", async () => {
    const sqlitePath = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.sqlite`;
    const config = testConfig();
    config.storage.cloud = { backend: "sqlite", sqlitePath };
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

    await createChatCompletion(
      {
        config,
        env: testEnv(),
        fetchImpl: async () =>
          jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          }),
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "first" }],
        gateway: { tenant: "acme" },
      },
    );

    const reopenedConfig = testConfig();
    reopenedConfig.storage.cloud = { backend: "sqlite", sqlitePath };
    reopenedConfig.budgets = config.budgets;
    const [status] = await getBudgetStatuses(reopenedConfig, {
      tenant: "acme",
      requestedModel: "coding",
      selectedModel: "openai/gpt-4.1-mini",
    });

    expect(status?.budget.id).toBe("tenant-daily");
    expect(status?.spent.totalTokens).toBe(25);
    expect(status?.spent.usd).toBeGreaterThan(0);
    expect(status?.remaining.totalTokens).toBe(75);
    await removeSqliteFiles(sqlitePath);
  });

  test("combines existing JSONL spend with cloud ledger writes without double-counting", async () => {
    const path = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.jsonl`;
    const sqlitePath = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.sqlite`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.storage.cloud = { backend: "sqlite", sqlitePath };
    config.budgets = [
      {
        id: "tenant-migration",
        window: "lifetime",
        mode: "hard",
        scope: { tenant: "acme", modelAlias: "coding" },
        maxTotalTokens: 120,
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
        usage: { inputTokens: 70, outputTokens: 20, totalTokens: 90 },
        estimatedCostUsd: 0.01,
      })}\n`,
      "utf8",
    );

    await createChatCompletion(
      {
        config,
        env: testEnv(),
        fetchImpl: async () =>
          jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
          }),
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "during migration" }],
        gateway: { tenant: "acme" },
      },
    );

    const [status] = await getBudgetStatuses(config, {
      tenant: "acme",
      requestedModel: "coding",
      selectedModel: "openai/gpt-4.1-mini",
    });
    expect(status?.spent.totalTokens).toBe(100);
    expect(status?.remaining.totalTokens).toBe(20);
    await unlink(path);
    await removeSqliteFiles(sqlitePath);
  });

  test("does not read cloud ledger storage when no configured budget needs cumulative records", async () => {
    const cloud = { backend: "postgres" as const, connectionStringEnv: "MISSING_BUDGET_LEDGER_URL" };
    const noBudgetsConfig = testConfig();
    noBudgetsConfig.storage.cloud = cloud;
    noBudgetsConfig.budgets = [];

    await expect(getBudgetStatuses(noBudgetsConfig, {
      tenant: "acme",
      requestedModel: "coding",
      selectedModel: "openai/gpt-4.1-mini",
    })).resolves.toEqual([]);

    const budgetIdMissConfig = testConfig();
    budgetIdMissConfig.storage.cloud = cloud;
    budgetIdMissConfig.budgets = [
      {
        id: "tenant-daily",
        window: "daily",
        mode: "hard",
        scope: { tenant: "acme", modelAlias: "coding" },
        maxTotalTokens: 100,
      },
    ];

    await expect(getBudgetStatuses(
      budgetIdMissConfig,
      {
        tenant: "acme",
        requestedModel: "coding",
        selectedModel: "openai/gpt-4.1-mini",
      },
      { budgetId: "missing-budget" },
    )).resolves.toEqual([]);

    const perRequestConfig = testConfig();
    perRequestConfig.storage.cloud = cloud;
    perRequestConfig.budgets = [
      {
        id: "per-request-only",
        window: "per-request",
        mode: "hard",
        scope: { tenant: "acme", modelAlias: "coding" },
        maxTotalTokens: 100,
      },
    ];

    const [status] = await getBudgetStatuses(perRequestConfig, {
      tenant: "acme",
      requestedModel: "coding",
      selectedModel: "openai/gpt-4.1-mini",
    });
    expect(status?.budget.id).toBe("per-request-only");
    expect(status?.spent.totalTokens).toBe(0);
    expect(status?.remaining.totalTokens).toBe(100);
  });

  test("still reads cloud ledger storage for matched cumulative budgets", async () => {
    const config = testConfig();
    config.storage.cloud = { backend: "postgres", connectionStringEnv: "MISSING_BUDGET_LEDGER_URL" };
    config.budgets = [
      {
        id: "tenant-daily",
        window: "daily",
        mode: "hard",
        scope: { tenant: "acme", modelAlias: "coding" },
        maxTotalTokens: 100,
      },
    ];

    await expect(getBudgetStatuses(config, {
      tenant: "acme",
      requestedModel: "coding",
      selectedModel: "openai/gpt-4.1-mini",
    })).rejects.toMatchObject({
      status: 500,
    });
  });

  test("fails closed when a budgeted response cannot be persisted to the cloud ledger", async () => {
    const config = testConfig();
    config.storage.cloud = { backend: "postgres", connectionStringEnv: "MISSING_BUDGET_LEDGER_URL" };
    config.budgets = [
      {
        id: "per-request-budgeted",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "coding" },
        maxTotalTokens: 100,
      },
    ];

    let providerCalls = 0;
    await expect(createChatCompletion(
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
        messages: [{ role: "user", content: "budgeted cloud append should fail closed" }],
      },
    )).rejects.toMatchObject({
      status: 500,
    });
    expect(providerCalls).toBe(1);
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
      env: testEnv(),
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

  test("blocks a second request after reopening the cloud sqlite budget ledger", async () => {
    const sqlitePath = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.sqlite`;
    const makeConfig = () => {
      const config = testConfig();
      config.storage.cloud = { backend: "sqlite", sqlitePath };
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
      return config;
    };

    let firstProviderCalls = 0;
    await createChatCompletion(
      {
        config: makeConfig(),
        env: testEnv(),
        fetchImpl: async () => {
          firstProviderCalls += 1;
          return jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "first" }],
        gateway: { tenant: "acme" },
      },
    );

    let secondProviderCalls = 0;
    await expect(createChatCompletion(
      {
        config: makeConfig(),
        env: testEnv(),
        fetchImpl: async () => {
          secondProviderCalls += 1;
          return jsonResponse({
            choices: [{ index: 0, message: { role: "assistant", content: "too late" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "second" }],
        gateway: { tenant: "acme" },
      },
    )).rejects.toMatchObject({
      status: 402,
      type: "gateway_budget_error",
      code: "budget_exceeded",
    });

    expect(firstProviderCalls).toBe(1);
    expect(secondProviderCalls).toBe(0);
    await removeSqliteFiles(sqlitePath);
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
          env: testEnv(),
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
        env: testEnv(),
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
          env: testEnv(),
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

  test("fails closed for hard USD budgets when selected model pricing is partially unknown", async () => {
    const path = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    const pricedModel = config.models.find((model) => model.id === "openai/gpt-4.1-mini")!;
    delete pricedModel.outputUsdPerMillionTokens;
    config.budgets = [
      {
        id: "money-needs-output-price",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "coding" },
        maxUsd: 0.01,
      },
    ];

    let thrown: unknown;
    try {
      await createChatCompletion(
        {
          config,
          env: testEnv(),
          fetchImpl: async () =>
            jsonResponse({
              choices: [{ index: 0, message: { role: "assistant", content: "unpriced output" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1_000_000, total_tokens: 1_000_001 },
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
        env: testEnv(),
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

  test("requests streaming usage and fails closed when a hard-budget stream omits usage", async () => {
    const path = `/tmp/hasna-gateway-budget-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.storage.usageLedgerPath = path;
    config.budgets = [
      {
        id: "stream-needs-usage",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "coding" },
        maxTotalTokens: 100,
      },
    ];

    let providerBody: Record<string, unknown> = {};
    const response = await createChatCompletionStream(
      {
        config,
        env: testEnv(),
        fetchImpl: async (_input, init) => {
          providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            [
              'data: {"id":"chunk","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    );

    const streamText = await response.text();
    expect(providerBody.stream_options).toEqual({ include_usage: true });
    expect(streamText).toContain('"type":"gateway_budget_error"');
    expect(streamText).toContain('"code":"budget_usage_missing"');
    const ledgerText = await Bun.file(path).text();
    expect(ledgerText).toContain('"status":"error"');
    expect(ledgerText).toContain('"errorCode":"budget_usage_missing"');
    await unlink(path);
  });
});
