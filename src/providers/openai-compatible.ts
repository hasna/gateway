import { mapProviderStatus, redactSensitiveText } from "../errors";
import type {
  GatewayModelCapability,
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

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function toProviderChatBody(request: OpenAIChatCompletionRequest, providerModel: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key === "stream_options" && !request.stream) continue;
    if (forwardedFields.has(key) && value !== undefined) {
      body[key] = value;
    }
  }

  body.model = providerModel;
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
    if (!input.provider.baseUrl) {
      throw new Error(`Provider ${input.provider.id} does not define a baseUrl.`);
    }

    const body = toProviderChatBody(input.request, input.model.providerModel);

    return {
      url: joinUrl(input.provider.baseUrl, "/chat/completions"),
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`,
          ...(input.provider.id === "openrouter"
            ? {
                "http-referer": "https://github.com/hasna/open-gateway",
                "x-title": "Hasna Gateway",
              }
            : {}),
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
