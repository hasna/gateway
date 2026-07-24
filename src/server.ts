import { gatewayErrorResponse, GatewayHttpError, jsonError } from "./errors";
import { fingerprintGatewayKey } from "./budget";
import { validateRuntimeSecrets } from "./config";
import { createChatCompletion, createChatCompletionStream, createEmbeddings } from "./gateway";
import { GatewayKeyRateLimiter, gatewayRateLimitKey, type GatewayRateLimitExceeded } from "./rate-limit";
import type {
  GatewayConfig,
  GatewayFetch,
  GatewayRuntimeOptions,
  OpenAIChatCompletionRequest,
  OpenAIEmbeddingsInput,
  OpenAIEmbeddingsRequest,
} from "./types";
import { gatewayVersion } from "./version";

type ServerOptions = {
  config: GatewayConfig;
  env?: Record<string, string | undefined>;
  fetchImpl?: GatewayFetch;
};

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

function validateGatewayAuth(request: Request, config: GatewayConfig, env: Record<string, string | undefined>): void {
  if (!config.auth.required) return;
  const expected = env[config.auth.apiKeyEnv];
  if (!expected) {
    throw new GatewayHttpError({
      status: 500,
      type: "gateway_config_error",
      code: "gateway_key_missing",
      message: `Gateway API key env var ${config.auth.apiKeyEnv} is not set.`,
    });
  }
  if (bearerToken(request) !== expected) {
    throw new GatewayHttpError({
      status: 401,
      type: "gateway_auth_error",
      code: "unauthorized",
      message: "Invalid or missing gateway bearer token.",
    });
  }
}

function corsHeaders(request: Request, config: GatewayConfig): HeadersInit {
  const origin = request.headers.get("origin");
  if (origin && !config.server.corsAllowedOrigins.includes(origin)) {
    return {};
  }
  const allowedHeaders = new Set(["authorization", "content-type", "x-gateway-tenant"]);
  allowedHeaders.add(config.server.responseCache.bypassHeader.toLowerCase());
  return {
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": [...allowedHeaders].join(","),
    "access-control-expose-headers": "retry-after",
  };
}

function json(request: Request, config: GatewayConfig, data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(request, config) });
}

function rateLimitResponse(request: Request, config: GatewayConfig, exceeded: GatewayRateLimitExceeded): Response {
  return Response.json(
    {
      error: {
        message: `Gateway ${exceeded.kind} rate limit exceeded. Retry after ${exceeded.retryAfterSeconds} seconds.`,
        type: "gateway_rate_limit_error",
        code: exceeded.kind === "requests" ? "gateway_request_rate_limit" : "gateway_token_rate_limit",
      },
    },
    {
      status: 429,
      headers: {
        ...corsHeaders(request, config),
        "retry-after": String(exceeded.retryAfterSeconds),
      },
    },
  );
}

async function parseJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new GatewayHttpError({
      status: 413,
      type: "gateway_bad_request",
      code: "request_too_large",
      message: `Request body exceeds ${maxBytes} bytes.`,
    });
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new GatewayHttpError({
      status: 413,
      type: "gateway_bad_request",
      code: "request_too_large",
      message: `Request body exceeds ${maxBytes} bytes.`,
    });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "invalid_json",
      message: "Request body must be valid JSON.",
      raw: error,
    });
  }
}

function validateChatRequest(body: unknown): OpenAIChatCompletionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "invalid_request",
      message: "Chat completion request body must be an object.",
    });
  }

  const request = body as OpenAIChatCompletionRequest;
  if (typeof request.model !== "string" || request.model.length === 0) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "missing_model",
      message: "Chat completion request requires a model string.",
    });
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "missing_messages",
      message: "Chat completion request requires at least one message.",
    });
  }

  return request;
}

function responseCacheBypassRequested(request: Request, config: GatewayConfig): boolean {
  const value = request.headers.get(config.server.responseCache.bypassHeader);
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || !["0", "false", "no", "off"].includes(normalized);
}

function isToken(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTokenArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(isToken);
}

function isEmbeddingsInput(value: unknown): value is OpenAIEmbeddingsInput {
  if (typeof value === "string") return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every((item) => typeof item === "string")) return true;
  if (value.every(isToken)) return true;
  return value.every(isTokenArray);
}

function validateEmbeddingsRequest(body: unknown): OpenAIEmbeddingsRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "invalid_request",
      message: "Embeddings request body must be an object.",
    });
  }

  const request = body as OpenAIEmbeddingsRequest;
  if (typeof request.model !== "string" || request.model.length === 0) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "missing_model",
      message: "Embeddings request requires a model string.",
    });
  }
  if (!isEmbeddingsInput(request.input)) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "missing_input",
      message: "Embeddings request requires input as a string, string array, token array, or token array array.",
    });
  }
  if (request.encoding_format !== undefined && typeof request.encoding_format !== "string") {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "invalid_encoding_format",
      message: "Embeddings request encoding_format must be a string when provided.",
    });
  }
  if (request.dimensions !== undefined && (!Number.isInteger(request.dimensions) || request.dimensions <= 0)) {
    throw new GatewayHttpError({
      status: 400,
      type: "gateway_bad_request",
      code: "invalid_dimensions",
      message: "Embeddings request dimensions must be a positive integer when provided.",
    });
  }

  return request;
}

function modelsResponse(config: GatewayConfig): Record<string, unknown> {
  const aliasIds = new Set<string>();
  for (const model of config.models) {
    for (const alias of model.aliases ?? []) {
      aliasIds.add(alias);
    }
  }
  for (const route of config.routes) {
    for (const alias of route.modelAliases ?? []) {
      aliasIds.add(alias);
    }
  }

  const aliases = [...aliasIds].map((alias) => {
    const models = config.models.filter((model) => (model.aliases ?? []).includes(alias));
    const route = config.routes.find((candidate) => (candidate.modelAliases ?? []).includes(alias));
    const routeModelIds = route?.fallbackModelIds ?? [];
    const routeModels = routeModelIds
      .map((modelId) => config.models.find((model) => model.id === modelId))
      .filter((model): model is (typeof config.models)[number] => Boolean(model));
    const allModels = routeModels.length ? routeModels : models;
    return {
      id: alias,
      object: "model",
      owned_by: "hasna-gateway",
      providers: [...new Set(allModels.map((model) => model.providerId))],
      capabilities: [...new Set(allModels.flatMap((model) => model.capabilities))],
    };
  });

  const configuredModels = config.models.map((model) => ({
    id: model.id,
    object: "model",
    owned_by: model.providerId,
    providers: [model.providerId],
    capabilities: model.capabilities,
  }));

  return {
    object: "list",
    data: [...aliases, ...configuredModels],
  };
}

function readinessResponse(config: GatewayConfig, env: Record<string, string | undefined>): Record<string, unknown> {
  const runtimeErrors = validateRuntimeSecrets(config, env);
  const checks = [
    {
      id: "gateway-auth",
      status: config.auth.required && !env[config.auth.apiKeyEnv] ? "failed" : "passed",
      summary: config.auth.required ? `Gateway auth uses env var ${config.auth.apiKeyEnv}.` : "Gateway auth is disabled by config.",
    },
    {
      id: "provider-secrets",
      status: runtimeErrors.some((error) => error.startsWith("At least one enabled provider")) ? "failed" : "passed",
      summary: "At least one enabled provider has an environment-backed API key.",
    },
    {
      id: "usage-ledger",
      status: config.storage.usageLedgerPath || config.storage.cloud ? "passed" : "deferred",
      summary: config.storage.usageLedgerPath || config.storage.cloud
        ? "Usage ledger backend is configured."
        : "No cumulative usage ledger configured; per-request budgets can still run.",
    },
  ];
  return {
    ready: runtimeErrors.length === 0,
    version: gatewayVersion,
    checks,
    errors: runtimeErrors.map((error) => ({ code: "runtime_config", message: error })),
  };
}

function healthResponse(request: Request, config: GatewayConfig, env: Record<string, string | undefined>): Response {
  const runtimeErrors = config.runtime.health.requireRuntimeSecrets ? validateRuntimeSecrets(config, env) : [];
  const ready = runtimeErrors.length === 0;

  return json(
    request,
    config,
    {
      status: ready ? "ok" : "unhealthy",
      version: gatewayVersion,
      runtime: {
        mode: config.runtime.mode,
      },
      checks: {
        runtimeSecrets: config.runtime.health.requireRuntimeSecrets ? (ready ? "ok" : "failed") : "not_required",
      },
    },
    ready ? 200 : 503,
  );
}

export function createGatewayHandler(options: ServerOptions): (request: Request) => Promise<Response> {
  const env = options.env ?? process.env;
  const keyRateLimiter = new GatewayKeyRateLimiter();
  const runtime: GatewayRuntimeOptions = {
    config: options.config,
    env,
    fetchImpl: options.fetchImpl,
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const corsAllowed = !origin || options.config.server.corsAllowedOrigins.includes(origin);
    if (request.method === "OPTIONS") {
      if (!corsAllowed) {
        return Response.json(
          { error: { message: "CORS origin is not allowed.", type: "gateway_cors_error", code: "cors_origin_denied" } },
          { status: 403 },
        );
      }
      return new Response(null, { status: 204, headers: corsHeaders(request, options.config) });
    }
    if (!corsAllowed) {
      return Response.json(
        { error: { message: "CORS origin is not allowed.", type: "gateway_cors_error", code: "cors_origin_denied" } },
        { status: 403 },
      );
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return healthResponse(request, options.config, env);
      }

      if (request.method === "GET" && url.pathname === "/version") {
        return json(request, options.config, { name: "@hasna/gateway", version: gatewayVersion });
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        validateGatewayAuth(request, options.config, env);
        const body = readinessResponse(options.config, env);
        return json(request, options.config, body, body.ready ? 200 : 503);
      }

      if (url.pathname.startsWith("/v1/")) {
        validateGatewayAuth(request, options.config, env);
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        return json(request, options.config, modelsResponse(options.config));
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = validateChatRequest(await parseJsonBody(request, options.config.server.maxRequestBodyBytes));
        const gatewayKeyFingerprint = fingerprintGatewayKey(bearerToken(request));
        const rateLimitKey = gatewayRateLimitKey(gatewayKeyFingerprint);
        const rateLimitConfig = options.config.server.rateLimits?.perGatewayKey;
        const rateLimitCheck = keyRateLimiter.checkAndConsumeRequest(rateLimitKey, rateLimitConfig);
        if (!rateLimitCheck.allowed) {
          return rateLimitResponse(request, options.config, rateLimitCheck.exceeded);
        }

        const runtimeWithRequestContext: GatewayRuntimeOptions = {
          ...runtime,
          budgetContext: {
            gatewayKey: gatewayKeyFingerprint,
            tenant: request.headers.get("x-gateway-tenant") ?? undefined,
          },
          rateLimit: {
            onUsage: (usage) => keyRateLimiter.recordUsage(rateLimitKey, rateLimitConfig, usage),
            requiresStreamingUsage: rateLimitConfig?.tokensPerMinute !== undefined,
          },
          requestContext: {
            responseCacheBypass: responseCacheBypassRequested(request, options.config),
          },
        };
        if (body.stream) {
          return await createChatCompletionStream(runtimeWithRequestContext, body);
        }

        const result = await createChatCompletion(runtimeWithRequestContext, body);
        return json(request, options.config, result.body, result.status);
      }

      if (request.method === "POST" && url.pathname === "/v1/embeddings") {
        const body = validateEmbeddingsRequest(await parseJsonBody(request, options.config.server.maxRequestBodyBytes));
        const gatewayKeyFingerprint = fingerprintGatewayKey(bearerToken(request));
        const rateLimitKey = gatewayRateLimitKey(gatewayKeyFingerprint);
        const rateLimitConfig = options.config.server.rateLimits?.perGatewayKey;
        const rateLimitCheck = keyRateLimiter.checkAndConsumeRequest(rateLimitKey, rateLimitConfig);
        if (!rateLimitCheck.allowed) {
          return rateLimitResponse(request, options.config, rateLimitCheck.exceeded);
        }

        const runtimeWithRequestContext: GatewayRuntimeOptions = {
          ...runtime,
          budgetContext: {
            gatewayKey: gatewayKeyFingerprint,
            tenant: request.headers.get("x-gateway-tenant") ?? undefined,
          },
          rateLimit: {
            onUsage: (usage) => keyRateLimiter.recordUsage(rateLimitKey, rateLimitConfig, usage),
            requiresStreamingUsage: rateLimitConfig?.tokensPerMinute !== undefined,
          },
        };
        const result = await createEmbeddings(runtimeWithRequestContext, body);
        return json(request, options.config, result.body, result.status);
      }

      return jsonError(404, "Endpoint not found.", "gateway_routing_error", "not_found");
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };
}

export function startGatewayServer(options: ServerOptions): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: options.config.server.host,
    port: options.config.server.port,
    fetch: createGatewayHandler(options),
  });
}
