import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  interpolateEnvPlaceholders,
  loadGatewayConfig,
  validateConfig,
  validateRuntimeSecrets,
} from "../src/config";
import { GatewayHttpError } from "../src/errors";
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

  test("accepts auth-header provider credentials in production-cloud mode", () => {
    const config = testConfig();
    config.runtime = {
      mode: "production-cloud",
      serviceDiscovery: {
        allowLocalProviderEndpoints: false,
        allowedProviderBaseUrls: ["https://api.portkey.test"],
      },
      health: {
        requireRuntimeSecrets: true,
      },
    };
    config.server.host = "0.0.0.0";
    config.providers = [
      {
        id: "portkey",
        displayName: "Portkey AI Gateway",
        kind: "openai-compatible",
        baseUrl: "https://api.portkey.test/v1",
        auth: {
          type: "header",
          apiKeyEnv: "PORTKEY_API_KEY",
          headerName: "x-portkey-api-key",
          prefix: "",
        },
        enabled: true,
        regions: ["global"],
        dataPolicy: { allowTraining: false, allowLogging: true, byokOnly: true },
      },
    ];
    config.models = [
      {
        id: "portkey/gpt",
        providerId: "portkey",
        providerModel: "openai/gpt-4.1-mini",
        capabilities: ["chat"],
      },
    ];
    config.routes = [
      {
        id: "portkey-coding",
        mode: "fallback",
        modelAliases: ["portkey-coding"],
        fallbackModelIds: ["portkey/gpt"],
        dataPolicy: { allowTraining: false, allowLogging: true, allowedRegions: ["global"] },
      },
    ];

    const result = validateConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Credential lives in auth.apiKeyEnv, not top-level apiKeyEnv; must not be rejected.
      expect(result.config.providers[0]?.auth?.apiKeyEnv).toBe("PORTKEY_API_KEY");
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

  test("rejects invalid provider and model identifiers", () => {
    const badProvider = validateConfig({
      providers: [{ id: "x", displayName: "X", kind: "openai-compatible", apiKeyEnv: "K" }],
      models: [{ id: "m", providerId: "x", providerModel: "m", capabilities: ["chat"] }],
    });
    expect(badProvider.ok).toBe(false);
    if (!badProvider.ok) {
      expect(badProvider.errors.join("\n")).toContain("must define baseUrl");
    }

    const badModel = validateConfig({
      providers: [{ id: "x", displayName: "X", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" }],
      models: [{ id: "m", providerId: "missing", providerModel: "m", capabilities: ["chat"] }],
    });
    expect(badModel.ok).toBe(false);
    if (!badModel.ok) {
      expect(badModel.errors.join("\n")).toContain("unknown provider");
    }
  });

  test("rejects duplicate budget ids", () => {
    const config = testConfig();
    config.storage.usageLedgerPath = "/tmp/ledger.jsonl";
    config.budgets = [
      { id: "dup", window: "daily", mode: "hard", maxTotalTokens: 10 },
      { id: "dup", window: "daily", mode: "hard", maxTotalTokens: 20 },
    ];
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("duplicated");
    }
  });

  test("rejects empty providers and models", () => {
    const emptyProviders = validateConfig({ providers: [], models: [{ id: "x", providerId: "y", providerModel: "z", capabilities: ["chat"] }] });
    expect(emptyProviders.ok).toBe(false);
    const emptyModels = validateConfig({
      providers: [
        {
          id: "local",
          displayName: "Local",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:9999/v1",
          apiKeyEnv: "LOCAL_KEY",
        },
      ],
      models: [],
    });
    expect(emptyModels.ok).toBe(false);
  });

  test("rejects budgets without any limits", () => {
    const config = testConfig();
    config.budgets = [{ id: "empty", window: "per-request", mode: "hard" }];
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("must define at least one");
    }
  });

  test("rejects unknown providers in route allowlists and blocklists", () => {
    const config = testConfig();
    config.routes[0] = {
      ...config.routes[0]!,
      providerAllowlist: ["missing-provider"],
      providerBlocklist: ["also-missing"],
    };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("allowlists unknown provider");
      expect(result.errors.join("\n")).toContain("blocks unknown provider");
    }
  });

  test("rejects models without capabilities", () => {
    const config = testConfig();
    config.models[0] = { ...config.models[0]!, capabilities: [] };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("capabilities");
    }
  });

  test("loads gateway config from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-config-"));
    const path = join(dir, "gateway.config.json");
    writeFileSync(path, JSON.stringify(testConfig()));
    const config = await loadGatewayConfig(path);
    expect(config.providers.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws config_not_found for missing files", async () => {
    await expect(loadGatewayConfig("/tmp/does-not-exist-gateway-config.json")).rejects.toMatchObject({
      code: "config_not_found",
    });
  });

  test("throws config_invalid_json for malformed files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-config-"));
    const path = join(dir, "gateway.config.json");
    writeFileSync(path, "{not-json");
    await expect(loadGatewayConfig(path)).rejects.toMatchObject({ code: "config_invalid_json" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws config_invalid for non-object JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-config-"));
    const path = join(dir, "gateway.config.json");
    writeFileSync(path, JSON.stringify(["not", "object"]));
    await expect(loadGatewayConfig(path)).rejects.toMatchObject({ code: "config_invalid" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws config_env_missing for unresolved placeholders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-config-"));
    const path = join(dir, "gateway.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: [
          {
            id: "local",
            displayName: "Local",
            kind: "openai-compatible",
            baseUrl: "${MISSING_URL}",
            apiKeyEnv: "LOCAL_KEY",
          },
        ],
        models: [{ id: "local/test", providerId: "local", providerModel: "test", capabilities: ["chat"] }],
      }),
    );
    await expect(loadGatewayConfig(path)).rejects.toMatchObject({ code: "config_env_missing" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("validates runtime secrets for gateway and provider keys", () => {
    const config = testConfig();
    expect(validateRuntimeSecrets(config, {})).toContain("Gateway API key env var GATEWAY_API_KEY is required.");
    expect(
      validateRuntimeSecrets(config, { GATEWAY_API_KEY: "gateway" }),
    ).toContain("At least one enabled provider must have its apiKeyEnv set in the environment.");
    expect(
      validateRuntimeSecrets(config, { GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" }),
    ).toEqual([]);
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
