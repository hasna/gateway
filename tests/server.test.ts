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
});
