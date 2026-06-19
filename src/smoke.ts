import { createChatCompletion } from "./gateway";
import { redactSensitiveText } from "./errors";
import { isChinaProvider } from "./presets";
import { resolveRoute } from "./router";
import type {
  GatewayConfig,
  GatewayFetch,
  GatewayModelConfig,
  GatewayProviderConfig,
  GatewayRoutePolicy,
  OpenAIChatCompletionRequest,
} from "./types";

export type SmokeResult = {
  status: "passed" | "skipped" | "failed";
  provider?: string;
  model?: string;
  message: string;
};

export type SmokeSuiteResult = {
  results: SmokeResult[];
  passed: number;
  failed: number;
  skipped: number;
};

function safeMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function firstChatModelForProvider(config: GatewayConfig, provider: GatewayProviderConfig): GatewayModelConfig | undefined {
  return config.models.find(
    (model) => model.providerId === provider.id && model.capabilities.includes("chat"),
  );
}

function smokeGatewayPolicyFor(provider: GatewayProviderConfig): NonNullable<OpenAIChatCompletionRequest["gateway"]> {
  return {
    include_gateway_metadata: true,
    strict_openai_compatibility: false,
    allow_chinese_providers: isChinaProvider(provider),
    allow_logging: provider.dataPolicy?.allowLogging ?? false,
    byok_only: true,
    ...(provider.regions?.length ? { allowed_regions: provider.regions } : {}),
  };
}

function smokeRouteFor(provider: GatewayProviderConfig, model: GatewayModelConfig): GatewayRoutePolicy {
  return {
    id: `__smoke__${provider.id}`,
    mode: "fallback",
    modelAliases: [`__smoke__${provider.id}`],
    fallbackModelIds: [model.id],
    dataPolicy: {
      allowTraining: provider.dataPolicy?.allowTraining ?? false,
      allowLogging: provider.dataPolicy?.allowLogging ?? false,
      allowChineseProviders: isChinaProvider(provider),
      byokOnly: true,
      ...(provider.regions?.length ? { allowedRegions: provider.regions } : {}),
    },
  };
}

function configWithSmokeRoute(
  config: GatewayConfig,
  provider: GatewayProviderConfig,
  model: GatewayModelConfig,
): GatewayConfig {
  return {
    ...config,
    routes: [...config.routes, smokeRouteFor(provider, model)],
  };
}

export async function runLiveSmokeCheck(input: {
  config: GatewayConfig;
  env?: Record<string, string | undefined>;
  model?: string;
  prompt?: string;
  fetchImpl?: GatewayFetch;
}): Promise<SmokeResult> {
  const env = input.env ?? process.env;
  const request: OpenAIChatCompletionRequest = {
    model: input.model ?? "fast",
    messages: [
      {
        role: "user",
        content: input.prompt ?? "Reply with exactly: hasna-gateway-ok",
      },
    ],
    max_tokens: 16,
    gateway: {
      include_gateway_metadata: true,
      strict_openai_compatibility: false,
    },
  };

  let route;
  try {
    route = resolveRoute({ config: input.config, env, fetchImpl: input.fetchImpl }, request);
  } catch (error) {
    return {
      status: "skipped",
      message: error instanceof Error ? error.message : "No live provider route is available.",
    };
  }

  const candidate = route.candidates[0];
  if (!candidate) {
    return {
      status: "skipped",
      message: "No live provider route is available.",
    };
  }

  try {
    const completion = await createChatCompletion(
      { config: input.config, env, fetchImpl: input.fetchImpl },
      request,
    );
    return {
      status: "passed",
      provider: candidate.provider.id,
      model: candidate.model.id,
      message: `Live smoke check passed with provider ${candidate.provider.id} and model ${candidate.model.id}. Response id: ${String(completion.body.id)}`,
    };
  } catch (error) {
    return {
      status: "failed",
      provider: candidate.provider.id,
      model: candidate.model.id,
      message: safeMessage(error),
    };
  }
}

export async function runAvailableProviderSmokeChecks(input: {
  config: GatewayConfig;
  env?: Record<string, string | undefined>;
  prompt?: string;
  fetchImpl?: GatewayFetch;
}): Promise<SmokeSuiteResult> {
  const env = input.env ?? process.env;
  const results: SmokeResult[] = [];

  for (const provider of input.config.providers) {
    if (provider.enabled === false) {
      results.push({
        status: "skipped",
        provider: provider.id,
        message: `Provider ${provider.id} is disabled.`,
      });
      continue;
    }

    if (!provider.apiKeyEnv || !env[provider.apiKeyEnv]) {
      results.push({
        status: "skipped",
        provider: provider.id,
        message: `Provider ${provider.id} skipped because ${provider.apiKeyEnv ?? "apiKeyEnv"} is not set.`,
      });
      continue;
    }

    const model = firstChatModelForProvider(input.config, provider);
    if (!model) {
      results.push({
        status: "skipped",
        provider: provider.id,
        message: `Provider ${provider.id} has no configured chat model.`,
      });
      continue;
    }

    try {
      const completion = await createChatCompletion(
        { config: configWithSmokeRoute(input.config, provider, model), env, fetchImpl: input.fetchImpl },
        {
          model: `__smoke__${provider.id}`,
          messages: [
            {
              role: "user",
              content: input.prompt ?? "Reply with exactly: hasna-gateway-ok",
            },
          ],
          max_tokens: 16,
          gateway: smokeGatewayPolicyFor(provider),
        },
      );
      results.push({
        status: "passed",
        provider: provider.id,
        model: model.id,
        message: `Provider ${provider.id} passed with model ${model.id}. Response id: ${String(completion.body.id)}`,
      });
    } catch (error) {
      results.push({
        status: "failed",
        provider: provider.id,
        model: model.id,
        message: `Provider ${provider.id} failed with model ${model.id}: ${safeMessage(error)}`,
      });
    }
  }

  return {
    results,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
}
