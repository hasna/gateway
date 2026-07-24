import { mapProviderStatus, redactSensitiveText } from "../errors";
import { buildProviderHeaders, providerBaseUrl } from "../provider-config";
import type {
  GatewayModelCapability,
  GatewayProviderConfig,
  GatewayProviderError,
  OpenAIChatCompletionRequest,
  ProviderAdapter,
  ProviderBuildInput,
  ProviderHttpRequest,
} from "../types";

const forwardedFields = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "response_format",
  "stream_options",
  "parallel_tool_calls",
  "logprobs",
  "top_logprobs",
  "metadata",
  "store",
  "max_completion_tokens",
  "reasoning_effort",
  "modalities",
  "audio",
  "prediction",
  "service_tier",
  "temperature",
  "top_p",
  "max_tokens",
  "stop",
  "seed",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "user",
]);

const openRouterProviderFields = new Set([
  "order",
  "allow_fallbacks",
  "require_parameters",
  "data_collection",
  "zdr",
  "enforce_distillable_text",
  "only",
  "ignore",
  "quantizations",
  "sort",
  "preferred_min_throughput",
  "max_price",
]);

const vercelGatewayFields = new Set(["models", "order", "only", "caching", "providerTimeouts"]);

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return result.length ? result : undefined;
}

function namespacedOptions(request: OpenAIChatCompletionRequest, namespace: string): Record<string, unknown> {
  const snake = isObject(request.provider_options?.[namespace]) ? request.provider_options[namespace] : undefined;
  const camel = isObject(request.providerOptions?.[namespace]) ? request.providerOptions[namespace] : undefined;
  return {
    ...(isObject(snake) ? snake : {}),
    ...(isObject(camel) ? camel : {}),
  };
}

function pickAllowed(input: unknown, allowed: Set<string>): Record<string, unknown> {
  if (!isObject(input)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key) && value !== undefined) output[key] = value;
  }
  return output;
}

function isOpenRouterProvider(provider: GatewayProviderConfig | undefined): boolean {
  return provider?.id === "openrouter" || provider?.kind === "openrouter";
}

function isVercelGatewayProvider(provider: GatewayProviderConfig | undefined): boolean {
  return provider?.id === "vercel-ai-gateway";
}

function openRouterProviderOptions(request: OpenAIChatCompletionRequest): Record<string, unknown> {
  const options = namespacedOptions(request, "openrouter");
  const providerOptions = {
    ...pickAllowed(request.provider, openRouterProviderFields),
    ...pickAllowed(options.provider, openRouterProviderFields),
  };

  if (request.gateway?.provider_order && providerOptions.order === undefined) {
    providerOptions.order = request.gateway.provider_order;
  }
  if (request.gateway?.provider_only && providerOptions.only === undefined) {
    providerOptions.only = request.gateway.provider_only;
  }
  if (request.gateway?.provider_ignore && providerOptions.ignore === undefined) {
    providerOptions.ignore = request.gateway.provider_ignore;
  }
  if (request.gateway?.provider_sort && providerOptions.sort === undefined) {
    providerOptions.sort = request.gateway.provider_sort;
  }
  if (request.gateway?.allow_fallbacks !== undefined && providerOptions.allow_fallbacks === undefined) {
    providerOptions.allow_fallbacks = request.gateway.allow_fallbacks;
  }
  if (request.gateway?.zdr === true) {
    providerOptions.zdr = true;
  } else if (request.gateway?.zdr !== undefined && providerOptions.zdr === undefined) {
    providerOptions.zdr = request.gateway.zdr;
  }
  if (request.gateway?.zero_data_retention_required) {
    providerOptions.zdr = true;
  }
  if (request.gateway?.data_collection && providerOptions.data_collection === undefined) {
    providerOptions.data_collection = request.gateway.data_collection;
  }
  if (request.gateway?.allow_logging === false) {
    providerOptions.data_collection = "deny";
  }
  if (request.gateway?.max_price && providerOptions.max_price === undefined) {
    providerOptions.max_price = request.gateway.max_price;
  }

  return providerOptions;
}

function sanitizeAutoRouterPlugin(input: unknown): Record<string, unknown> | undefined {
  if (!isObject(input)) return undefined;
  const plugin: Record<string, unknown> = { id: "auto-router" };
  const allowedModels = stringArray(input.allowed_models);
  if (allowedModels) plugin.allowed_models = allowedModels;
  if (typeof input.cost_quality_tradeoff === "number") {
    plugin.cost_quality_tradeoff = input.cost_quality_tradeoff;
  }
  return Object.keys(plugin).length > 1 ? plugin : undefined;
}

function openRouterPlugins(request: OpenAIChatCompletionRequest): Record<string, unknown>[] {
  const options = namespacedOptions(request, "openrouter");
  const plugins: Record<string, unknown>[] = [];

  for (const plugin of Array.isArray(request.plugins) ? request.plugins : []) {
    const sanitized = isObject(plugin) && plugin.id === "auto-router" ? sanitizeAutoRouterPlugin(plugin) : undefined;
    if (sanitized) plugins.push(sanitized);
  }

  for (const plugin of Array.isArray(options.plugins) ? options.plugins : []) {
    const sanitized = isObject(plugin) && plugin.id === "auto-router" ? sanitizeAutoRouterPlugin(plugin) : undefined;
    if (sanitized) plugins.push(sanitized);
  }

  const autoRouterOptions = {
    ...pickAllowed(options, new Set(["allowed_models", "cost_quality_tradeoff"])),
    ...pickAllowed(options.auto, new Set(["allowed_models", "cost_quality_tradeoff"])),
    ...(request.gateway?.cost_quality_tradeoff === undefined
      ? {}
      : { cost_quality_tradeoff: request.gateway.cost_quality_tradeoff }),
  };
  const autoRouterPlugin = sanitizeAutoRouterPlugin(autoRouterOptions);
  if (autoRouterPlugin) plugins.push(autoRouterPlugin);

  return plugins;
}

function applyOpenRouterOptions(body: Record<string, unknown>, request: OpenAIChatCompletionRequest): void {
  const provider = openRouterProviderOptions(request);
  if (Object.keys(provider).length > 0) body.provider = provider;

  const plugins = openRouterPlugins(request);
  if (plugins.length > 0) body.plugins = plugins;

  const options = namespacedOptions(request, "openrouter");
  const sessionId =
    (typeof options.session_id === "string" ? options.session_id : undefined) ??
    request.gateway?.sticky_session_id ??
    request.gateway?.session_id ??
    request.session_id;
  if (sessionId) body.session_id = sessionId;
}

function applyVercelGatewayOptions(body: Record<string, unknown>, request: OpenAIChatCompletionRequest): void {
  const options = namespacedOptions(request, "vercel");
  const gatewayInput = isObject(options.gateway) ? options.gateway : options;
  const gateway = pickAllowed(gatewayInput, vercelGatewayFields);

  if (request.gateway?.provider_order && gateway.order === undefined) {
    gateway.order = request.gateway.provider_order;
  }
  if (request.gateway?.provider_only && gateway.only === undefined) {
    gateway.only = request.gateway.provider_only;
  }
  if (request.gateway?.caching && gateway.caching === undefined) {
    gateway.caching = request.gateway.caching;
  }
  if (request.gateway?.provider_timeouts && gateway.providerTimeouts === undefined) {
    gateway.providerTimeouts = request.gateway.provider_timeouts;
  }

  if (Object.keys(gateway).length > 0) {
    body.providerOptions = { gateway };
  }
}

export function toProviderChatBody(
  request: OpenAIChatCompletionRequest,
  providerModel: string,
  provider?: GatewayProviderConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key === "stream_options" && !request.stream) continue;
    if (forwardedFields.has(key) && value !== undefined) {
      body[key] = value;
    }
  }

  body.model = providerModel;

  if (isOpenRouterProvider(provider)) {
    applyOpenRouterOptions(body, request);
  } else if (isVercelGatewayProvider(provider)) {
    applyVercelGatewayOptions(body, request);
  }

  return body;
}

function createAbortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  if (signal) return signal;
  return AbortSignal.timeout(timeoutMs);
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id = "openai-compatible";
  readonly kind = "openai-compatible";
  readonly supports: GatewayModelCapability[] = ["chat", "streaming", "tools", "json"];

  buildRequest(input: ProviderBuildInput): ProviderHttpRequest {
    const baseUrl = providerBaseUrl(input.provider, input.env);
    if (!baseUrl) {
      throw new Error(`Provider ${input.provider.id} does not define a baseUrl or resolvable baseUrlEnv.`);
    }

    const body = toProviderChatBody(input.request, input.model.providerModel, input.provider);

    return {
      url: joinUrl(baseUrl, "/chat/completions"),
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildProviderHeaders({
            provider: input.provider,
            apiKey: input.apiKey,
            env: input.env,
          }),
        },
        body: JSON.stringify(body),
        signal: createAbortSignal(input.timeoutMs, input.signal),
      },
    };
  }

  send(input: ProviderBuildInput): Promise<Response> {
    const request = this.buildRequest({
      ...input,
      request: {
        ...input.request,
        stream: false,
      },
    });
    return (input.fetchImpl ?? fetch)(request.url, request.init);
  }

  stream(input: ProviderBuildInput): Promise<Response> {
    const request = this.buildRequest({
      ...input,
      request: {
        ...input.request,
        stream: true,
      },
    });
    return (input.fetchImpl ?? fetch)(request.url, request.init);
  }

  mapError(response: Response, bodyText?: string): GatewayProviderError {
    const mapped = mapProviderStatus(response.status);
    return {
      status: response.status,
      type: mapped.type,
      code: mapped.code,
      retryable: mapped.retryable,
      message: providerErrorMessage(response, bodyText),
    };
  }
}

export function providerErrorMessage(response: Response, bodyText?: string): string {
  if (!bodyText) {
    return `Provider returned HTTP ${response.status}.`;
  }

  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; type?: string; code?: string };
      message?: string;
    };
    return redactSensitiveText(parsed.error?.message ?? parsed.message ?? `Provider returned HTTP ${response.status}.`);
  } catch {
    return `Provider returned HTTP ${response.status}.`;
  }
}
