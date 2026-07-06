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
import { resolveRoute } from "./router";
import { transformOpenAICompatibleStream } from "./streaming";
import type {
  GatewayRouteCandidate,
  GatewayRouteDecision,
  GatewayRuntimeOptions,
  GatewayUsage,
  OpenAIChatCompletionRequest,
} from "./types";
import { estimateCostUsd, normalizeUsage, toOpenAIUsage } from "./usage";

type CompletionResult = {
  body: Record<string, unknown>;
  status: number;
  decision: GatewayRouteDecision;
};

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

function metricsModelId(options: GatewayRuntimeOptions, modelId: string | undefined, providerId?: string): string | undefined {
  if (!modelId) return undefined;
  if (options.config.models.some((model) => model.id === modelId)) return modelId;
  if (providerId && options.config.providers.some((provider) => provider.id === providerId)) {
    return `${providerId}/dynamic`;
  }
  return "dynamic";
}

function metricsDecision(options: GatewayRuntimeOptions, decision: GatewayRouteDecision): GatewayRouteDecision {
  return {
    ...decision,
    selected: metricsModelId(options, decision.selected),
    resolved_candidates: decision.resolved_candidates.map((modelId) => metricsModelId(options, modelId) ?? "dynamic"),
    attempts: decision.attempts.map((attempt) => ({
      ...attempt,
      model: metricsModelId(options, attempt.model, attempt.provider) ?? "dynamic",
    })),
  };
}

function isRouteDecision(value: unknown): value is GatewayRouteDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<GatewayRouteDecision>;
  return (
    typeof record.requested_model === "string" &&
    Array.isArray(record.resolved_candidates) &&
    typeof record.mode === "string" &&
    Array.isArray(record.attempts)
  );
}

function gatewayErrorDetails(error: unknown): { errorType?: string; errorCode?: string } {
  if (error instanceof GatewayHttpError) {
    return { errorType: error.type, errorCode: error.code };
  }
  return {};
}

function recordSetupErrorMetrics(options: GatewayRuntimeOptions, stream: boolean, error: unknown): void {
  const details = gatewayErrorDetails(error);
  if (error instanceof GatewayHttpError && isRouteDecision(error.raw)) {
    recordCompletionMetrics(options, {
      stream,
      status: "error",
      decision: error.raw,
      errorType: details.errorType,
      errorCode: details.errorCode,
    });
    return;
  }
  options.metrics?.recordChatError({
    stream,
    errorType: details.errorType,
    errorCode: details.errorCode,
  });
}

function recordCompletionMetrics(
  options: GatewayRuntimeOptions,
  input: {
    stream: boolean;
    status: "success" | "error";
    decision: GatewayRouteDecision;
    candidate?: GatewayRouteCandidate;
    usage?: GatewayUsage;
    estimatedCostUsd?: number;
    errorType?: string;
    errorCode?: string;
  },
): void {
  options.metrics?.recordChatCompletion({
    stream: input.stream,
    status: input.status,
    decision: metricsDecision(options, input.decision),
    provider: input.candidate?.provider.id,
    model: metricsModelId(options, input.candidate?.model.id, input.candidate?.provider.id),
    usage: input.usage,
    estimatedCostUsd: input.estimatedCostUsd,
    errorType: input.errorType,
    errorCode: input.errorCode,
  });
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
  const apiKeyEnv = candidate.provider.apiKeyEnv;
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (!apiKey) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_config_error",
      code: "provider_key_missing",
      message: `Provider ${candidate.provider.id} is missing API key env ${apiKeyEnv ?? "(none)"}.`,
    });
  }
  return apiKey;
}

async function callProvider(
  options: GatewayRuntimeOptions,
  request: OpenAIChatCompletionRequest,
  candidate: GatewayRouteCandidate,
): Promise<Response> {
  const adapter = adapterForProvider(candidate.provider);
  return adapter.send({
    provider: candidate.provider,
    model: candidate.model,
    request,
    apiKey: apiKeyFor(candidate, options.env ?? process.env),
    timeoutMs: options.config.server.requestTimeoutMs,
    fetchImpl: options.fetchImpl,
  });
}

async function openProviderStream(
  options: GatewayRuntimeOptions,
  request: OpenAIChatCompletionRequest,
  candidate: GatewayRouteCandidate,
): Promise<Response> {
  const adapter = adapterForProvider(candidate.provider);
  return adapter.stream({
    provider: candidate.provider,
    model: candidate.model,
    request,
    apiKey: apiKeyFor(candidate, options.env ?? process.env),
    timeoutMs: options.config.server.requestTimeoutMs,
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

export async function createChatCompletion(
  options: GatewayRuntimeOptions,
  request: OpenAIChatCompletionRequest,
): Promise<CompletionResult> {
  const requestBudgetContext = budgetContextFromRequest(request, options.budgetContext);
  let route: ReturnType<typeof resolveRoute>;
  try {
    await assertBudgetPreflight(options.config, requestBudgetContext);
    route = resolveRoute(options, request);
  } catch (error) {
    recordSetupErrorMetrics(options, false, error);
    throw error;
  }
  const maxAttempts = Math.min(options.config.server.maxFallbackAttempts, route.candidates.length);
  let lastError: GatewayHttpError | undefined;

  for (const candidate of route.candidates.slice(0, maxAttempts)) {
    const started = Date.now();
    let metricsRecorded = false;
    let observedUsage: GatewayUsage | undefined;
    let observedEstimatedCostUsd: number | undefined;
    const budgetContext = { ...requestBudgetContext, selectedModel: candidate.model.id };
    try {
      await assertBudgetPreflight(options.config, budgetContext);
      const response = await callProvider(options, request, candidate);
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
      const usage = normalizeUsage(rawUsage);
      observedUsage = usage;
      const estimatedCostUsd = estimateCostUsd(usage, candidate.model);
      observedEstimatedCostUsd = estimatedCostUsd;
      const budgets = await evaluateBudgetPostflight(
        options.config,
        budgetContext,
        spendFromUsage(usage, estimatedCostUsd),
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

      await appendUsageLedger({
        config: options.config,
        provider: candidate.provider,
        model: candidate.model,
        decision: route.decision,
        context: budgetContext,
        usage,
        estimatedCostUsd,
        budgets,
        status: "success",
      });

      try {
        assertBudgetPostflight(budgets);
      } catch (error) {
        const details = gatewayErrorDetails(error);
        recordCompletionMetrics(options, {
          stream: false,
          status: "error",
          decision: route.decision,
          candidate,
          usage,
          estimatedCostUsd,
          errorType: details.errorType,
          errorCode: details.errorCode,
        });
        metricsRecorded = true;
        throw error;
      }
      recordCompletionMetrics(options, {
        stream: false,
        status: "success",
        decision: route.decision,
        candidate,
        usage,
        estimatedCostUsd,
      });
      metricsRecorded = true;
      return { body, status: 200, decision: route.decision };
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
      if (!metricsRecorded) {
        recordCompletionMetrics(options, {
          stream: false,
          status: "error",
          decision: route.decision,
          candidate,
          usage: observedUsage,
          estimatedCostUsd: observedEstimatedCostUsd,
          errorType: gatewayError.type,
          errorCode: gatewayError.code,
        });
      }
      throw gatewayError;
    }
  }

  recordCompletionMetrics(options, {
    stream: false,
    status: "error",
    decision: route.decision,
    errorType: lastError?.type,
    errorCode: lastError?.code,
  });
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
  const requestBudgetContext = budgetContextFromRequest(request, options.budgetContext);
  let route: ReturnType<typeof resolveRoute>;
  try {
    await assertBudgetPreflight(options.config, requestBudgetContext);
    route = resolveRoute(options, request);
  } catch (error) {
    recordSetupErrorMetrics(options, true, error);
    throw error;
  }
  const maxAttempts = Math.min(options.config.server.maxFallbackAttempts, route.candidates.length);
  let lastError: GatewayHttpError | undefined;

  for (const candidate of route.candidates.slice(0, maxAttempts)) {
    const started = Date.now();
    let response: Response;
    const budgetContext = { ...requestBudgetContext, selectedModel: candidate.model.id };
    let hardBudgetRequiresUsage = false;
    try {
      const budgetStatuses = await assertBudgetPreflight(options.config, budgetContext);
      const budgetedRequest = budgetStatuses.length > 0 ? requestWithStreamingUsage(request) : request;
      hardBudgetRequiresUsage = budgetStatuses.some((status) => status.budget.mode === "hard");
      response = await openProviderStream(options, budgetedRequest, candidate);
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
      recordCompletionMetrics(options, {
        stream: true,
        status: "error",
        decision: route.decision,
        candidate,
        errorType: lastError.type,
        errorCode: lastError.code,
      });
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
      recordCompletionMetrics(options, {
        stream: true,
        status: "error",
        decision: route.decision,
        candidate,
        errorType: error.type,
        errorCode: error.code,
      });
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
      const estimatedCostUsd = usage ? estimateCostUsd(usage, candidate.model) : undefined;
      const budgets = await evaluateBudgetPostflight(
        options.config,
        budgetContext,
        spendFromUsage(usage, estimatedCostUsd),
      );
      await appendUsageLedger({
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
      });
      streamBudgetAccounted = true;
      if (status === "success") {
        try {
          assertBudgetPostflight(budgets);
        } catch (error) {
          const details = gatewayErrorDetails(error);
          recordCompletionMetrics(options, {
            stream: true,
            status: "error",
            decision: route.decision,
            candidate,
            usage,
            estimatedCostUsd,
            errorType: details.errorType,
            errorCode: details.errorCode,
          });
          throw error;
        }
      }
      recordCompletionMetrics(options, {
        stream: true,
        status,
        decision: route.decision,
        candidate,
        usage,
        estimatedCostUsd,
        errorType,
        errorCode,
      });
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
        if (result.status === "success" && result.rawUsage === undefined && hardBudgetRequiresUsage) {
          throw new GatewayHttpError({
            status: 402,
            type: "gateway_budget_error",
            code: "budget_usage_missing",
            message: "Provider stream did not include usage required to enforce a hard budget.",
            raw: { context: budgetContext },
          });
        }
        await accountStreamingUsage(result.rawUsage, result.status, result.errorType, result.errorCode);
      },
    });
  }

  recordCompletionMetrics(options, {
    stream: true,
    status: "error",
    decision: route.decision,
    errorType: lastError?.type,
    errorCode: lastError?.code,
  });
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
