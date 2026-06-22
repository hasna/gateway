import { describe, expect, test } from "bun:test";
import { interpolateEnvPlaceholders, validateConfig, validateRuntimeSecrets } from "../src/config";
import { testConfig } from "./helpers";

describe("config validation", () => {
  test("accepts a complete config", () => {
    const result = validateConfig(testConfig());
    expect(result.ok).toBe(true);
  });

  test("rejects models with unknown providers", () => {
    const config = testConfig();
    config.models[0] = {
      ...config.models[0],
      providerId: "missing",
    };

    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("unknown provider 'missing'");
    }
  });

  test("rejects invalid config field types through schema validation", () => {
    const result = validateConfig({
      server: {
        // @ts-expect-error exercising runtime config validation
        port: "8787",
      },
      presets: ["openai"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("server.port");
    }
  });

  test("rejects cumulative budgets without a usage ledger path", () => {
    const config = testConfig();
    config.budgets = [
      {
        id: "daily",
        window: "daily",
        mode: "hard",
        maxTotalTokens: 100,
      },
    ];

    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("requires storage.usageLedgerPath");
    }
  });

  test("interpolates environment placeholders before loading validation", () => {
    const interpolated = interpolateEnvPlaceholders(
      {
        providers: [
          {
            id: "local",
            displayName: "Local",
            kind: "openai-compatible",
            baseUrl: "${LOCAL_PROVIDER_URL}",
            apiKeyEnv: "LOCAL_PROVIDER_KEY",
            regions: ["us"],
            dataPolicy: { allowTraining: false },
          },
        ],
      },
      {
        LOCAL_PROVIDER_URL: "http://127.0.0.1:9999/v1",
      },
    ) as { providers: Array<{ baseUrl: string }> };

    expect(interpolated.providers[0]?.baseUrl).toBe("http://127.0.0.1:9999/v1");
  });

  test("rejects unresolved environment placeholders", () => {
    expect(() =>
      interpolateEnvPlaceholders(
        {
          providers: [{ baseUrl: "${MISSING_PROVIDER_URL}" }],
        },
        {},
      ),
    ).toThrow("Missing environment variable MISSING_PROVIDER_URL");
  });

  test("expands presets", () => {
    const result = validateConfig({ presets: ["openai", "deepseek"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers.map((provider) => provider.id)).toContain("openai");
      expect(result.config.providers.map((provider) => provider.id)).toContain("deepseek");
      expect(result.config.models.some((model) => model.providerId === "deepseek")).toBe(true);
    }
  });

  test("rejects unknown presets", () => {
    const result = validateConfig({ presets: ["openai", "typo-provider"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("Unknown preset 'typo-provider'");
    }
  });

  test("strips hosted-only provider policy fields from normalized config", () => {
    const runtimeProviderPolicy = {
      allowTraining: false,
      allowLogging: false,
      byokOnly: true,
      zeroDataRetentionAvailable: true,
      hostedAllowed: true,
    };

    const result = validateConfig({
      providers: [
        {
          id: "local",
          displayName: "Local",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:9999/v1",
          apiKeyEnv: "LOCAL_PROVIDER_KEY",
          dataPolicy: runtimeProviderPolicy,
        },
      ],
      models: [
        {
          id: "local/test",
          providerId: "local",
          providerModel: "test",
          capabilities: ["chat"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers[0]?.dataPolicy).not.toHaveProperty("hostedAllowed");
      expect(result.config.providers[0]?.dataPolicy?.zeroDataRetentionAvailable).toBe(true);
    }
  });

  test("accepts baseUrlEnv, custom auth, and env-derived provider headers", () => {
    const result = validateConfig({
      providers: [
        {
          id: "portkey",
          displayName: "Portkey",
          kind: "openai-compatible",
          baseUrlEnv: "PORTKEY_BASE_URL",
          auth: {
            type: "header",
            apiKeyEnv: "PORTKEY_API_KEY",
            headerName: "x-portkey-api-key",
            prefix: "",
          },
          headers: {
            "x-portkey-config": { env: "PORTKEY_CONFIG_ID" },
          },
          dataPolicy: { allowTraining: false, allowLogging: true, byokOnly: true },
        },
      ],
      models: [
        {
          id: "portkey/test",
          providerId: "portkey",
          providerModel: "openai/gpt-4.1-mini",
          capabilities: ["chat"],
          qualityScore: 0.8,
          averageLatencyMs: 1000,
          successRate: 0.99,
          throughputTokensPerSecond: 80,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers[0]?.baseUrlEnv).toBe("PORTKEY_BASE_URL");
      expect(result.config.providers[0]?.auth?.apiKeyEnv).toBe("PORTKEY_API_KEY");
      expect(result.config.models[0]?.qualityScore).toBe(0.8);
    }
  });

  test("runtime secret validation uses auth.apiKeyEnv", () => {
    const result = validateConfig({
      auth: {
        apiKeyEnv: "GATEWAY_API_KEY",
        required: true,
      },
      providers: [
        {
          id: "custom",
          displayName: "Custom",
          kind: "openai-compatible",
          baseUrl: "https://custom.test/v1",
          auth: {
            type: "header",
            apiKeyEnv: "CUSTOM_PROVIDER_KEY",
            headerName: "x-api-key",
          },
          dataPolicy: { allowTraining: false, byokOnly: true },
        },
      ],
      models: [
        {
          id: "custom/test",
          providerId: "custom",
          providerModel: "test",
          capabilities: ["chat"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateRuntimeSecrets(result.config, { GATEWAY_API_KEY: "gateway" })).toContain(
        "At least one enabled provider must have its apiKeyEnv set in the environment.",
      );
      expect(
        validateRuntimeSecrets(result.config, {
          GATEWAY_API_KEY: "gateway",
          CUSTOM_PROVIDER_KEY: "provider",
        }),
      ).toEqual([]);
    }
  });
});
