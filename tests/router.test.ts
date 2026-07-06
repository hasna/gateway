import { describe, expect, test } from "bun:test";
import { GatewayHttpError } from "../src/errors";
import { resolveRoute } from "../src/router";
import { testConfig } from "./helpers";

const request = {
  model: "coding",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("routing policy", () => {
  test("skips Chinese providers unless explicitly allowed", () => {
    const result = resolveRoute(
      {
        config: testConfig(),
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
          DEEPSEEK_API_KEY: "deepseek",
        },
      },
      request,
    );

    expect(result.decision.selected).toBe("openai/gpt-4.1-mini");
    expect(result.decision.attempts[0]?.status).toBe("skipped");
    expect(result.decision.attempts[0]?.reason).toContain("china provider");
  });

  test("allows Chinese providers when route policy opts in", () => {
    const result = resolveRoute(
      {
        config: testConfig(),
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
          DEEPSEEK_API_KEY: "deepseek",
        },
      },
      {
        ...request,
        model: "china-coding",
      },
    );

    expect(result.decision.selected).toBe("deepseek/deepseek-v4-pro");
  });

  test("does not let request policy expand operator policy by default", () => {
    expect(() =>
      resolveRoute(
        {
          config: testConfig(),
          env: {
            GATEWAY_API_KEY: "gateway",
            DEEPSEEK_API_KEY: "deepseek",
          },
        },
        {
          ...request,
          model: "deepseek/deepseek-v4-pro",
          gateway: {
            allow_chinese_providers: true,
            allow_logging: true,
            allowed_regions: ["cn"],
          },
        },
      ),
    ).toThrow(GatewayHttpError);
  });

  test("can opt into request policy expansion for self-hosted diagnostics", () => {
    const config = testConfig();
    config.policy.allowRequestPolicyExpansion = true;

    const result = resolveRoute(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          DEEPSEEK_API_KEY: "deepseek",
        },
      },
      {
        ...request,
        model: "deepseek/deepseek-v4-pro",
        gateway: {
          allow_chinese_providers: true,
          allow_logging: true,
          allowed_regions: ["cn"],
        },
      },
    );

    expect(result.decision.selected).toBe("deepseek/deepseek-v4-pro");
  });

  test("treats unknown price as not cheapest", () => {
    const config = testConfig();
    config.routes[0] = {
      ...config.routes[0]!,
      mode: "cheapest",
      dataPolicy: {
        allowTraining: false,
        allowChineseProviders: true,
        allowLogging: true,
        allowedRegions: ["cn", "us"],
      },
    };

    const result = resolveRoute(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
          DEEPSEEK_API_KEY: "deepseek",
        },
      },
      request,
    );

    expect(result.decision.selected).toBe("openai/gpt-4.1-mini");
  });

  test("enforces BYOK-only policy before routing", () => {
    const config = testConfig();
    config.providers[0] = {
      ...config.providers[0],
      dataPolicy: {
        ...config.providers[0]!.dataPolicy,
        byokOnly: false,
      },
    };

    expect(() =>
      resolveRoute(
        {
          config,
          env: {
            GATEWAY_API_KEY: "gateway",
            OPENAI_API_KEY: "openai",
          },
        },
        {
          ...request,
          model: "openai/gpt-4.1-mini",
        },
      ),
    ).toThrow(GatewayHttpError);
  });

  test("request policy cannot weaken BYOK or ZDR requirements by default", () => {
    const config = testConfig();
    config.policy.zeroDataRetentionRequired = true;
    config.providers[0] = {
      ...config.providers[0]!,
      dataPolicy: {
        ...config.providers[0]!.dataPolicy,
        byokOnly: false,
        zeroDataRetentionAvailable: false,
      },
    };

    expect(() =>
      resolveRoute(
        {
          config,
          env: {
            GATEWAY_API_KEY: "gateway",
            OPENAI_API_KEY: "openai",
          },
        },
        {
          ...request,
          model: "openai/gpt-4.1-mini",
          gateway: {
            byok_only: false,
            zero_data_retention_required: false,
          },
        },
      ),
    ).toThrow(GatewayHttpError);
  });

  test("fails closed without provider keys", () => {
    expect(() =>
      resolveRoute(
        {
          config: testConfig(),
          env: { GATEWAY_API_KEY: "gateway" },
        },
        request,
      ),
    ).toThrow(GatewayHttpError);
  });

  test("does not advertise dynamic Anthropic routes as streaming-capable", () => {
    const config = testConfig();
    config.providers.push({
      id: "anthropic",
      displayName: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      enabled: true,
      regions: ["us"],
      dataPolicy: {
        allowTraining: false,
        allowLogging: false,
        byokOnly: true,
        zeroDataRetentionAvailable: false,
      },
    });

    expect(() =>
      resolveRoute(
        {
          config,
          env: {
            GATEWAY_API_KEY: "gateway",
            ANTHROPIC_API_KEY: "anthropic",
          },
        },
        {
          ...request,
          model: "anthropic/claude-3-5-sonnet-latest",
          stream: true,
        },
      ),
    ).toThrow("No allowed provider can satisfy model 'anthropic/claude-3-5-sonnet-latest'.");
  });

  test("fails cheapest routing when all eligible candidates are unpriced", () => {
    const config = testConfig();
    config.models = config.models.map((model) => ({
      ...model,
      inputUsdPerMillionTokens: undefined,
      outputUsdPerMillionTokens: undefined,
    }));
    config.routes[0] = {
      ...config.routes[0]!,
      mode: "cheapest",
      dataPolicy: {
        allowTraining: false,
        allowChineseProviders: true,
        allowLogging: true,
        allowedRegions: ["cn", "us"],
      },
    };

    expect(() =>
      resolveRoute(
        {
          config,
          env: {
            GATEWAY_API_KEY: "gateway",
            OPENAI_API_KEY: "openai",
            DEEPSEEK_API_KEY: "deepseek",
          },
        },
        request,
      ),
    ).toThrow(GatewayHttpError);
  });
});
