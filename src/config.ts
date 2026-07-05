import { GatewayHttpError } from "./errors";
import { modelPresets, providerPresets } from "./presets";
import { resolveRoute } from "./router";
import { z } from "zod";
import type {
  GatewayAuthConfig,
  GatewayBudgetConfig,
  GatewayConfig,
  GatewayConfigInput,
  GatewayConfigValidationResult,
  GatewayDataPolicy,
  GatewayGlobalPolicy,
  GatewayStorageConfig,
  GatewayModelConfig,
  GatewayProviderConfig,
  GatewayRuntimeConfig,
  GatewayRoutePolicy,
  GatewayServerConfig,
  OpenAIChatCompletionRequest,
} from "./types";

const dataPolicySchema = z
  .object({
    allowTraining: z.boolean().optional(),
    allowLogging: z.boolean().optional(),
    allowedRegions: z.array(z.string().min(1)).optional(),
    blockedRegions: z.array(z.string().min(1)).optional(),
    allowedProviders: z.array(z.string().min(1)).optional(),
    blockedProviders: z.array(z.string().min(1)).optional(),
    zeroDataRetentionRequired: z.boolean().optional(),
    allowChineseProviders: z.boolean().optional(),
    allowRequestPolicyExpansion: z.boolean().optional(),
    byokOnly: z.boolean().optional(),
    zeroDataRetentionAvailable: z.boolean().optional(),
  })
  .passthrough();

const serverSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    requestTimeoutMs: z.number().min(1).optional(),
    maxRequestBodyBytes: z.number().min(1).optional(),
    includeGatewayMetadata: z.boolean().optional(),
    maxFallbackAttempts: z.number().int().min(1).optional(),
    corsAllowedOrigins: z.array(z.string().min(1)).optional(),
    rateLimits: z
      .object({
        perGatewayKey: z
          .object({
            requestsPerMinute: z.number().int().min(1).optional(),
            tokensPerMinute: z.number().int().min(1).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const authSchema = z
  .object({
    apiKeyEnv: z.string().min(1).optional(),
    required: z.boolean().optional(),
  })
  .passthrough();

const storageSchema = z
  .object({
    usageLedgerPath: z.string().min(1).optional(),
    cloud: z
      .discriminatedUnion("backend", [
        z.object({ backend: z.literal("sqlite"), sqlitePath: z.string().min(1) }).passthrough(),
        z
          .object({
            backend: z.literal("postgres"),
            connectionString: z.string().min(1).optional(),
            connectionStringEnv: z.string().min(1).optional(),
          })
          .passthrough(),
      ])
      .optional(),
  })
  .passthrough();

const serviceDiscoverySchema = z
  .object({
    allowLocalProviderEndpoints: z.boolean().optional(),
    allowedProviderBaseUrls: z.array(z.string().url()).optional(),
  })
  .passthrough();

const healthSchema = z
  .object({
    requireRuntimeSecrets: z.boolean().optional(),
  })
  .passthrough();

const runtimeSchema = z
  .object({
    mode: z.enum(["local", "production-cloud"]).optional(),
    serviceDiscovery: serviceDiscoverySchema.optional(),
    health: healthSchema.optional(),
  })
  .passthrough();

const budgetScopeSchema = z
  .object({
    gatewayKey: z.string().min(1).optional(),
    tenant: z.string().min(1).optional(),
    modelAlias: z.string().min(1).optional(),
  })
  .passthrough();

const budgetSchema = z
  .object({
    id: z.string().min(1),
    scope: budgetScopeSchema.optional(),
    window: z.enum(["per-request", "daily", "monthly", "lifetime"]),
    mode: z.enum(["hard", "soft"]).default("hard"),
    maxUsd: z.number().min(0).optional(),
    maxInputTokens: z.number().int().min(0).optional(),
    maxOutputTokens: z.number().int().min(0).optional(),
    maxTotalTokens: z.number().int().min(0).optional(),
    warningThreshold: z.number().min(0).max(1).optional(),
    resetAt: z.string().min(1).optional(),
  })
  .passthrough();

const providerSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    kind: z
      .enum(["openai-compatible", "openai", "anthropic", "google", "bedrock", "vertex", "openrouter"])
      .default("openai-compatible"),
    baseUrl: z.string().url().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    regions: z.array(z.string().min(1)).optional(),
    jurisdiction: z.string().min(1).optional(),
    dataPolicy: dataPolicySchema.optional(),
  })
  .passthrough();

const modelSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    providerModel: z.string().min(1),
    aliases: z.array(z.string().min(1)).optional(),
    capabilities: z
      .array(z.enum(["chat", "streaming", "tools", "json", "vision", "reasoning", "embeddings"]))
      .min(1),
    contextWindow: z.number().int().min(1).optional(),
    inputUsdPerMillionTokens: z.number().min(0).optional(),
    outputUsdPerMillionTokens: z.number().min(0).optional(),
  })
  .passthrough();

const routeSchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(["explicit", "fallback", "cheapest", "lowest-latency", "highest-throughput", "balanced"]),
    modelAliases: z.array(z.string().min(1)).optional(),
    providerAllowlist: z.array(z.string().min(1)).optional(),
    providerBlocklist: z.array(z.string().min(1)).optional(),
    maxInputUsdPerMillionTokens: z.number().min(0).optional(),
    maxOutputUsdPerMillionTokens: z.number().min(0).optional(),
    maxLatencyMs: z.number().min(1).optional(),
    fallbackModelIds: z.array(z.string().min(1)).optional(),
    dataPolicy: dataPolicySchema.optional(),
  })
  .passthrough();

const gatewayConfigInputSchema = z
  .object({
    runtime: runtimeSchema.optional(),
    server: serverSchema.optional(),
    auth: authSchema.optional(),
    storage: storageSchema.optional(),
    policy: dataPolicySchema.optional(),
    providers: z.array(providerSchema).optional(),
    models: z.array(modelSchema).optional(),
    routes: z.array(routeSchema).optional(),
    budgets: z.array(budgetSchema).optional(),
    presets: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

const defaultServer: GatewayServerConfig = {
  host: "127.0.0.1",
  port: 8787,
  requestTimeoutMs: 60_000,
  maxRequestBodyBytes: 1_000_000,
  includeGatewayMetadata: true,
  maxFallbackAttempts: 3,
  corsAllowedOrigins: ["http://127.0.0.1:8787", "http://localhost:8787"],
};

const defaultAuth: GatewayAuthConfig = {
  apiKeyEnv: "GATEWAY_API_KEY",
  required: true,
};

const defaultStorage: GatewayStorageConfig = {};

const defaultRuntime: GatewayRuntimeConfig = {
  mode: "local",
  serviceDiscovery: {
    allowLocalProviderEndpoints: true,
  },
  health: {
    requireRuntimeSecrets: false,
  },
};

const defaultPolicy: GatewayGlobalPolicy = {
  allowTraining: false,
  allowLogging: false,
  allowChineseProviders: false,
  byokOnly: true,
};

function normalizeBudget(budget: GatewayBudgetConfig): GatewayBudgetConfig {
  return {
    ...budget,
    mode: budget.mode ?? "hard",
    scope: budget.scope ?? {},
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      result.push(item);
      seen.add(item.id);
    }
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeDataPolicy(input: unknown): GatewayDataPolicy | undefined {
  if (!isObject(input)) return undefined;

  const allowedRegions = normalizeStringArray(input.allowedRegions);
  const blockedRegions = normalizeStringArray(input.blockedRegions);
  const allowedProviders = normalizeStringArray(input.allowedProviders);
  const blockedProviders = normalizeStringArray(input.blockedProviders);

  return {
    ...(typeof input.allowTraining === "boolean" ? { allowTraining: input.allowTraining } : {}),
    ...(typeof input.allowLogging === "boolean" ? { allowLogging: input.allowLogging } : {}),
    ...(allowedRegions ? { allowedRegions } : {}),
    ...(blockedRegions ? { blockedRegions } : {}),
    ...(allowedProviders ? { allowedProviders } : {}),
    ...(blockedProviders ? { blockedProviders } : {}),
    ...(typeof input.zeroDataRetentionRequired === "boolean"
      ? { zeroDataRetentionRequired: input.zeroDataRetentionRequired }
      : {}),
    ...(typeof input.allowChineseProviders === "boolean" ? { allowChineseProviders: input.allowChineseProviders } : {}),
    ...(typeof input.byokOnly === "boolean" ? { byokOnly: input.byokOnly } : {}),
  };
}

function normalizeGlobalPolicy(input: unknown): GatewayGlobalPolicy | undefined {
  const policy = normalizeDataPolicy(input);
  if (!isObject(input)) return policy;
  return {
    ...(policy ?? {}),
    ...(typeof input.allowRequestPolicyExpansion === "boolean"
      ? { allowRequestPolicyExpansion: input.allowRequestPolicyExpansion }
      : {}),
  };
}

function normalizeProviderDataPolicy(input: unknown): GatewayProviderConfig["dataPolicy"] | undefined {
  const policy = normalizeDataPolicy(input);
  if (!isObject(input)) return policy;
  return {
    ...(policy ?? {}),
    ...(typeof input.zeroDataRetentionAvailable === "boolean"
      ? { zeroDataRetentionAvailable: input.zeroDataRetentionAvailable }
      : {}),
  };
}

function formatZodIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "config";
  return `${path}: ${issue.message}`;
}

export function interpolateEnvPlaceholders(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined) {
        throw new EnvInterpolationError(`Missing environment variable ${name} required by config placeholder ${match}.`);
      }
      return replacement;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvPlaceholders(item, env));
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnvPlaceholders(item, env)]),
    );
  }

  return value;
}

export class EnvInterpolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvInterpolationError";
  }
}

function normalizeProvider(provider: GatewayProviderConfig): GatewayProviderConfig {
  return {
    ...provider,
    kind: provider.kind ?? "openai-compatible",
    enabled: provider.enabled ?? true,
    regions: provider.regions ?? [],
    dataPolicy: normalizeProviderDataPolicy(provider.dataPolicy),
  };
}

function normalizeModel(model: GatewayModelConfig): GatewayModelConfig {
  return {
    ...model,
    aliases: model.aliases ?? [],
    capabilities: model.capabilities ?? ["chat"],
  };
}

function normalizeRuntime(input: GatewayConfigInput["runtime"]): GatewayRuntimeConfig {
  const mode = input?.mode ?? defaultRuntime.mode;
  return {
    mode,
    serviceDiscovery: {
      allowLocalProviderEndpoints:
        input?.serviceDiscovery?.allowLocalProviderEndpoints ?? (mode === "production-cloud" ? false : true),
      ...(input?.serviceDiscovery?.allowedProviderBaseUrls
        ? { allowedProviderBaseUrls: input.serviceDiscovery.allowedProviderBaseUrls }
        : {}),
    },
    health: {
      requireRuntimeSecrets: input?.health?.requireRuntimeSecrets ?? mode === "production-cloud",
    },
  };
}

function withPresetExpansion(input: GatewayConfigInput): {
  providers: GatewayProviderConfig[];
  models: GatewayModelConfig[];
  unknownPresets: string[];
} {
  const presetIds = input.presets ?? [];
  const presetProviders = presetIds
    .map((id) => providerPresets[id])
    .filter((provider): provider is GatewayProviderConfig => provider !== undefined);
  const unknownPresets = presetIds.filter((id) => providerPresets[id] === undefined);
  const presetProviderIds = new Set(presetProviders.map((provider) => provider.id));
  const presetModels = modelPresets.filter((model) => presetProviderIds.has(model.providerId));

  return {
    providers: uniqueById([...(input.providers ?? []), ...presetProviders]).map(normalizeProvider),
    models: uniqueById([...(input.models ?? []), ...presetModels]).map(normalizeModel),
    unknownPresets,
  };
}

export function normalizeConfig(input: GatewayConfigInput): GatewayConfig {
  const expanded = withPresetExpansion(input);

  return {
    runtime: normalizeRuntime(input.runtime),
    server: {
      ...defaultServer,
      ...(input.server ?? {}),
    },
    auth: {
      ...defaultAuth,
      ...(input.auth ?? {}),
    },
    storage: {
      ...defaultStorage,
      ...(input.storage ?? {}),
    },
    policy: {
      ...defaultPolicy,
      ...(normalizeGlobalPolicy(input.policy) ?? input.policy ?? {}),
    },
    providers: expanded.providers,
    models: expanded.models,
    routes: input.routes ?? [],
    budgets: (input.budgets ?? []).map(normalizeBudget),
  };
}

function assertString(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function assertNumber(value: unknown, label: string, errors: string[], min?: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || (min !== undefined && value < min)) {
    errors.push(`${label} must be a number${min === undefined ? "" : ` >= ${min}`}.`);
  }
}

function assertCloudStorage(config: GatewayConfig, errors: string[]): void {
  const cloud = config.storage.cloud;
  if (!cloud) return;
  if (cloud.backend === "sqlite") {
    assertString(cloud.sqlitePath, "storage.cloud.sqlitePath", errors);
    return;
  }
  if (!cloud.connectionString && !cloud.connectionStringEnv) {
    errors.push("storage.cloud postgres backend requires connectionString or connectionStringEnv.");
  }
}

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const parsed = parts.map((part) => Number(part));
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return parsed;
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const ipv4 = parseIpv4(normalized);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.endsWith(".localhost") ||
    normalized.startsWith("::ffff:127.") ||
    ipv4?.[0] === 127
  );
}

function isPrivateProviderHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const ipv4 = parseIpv4(normalized);
  if (!ipv4 && normalized.startsWith("::ffff:")) {
    const mappedIpv4 = parseIpv4(normalized.slice("::ffff:".length));
    return mappedIpv4 ? isPrivateProviderHost(mappedIpv4.join(".")) : true;
  }
  if (!ipv4 && normalized.includes(":")) {
    const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return (
      isLoopbackHost(normalized) ||
      normalized === "::" ||
      (Number.isFinite(firstHextet) && (firstHextet & 0xfe00) === 0xfc00) ||
      (Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80)
    );
  }
  if (!ipv4) return isLoopbackHost(normalized);
  const [first = 0, second = 0] = ipv4;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function urlOrigin(value: string): string {
  return new URL(value).origin;
}

function validateProductionProviderBoundary(config: GatewayConfig, provider: GatewayProviderConfig, errors: string[]): void {
  if (provider.enabled === false || !provider.baseUrl) return;

  const discovery = config.runtime.serviceDiscovery;
  const allowedOrigins = new Set((discovery.allowedProviderBaseUrls ?? []).map(urlOrigin));
  const providerUrl = new URL(provider.baseUrl);
  const providerOrigin = providerUrl.origin;
  const explicitlyAllowed = allowedOrigins.size > 0 && allowedOrigins.has(providerOrigin);

  if (allowedOrigins.size > 0 && !explicitlyAllowed) {
    errors.push(`provider ${provider.id} baseUrl origin ${providerOrigin} is not in runtime.serviceDiscovery.allowedProviderBaseUrls.`);
  }

  if (!discovery.allowLocalProviderEndpoints && isPrivateProviderHost(providerUrl.hostname)) {
    errors.push(`provider ${provider.id} baseUrl must not resolve to a local or private endpoint in production-cloud mode.`);
  }

  if (
    providerUrl.protocol !== "https:" &&
    !(discovery.allowLocalProviderEndpoints && explicitlyAllowed && isPrivateProviderHost(providerUrl.hostname))
  ) {
    errors.push(`provider ${provider.id} baseUrl must use https in production-cloud mode unless an explicit local endpoint allowlist is enabled.`);
  }
}

export function validateConfig(input: GatewayConfigInput): GatewayConfigValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const schemaResult = gatewayConfigInputSchema.safeParse(input);
  if (!schemaResult.success) {
    return {
      ok: false,
      errors: schemaResult.error.issues.map(formatZodIssue),
      warnings,
    };
  }

  const config = normalizeConfig(schemaResult.data as GatewayConfigInput);
  const unknownPresets = withPresetExpansion(schemaResult.data as GatewayConfigInput).unknownPresets;
  for (const preset of unknownPresets) {
    errors.push(`Unknown preset '${preset}'.`);
  }

  assertString(config.server.host, "server.host", errors);
  assertNumber(config.server.port, "server.port", errors, 1);
  assertNumber(config.server.requestTimeoutMs, "server.requestTimeoutMs", errors, 1);
  assertNumber(config.server.maxRequestBodyBytes, "server.maxRequestBodyBytes", errors, 1);
  assertNumber(config.server.maxFallbackAttempts, "server.maxFallbackAttempts", errors, 1);
  for (const [index, origin] of config.server.corsAllowedOrigins.entries()) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push(`server.corsAllowedOrigins.${index} must use http or https.`);
      }
    } catch {
      errors.push(`server.corsAllowedOrigins.${index} must be a valid origin URL.`);
    }
  }
  assertString(config.auth.apiKeyEnv, "auth.apiKeyEnv", errors);
  assertCloudStorage(config, errors);

  if (config.runtime.mode === "production-cloud") {
    if (!config.auth.required) {
      errors.push("production-cloud runtime requires auth.required to be true.");
    }
    if (isLoopbackHost(config.server.host)) {
      errors.push("production-cloud runtime requires server.host to bind a non-loopback interface such as 0.0.0.0.");
    }
    if (!config.runtime.health.requireRuntimeSecrets) {
      errors.push("production-cloud runtime requires runtime.health.requireRuntimeSecrets to be true.");
    }
  }

  const providerIds = new Set<string>();
  for (const provider of config.providers) {
    assertString(provider.id, "provider.id", errors);
    assertString(provider.displayName, `provider ${provider.id}.displayName`, errors);
    assertString(provider.kind, `provider ${provider.id}.kind`, errors);
    if (!provider.baseUrl) {
      errors.push(`provider ${provider.id} must define baseUrl.`);
    }
    if (!provider.apiKeyEnv) {
      warnings.push(`provider ${provider.id} does not define apiKeyEnv and will not be callable.`);
    }
    if (config.runtime.mode === "production-cloud" && provider.enabled !== false && !provider.apiKeyEnv) {
      errors.push(`provider ${provider.id} must define apiKeyEnv in production-cloud mode.`);
    }
    if (config.runtime.mode === "production-cloud") {
      validateProductionProviderBoundary(config, provider, errors);
    }
    if (providerIds.has(provider.id)) {
      errors.push(`provider id '${provider.id}' is duplicated.`);
    }
    providerIds.add(provider.id);
  }

  const modelIds = new Set<string>();
  for (const model of config.models) {
    assertString(model.id, "model.id", errors);
    assertString(model.providerId, `model ${model.id}.providerId`, errors);
    assertString(model.providerModel, `model ${model.id}.providerModel`, errors);
    if (!providerIds.has(model.providerId)) {
      errors.push(`model ${model.id} references unknown provider '${model.providerId}'.`);
    }
    if (model.capabilities.length === 0) {
      errors.push(`model ${model.id} must declare at least one capability.`);
    }
    if (modelIds.has(model.id)) {
      errors.push(`model id '${model.id}' is duplicated.`);
    }
    modelIds.add(model.id);
  }

  for (const route of config.routes) {
    assertString(route.id, "route.id", errors);
    assertString(route.mode, `route ${route.id}.mode`, errors);
    for (const providerId of route.providerAllowlist ?? []) {
      if (!providerIds.has(providerId)) errors.push(`route ${route.id} allowlists unknown provider '${providerId}'.`);
    }
    for (const providerId of route.providerBlocklist ?? []) {
      if (!providerIds.has(providerId)) errors.push(`route ${route.id} blocks unknown provider '${providerId}'.`);
    }
    for (const modelId of route.fallbackModelIds ?? []) {
      if (!modelIds.has(modelId)) errors.push(`route ${route.id} references unknown fallback model '${modelId}'.`);
    }
  }

  const budgetIds = new Set<string>();
  for (const budget of config.budgets) {
    assertString(budget.id, "budget.id", errors);
    assertString(budget.window, `budget ${budget.id}.window`, errors);
    assertString(budget.mode, `budget ${budget.id}.mode`, errors);
    if (budgetIds.has(budget.id)) {
      errors.push(`budget id '${budget.id}' is duplicated.`);
    }
    budgetIds.add(budget.id);
    if (
      budget.maxUsd === undefined &&
      budget.maxInputTokens === undefined &&
      budget.maxOutputTokens === undefined &&
      budget.maxTotalTokens === undefined
    ) {
      errors.push(`budget ${budget.id} must define at least one money or token limit.`);
    }
    if (budget.window !== "per-request" && !config.storage.usageLedgerPath && !config.storage.cloud) {
      errors.push(`budget ${budget.id} uses a ${budget.window} window and requires a usage ledger backend.`);
    }
  }

  if (config.providers.length === 0) {
    errors.push("At least one provider must be configured.");
  }
  if (config.models.length === 0) {
    errors.push("At least one model must be configured.");
  }

  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, config, warnings };
}

export async function loadGatewayConfig(path = "gateway.config.json"): Promise<GatewayConfig> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (error) {
    throw new GatewayHttpError({
      status: 500,
      type: "gateway_config_error",
      code: "config_not_found",
      message: `Could not read config file '${path}'.`,
      raw: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GatewayHttpError({
      status: 500,
      type: "gateway_config_error",
      code: "config_invalid_json",
      message: `Config file '${path}' is not valid JSON.`,
      raw: error,
    });
  }

  if (!isObject(parsed)) {
    throw new GatewayHttpError({
      status: 500,
      type: "gateway_config_error",
      code: "config_invalid",
      message: `Config file '${path}' must contain a JSON object.`,
    });
  }

  let interpolated: unknown;
  try {
    interpolated = interpolateEnvPlaceholders(parsed);
  } catch (error) {
    throw new GatewayHttpError({
      status: 500,
      type: "gateway_config_error",
      code: "config_env_missing",
      message: error instanceof Error ? error.message : "Config contains an unresolved environment placeholder.",
      raw: error,
    });
  }

  const result = validateConfig(interpolated as GatewayConfigInput);
  if (!result.ok) {
    throw new GatewayHttpError({
      status: 500,
      type: "gateway_config_error",
      code: "config_invalid",
      message: result.errors.join(" "),
      raw: result.errors,
    });
  }

  return result.config;
}

function routeProbeRequest(model: string): OpenAIChatCompletionRequest {
  return {
    model,
    messages: [{ role: "user", content: "health" }],
  };
}

function validateProductionRouteReadiness(config: GatewayConfig, env: Record<string, string | undefined>): string[] {
  if (config.runtime.mode !== "production-cloud" || config.routes.length === 0) return [];

  const unavailableRouteIds = config.routes
    .filter((route) => {
      const model = route.modelAliases?.[0] ?? route.id;
      try {
        resolveRoute({ config, env }, routeProbeRequest(model));
        return false;
      } catch {
        return true;
      }
    })
    .map((route) => route.id);

  return unavailableRouteIds.length > 0
    ? [`Production cloud routes without an eligible provider key: ${unavailableRouteIds.join(", ")}.`]
    : [];
}

export function validateRuntimeSecrets(config: GatewayConfig, env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];

  if (config.auth.required && !env[config.auth.apiKeyEnv]) {
    errors.push(`Gateway API key env var ${config.auth.apiKeyEnv} is required.`);
  }

  const hasCallableProvider = config.providers.some((provider) => {
    if (provider.enabled === false || !provider.apiKeyEnv) return false;
    return Boolean(env[provider.apiKeyEnv]);
  });

  if (!hasCallableProvider) {
    errors.push("At least one enabled provider must have its apiKeyEnv set in the environment.");
  }

  errors.push(...validateProductionRouteReadiness(config, env));

  return errors;
}
