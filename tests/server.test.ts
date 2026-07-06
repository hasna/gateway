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

  test("leaves chat requests unaffected when rate limits are not configured", async () => {
    let providerCalls = 0;
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await handler(chatRequest("gateway"));
      expect(response.status).toBe(200);
    }
    expect(providerCalls).toBe(2);
  });

  test("rejects requests over the configured per-gateway-key RPM before provider fetch", async () => {
    const config = testConfig();
    config.server.rateLimits = { perGatewayKey: { requestsPerMinute: 1 } };
    let providerCalls = 0;
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    const allowed = await handler(chatRequest("gateway"));
    const rejected = await handler(chatRequest("gateway"));
    const body = await rejected.json();

    expect(allowed.status).toBe(200);
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(rejected.headers.get("access-control-allow-origin")).toBe("*");
    expect(rejected.headers.get("access-control-expose-headers")).toContain("retry-after");
    expect(body.error.type).toBe("gateway_rate_limit_error");
    expect(body.error.code).toBe("gateway_request_rate_limit");
    expect(providerCalls).toBe(1);
  });

  test("allows requests within the configured per-gateway-key RPM", async () => {
    const config = testConfig();
    config.server.rateLimits = { perGatewayKey: { requestsPerMinute: 2 } };
    let providerCalls = 0;
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    const first = await handler(chatRequest("gateway"));
    const second = await handler(chatRequest("gateway"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(providerCalls).toBe(2);
  });

  test("rejects requests after configured per-gateway-key TPM is exhausted", async () => {
    const config = testConfig();
    config.server.rateLimits = { perGatewayKey: { tokensPerMinute: 2 } };
    let providerCalls = 0;
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    const allowed = await handler(chatRequest("gateway"));
    const rejected = await handler(chatRequest("gateway"));
    const body = await rejected.json();

    expect(allowed.status).toBe(200);
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(body.error.type).toBe("gateway_rate_limit_error");
    expect(body.error.code).toBe("gateway_token_rate_limit");
    expect(providerCalls).toBe(1);
  });

  test("keeps separate per-gateway-key RPM buckets", async () => {
    const config = testConfig();
    config.auth.required = false;
    config.server.rateLimits = { perGatewayKey: { requestsPerMinute: 1 } };
    let providerCalls = 0;
    const handler = createGatewayHandler({
      config,
      env: { OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    expect((await handler(chatRequest("gateway-a"))).status).toBe(200);
    expect((await handler(chatRequest("gateway-a"))).status).toBe(429);
    expect((await handler(chatRequest("gateway-b"))).status).toBe(200);
    expect(providerCalls).toBe(2);
  });

  test("accounts streaming usage for per-gateway-key TPM enforcement", async () => {
    const config = testConfig();
    config.server.rateLimits = { perGatewayKey: { tokensPerMinute: 3 } };
    let providerCalls = 0;
    let providerBody: Record<string, unknown> = {};
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async (_input, init) => {
        providerCalls += 1;
        providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          [
            'data: {"id":"chunk","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}',
            'data: {"id":"chunk","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    const streamResponse = await handler(chatRequest("gateway", { stream: true }));
    expect(streamResponse.status).toBe(200);
    expect(await streamResponse.text()).toContain("data: [DONE]");
    expect(providerBody.stream_options).toEqual({ include_usage: true });

    const rejected = await handler(chatRequest("gateway"));
    expect(rejected.status).toBe(429);
    expect((await rejected.json()).error.code).toBe("gateway_token_rate_limit");
    expect(providerCalls).toBe(1);
  });

  test("fails closed when a token-limited stream omits required usage", async () => {
    const config = testConfig();
    config.server.rateLimits = { perGatewayKey: { tokensPerMinute: 3 } };
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () =>
        new Response(
          [
            'data: {"id":"chunk","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    const streamResponse = await handler(chatRequest("gateway", { stream: true }));
    const text = await streamResponse.text();

    expect(streamResponse.status).toBe(200);
    expect(text).toContain('"type":"gateway_rate_limit_error"');
    expect(text).toContain('"code":"gateway_token_usage_missing"');
  });
});

function chatRequest(token: string, overrides: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "coding",
      messages: [{ role: "user", content: "hi" }],
      ...overrides,
    }),
  });
}
