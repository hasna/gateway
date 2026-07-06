import { GatewayHttpError } from "./errors";
import { isChinaProvider } from "./presets";
import {
  missingRequiredProviderHeaderEnvs,
  providerBaseUrl,
  providerCredentialEnv,
  providerRequiresCredential,
} from "./provider-config";
import type {
  GatewayConfig,
  GatewayModelCapability,
  GatewayModelConfig,
  GatewayProviderConfig,
  GatewayRoutableRequest,
  GatewayRouteCandidate,
  GatewayRouteDecision,
  GatewayRoutePolicy,
  GatewayRouteScore,
  GatewayRuntimeOptions,
  OpenAIChatCompletionRequest,
  OpenAIEmbeddingsRequest,
} from "./types";

type GatewayRouteOperation = "chat" | "embeddings";

type ResolveRouteOptions = {
  operation?: GatewayRouteOperation;
};

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

function arrayDifference(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return undefined;
  if (!b?.length) return a;
  const bSet = new Set(b);
  const result = a.filter((item) => !bSet.has(item));
  return result.length ? result : undefined;
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
  request: GatewayRoutableRequest,
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
  const requestAllowedProviders = requestPolicy?.provider_only ?? requestPolicy?.allowed_providers;
  const requestBlockedProviders = arrayUnion(requestPolicy?.blocked_providers, requestPolicy?.provider_ignore);

  return {
    allowedProviders: allowExpansion
      ? requestAllowedProviders ?? configuredAllowedProviders
      : arrayDifference(arrayIntersection(configuredAllowedProviders, requestAllowedProviders), requestBlockedProviders),
    blockedProviders: allowExpansion
      ? requestBlockedProviders ?? configuredBlockedProviders
      : arrayUnion(configuredBlockedProviders, requestBlockedProviders),
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

function routeMode(route: GatewayRoutePolicy | undefined, request: GatewayRoutableRequest): GatewayRoutePolicy["mode"] {
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

function dynamicCandidate(config: GatewayConfig, id: string, operation: GatewayRouteOperation): GatewayRouteCandidate | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  const providerId = id.slice(0, slash);
  const providerModel = id.slice(slash + 1);
  const provider = providerMap(config).get(providerId);
  if (!provider) return undefined;
  const capabilities: GatewayModelCapability[] =
    operation === "embeddings" ? ["embeddings"] : dynamicCapabilitiesForProvider(provider);

  return {
    provider,
    model: {
      id,
      providerId,
      providerModel,
      aliases: [],
      capabilities,
    },
  };
}

function initialCandidates(
  config: GatewayConfig,
  request: GatewayRoutableRequest,
  operation: GatewayRouteOperation,
): GatewayRouteCandidate[] {
  const providers = providerMap(config);
  const models = modelMap(config);
  const route = routeForRequest(config, request.model);

  const explicit = models.get(request.model);
  if (explicit) {
    const provider = providers.get(explicit.providerId);
    return provider ? [{ model: explicit, provider }] : [];
  }

  const dynamic = dynamicCandidate(config, request.model, operation);
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
  request: GatewayRoutableRequest,
  policy: EffectivePolicy,
  env: Record<string, string | undefined>,
  operation: GatewayRouteOperation,
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
  if (!providerBaseUrl(provider, env)) return `provider baseUrl env ${provider.baseUrlEnv ?? "(none)"} is not set`;
  const credentialEnv = providerCredentialEnv(provider);
  if (policy.byokOnly && !credentialEnv) return "provider is not configured for BYOK env credentials";
  if (providerRequiresCredential(provider) && (!credentialEnv || !env[credentialEnv])) {
    return `provider key env ${credentialEnv ?? "(none)"} is not set`;
  }
  const missingHeaderEnvs = missingRequiredProviderHeaderEnvs(provider, env);
  if (missingHeaderEnvs.length > 0) {
    return `provider required header env ${missingHeaderEnvs.join(", ")} is not set`;
  }
  if (operation === "embeddings") {
    if (!model.capabilities.includes("embeddings")) return "model does not support embeddings";
  } else {
    const chatRequest = request as OpenAIChatCompletionRequest;
    if (!model.capabilities.includes("chat")) return "model does not support chat";
    if (chatRequest.stream && !model.capabilities.includes("streaming")) return "model does not support streaming";
    if (chatRequest.tools && chatRequest.tools.length > 0 && !model.capabilities.includes("tools")) {
      return "model does not support tools";
    }
  }
  if (request.response_format && !model.capabilities.includes("json")) return "model does not support json output";
  for (const capability of request.gateway?.required_capabilities ?? []) {
    if (!model.capabilities.includes(capability)) return `model does not support required capability ${capability}`;
  }
  if (
    request.gateway?.min_context_tokens !== undefined &&
    (model.contextWindow === undefined || model.contextWindow < request.gateway.min_context_tokens)
  ) {
    return "model context window is below request minimum";
  }
  if (
    request.gateway?.min_quality !== undefined &&
    (model.qualityScore === undefined || model.qualityScore < request.gateway.min_quality)
  ) {
    return "model quality score is below request minimum";
  }
  if (
    policy.maxInputUsdPerMillionTokens !== undefined &&
    model.inputUsdPerMillionTokens === undefined
  ) {
    return "model input price is not configured for policy";
  }
  if (
    policy.maxInputUsdPerMillionTokens !== undefined &&
    model.inputUsdPerMillionTokens! > policy.maxInputUsdPerMillionTokens
  ) {
    return "model input price exceeds policy";
  }
  if (
    policy.maxOutputUsdPerMillionTokens !== undefined &&
    model.outputUsdPerMillionTokens === undefined
  ) {
    return "model output price is not configured for policy";
  }
  if (
    policy.maxOutputUsdPerMillionTokens !== undefined &&
    model.outputUsdPerMillionTokens! > policy.maxOutputUsdPerMillionTokens
  ) {
    return "model output price exceeds policy";
  }

  return undefined;
}

function candidateHasConfiguredPrice(candidate: GatewayRouteCandidate): boolean {
  return candidate.model.inputUsdPerMillionTokens !== undefined && candidate.model.outputUsdPerMillionTokens !== undefined;
}

function configuredTokenPrice(candidate: GatewayRouteCandidate): number {
  if (!candidateHasConfiguredPrice(candidate)) return Number.POSITIVE_INFINITY;
  return candidate.model.inputUsdPerMillionTokens! + candidate.model.outputUsdPerMillionTokens!;
}

function estimateInputTokens(request: GatewayRoutableRequest): number {
  if (request.gateway?.expected_input_tokens !== undefined) return request.gateway.expected_input_tokens;
  const messages = (request as OpenAIChatCompletionRequest).messages;
  let chars = 0;
  if (Array.isArray(messages)) {
    chars = messages.reduce((sum, message) => {
      if (typeof message.content === "string") return sum + message.content.length;
      if (Array.isArray(message.content)) return sum + JSON.stringify(message.content).length;
      return sum;
    }, 0);
  } else {
    // Embeddings and other non-chat requests carry their content in `input`.
    const input = (request as OpenAIEmbeddingsRequest).input;
    if (typeof input === "string") chars = input.length;
    else if (Array.isArray(input)) chars = JSON.stringify(input).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateOutputTokens(request: GatewayRoutableRequest): number {
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  return typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 512;
}

function estimatedRequestCost(candidate: GatewayRouteCandidate, request: GatewayRoutableRequest): number | undefined {
  if (!candidateHasConfiguredPrice(candidate)) return undefined;
  return (
    (estimateInputTokens(request) / 1_000_000) * candidate.model.inputUsdPerMillionTokens! +
    (estimateOutputTokens(request) / 1_000_000) * candidate.model.outputUsdPerMillionTokens!
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function inferredQuality(candidate: GatewayRouteCandidate): number {
  if (candidate.model.qualityScore !== undefined) return candidate.model.qualityScore;
  let score = 0.45;
  if (candidate.model.capabilities.includes("reasoning")) score += 0.15;
  if (candidate.model.capabilities.includes("tools")) score += 0.1;
  if (candidate.model.capabilities.includes("json")) score += 0.05;
  if (candidate.model.capabilities.includes("vision")) score += 0.05;
  score += Math.min(candidate.model.contextWindow ?? 0, 1_000_000) / 1_000_000 * 0.1;
  return clamp01(score);
}

function inverseNormalize(value: number | undefined, values: Array<number | undefined>, fallback: number): number {
  if (value === undefined) return fallback;
  const finite = values.filter((item): item is number => item !== undefined && Number.isFinite(item));
  if (finite.length === 0) return fallback;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return 1;
  return clamp01(1 - (value - min) / (max - min));
}

function normalize(value: number | undefined, values: Array<number | undefined>, fallback: number): number {
  if (value === undefined) return fallback;
  const finite = values.filter((item): item is number => item !== undefined && Number.isFinite(item));
  if (finite.length === 0) return fallback;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return 1;
  return clamp01((value - min) / (max - min));
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stickyTieBreaker(candidate: GatewayRouteCandidate, request: GatewayRoutableRequest): number {
  const sessionId = request.gateway?.sticky_session_id ?? request.gateway?.session_id ?? request.session_id;
  if (!sessionId) return 0;
  return hashString(`${sessionId}:${candidate.model.id}`) / 0xffffffff;
}

function providerOrderScore(candidate: GatewayRouteCandidate, request: GatewayRoutableRequest): number | undefined {
  const order = request.gateway?.provider_order;
  if (!order?.length) return undefined;
  const index = order.indexOf(candidate.provider.id);
  if (index < 0) return 0;
  return 1 - index / Math.max(order.length, 1);
}

function weightsForMode(
  mode: GatewayRoutePolicy["mode"],
  request: GatewayRoutableRequest,
): Record<"cost" | "quality" | "latency" | "success" | "throughput" | "providerOrder", number> {
  if (mode === "lowest-latency") {
    return { cost: 0.1, quality: 0.1, latency: 0.55, success: 0.2, throughput: 0, providerOrder: 0.05 };
  }
  if (mode === "highest-throughput") {
    return { cost: 0.1, quality: 0.1, latency: 0.1, success: 0.25, throughput: 0.4, providerOrder: 0.05 };
  }

  const priority = request.gateway?.priority ?? "balanced";
  if (priority === "cost") {
    return { cost: 0.55, quality: 0.15, latency: 0.1, success: 0.15, throughput: 0, providerOrder: 0.05 };
  }
  if (priority === "quality") {
    return { cost: 0.1, quality: 0.55, latency: 0.1, success: 0.2, throughput: 0, providerOrder: 0.05 };
  }
  if (priority === "latency") {
    return { cost: 0.1, quality: 0.15, latency: 0.45, success: 0.25, throughput: 0, providerOrder: 0.05 };
  }

  const tradeoff = clamp01((request.gateway?.cost_quality_tradeoff ?? 5) / 10);
  return {
    cost: 0.2 + tradeoff * 0.25,
    quality: 0.45 - tradeoff * 0.25,
    latency: 0.15,
    success: 0.15,
    throughput: 0,
    providerOrder: 0.05,
  };
}

function scoreCandidates(
  candidates: GatewayRouteCandidate[],
  mode: GatewayRoutePolicy["mode"],
  request: GatewayRoutableRequest,
): GatewayRouteScore[] {
  const costs = candidates.map((candidate) => estimatedRequestCost(candidate, request));
  const latencies = candidates.map((candidate) => candidate.model.averageLatencyMs);
  const throughputs = candidates.map((candidate) => candidate.model.throughputTokensPerSecond);
  const weights = weightsForMode(mode, request);

  return candidates.map((candidate) => {
    const components = {
      cost: inverseNormalize(estimatedRequestCost(candidate, request), costs, 0.35),
      quality: inferredQuality(candidate),
      latency: inverseNormalize(candidate.model.averageLatencyMs, latencies, 0.5),
      success: candidate.model.successRate ?? 0.5,
      throughput: normalize(candidate.model.throughputTokensPerSecond, throughputs, 0.5),
      providerOrder: providerOrderScore(candidate, request) ?? 0.5,
      sticky: stickyTieBreaker(candidate, request),
    };
    const score =
      components.cost * weights.cost +
      components.quality * weights.quality +
      components.latency * weights.latency +
      components.success * weights.success +
      components.throughput * weights.throughput +
      components.providerOrder * weights.providerOrder;
    const reason =
      mode === "lowest-latency"
        ? "highest latency-weighted score among eligible models"
        : mode === "highest-throughput"
          ? "highest throughput and success weighted score among eligible models"
          : "highest cost, quality, latency, and success weighted score among eligible models";

    return {
      provider: candidate.provider.id,
      model: candidate.model.id,
      providerModel: candidate.model.providerModel,
      score,
      reason,
      components,
    };
  });
}

function scoreFor(candidate: GatewayRouteCandidate, scores: GatewayRouteScore[]): GatewayRouteScore | undefined {
  return scores.find((score) => score.model === candidate.model.id && score.provider === candidate.provider.id);
}

function originalIndexMap(candidates: GatewayRouteCandidate[]): Map<string, number> {
  return new Map(candidates.map((candidate, index) => [`${candidate.provider.id}:${candidate.model.id}`, index]));
}

function sortCandidates(
  candidates: GatewayRouteCandidate[],
  mode: GatewayRoutePolicy["mode"],
  request: GatewayRoutableRequest,
): { sorted: GatewayRouteCandidate[]; scores?: GatewayRouteScore[] } {
  const indexes = originalIndexMap(candidates);
  const byOriginalOrder = (a: GatewayRouteCandidate, b: GatewayRouteCandidate): number =>
    (indexes.get(`${a.provider.id}:${a.model.id}`) ?? 0) - (indexes.get(`${b.provider.id}:${b.model.id}`) ?? 0);

  if (mode === "cheapest") {
    return {
      sorted: [...candidates].sort((a, b) => configuredTokenPrice(a) - configuredTokenPrice(b) || byOriginalOrder(a, b)),
    };
  }

  if (mode === "fallback" || mode === "explicit") {
    const order = request.gateway?.provider_order;
    if (!order?.length) return { sorted: candidates };
    return {
      sorted: [...candidates].sort((a, b) => {
        const aIndex = order.indexOf(a.provider.id);
        const bIndex = order.indexOf(b.provider.id);
        const aRank = aIndex < 0 ? Number.POSITIVE_INFINITY : aIndex;
        const bRank = bIndex < 0 ? Number.POSITIVE_INFINITY : bIndex;
        return aRank - bRank || byOriginalOrder(a, b);
      }),
    };
  }

  const scores = scoreCandidates(candidates, mode, request);
  return {
    scores,
    sorted: [...candidates].sort((a, b) => {
      const aScore = scoreFor(a, scores);
      const bScore = scoreFor(b, scores);
      return (
        (bScore?.score ?? 0) - (aScore?.score ?? 0) ||
        (bScore?.components.sticky ?? 0) - (aScore?.components.sticky ?? 0) ||
        byOriginalOrder(a, b)
      );
    }),
  };
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

export function resolveRoute(
  options: GatewayRuntimeOptions,
  request: GatewayRoutableRequest,
  resolveOptions: ResolveRouteOptions = {},
): ResolveResult {
  const operation = resolveOptions.operation ?? "chat";
  const route = routeForRequest(options.config, request.model);
  const mode = routeMode(route, request);
  const policy = mergePolicy(options.config, route, request);
  const env = options.env ?? process.env;
  const candidates = initialCandidates(options.config, request, operation);
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
    const reason = candidateSkipReason(candidate, request, policy, env, operation);
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

  const { sorted, scores } = sortCandidates(eligible, mode, request);
  if (scores) decision.scores = scores.sort((a, b) => b.score - a.score);
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
    decision.reason =
      mode === "cheapest"
        ? "lowest configured token price among eligible models"
        : scores
          ? (scoreFor(sorted[0]!, scores)?.reason ?? "highest score among eligible models")
          : request.gateway?.provider_order?.length
            ? "first eligible model after provider_order hint"
            : "first eligible model";
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
