import { describe, expect, test } from "bun:test";
import { createGatewayHandler } from "../src/server";
import { testConfig, jsonResponse } from "./helpers";

describe("HTTP server handler", () => {
  test("serves health without auth", async () => {
    const handler = createGatewayHandler({ config: testConfig(), env: {} });
    const response = await handler(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      runtime: {
        mode: "local",
      },
      checks: {
        runtimeSecrets: "not_required",
      },
    });
  });

  test("fails health closed when production cloud runtime secrets are missing", async () => {
    const config = testConfig();
    config.runtime = {
      mode: "production-cloud",
      serviceDiscovery: {
        allowLocalProviderEndpoints: false,
      },
      health: {
        requireRuntimeSecrets: true,
      },
    };
    config.server.host = "0.0.0.0";

    const handler = createGatewayHandler({ config, env: {} });
    const response = await handler(new Request("http://localhost/health"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "unhealthy",
      runtime: {
        mode: "production-cloud",
      },
      checks: {
        runtimeSecrets: "failed",
      },
    });
    expect(JSON.stringify(body)).not.toContain("GATEWAY_API_KEY");
    expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY");
  });

  test("serves healthy production cloud health when runtime secrets are present", async () => {
    const config = testConfig();
    config.runtime = {
      mode: "production-cloud",
      serviceDiscovery: {
        allowLocalProviderEndpoints: false,
      },
      health: {
        requireRuntimeSecrets: true,
      },
    };
    config.server.host = "0.0.0.0";

    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      runtime: {
        mode: "production-cloud",
      },
      checks: {
        runtimeSecrets: "ok",
      },
    });
  });

  test("fails production cloud health when keyed providers cannot satisfy every configured route", async () => {
    const config = testConfig();
    config.runtime = {
      mode: "production-cloud",
      serviceDiscovery: {
        allowLocalProviderEndpoints: false,
      },
      health: {
        requireRuntimeSecrets: true,
      },
    };
    config.server.host = "0.0.0.0";

    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", DEEPSEEK_API_KEY: "deepseek" },
    });
    const response = await handler(new Request("http://localhost/health"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "unhealthy",
      runtime: {
        mode: "production-cloud",
      },
      checks: {
        runtimeSecrets: "failed",
      },
    });
    expect(JSON.stringify(body)).not.toContain("DEEPSEEK_API_KEY");
  });

  test("serves version without auth", async () => {
    const handler = createGatewayHandler({ config: testConfig(), env: {} });
    const response = await handler(new Request("http://localhost/version"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.name).toBe("@hasna/gateway");
    expect(body.version).toBeString();
  });

  test("serves authenticated readiness and fails closed without provider secrets", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway" },
    });
    const response = await handler(
      new Request("http://localhost/ready", {
        headers: { authorization: "Bearer gateway" },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(body)).not.toContain("openai");
    expect(body.errors.some((error: { message: string }) => error.message.includes("provider"))).toBe(true);
  });

  test("serves authenticated readiness when runtime secrets are present", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/ready", {
        headers: { authorization: "Bearer gateway" },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.checks.some((check: { id: string; status: string }) => check.id === "gateway-auth" && check.status === "passed")).toBe(true);
  });

  test("denies readiness without gateway auth", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(new Request("http://localhost/ready"));
    expect(response.status).toBe(401);
  });

  test("allowlists browser CORS origins", async () => {
    const config = testConfig();
    config.server.corsAllowedOrigins = ["https://app.example.test"];
    const handler = createGatewayHandler({ config, env: {} });
    const allowed = await handler(
      new Request("http://localhost/health", {
        headers: { origin: "https://app.example.test" },
      }),
    );
    const denied = await handler(
      new Request("http://localhost/health", {
        headers: { origin: "https://evil.example.test" },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("cors_origin_denied");
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
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
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

  test("fails closed when a token-limited non-streaming response omits required usage", async () => {
    const config = testConfig();
    config.server.rateLimits = { perGatewayKey: { tokensPerMinute: 3 } };
    let providerCalls = 0;
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        });
      },
    });

    const response = await handler(chatRequest("gateway"));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.type).toBe("gateway_rate_limit_error");
    expect(body.error.code).toBe("gateway_token_usage_missing");
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

  test("honors response cache bypass header", async () => {
    const config = testConfig();
    config.server.responseCache = {
      ...config.server.responseCache,
      enabled: true,
      ttlMs: 60_000,
    };
    let callCount = 0;
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse({
          id: `provider-${callCount}`,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `ok-${callCount}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const body = JSON.stringify({ model: "coding", messages: [{ role: "user", content: "hi" }] });

    const cachedResponse = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body,
      }),
    );
    const bypassResponse = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
          "x-gateway-cache-bypass": "true",
        },
        body,
      }),
    );
    const cachedAgainResponse = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body,
      }),
    );

    expect(cachedResponse.status).toBe(200);
    expect(bypassResponse.status).toBe(200);
    expect(cachedAgainResponse.status).toBe(200);
    expect((await cachedResponse.json()).id).toBe("provider-1");
    expect((await bypassResponse.json()).id).toBe("provider-2");
    expect((await cachedAgainResponse.json()).id).toBe("provider-2");
    expect(callCount).toBe(2);
  });

  test("does not cache streaming chat responses", async () => {
    const config = testConfig();
    config.server.responseCache = {
      ...config.server.responseCache,
      enabled: true,
      ttlMs: 60_000,
    };
    let callCount = 0;
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => {
        callCount += 1;
        return new Response(
          `data: {"id":"chunk-${callCount}","object":"chat.completion.chunk","choices":[]}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer gateway",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "coding", stream: true, messages: [{ role: "user", content: "hi" }] }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`chunk-${index + 1}`);
    }

    expect(callCount).toBe(2);
  });

  test("responds to OPTIONS with CORS headers", async () => {
    const config = testConfig();
    config.server.corsAllowedOrigins = ["https://app.example.test"];
    const handler = createGatewayHandler({ config, env: {} });
    const response = await handler(
      new Request("http://localhost/v1/models", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.test" },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("returns 404 for unknown endpoints", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/v1/unknown", {
        headers: { authorization: "Bearer gateway" },
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  test("returns gateway_key_missing when auth is required but env is unset", async () => {
    const handler = createGatewayHandler({ config: testConfig(), env: {} });
    const response = await handler(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer gateway" },
      }),
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("gateway_key_missing");
  });

  test("rejects oversized body via content-length header", async () => {
    const config = testConfig();
    config.server.maxRequestBodyBytes = 10;
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
          "content-length": "100",
        },
        body: JSON.stringify({ model: "coding", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("request_too_large");
  });

  test("rejects oversized body after reading bytes", async () => {
    const config = testConfig();
    config.server.maxRequestBodyBytes = 20;
    const handler = createGatewayHandler({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "coding",
          messages: [{ role: "user", content: "this body is definitely longer than twenty bytes" }],
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("request_too_large");
  });

  test("rejects invalid JSON bodies", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body: "{not-json",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  test("rejects non-object chat request bodies", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body: JSON.stringify(["not", "an", "object"]),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  test("rejects chat requests without a model", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("missing_model");
  });

  test("rejects chat requests without messages", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
    });
    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "coding", messages: [] }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("missing_messages");
  });

  test("handles streaming chat completions", async () => {
    const handler = createGatewayHandler({
      config: testConfig(),
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
    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "coding",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("data: [DONE]");
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
