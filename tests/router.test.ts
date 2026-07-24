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

  test("routes dynamic provider/model ids", () => {
    const result = resolveRoute(
      {
        config: testConfig(),
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" },
      },
      {
        model: "openai/gpt-4.1-mini",
        messages: [{ role: "user", content: "hi" }],
      },
    );
    expect(result.decision.selected).toBe("openai/gpt-4.1-mini");
  });

  test("skips disabled providers", () => {
    const config = testConfig();
    config.providers[0] = { ...config.providers[0]!, enabled: false };
    expect(() =>
      resolveRoute(
        {
          config,
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        },
        request,
      ),
    ).toThrow(GatewayHttpError);
  });

  test("skips blocked providers", () => {
    const config = testConfig();
    config.routes[0] = {
      ...config.routes[0]!,
      providerBlocklist: ["openai"],
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
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      },
      request,
    );
    expect(result.decision.selected).toBe("deepseek/deepseek-v4-pro");
  });

  test("skips models that do not support tools", () => {
    const config = testConfig();
    config.models = config.models.map((model) => ({
      ...model,
      capabilities: model.capabilities.filter((capability) => capability !== "tools"),
    }));
    expect(() =>
      resolveRoute(
        {
          config,
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        },
        {
          ...request,
          tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
        },
      ),
    ).toThrow(GatewayHttpError);
  });

  test("skips models that do not support streaming", () => {
    const config = testConfig();
    config.models = config.models.map((model) => ({
      ...model,
      capabilities: model.capabilities.filter((capability) => capability !== "streaming"),
    }));
    expect(() =>
      resolveRoute(
        {
          config,
          env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
        },
        { ...request, stream: true },
      ),
    ).toThrow(GatewayHttpError);
  });

  test("honors request routing mode override", () => {
    const config = testConfig();
    config.routes[0] = {
      ...config.routes[0]!,
      mode: "fallback",
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
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      },
      {
        ...request,
        gateway: { routing: "cheapest" },
      },
    );
    expect(result.decision.mode).toBe("cheapest");
  });

  test("skips models above configured price policy", () => {
    const config = testConfig();
    // Give the fallback a configured price under the ceiling so it stays eligible;
    // price ceilings are fail-closed for unpriced models under smart-routing policy.
    config.models = config.models.map((model) =>
      model.id === "deepseek/deepseek-v4-pro"
        ? { ...model, inputUsdPerMillionTokens: 0.05, outputUsdPerMillionTokens: 0.1 }
        : model,
    );
    config.routes[0] = {
      ...config.routes[0]!,
      maxInputUsdPerMillionTokens: 0.1,
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
        env: { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai", DEEPSEEK_API_KEY: "deepseek" },
      },
      request,
    );
    expect(result.decision.selected).toBe("deepseek/deepseek-v4-pro");
  });

  test("fails closed when price ceilings require an unpriced model", () => {
    const config = testConfig();
    config.routes.push({
      id: "unpriced",
      mode: "fallback",
      modelAliases: ["unpriced"],
      fallbackModelIds: ["deepseek/deepseek-v4-pro"],
      dataPolicy: {
        allowTraining: false,
        allowLogging: true,
        allowChineseProviders: true,
        allowedRegions: ["cn"],
      },
      maxInputUsdPerMillionTokens: 0,
      maxOutputUsdPerMillionTokens: 0,
    });

    expect(() =>
      resolveRoute(
        {
          config,
          env: {
            GATEWAY_API_KEY: "gateway",
            DEEPSEEK_API_KEY: "deepseek",
          },
        },
        {
          ...request,
          model: "unpriced",
        },
      ),
    ).toThrow(GatewayHttpError);
  });

  test("fails closed when required provider header env is missing", () => {
    const config = testConfig();
    config.providers[0] = {
      ...config.providers[0]!,
      headers: {
        "x-required-config": {
          env: "REQUIRED_PROVIDER_CONFIG",
          required: true,
        },
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

  test("smart routing scores eligible candidates by request priority", () => {
    const config = testConfig();
    config.models = [
      ...config.models,
      {
        id: "openai/cheap",
        providerId: "openai",
        providerModel: "cheap",
        aliases: ["smart-coding"],
        capabilities: ["chat", "streaming", "tools", "json"],
        contextWindow: 128_000,
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.2,
        qualityScore: 0.45,
        averageLatencyMs: 500,
        successRate: 0.98,
      },
      {
        id: "openai/quality",
        providerId: "openai",
        providerModel: "quality",
        aliases: ["smart-coding"],
        capabilities: ["chat", "streaming", "tools", "json", "reasoning"],
        contextWindow: 1_000_000,
        inputUsdPerMillionTokens: 5,
        outputUsdPerMillionTokens: 10,
        qualityScore: 0.95,
        averageLatencyMs: 1200,
        successRate: 0.99,
      },
    ];
    config.routes.push({
      id: "smart-coding",
      mode: "smart",
      modelAliases: ["smart-coding"],
      fallbackModelIds: ["openai/cheap", "openai/quality"],
      dataPolicy: { allowTraining: false, allowLogging: false, blockedRegions: ["cn"] },
    });

    const qualityResult = resolveRoute(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
        },
      },
      {
        ...request,
        model: "smart-coding",
        gateway: { priority: "quality" },
      },
    );
    expect(qualityResult.decision.selected).toBe("openai/quality");
    expect(qualityResult.decision.scores?.[0]?.model).toBe("openai/quality");

    const costResult = resolveRoute(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
        },
      },
      {
        ...request,
        model: "smart-coding",
        gateway: { priority: "cost" },
      },
    );
    expect(costResult.decision.selected).toBe("openai/cheap");
  });

  test("policy filtering happens before smart scoring", () => {
    const config = testConfig();
    config.models = [
      ...config.models,
      {
        id: "openai/safe",
        providerId: "openai",
        providerModel: "safe",
        aliases: ["policy-smart"],
        capabilities: ["chat", "streaming", "tools"],
        qualityScore: 0.4,
        inputUsdPerMillionTokens: 0.4,
        outputUsdPerMillionTokens: 1,
      },
      {
        id: "deepseek/high-quality",
        providerId: "deepseek",
        providerModel: "high-quality",
        aliases: ["policy-smart"],
        capabilities: ["chat", "streaming", "tools", "reasoning"],
        qualityScore: 1,
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.2,
      },
    ];
    config.routes.push({
      id: "policy-smart",
      mode: "smart",
      modelAliases: ["policy-smart"],
      fallbackModelIds: ["deepseek/high-quality", "openai/safe"],
      dataPolicy: {
        allowTraining: false,
        allowLogging: false,
        allowChineseProviders: false,
        blockedRegions: ["cn"],
      },
    });

    const result = resolveRoute(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
          DEEPSEEK_API_KEY: "deepseek",
        },
      },
      {
        ...request,
        model: "policy-smart",
        gateway: { priority: "quality" },
      },
    );

    expect(result.decision.selected).toBe("openai/safe");
    expect(result.decision.scores?.map((score) => score.model)).toEqual(["openai/safe"]);
    expect(result.decision.attempts[0]?.status).toBe("skipped");
    expect(result.decision.attempts[0]?.reason).toContain("china provider");
  });

  test("required capabilities and context fail closed", () => {
    expect(() =>
      resolveRoute(
        {
          config: testConfig(),
          env: {
            GATEWAY_API_KEY: "gateway",
            OPENAI_API_KEY: "openai",
          },
        },
        {
          ...request,
          model: "openai/gpt-4.1-mini",
          gateway: {
            required_capabilities: ["vision"],
            min_context_tokens: 2_000_000,
          },
        },
      ),
    ).toThrow(GatewayHttpError);
  });

  test("unknown smart metrics fall back to deterministic configured order", () => {
    const config = testConfig();
    config.models = [
      {
        id: "openai/first",
        providerId: "openai",
        providerModel: "first",
        aliases: ["unknown-metrics"],
        capabilities: ["chat"],
      },
      {
        id: "openai/second",
        providerId: "openai",
        providerModel: "second",
        aliases: ["unknown-metrics"],
        capabilities: ["chat"],
      },
    ];
    config.routes = [
      {
        id: "unknown-metrics",
        mode: "smart",
        modelAliases: ["unknown-metrics"],
        fallbackModelIds: ["openai/first", "openai/second"],
        dataPolicy: { allowTraining: false, allowLogging: false, blockedRegions: ["cn"] },
      },
    ];

    const result = resolveRoute(
      {
        config,
        env: {
          GATEWAY_API_KEY: "gateway",
          OPENAI_API_KEY: "openai",
        },
      },
      {
        ...request,
        model: "unknown-metrics",
      },
    );

    expect(result.decision.selected).toBe("openai/first");
    expect(result.decision.scores?.length).toBe(2);
  });
});
