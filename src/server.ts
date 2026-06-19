import { gatewayErrorResponse, GatewayHttpError, jsonError } from "./errors";
import { createChatCompletion, createChatCompletionStream } from "./gateway";
import type { GatewayConfig, GatewayFetch, GatewayRuntimeOptions, OpenAIChatCompletionRequest } from "./types";
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

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders() });
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

export function createGatewayHandler(options: ServerOptions): (request: Request) => Promise<Response> {
  const env = options.env ?? process.env;
  const runtime: GatewayRuntimeOptions = {
    config: options.config,
    env,
    fetchImpl: options.fetchImpl,
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", version: gatewayVersion });
      }

      if (url.pathname.startsWith("/v1/")) {
        validateGatewayAuth(request, options.config, env);
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        return json(modelsResponse(options.config));
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = validateChatRequest(await parseJsonBody(request, options.config.server.maxRequestBodyBytes));
        if (body.stream) {
          return await createChatCompletionStream(runtime, body);
        }

        const result = await createChatCompletion(runtime, body);
        return json(result.body, result.status);
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
