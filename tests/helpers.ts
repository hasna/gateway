import { normalizeConfig } from "../src/config";
import type { GatewayConfig } from "../src/types";

export function testConfig(): GatewayConfig {
  return normalizeConfig({
    server: {
      host: "127.0.0.1",
      port: 8787,
      requestTimeoutMs: 5000,
      maxRequestBodyBytes: 100000,
      includeGatewayMetadata: true,
      maxFallbackAttempts: 3,
    },
    auth: {
      apiKeyEnv: "GATEWAY_API_KEY",
      required: true,
    },
    policy: {
      allowTraining: false,
      allowChineseProviders: false,
      blockedRegions: ["cn"],
    },
    providers: [
      {
        id: "openai",
        displayName: "OpenAI",
        kind: "openai-compatible",
        baseUrl: "https://api.openai.test/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        enabled: true,
        regions: ["us"],
        dataPolicy: {
          allowTraining: false,
          allowLogging: false,
          byokOnly: true,
          zeroDataRetentionAvailable: false,
        },
      },
      {
        id: "deepseek",
        displayName: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.test",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        enabled: true,
        regions: ["cn"],
        dataPolicy: {
          allowTraining: false,
          allowLogging: true,
          byokOnly: true,
          zeroDataRetentionAvailable: false,
        },
      },
    ],
    models: [
      {
        id: "openai/gpt-4.1-mini",
        providerId: "openai",
        providerModel: "gpt-4.1-mini",
        aliases: ["coding", "fast"],
        capabilities: ["chat", "streaming", "tools", "json"],
        inputUsdPerMillionTokens: 0.4,
        outputUsdPerMillionTokens: 1.6,
      },
      {
        id: "deepseek/deepseek-v4-pro",
        providerId: "deepseek",
        providerModel: "deepseek-v4-pro",
        aliases: ["coding", "china-coding"],
        capabilities: ["chat", "streaming", "tools"],
      },
    ],
    routes: [
      {
        id: "coding",
        mode: "fallback",
        modelAliases: ["coding"],
        fallbackModelIds: ["deepseek/deepseek-v4-pro", "openai/gpt-4.1-mini"],
        dataPolicy: {
          allowTraining: false,
          allowChineseProviders: false,
          blockedRegions: ["cn"],
        },
      },
      {
        id: "china-coding",
        mode: "fallback",
        modelAliases: ["china-coding"],
        fallbackModelIds: ["deepseek/deepseek-v4-pro", "openai/gpt-4.1-mini"],
        dataPolicy: {
          allowTraining: false,
          allowChineseProviders: true,
          allowLogging: true,
          allowedRegions: ["cn", "us"],
        },
      },
    ],
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
