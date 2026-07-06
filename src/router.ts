import { GatewayHttpError } from "./errors";
import { isChinaProvider } from "./presets";
import type {
  GatewayConfig,
  GatewayModelCapability,
  GatewayModelConfig,
  GatewayProviderConfig,
  GatewayRouteCandidate,
  GatewayRouteDecision,
  GatewayRoutePolicy,
  GatewayRuntimeOptions,
  OpenAIChatCompletionRequest,
} from "./types";

type EffectivePolicy = {
  allowedProviders?: string[];
  blockedProviders?: string[];
  allowedRegions?: string[];
  blockedRegions?: string[];
  allowTraining: boolean;
  allowLogging: boolean;
  allowChineseProviders: boolean;
  zeroDataRetentionRequired: boolean;
  byokOnly: boolean;
  maxInputUsdPerMillionTokens?: number;
  maxOutputUsdPerMillionTokens?: number;
};

type ResolveResult = {
  candidates: GatewayRouteCandidate[];
  decision: GatewayRouteDecision;
};

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function arrayIntersection(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  const bSet = new Set(b);
  return a.filter((item) => bSet.has(item));
}

function arrayUnion(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  const values = [...(a ?? []), ...(b ?? [])];
  return values.length ? unique(values) : undefined;
}

function strictBoolean(
  requestValue: boolean | undefined,
  routeValue: boolean | undefined,
  configValue: boolean | undefined,
  fallback: boolean,
): boolean {
  const base = routeValue ?? configValue ?? fallback;
  if (requestValue === undefined) return base;
  return requestValue && base;
}

function strictRequiredBoolean(
  requestValue: boolean | undefined,
  routeValue: boolean | undefined,
  configValue: boolean | undefined,
  fallback: boolean,
): boolean {
  const base = routeValue ?? configValue ?? fallback;
  if (requestValue === undefined) return base;
  return requestValue || base;
}

function strictMax(
  requestValue: number | undefined,
  routeValue: number | undefined,
): number | undefined {
  if (requestValue === undefined) return routeValue;
  if (routeValue === undefined) return requestValue;
  return Math.min(requestValue, routeValue);
}

function mergePolicy(
  config: GatewayConfig,
  route: GatewayRoutePolicy | undefined,
  request: OpenAIChatCompletionRequest,
): EffectivePolicy {
  const requestPolicy = request.gateway;
  const configPolicy = config.policy;
  const routePolicy = route?.dataPolicy ?? {};
  const allowExpansion = configPolicy.allowRequestPolicyExpansion === true;
  const configuredAllowedRegions = routePolicy.allowedRegions ?? configPolicy.allowedRegions;
  const configuredBlockedRegions = routePolicy.blockedRegions ?? (routePolicy.allowedRegions ? undefined : configPolicy.blockedRegions);
  const allowedRegions = allowExpansion
    ? requestPolicy?.allowed_regions ?? configuredAllowedRegions
    : arrayIntersection(configuredAllowedRegions, requestPolicy?.allowed_regions);
  const blockedRegions = allowExpansion
    ? requestPolicy?.blocked_regions ??
      (requestPolicy?.allowed_regions ? undefined : configuredBlockedRegions)
    : arrayUnion(configuredBlockedRegions, requestPolicy?.blocked_regions);
  const configuredAllowedProviders = route?.providerAllowlist ?? routePolicy.allowedProviders ?? configPolicy.allowedProviders;
  const configuredBlockedProviders = route?.providerBlocklist ?? routePolicy.blockedProviders ?? configPolicy.blockedProviders;

  return {
    allowedProviders: allowExpansion
      ? requestPolicy?.allowed_providers ?? configuredAllowedProviders
      : arrayIntersection(configuredAllowedProviders, requestPolicy?.allowed_providers),
    blockedProviders: allowExpansion
      ? requestPolicy?.blocked_providers ?? configuredBlockedProviders
      : arrayUnion(configuredBlockedProviders, requestPolicy?.blocked_providers),
    allowedRegions,
    blockedRegions,
    allowTraining: allowExpansion
      ? requestPolicy?.allow_training ?? routePolicy.allowTraining ?? configPolicy.allowTraining ?? false
      : strictBoolean(requestPolicy?.allow_training, routePolicy.allowTraining, configPolicy.allowTraining, false),
    allowLogging: allowExpansion
      ? requestPolicy?.allow_logging ?? routePolicy.allowLogging ?? configPolicy.allowLogging ?? false
      : strictBoolean(requestPolicy?.allow_logging, routePolicy.allowLogging, configPolicy.allowLogging, false),
    allowChineseProviders: allowExpansion
      ? requestPolicy?.allow_chinese_providers ??
        routePolicy.allowChineseProviders ??
        configPolicy.allowChineseProviders ??
        allowedRegions?.includes("cn") ??
        false
      : strictBoolean(
          requestPolicy?.allow_chinese_providers ?? (requestPolicy?.allowed_regions?.includes("cn") ? true : undefined),
          routePolicy.allowChineseProviders,
          configPolicy.allowChineseProviders ?? (configuredAllowedRegions?.includes("cn") ? true : undefined),
          false,
        ),
    zeroDataRetentionRequired: allowExpansion
      ? requestPolicy?.zero_data_retention_required ??
        routePolicy.zeroDataRetentionRequired ??
        configPolicy.zeroDataRetentionRequired ??
        false
      : strictRequiredBoolean(
          requestPolicy?.zero_data_retention_required,
          routePolicy.zeroDataRetentionRequired,
          configPolicy.zeroDataRetentionRequired,
          false,
        ),
    byokOnly: allowExpansion
      ? requestPolicy?.byok_only ?? routePolicy.byokOnly ?? configPolicy.byokOnly ?? true
      : strictRequiredBoolean(requestPolicy?.byok_only, routePolicy.byokOnly, configPolicy.byokOnly, true),
    maxInputUsdPerMillionTokens: strictMax(
      requestPolicy?.max_input_usd_per_million_tokens,
      route?.maxInputUsdPerMillionTokens,
    ),
    maxOutputUsdPerMillionTokens: strictMax(
      requestPolicy?.max_output_usd_per_million_tokens,
      route?.maxOutputUsdPerMillionTokens,
    ),
  };
}

function routeMode(route: GatewayRoutePolicy | undefined, request: OpenAIChatCompletionRequest): GatewayRoutePolicy["mode"] {
  return request.gateway?.routing ?? route?.mode ?? "fallback";
}

function routeForRequest(config: GatewayConfig, model: string): GatewayRoutePolicy | undefined {
  return config.routes.find((route) => route.id === model || (route.modelAliases ?? []).includes(model));
}

function providerMap(config: GatewayConfig): Map<string, GatewayProviderConfig> {
  return new Map(config.providers.map((provider) => [provider.id, provider]));
}

function modelMap(config: GatewayConfig): Map<string, GatewayModelConfig> {
  return new Map(config.models.map((model) => [model.id, model]));
}

function dynamicCapabilitiesForProvider(provider: GatewayProviderConfig): GatewayModelCapability[] {
  if (provider.kind === "anthropic") {
    return ["chat", "tools", "vision", "reasoning"];
  }

  return ["chat", "streaming"];
}

function dynamicCandidate(config: GatewayConfig, id: string): GatewayRouteCandidate | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  const providerId = id.slice(0, slash);
  const providerModel = id.slice(slash + 1);
  const provider = providerMap(config).get(providerId);
  if (!provider) return undefined;

  return {
    provider,
    model: {
      id,
      providerId,
      providerModel,
      aliases: [],
      capabilities: dynamicCapabilitiesForProvider(provider),
    },
  };
}

function initialCandidates(config: GatewayConfig, request: OpenAIChatCompletionRequest): GatewayRouteCandidate[] {
  const providers = providerMap(config);
  const models = modelMap(config);
  const route = routeForRequest(config, request.model);

  const explicit = models.get(request.model);
  if (explicit) {
    const provider = providers.get(explicit.providerId);
    return provider ? [{ model: explicit, provider }] : [];
  }

  const dynamic = dynamicCandidate(config, request.model);
  if (dynamic) return [dynamic];

  if (route?.fallbackModelIds?.length) {
    return route.fallbackModelIds
      .map((id) => models.get(id))
      .filter((model): model is GatewayModelConfig => Boolean(model))
      .map((model) => ({ model, provider: providers.get(model.providerId) }))
      .filter((candidate): candidate is GatewayRouteCandidate => Boolean(candidate.provider));
  }

  return config.models
    .filter((model) => (model.aliases ?? []).includes(request.model))
    .map((model) => ({ model, provider: providers.get(model.providerId) }))
    .filter((candidate): candidate is GatewayRouteCandidate => Boolean(candidate.provider));
}

function providerHasRequiredDataPolicy(provider: GatewayProviderConfig, policy: EffectivePolicy): boolean {
  if (!policy.allowTraining && provider.dataPolicy?.allowTraining !== false) {
    return false;
  }

  if (!policy.allowLogging && provider.dataPolicy?.allowLogging !== false) {
    return false;
  }

  if (policy.zeroDataRetentionRequired && provider.dataPolicy?.zeroDataRetentionAvailable !== true) {
    return false;
  }

  if (policy.byokOnly && provider.dataPolicy?.byokOnly === false) {
    return false;
  }

  return true;
}

function intersects(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a?.length || !b?.length) return false;
  const bSet = new Set(b);
  return a.some((item) => bSet.has(item));
}

function hasAllowedRegion(provider: GatewayProviderConfig, policy: EffectivePolicy): boolean {
  if (policy.blockedRegions?.length && intersects(provider.regions, policy.blockedRegions)) {
    return false;
  }

  if (!policy.allowedRegions?.length) {
    return true;
  }

  const providerRegions = provider.regions ?? [];
  if (providerRegions.length === 0) {
    return false;
  }

  return intersects(providerRegions, policy.allowedRegions);
}

function candidateSkipReason(
  candidate: GatewayRouteCandidate,
  request: OpenAIChatCompletionRequest,
  policy: EffectivePolicy,
  env: Record<string, string | undefined>,
): string | undefined {
  const { model, provider } = candidate;

  if (provider.enabled === false) return "provider is disabled";
  if (policy.allowedProviders?.length && !policy.allowedProviders.includes(provider.id)) {
    return "provider is not in allowed_providers";
  }
  if (policy.blockedProviders?.includes(provider.id)) return "provider is blocked";
  if (isChinaProvider(provider) && !policy.allowChineseProviders) {
    return "china provider requires allow_chinese_providers or allowed_regions including cn";
  }
  if (!hasAllowedRegion(provider, policy)) return "provider region is not allowed";
  if (!providerHasRequiredDataPolicy(provider, policy)) return "provider data policy is not allowed";
  if (policy.byokOnly && !provider.apiKeyEnv) return "provider is not configured for BYOK env credentials";
  if (!provider.apiKeyEnv || !env[provider.apiKeyEnv]) return `provider key env ${provider.apiKeyEnv ?? "(none)"} is not set`;
  if (!model.capabilities.includes("chat")) return "model does not support chat";
  if (request.stream && !model.capabilities.includes("streaming")) return "model does not support streaming";
  if (request.tools && request.tools.length > 0 && !model.capabilities.includes("tools")) {
    return "model does not support tools";
  }
  if (
    policy.maxInputUsdPerMillionTokens !== undefined &&
    model.inputUsdPerMillionTokens !== undefined &&
    model.inputUsdPerMillionTokens > policy.maxInputUsdPerMillionTokens
  ) {
    return "model input price exceeds policy";
  }
  if (
    policy.maxOutputUsdPerMillionTokens !== undefined &&
    model.outputUsdPerMillionTokens !== undefined &&
    model.outputUsdPerMillionTokens > policy.maxOutputUsdPerMillionTokens
  ) {
    return "model output price exceeds policy";
  }

  return undefined;
}

function sortCandidates(candidates: GatewayRouteCandidate[], mode: GatewayRoutePolicy["mode"]): GatewayRouteCandidate[] {
  if (mode !== "cheapest") return candidates;
  return [...candidates].sort((a, b) => {
    const aCost =
      a.model.inputUsdPerMillionTokens === undefined || a.model.outputUsdPerMillionTokens === undefined
        ? Number.POSITIVE_INFINITY
        : a.model.inputUsdPerMillionTokens + a.model.outputUsdPerMillionTokens;
    const bCost =
      b.model.inputUsdPerMillionTokens === undefined || b.model.outputUsdPerMillionTokens === undefined
        ? Number.POSITIVE_INFINITY
        : b.model.inputUsdPerMillionTokens + b.model.outputUsdPerMillionTokens;
    return aCost - bCost;
  });
}

function candidateHasConfiguredPrice(candidate: GatewayRouteCandidate): boolean {
  return candidate.model.inputUsdPerMillionTokens !== undefined && candidate.model.outputUsdPerMillionTokens !== undefined;
}

function policyForDecision(policy: EffectivePolicy): GatewayRouteDecision["policy"] {
  return {
    ...(policy.allowedProviders ? { allowed_providers: policy.allowedProviders } : {}),
    ...(policy.blockedProviders ? { blocked_providers: policy.blockedProviders } : {}),
    ...(policy.allowedRegions ? { allowed_regions: policy.allowedRegions } : {}),
    ...(policy.blockedRegions ? { blocked_regions: policy.blockedRegions } : {}),
    allow_training: policy.allowTraining,
    allow_logging: policy.allowLogging,
    allow_chinese_providers: policy.allowChineseProviders,
    zero_data_retention_required: policy.zeroDataRetentionRequired,
    byok_only: policy.byokOnly,
  };
}

export function resolveRoute(options: GatewayRuntimeOptions, request: OpenAIChatCompletionRequest): ResolveResult {
  const route = routeForRequest(options.config, request.model);
  const mode = routeMode(route, request);
  const policy = mergePolicy(options.config, route, request);
  const env = options.env ?? process.env;
  const candidates = initialCandidates(options.config, request);
  const decision: GatewayRouteDecision = {
    requested_model: request.model,
    resolved_candidates: unique(candidates.map((candidate) => candidate.model.id)),
    mode,
    policy: policyForDecision(policy),
    reason: "",
    attempts: [],
  };

  const eligible: GatewayRouteCandidate[] = [];
  for (const candidate of candidates) {
    const reason = candidateSkipReason(candidate, request, policy, env);
    if (reason) {
      decision.attempts.push({
        provider: candidate.provider.id,
        model: candidate.model.id,
        providerModel: candidate.model.providerModel,
        status: "skipped",
        reason,
      });
    } else {
      eligible.push(candidate);
    }
  }

  const sorted = sortCandidates(eligible, mode);
  if (mode === "cheapest" && sorted.length > 0 && !sorted.some(candidateHasConfiguredPrice)) {
    decision.reason = "no eligible model has configured token price for cheapest routing";
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_policy_error",
      code: "no_priced_route",
      message: `No priced provider can satisfy cheapest routing for model '${request.model}'.`,
      raw: decision,
    });
  }

  if (sorted.length > 0) {
    decision.selected = sorted[0]?.model.id;
    decision.reason = mode === "cheapest" ? "lowest configured token price among eligible models" : "first eligible model";
    return { candidates: sorted, decision };
  }

  decision.reason = "no eligible model after policy filtering";
  throw new GatewayHttpError({
    status: 400,
    type: "gateway_policy_error",
    code: "no_route",
    message: `No allowed provider can satisfy model '${request.model}'.`,
    raw: decision,
  });
}
