import { unlink } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { createGatewayHandler } from "../src/server";
import { testConfig, jsonResponse } from "./helpers";

describe("HTTP server handler", () => {
  test("serves health without auth", async () => {
    const handler = createGatewayHandler({ config: testConfig(), env: {} });
    const response = await handler(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  test("does not serve metrics unless configured", async () => {
    const handler = createGatewayHandler({ config: testConfig(), env: {} });
    const response = await handler(new Request("http://localhost/metrics"));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  test("serves OpenMetrics counters and budget state when enabled", async () => {
    const ledgerPath = `/tmp/hasna-gateway-metrics-ledger-${crypto.randomUUID()}.jsonl`;
    const config = testConfig();
    config.server.metricsEnabled = true;
    config.storage.usageLedgerPath = ledgerPath;
    config.budgets = [
      {
        id: "daily-total",
        window: "daily",
        mode: "hard",
        scope: { modelAlias: "coding" },
        maxUsd: 0.01,
        maxTotalTokens: 100,
      },
    ];

    const handler = createGatewayHandler({
      config,
      env: {
        GATEWAY_API_KEY: "gateway-test-value",
        OPENAI_API_KEY: "provider-test-value",
        DEEPSEEK_API_KEY: "deepseek-test-value",
      },
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    });

    const chatResponse = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-test-value",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "coding", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(chatResponse.status).toBe(200);

    const response = await handler(new Request("http://localhost/metrics"));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/openmetrics-text");
    expect(text).toContain("# EOF");
    expect(text).toContain("gateway_http_requests_total");
    expect(text).toContain("gateway_chat_completions_total");
    expect(text).toContain("gateway_tokens_total");
    expect(text).toContain("gateway_estimated_cost_usd_total");
    expect(text).toContain("gateway_route_decisions_total");
    expect(text).toContain("gateway_route_attempts_total");
    expect(text).toContain("gateway_budget_remaining_usd");
    expect(text).toContain("gateway_budget_remaining_tokens");
    expect(text).toContain("gateway_budget_exhausted");
    expect(text).toContain(
      'gateway_http_requests_total{endpoint="/v1/chat/completions",method="POST",status="200",status_class="2xx"} 1',
    );
    expect(text).toContain(
      'gateway_chat_completions_total{model="openai/gpt-4.1-mini",provider="openai",route_mode="fallback",status="success",stream="false"} 1',
    );
    expect(text).toContain(
      'gateway_tokens_total{model="openai/gpt-4.1-mini",provider="openai",route_mode="fallback",status="success",stream="false",type="input"} 10',
    );
    expect(text).toMatch(
      /gateway_budget_remaining_tokens\{budget_id="sha256:[a-f0-9]{16}",dimension="total",mode="hard",window="daily"\} 85/,
    );
    expect(text).not.toContain("gateway-test-value");
    expect(text).not.toContain("provider-test-value");
    expect(text).not.toContain("deepseek-test-value");
    await unlink(ledgerPath).catch(() => undefined);
  });

  test("records consumed usage when a postflight hard budget rejects the response", async () => {
    const config = testConfig();
    config.server.metricsEnabled = true;
    config.budgets = [
      {
        id: "tiny-request",
        window: "per-request",
        mode: "hard",
        scope: { modelAlias: "coding" },
        maxTotalTokens: 1,
      },
    ];

    const handler = createGatewayHandler({
      config,
      env: {
        GATEWAY_API_KEY: "gateway-test-value",
        OPENAI_API_KEY: "provider-test-value",
        DEEPSEEK_API_KEY: "deepseek-test-value",
      },
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "too much" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    });

    const chatResponse = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-test-value",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "coding", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(chatResponse.status).toBe(402);

    const metricsResponse = await handler(new Request("http://localhost/metrics"));
    const text = await metricsResponse.text();
    expect(text).toContain(
      'gateway_chat_completions_total{model="openai/gpt-4.1-mini",provider="openai",route_mode="fallback",status="error",stream="false"} 1',
    );
    expect(text).toContain(
      'gateway_tokens_total{model="openai/gpt-4.1-mini",provider="openai",route_mode="fallback",status="error",stream="false",type="total"} 2',
    );
  });

  test("bounds dynamic request model labels in metrics", async () => {
    const config = testConfig();
    config.server.metricsEnabled = true;

    const handler = createGatewayHandler({
      config,
      env: {
        GATEWAY_API_KEY: "gateway-test-value",
        OPENAI_API_KEY: "provider-test-value",
        DEEPSEEK_API_KEY: "deepseek-test-value",
      },
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    });

    const chatResponse = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-test-value",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/customer-sensitive-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(chatResponse.status).toBe(200);

    const metricsResponse = await handler(new Request("http://localhost/metrics"));
    const text = await metricsResponse.text();
    expect(text).toContain('model="openai/dynamic"');
    expect(text).not.toContain("customer-sensitive-model");
  });

  test("records chat and route errors when route resolution fails", async () => {
    const config = testConfig();
    config.server.metricsEnabled = true;

    const handler = createGatewayHandler({
      config,
      env: {
        GATEWAY_API_KEY: "gateway-test-value",
        OPENAI_API_KEY: "provider-test-value",
        DEEPSEEK_API_KEY: "deepseek-test-value",
      },
    });

    const chatResponse = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-test-value",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "missing", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(chatResponse.status).toBe(400);

    const metricsResponse = await handler(new Request("http://localhost/metrics"));
    const text = await metricsResponse.text();
    expect(text).toContain(
      'gateway_chat_completions_total{model="none",provider="none",route_mode="fallback",status="error",stream="false"} 1',
    );
    expect(text).toContain(
      'gateway_route_decisions_total{model="none",provider="none",route_mode="fallback",status="error",stream="false"} 1',
    );
  });

  test("keeps metrics scrapes successful when budget state collection fails", async () => {
    const config = testConfig();
    config.server.metricsEnabled = true;
    config.budgets = [
      {
        id: "daily-without-ledger",
        window: "daily",
        mode: "hard",
        maxTotalTokens: 100,
      },
    ];

    const handler = createGatewayHandler({ config, env: {} });
    const response = await handler(new Request("http://localhost/metrics"));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("# EOF");
    expect(text).toContain(
      'gateway_metrics_scrape_errors_total{code="budget_ledger_missing",section="budgets"} 1',
    );
  });

  test("rejects missing gateway auth on v1 routes", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(new Request("http://localhost/v1/models"));
    expect(response.status).toBe(401);
    expect((await response.json()).error.type).toBe("gateway_auth_error");
  });

  test("serves models with auth", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer gateway" },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.some((model: { id: string }) => model.id === "coding")).toBe(true);
  });

  test("handles non-streaming chat", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    });
    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "coding", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.object).toBe("chat.completion");
    expect(body.gateway.provider).toBe("openai");
  });
});
