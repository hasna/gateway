import { describe, expect, test } from "bun:test";
import { runAvailableProviderSmokeChecks, runLiveSmokeCheck } from "../src/smoke";
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

  test("skips disabled providers in all-provider smoke", async () => {
    const config = testConfig();
    config.providers[0] = { ...config.providers[0]!, enabled: false };
    const suite = await runAvailableProviderSmokeChecks({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
    });
    const disabled = suite.results.find((result) => result.provider === "openai");
    expect(disabled?.status).toBe("skipped");
    expect(disabled?.message).toContain("disabled");
  });

  test("skips providers without a chat model", async () => {
    const config = testConfig();
    config.models = config.models.filter((model) => model.providerId !== "openai");
    const suite = await runAvailableProviderSmokeChecks({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
    });
    const missingModel = suite.results.find((result) => result.provider === "openai");
    expect(missingModel?.status).toBe("skipped");
    expect(missingModel?.message).toContain("no configured chat model");
  });

  test("skips providers without api key env set", async () => {
    const config = testConfig();
    const suite = await runAvailableProviderSmokeChecks({
      config,
      env: { GATEWAY_API_KEY: "gateway" },
    });
    expect(suite.skipped).toBe(2);
    expect(suite.results.some((result) => result.message.includes("not set"))).toBe(true);
  });

  test("records per-provider failures in all-provider smoke", async () => {
    const config = testConfig();
    const suite = await runAvailableProviderSmokeChecks({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
      fetchImpl: async () => jsonResponse({ error: { message: "provider down" } }, 503),
    });
    expect(suite.failed).toBe(1);
    expect(suite.results[0]?.status).toBe("failed");
  });

  test("passes live smoke check when routing and provider succeed", async () => {
    const result = await runLiveSmokeCheck({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () =>
        jsonResponse({
          id: "live-ok",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    });
    expect(result.status).toBe("passed");
    expect(result.provider).toBe("openai");
  });

  test("skips live smoke check when routing fails", async () => {
    const result = await runLiveSmokeCheck({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway" },
    });
    expect(result.status).toBe("skipped");
  });

  test("fails live smoke check when provider call throws", async () => {
    const result = await runLiveSmokeCheck({
      config: testConfig(),
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      fetchImpl: async () => jsonResponse({ error: { message: "unauthorized" } }, 401),
    });
    expect(result.status).toBe("failed");
    expect(result.provider).toBe("openai");
  });

  test("skips live smoke check when no candidate is available", async () => {
    const config = testConfig();
    config.routes = [];
    config.models = [];
    const result = await runLiveSmokeCheck({
      config,
      env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
      model: "nonexistent-alias",
    });
    expect(result.status).toBe("skipped");
  });
});
