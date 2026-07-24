import { describe, expect, test } from "bun:test";
import { interpolateEnvPlaceholders, validateConfig } from "../src/config";
import { testConfig } from "./helpers";

describe("config validation", () => {
  test("accepts a complete config", () => {
    const result = validateConfig(testConfig());
    expect(result.ok).toBe(true);
  });

  test("defaults to local runtime mode", () => {
    const result = validateConfig(testConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.runtime).toEqual({
        mode: "local",
        serviceDiscovery: {
          allowLocalProviderEndpoints: true,
        },
        health: {
          requireRuntimeSecrets: false,
        },
      });
    }
  });

  test("accepts explicit production cloud runtime boundaries", () => {
    const config = testConfig();
    config.runtime = {
      mode: "production-cloud",
      serviceDiscovery: {
        allowLocalProviderEndpoints: false,
        allowedProviderBaseUrls: ["https://api.openai.test", "https://api.deepseek.test"],
      },
      health: {
        requireRuntimeSecrets: true,
      },
    };
    config.server.host = "0.0.0.0";

    const result = validateConfig(config);
    expect(result.ok).toBe(true);
  });

  test("rejects production cloud runtime without fail-closed auth and health", () => {
    const config = testConfig();
    config.runtime = {
      mode: "production-cloud",
      serviceDiscovery: {
        allowLocalProviderEndpoints: false,
      },
      health: {
        requireRuntimeSecrets: false,
      },
    };
    config.auth.required = false;

    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.errors.join("\n");
      expect(errors).toContain("production-cloud runtime requires auth.required to be true");
      expect(errors).toContain("production-cloud runtime requires server.host to bind a non-loopback interface");
      expect(errors).toContain("production-cloud runtime requires runtime.health.requireRuntimeSecrets to be true");
    }
  });

  test("rejects unsafe production cloud provider discovery", () => {
    const config = testConfig();
    config.runtime = {
      mode: "production-cloud",
      serviceDiscovery: {
        allowLocalProviderEndpoints: false,
        allowedProviderBaseUrls: ["https://api.deepseek.test"],
      },
      health: {
        requireRuntimeSecrets: true,
      },
    };
    config.server.host = "0.0.0.0";
    config.providers[0] = {
      ...config.providers[0],
      baseUrl: "http://127.0.0.1:9999/v1",
    };

    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.errors.join("\n");
      expect(errors).toContain("provider openai baseUrl origin http://127.0.0.1:9999 is not in runtime.serviceDiscovery.allowedProviderBaseUrls");
      expect(errors).toContain("provider openai baseUrl must not resolve to a local or private endpoint in production-cloud mode");
      expect(errors).toContain("provider openai baseUrl must use https in production-cloud mode");
    }
  });

  test("rejects production cloud IPv6 local and private provider endpoints", () => {
    for (const baseUrl of ["https://[::1]/v1", "https://[fd00::1]/v1", "https://[fe80::1]/v1", "https://[::ffff:127.0.0.1]/v1"]) {
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
      config.providers[0] = {
        ...config.providers[0],
        baseUrl,
      };

      const result = validateConfig(config);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join("\n")).toContain("provider openai baseUrl must not resolve to a local or private endpoint in production-cloud mode");
      }
    }
  });

  test("rejects public http provider endpoints even when allowlisted", () => {
    const config = testConfig();
    config.runtime = {
      mode: "production-cloud",
      serviceDiscovery: {
        allowLocalProviderEndpoints: true,
        allowedProviderBaseUrls: ["http://public.example.com", "https://api.deepseek.test"],
      },
      health: {
        requireRuntimeSecrets: true,
      },
    };
    config.server.host = "0.0.0.0";
    config.providers[0] = {
      ...config.providers[0],
      baseUrl: "http://public.example.com/v1",
    };

    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("provider openai baseUrl must use https in production-cloud mode");
    }
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

  test("rejects cumulative budgets without a usage ledger backend", () => {
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
      expect(result.errors.join("\n")).toContain("requires a usage ledger backend");
    }
  });

  test("accepts cumulative budgets with a cloud sqlite ledger backend", () => {
    const config = testConfig();
    config.storage.cloud = {
      backend: "sqlite",
      sqlitePath: `/tmp/hasna-gateway-config-${crypto.randomUUID()}.sqlite`,
    };
    config.budgets = [
      {
        id: "daily",
        window: "daily",
        mode: "hard",
        maxTotalTokens: 100,
      },
    ];

    const result = validateConfig(config);
    expect(result.ok).toBe(true);
  });

  test("rejects postgres cloud ledger backend without a connection source", () => {
    const config = testConfig();
    config.storage.cloud = {
      backend: "postgres",
    };

    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("requires connectionString or connectionStringEnv");
    }
  });

  test("accepts optional per-gateway-key rate limits", () => {
    const config = testConfig();
    config.server.rateLimits = {
      perGatewayKey: {
        requestsPerMinute: 2,
        tokensPerMinute: 100,
      },
    };

    const result = validateConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.server.rateLimits?.perGatewayKey?.requestsPerMinute).toBe(2);
      expect(result.config.server.rateLimits?.perGatewayKey?.tokensPerMinute).toBe(100);
    }
  });

  test("rejects invalid CORS origins", () => {
    const config = testConfig();
    config.server.corsAllowedOrigins = ["*", "ftp://example.test"];

    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.errors.join("\n");
      expect(errors).toContain("server.corsAllowedOrigins.0");
      expect(errors).toContain("server.corsAllowedOrigins.1");
    }
  });

  test("rejects invalid per-gateway-key rate limit values", () => {
    const result = validateConfig({
      server: {
        rateLimits: {
          perGatewayKey: {
            requestsPerMinute: 0,
            // @ts-expect-error exercising runtime config validation
            tokensPerMinute: "100",
          },
        },
      },
      presets: ["openai"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("server.rateLimits.perGatewayKey.requestsPerMinute");
      expect(result.errors.join("\n")).toContain("server.rateLimits.perGatewayKey.tokensPerMinute");
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
    const result = validateConfig({ presets: ["openai", "google", "deepseek"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers.map((provider) => provider.id)).toContain("openai");
      expect(result.config.providers.map((provider) => provider.id)).toContain("google");
      expect(result.config.providers.map((provider) => provider.id)).toContain("deepseek");
      expect(result.config.providers.find((provider) => provider.id === "google")?.dataPolicy).toMatchObject({
        allowTraining: true,
        allowLogging: true,
        byokOnly: true,
      });
      expect(result.config.models.some((model) => model.providerId === "google")).toBe(true);
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
});
