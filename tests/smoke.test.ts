import { describe, expect, test } from "bun:test";
import { runAvailableProviderSmokeChecks } from "../src/smoke";
import { jsonResponse, testConfig } from "./helpers";

describe("live smoke helpers", () => {
  test("runs all configured providers with available keys", async () => {
    const config = testConfig();
    const seen: string[] = [];

    const suite = await runAvailableProviderSmokeChecks({
      config,
      env: {
        GATEWAY_API_KEY: "gateway",
        OPENAI_API_KEY: "openai",
      },
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).model);
        return jsonResponse({
          id: "smoke-ok",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    expect(suite.passed).toBe(1);
    expect(suite.failed).toBe(0);
    expect(suite.skipped).toBe(1);
    expect(seen).toEqual(["gpt-4.1-mini"]);
  });

  test("redacts provider failures in all-provider smoke", async () => {
    const config = testConfig();
    const suite = await runAvailableProviderSmokeChecks({
      config,
      env: {
        GATEWAY_API_KEY: "gateway",
        OPENAI_API_KEY: "openai",
      },
      fetchImpl: async () =>
        jsonResponse({ error: { message: "bad key sk-proj-secret-value-123456" } }, 401),
    });

    expect(suite.failed).toBe(1);
    expect(suite.results[0]?.message).toContain("[redacted-api-key]");
    expect(suite.results[0]?.message).not.toContain("sk-proj");
  });

  test("uses diagnostic routes for providers blocked by default policy", async () => {
    const config = testConfig();
    const seen: string[] = [];

    const suite = await runAvailableProviderSmokeChecks({
      config,
      env: {
        GATEWAY_API_KEY: "gateway",
        OPENAI_API_KEY: "openai",
        DEEPSEEK_API_KEY: "deepseek",
      },
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).model);
        return jsonResponse({
          id: "smoke-ok",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    expect(suite.passed).toBe(2);
    expect(seen).toEqual(["gpt-4.1-mini", "deepseek-v4-pro"]);
  });
});
