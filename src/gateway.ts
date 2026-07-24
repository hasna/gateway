import { createHash } from "node:crypto";
import { GatewayHttpError, providerErrorToGateway } from "./errors";
import { appendUsageLedger } from "./ledger";
import {
  assertBudgetPostflight,
  assertBudgetPreflight,
  budgetContextFromRequest,
  evaluateBudgetPostflight,
  spendFromUsage,
} from "./budget";
import { adapterForProvider } from "./providers";
import { providerCredentialEnv, providerRequiresCredential } from "./provider-config";
import { resolveRoute } from "./router";
import { transformOpenAICompatibleStream } from "./streaming";
import type {
  GatewayRouteCandidate,
  GatewayRouteDecision,
  GatewayRuntimeOptions,
  OpenAIChatCompletionRequest,
} from "./types";
import { estimateCostUsd, normalizeUsage, toOpenAIUsage } from "./usage";

type CompletionResult = {
  body: Record<string, unknown>;
  status: number;
  decision: GatewayRouteDecision;
};

type CachedCompletion = {
  expiresAt: number;
  result: CompletionResult;
};

const responseCacheStores = new WeakMap<GatewayRuntimeOptions["config"], Map<string, CachedCompletion>>();

function metadataFor(
  candidate: GatewayRouteCandidate,
  decision: GatewayRouteDecision,
  estimatedCostUsd: number | undefined,
  budgets?: Awaited<ReturnType<typeof evaluateBudgetPostflight>>,
): Record<string, unknown> {
  return {
    provider: candidate.provider.id,
    provider_model: candidate.model.providerModel,
    route_mode: decision.mode,
    attempts: decision.attempts.filter((attempt) => attempt.status !== "skipped").length || 1,
    ...(estimatedCostUsd === undefined ? {} : { estimated_cost_usd: estimatedCostUsd }),
    ...(budgets && budgets.length > 0
      ? {
          budgets: budgets.map((status) => ({
            id: status.budget.id,
            mode: status.budget.mode,
            remaining: status.remaining,
            warnings: status.warnings,
          })),
        }
      : {}),
    route_decision: decision,
  };
}

function includeGatewayMetadata(options: GatewayRuntimeOptions, request: OpenAIChatCompletionRequest): boolean {
  if (request.gateway?.strict_openai_compatibility) return false;
  return request.gateway?.include_gateway_metadata ?? options.config.server.includeGatewayMetadata;
}

function normalizedCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizedCacheValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizedCacheValue(item)]),
    );
  }
  return value;
}

function stableCacheJson(value: unknown): string {
  return JSON.stringify(normalizedCacheValue(value));
}

function stableCacheHash(value: unknown): string {
  return createHash("sha256").update(stableCacheJson(value)).digest("hex");
}

function cacheRelevantRequestFields(request: OpenAIChatCompletionRequest): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request).filter(([key, value]) => {
      if (value === undefined) return false;
      return key !== "model" && key !== "messages" && key !== "stream" && key !== "gateway";
    }),
  );
}

function responseCacheKey(
  options: GatewayRuntimeOptions,
  request: OpenAIChatCompletionRequest,
  candidate: GatewayRouteCandidate,
  isolation: { gatewayKey?: string; tenant?: string },
): string {
  return stableCacheHash({
    gatewayHash: stableCacheHash(request.gateway ?? null),
    gatewayKey: isolation.gatewayKey ?? null,
    includeGatewayMetadata: includeGatewayMetadata(options, request),
    messagesHash: stableCacheHash(request.messages),
    model: candidate.model.id,
    requestHash: stableCacheHash(cacheRelevantRequestFields(request)),
    requestedModel: request.model,
    tenant: isolation.tenant ?? null,
  });
}

function responseCacheEnabled(options: GatewayRuntimeOptions): boolean {
  const cache = options.config.server.responseCache;
  return cache.enabled && cache.ttlMs > 0 && cache.maxEntries > 0;
}

function responseCacheStore(options: GatewayRuntimeOptions): Map<string, CachedCompletion> {
  let store = responseCacheStores.get(options.config);
  if (!store) {
    store = new Map();
    responseCacheStores.set(options.config, store);
  }
  return store;
}

function cloneCompletionResult(result: CompletionResult): CompletionResult {
  return {
    body: structuredClone(result.body),
    status: result.status,
    decision: structuredClone(result.decision),
  };
}

function pruneResponseCache(options: GatewayRuntimeOptions, store: Map<string, CachedCompletion>, now: number): void {
  for (const [key, cached] of store) {
    if (cached.expiresAt <= now) {
      store.delete(key);
    }
  }

  while (store.size >= options.config.server.responseCache.maxEntries) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) return;
    store.delete(oldestKey);
  }
}

function readResponseCache(options: GatewayRuntimeOptions, key: string): CompletionResult | undefined {
  if (!responseCacheEnabled(options) || options.requestContext?.responseCacheBypass) return undefined;
  const store = responseCacheStore(options);
  const cached = store.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return cloneCompletionResult(cached.result);
}

function writeResponseCache(options: GatewayRuntimeOptions, key: string, result: CompletionResult): void {
  if (!responseCacheEnabled(options)) return;
  const now = Date.now();
  const store = responseCacheStore(options);
  pruneResponseCache(options, store, now);
  store.set(key, {
    expiresAt: now + options.config.server.responseCache.ttlMs,
    result: cloneCompletionResult(result),
  });
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requestWithStreamingUsage(request: OpenAIChatCompletionRequest): OpenAIChatCompletionRequest {
  return {
    ...request,
    stream: true,
    stream_options: {
      ...objectRecord(request.stream_options),
      include_usage: true,
    },
  };
}

function requestWithEffectivePolicy(
  request: OpenAIChatCompletionRequest,
  decision: GatewayRouteDecision,
): OpenAIChatCompletionRequest {
  return {
    ...request,
    gateway: {
      ...(request.gateway ?? {}),
      allow_training: decision.policy.allow_training,
      allow_logging: decision.policy.allow_logging,
      allow_chinese_providers: decision.policy.allow_chinese_providers,
      zero_data_retention_required: decision.policy.zero_data_retention_required,
      byok_only: decision.policy.byok_only,
      ...(decision.policy.allowed_providers ? { allowed_providers: decision.policy.allowed_providers } : {}),
      ...(decision.policy.blocked_providers ? { blocked_providers: decision.policy.blocked_providers } : {}),
      ...(decision.policy.allowed_regions ? { allowed_regions: decision.policy.allowed_regions } : {}),
      ...(decision.policy.blocked_regions ? { blocked_regions: decision.policy.blocked_regions } : {}),
    },
  };
}

function extractProviderMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" ? message : undefined;
  }
  return typeof record.message === "string" ? record.message : undefined;
}

async function parseProviderJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw new GatewayHttpError({
      status: 502,
      type: "provider_bad_response",
      code: "provider_invalid_json",
      message: "Provider returned a non-JSON response.",
      retryable: true,
      raw: error,
    });
  }
}

function apiKeyFor(candidate: GatewayRouteCandidate, env: Record<string, string | undefined>): string {
  const apiKeyEnv = providerCredentialEnv(candidate.provider);
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (providerRequiresCredential(candidate.provider) && !apiKey) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_config_error",
      code: "provider_key_missing",
      message: `Provider ${candidate.provider.id} is missing API key env ${apiKeyEnv ?? "(none)"}.`,
    });
  }
  return apiKey ?? "";
}

async function callProvider(
  options: GatewayRuntimeOptions,
  request: OpenAIChatCompletionRequest,
  candidate: GatewayRouteCandidate,
  decision: GatewayRouteDecision,
): Promise<Response> {
  const adapter = adapterForProvider(candidate.provider);
  return adapter.send({
    provider: candidate.provider,
    model: candidate.model,
    request: requestWithEffectivePolicy(request, decision),
    apiKey: apiKeyFor(candidate, options.env ?? process.env),
    timeoutMs: options.config.server.requestTimeoutMs,
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl,
  });
}

async function openProviderStream(
  options: GatewayRuntimeOptions,
  request: OpenAIChatCompletionRequest,
  candidate: GatewayRouteCandidate,
  decision: GatewayRouteDecision,
): Promise<Response> {
  const adapter = adapterForProvider(candidate.provider);
  return adapter.stream({
    provider: candidate.provider,
    model: candidate.model,
    request: requestWithEffectivePolicy(request, decision),
    apiKey: apiKeyFor(candidate, options.env ?? process.env),
    timeoutMs: options.config.server.requestTimeoutMs,
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl,
  });
}

async function providerErrorFromResponse(candidate: GatewayRouteCandidate, response: Response): Promise<GatewayHttpError> {
  const bodyText = await response.text().catch(() => "");
  const adapter = adapterForProvider(candidate.provider);
  const mapped = adapter.mapError(response, bodyText);
  mapped.provider = candidate.provider.id;
  return providerErrorToGateway(mapped);
}

async function appendUsageLedgerBestEffort(input: Parameters<typeof appendUsageLedger>[0]): Promise<void> {
  try {
    await appendUsageLedger(input);
  } catch (error) {
    if ((input.budgets?.length ?? 0) > 0) throw error;
    // Usage ledger persistence is observability/accounting for already-consumed provider work.
    // Budget checks remain fail-closed before and after this best-effort write.
  }
}

export async function createChatCompletion(
  options: GatewayRuntimeOptions,
  request: OpenAIChatCompletionRequest,
): Promise<CompletionResult> {
  const env = options.env ?? process.env;
  const requestBudgetContext = budgetContextFromRequest(request, options.budgetContext);
  await assertBudgetPreflight(options.config, requestBudgetContext, { env });
  const route = resolveRoute(options, request);
  const maxAttempts = Math.min(options.config.server.maxFallbackAttempts, route.candidates.length);
  let lastError: GatewayHttpError | undefined;

  for (const candidate of route.candidates.slice(0, maxAttempts)) {
    const started = Date.now();
    const budgetContext = { ...requestBudgetContext, selectedModel: candidate.model.id };
    try {
      await assertBudgetPreflight(options.config, budgetContext, { env });
      const cacheKey = responseCacheKey(options, request, candidate, budgetContext);
      const cachedResult = readResponseCache(options, cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      const response = await callProvider(options, request, candidate, route.decision);
      const latencyMs = Date.now() - started;

      if (!response.ok) {
        const error = await providerErrorFromResponse(candidate, response);
        route.decision.attempts.push({
          provider: candidate.provider.id,
          model: candidate.model.id,
          providerModel: candidate.model.providerModel,
          status: "failed",
          reason: error.message,
          errorType: error.type,
          errorCode: error.code,
          retryable: error.retryable,
          latencyMs,
        });
        lastError = error;
        if (error.retryable) continue;
        throw error;
      }

      route.decision.selected = candidate.model.id;
      route.decision.attempts.push({
        provider: candidate.provider.id,
        model: candidate.model.id,
        providerModel: candidate.model.providerModel,
        status: "selected",
        latencyMs,
      });

      const providerJson = await parseProviderJson(response);
      const rawUsage = providerJson.usage;
      if (rawUsage === undefined && options.rateLimit?.requiresStreamingUsage === true) {
        throw new GatewayHttpError({
          status: 429,
          type: "gateway_rate_limit_error",
          code: "gateway_token_usage_missing",
          message: "Provider response did not include usage required to enforce a token rate limit.",
          raw: { context: budgetContext },
        });
      }
      const usage = normalizeUsage(rawUsage);
      await options.rateLimit?.onUsage?.(usage);
      const estimatedCostUsd = estimateCostUsd(usage, candidate.model);
      const budgets = await evaluateBudgetPostflight(
        options.config,
        budgetContext,
        spendFromUsage(usage, estimatedCostUsd),
        { env },
      );
      const body: Record<string, unknown> = {
        ...providerJson,
        id: providerJson.id ?? `chatcmpl_gateway_${crypto.randomUUID()}`,
        object: "chat.completion",
        created: providerJson.created ?? Math.floor(Date.now() / 1000),
        model: candidate.model.id,
        usage: toOpenAIUsage(usage),
      };

      if (includeGatewayMetadata(options, request)) {
        body.gateway = metadataFor(candidate, route.decision, estimatedCostUsd, budgets);
      }

      await appendUsageLedgerBestEffort({
        config: options.config,
        provider: candidate.provider,
        model: candidate.model,
        decision: route.decision,
        context: budgetContext,
        usage,
        estimatedCostUsd,
        budgets,
        status: "success",
        env,
      });

      assertBudgetPostflight(budgets);
      const result = { body, status: 200, decision: route.decision };
      writeResponseCache(options, cacheKey, result);
      return result;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayHttpError
          ? error
          : new GatewayHttpError({
              status: 502,
              type: "provider_unavailable",
              code: "provider_fetch_failed",
              message: error instanceof Error ? error.message : "Provider fetch failed.",
              retryable: true,
              provider: candidate.provider.id,
            });

      lastError = gatewayError;
      if (!route.decision.attempts.some((attempt) => attempt.provider === candidate.provider.id && attempt.status === "failed")) {
        route.decision.attempts.push({
          provider: candidate.provider.id,
          model: candidate.model.id,
          providerModel: candidate.model.providerModel,
          status: "failed",
          reason: gatewayError.message,
          errorType: gatewayError.type,
          errorCode: gatewayError.code,
          retryable: gatewayError.retryable,
          latencyMs: Date.now() - started,
        });
      }

      if (gatewayError.retryable) continue;
      throw gatewayError;
    }
  }

  throw new GatewayHttpError({
    status: lastError?.status ?? 502,
    type: lastError?.type ?? "gateway_routing_error",
    code: lastError?.code ?? "all_routes_failed",
    message: lastError?.message ?? `All route attempts failed for model '${request.model}'.`,
    retryable: false,
    raw: route.decision,
  });
}

export async function createChatCompletionStream(
  options: GatewayRuntimeOptions,
  request: OpenAIChatCompletionRequest,
): Promise<Response> {
  const env = options.env ?? process.env;
  const requestBudgetContext = budgetContextFromRequest(request, options.budgetContext);
  await assertBudgetPreflight(options.config, requestBudgetContext, { env });
  const route = resolveRoute(options, request);
  const maxAttempts = Math.min(options.config.server.maxFallbackAttempts, route.candidates.length);
  let lastError: GatewayHttpError | undefined;

  for (const candidate of route.candidates.slice(0, maxAttempts)) {
    const started = Date.now();
    let response: Response;
    const budgetContext = { ...requestBudgetContext, selectedModel: candidate.model.id };
    let hardBudgetRequiresUsage = false;
    const rateLimitRequiresUsage = options.rateLimit?.requiresStreamingUsage === true;
    try {
      const budgetStatuses = await assertBudgetPreflight(options.config, budgetContext, { env });
      const budgetedRequest = budgetStatuses.length > 0 || rateLimitRequiresUsage
        ? requestWithStreamingUsage(request)
        : request;
      hardBudgetRequiresUsage = budgetStatuses.some((status) => status.budget.mode === "hard");
      response = await openProviderStream(options, budgetedRequest, candidate, route.decision);
    } catch (error) {
      lastError =
        error instanceof GatewayHttpError
          ? error
          : new GatewayHttpError({
              status: 502,
              type: "provider_unavailable",
              code: "provider_fetch_failed",
              message: error instanceof Error ? error.message : "Provider stream failed.",
              retryable: true,
              provider: candidate.provider.id,
            });
      route.decision.attempts.push({
        provider: candidate.provider.id,
        model: candidate.model.id,
        providerModel: candidate.model.providerModel,
        status: "failed",
        reason: lastError.message,
        errorType: lastError.type,
        errorCode: lastError.code,
        retryable: lastError.retryable,
        latencyMs: Date.now() - started,
      });
      if (lastError.retryable) continue;
      throw lastError;
    }
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const error = await providerErrorFromResponse(candidate, response);
      route.decision.attempts.push({
        provider: candidate.provider.id,
        model: candidate.model.id,
        providerModel: candidate.model.providerModel,
        status: "failed",
        reason: error.message,
        errorType: error.type,
        errorCode: error.code,
        retryable: error.retryable,
        latencyMs,
      });
      lastError = error;
      if (error.retryable) continue;
      throw error;
    }

    route.decision.selected = candidate.model.id;
    route.decision.attempts.push({
      provider: candidate.provider.id,
      model: candidate.model.id,
      providerModel: candidate.model.providerModel,
      status: "selected",
      latencyMs,
    });

    let streamBudgetAccounted = false;
    const accountStreamingUsage = async (
      rawUsage: unknown,
      status: "success" | "error",
      errorType?: string,
      errorCode?: string,
    ) => {
      const usage = rawUsage === undefined ? undefined : normalizeUsage(rawUsage);
      if (usage) await options.rateLimit?.onUsage?.(usage);
      const estimatedCostUsd = usage ? estimateCostUsd(usage, candidate.model) : undefined;
      const budgets = await evaluateBudgetPostflight(
        options.config,
        budgetContext,
        spendFromUsage(usage, estimatedCostUsd),
        { env },
      );
      await appendUsageLedgerBestEffort({
        config: options.config,
        provider: candidate.provider,
        model: candidate.model,
        decision: route.decision,
        context: budgetContext,
        usage,
        estimatedCostUsd,
        budgets,
        status,
        errorType,
        errorCode,
        env,
      });
      streamBudgetAccounted = true;
      if (status === "success") assertBudgetPostflight(budgets);
    };

    return transformOpenAICompatibleStream(response, {
      provider: candidate.provider,
      model: candidate.model,
      decision: route.decision,
      includeGatewayMetadata: includeGatewayMetadata(options, request),
      onUsage: async (rawUsage) => {
        await accountStreamingUsage(rawUsage, "success");
      },
      onComplete: async (result) => {
        if (streamBudgetAccounted) return;
        if (result.status === "success" && result.rawUsage === undefined) {
          if (hardBudgetRequiresUsage) {
            throw new GatewayHttpError({
              status: 402,
              type: "gateway_budget_error",
              code: "budget_usage_missing",
              message: "Provider stream did not include usage required to enforce a hard budget.",
              raw: { context: budgetContext },
            });
          }
          if (rateLimitRequiresUsage) {
            throw new GatewayHttpError({
              status: 429,
              type: "gateway_rate_limit_error",
              code: "gateway_token_usage_missing",
              message: "Provider stream did not include usage required to enforce a token rate limit.",
              raw: { context: budgetContext },
            });
          }
        }
        await accountStreamingUsage(result.rawUsage, result.status, result.errorType, result.errorCode);
      },
    });
  }

  throw new GatewayHttpError({
    status: lastError?.status ?? 502,
    type: lastError?.type ?? "gateway_routing_error",
    code: lastError?.code ?? "all_routes_failed",
    message: lastError?.message ?? `All stream route attempts failed for model '${request.model}'.`,
    retryable: false,
    raw: route.decision,
  });
}

export function providerErrorMessageFromBody(body: unknown): string | undefined {
  return extractProviderMessage(body);
}
