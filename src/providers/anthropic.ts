import { mapProviderStatus, redactSensitiveText } from "../errors";
import type {
  ChatMessage,
  GatewayModelCapability,
  GatewayProviderError,
  OpenAIChatCompletionRequest,
  ProviderAdapter,
  ProviderBuildInput,
  ProviderHttpRequest,
} from "../types";

type AnthropicContentBlock = Record<string, unknown>;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function createAbortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  if (signal) return signal;
  return AbortSignal.timeout(timeoutMs);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textFromContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicContentFrom(content: ChatMessage["content"]): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const blocks = content.flatMap((block): AnthropicContentBlock[] => {
    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "text", text: block.text }];
    }

    if (block.type === "image_url" && objectRecord(block.image_url).url) {
      return [
        {
          type: "image",
          source: {
            type: "url",
            url: objectRecord(block.image_url).url,
          },
        },
      ];
    }

    return [];
  });

  return blocks.length ? blocks : textFromContent(content);
}

function anthropicToolUseBlocksFrom(toolCalls: unknown): AnthropicContentBlock[] {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls.flatMap((toolCall): AnthropicContentBlock[] => {
    const record = objectRecord(toolCall);
    const fn = objectRecord(record.function);
    if (record.type !== "function" || typeof record.id !== "string" || typeof fn.name !== "string") return [];

    let input: unknown = {};
    if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
      try {
        input = JSON.parse(fn.arguments);
      } catch {
        input = { arguments: fn.arguments };
      }
    }

    return [
      {
        type: "tool_use",
        id: record.id,
        name: fn.name,
        input,
      },
    ];
  });
}

function anthropicToolResultFrom(message: ChatMessage): AnthropicContentBlock[] {
  if (message.role !== "tool" || typeof message.tool_call_id !== "string") return [];
  return [
    {
      type: "tool_result",
      tool_use_id: message.tool_call_id,
      content: textFromContent(message.content),
    },
  ];
}

function anthropicAssistantContentFrom(message: ChatMessage): string | AnthropicContentBlock[] {
  const toolUseBlocks = anthropicToolUseBlocksFrom(message.tool_calls);
  if (toolUseBlocks.length === 0) return anthropicContentFrom(message.content);

  const text = textFromContent(message.content);
  return [...(text ? [{ type: "text", text }] : []), ...toolUseBlocks];
}

function appendMessage(messages: AnthropicMessage[], role: "user" | "assistant", content: string | AnthropicContentBlock[]): void {
  const previous = messages[messages.length - 1];
  if (!previous || previous.role !== role || Array.isArray(previous.content) || Array.isArray(content)) {
    messages.push({ role, content });
    return;
  }

  previous.content = [previous.content, content].filter(Boolean).join("\n\n");
}

function anthropicMessagesFrom(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const content = textFromContent(message.content);
      if (content) systemParts.push(content);
      continue;
    }

    if (message.role === "assistant") {
      appendMessage(anthropicMessages, "assistant", anthropicAssistantContentFrom(message));
      continue;
    }

    const toolResult = anthropicToolResultFrom(message);
    appendMessage(anthropicMessages, "user", toolResult.length ? toolResult : anthropicContentFrom(message.content));
  }

  return {
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    messages: anthropicMessages,
  };
}

function anthropicToolsFrom(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;

  const anthropicTools = tools.flatMap((tool): unknown[] => {
    const record = objectRecord(tool);
    const fn = objectRecord(record.function);
    if (record.type !== "function" || typeof fn.name !== "string") return [];
    return [
      {
        name: fn.name,
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        input_schema: objectRecord(fn.parameters),
      },
    ];
  });

  return anthropicTools.length ? anthropicTools : undefined;
}

function anthropicToolChoiceFrom(toolChoice: unknown): unknown {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === "auto" || toolChoice === "none") return { type: toolChoice };
  if (toolChoice === "required") return { type: "any" };

  const record = objectRecord(toolChoice);
  const fn = objectRecord(record.function);
  if (record.type === "function" && typeof fn.name === "string") {
    return { type: "tool", name: fn.name };
  }

  return undefined;
}

export function toAnthropicMessagesBody(
  request: OpenAIChatCompletionRequest,
  providerModel: string,
): Record<string, unknown> {
  const { system, messages } = anthropicMessagesFrom(request.messages);
  const maxTokens = request.max_tokens ?? request.max_completion_tokens ?? 1024;
  const body: Record<string, unknown> = {
    model: providerModel,
    messages,
    max_tokens: maxTokens,
  };

  if (system) body.system = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.stop !== undefined) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  if (request.metadata !== undefined) body.metadata = request.metadata;

  const tools = anthropicToolsFrom(request.tools);
  if (tools) body.tools = tools;

  const toolChoice = anthropicToolChoiceFrom(request.tool_choice);
  if (toolChoice) body.tool_choice = toolChoice;

  return body;
}

function finishReasonFrom(stopReason: unknown): string | null {
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "stop_sequence") return "stop";
  if (stopReason === "tool_use") return "tool_calls";
  return typeof stopReason === "string" ? stopReason : null;
}

function responseTextFrom(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      const record = objectRecord(block);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("");
}

function openAIToolCallsFrom(content: unknown): unknown[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const toolCalls = content.flatMap((block): unknown[] => {
    const record = objectRecord(block);
    if (record.type !== "tool_use" || typeof record.id !== "string" || typeof record.name !== "string") return [];

    return [
      {
        id: record.id,
        type: "function",
        function: {
          name: record.name,
          arguments: JSON.stringify(record.input ?? {}),
        },
      },
    ];
  });

  return toolCalls.length ? toolCalls : undefined;
}

export function toOpenAIChatCompletionResponse(
  anthropicBody: Record<string, unknown>,
  requestedModel: string,
): Record<string, unknown> {
  const toolCalls = openAIToolCallsFrom(anthropicBody.content);
  const text = responseTextFrom(anthropicBody.content);
  return {
    id: typeof anthropicBody.id === "string" ? anthropicBody.id : `chatcmpl_anthropic_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (toolCalls ? null : ""),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReasonFrom(anthropicBody.stop_reason),
      },
    ],
    usage: anthropicBody.usage,
  };
}

async function normalizeAnthropicResponse(response: Response, requestedModel: string): Promise<Response> {
  if (!response.ok) return response;

  const anthropicBody = (await response.json()) as Record<string, unknown>;
  return new Response(JSON.stringify(toOpenAIChatCompletionResponse(anthropicBody, requestedModel)), {
    status: response.status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function unsupportedResponse(message: string): Response {
  return Response.json(
    {
      error: {
        message,
        type: "provider_bad_request",
        code: "provider_unsupported_feature",
      },
    },
    { status: 400 },
  );
}

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly id = "anthropic";
  readonly kind = "anthropic";
  readonly supports: GatewayModelCapability[] = ["chat", "tools", "vision", "reasoning"];

  buildRequest(input: ProviderBuildInput): ProviderHttpRequest {
    const body = toAnthropicMessagesBody(input.request, input.model.providerModel);

    return {
      url: joinUrl(input.provider.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL, "/messages"),
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: createAbortSignal(input.timeoutMs, input.signal),
      },
    };
  }

  async send(input: ProviderBuildInput): Promise<Response> {
    if (input.request.response_format !== undefined) {
      return unsupportedResponse("Anthropic Messages adapter does not support OpenAI response_format.");
    }

    const request = this.buildRequest({
      ...input,
      request: {
        ...input.request,
        stream: false,
      },
    });
    const response = await (input.fetchImpl ?? fetch)(request.url, request.init);
    return normalizeAnthropicResponse(response, input.model.providerModel);
  }

  async stream(): Promise<Response> {
    return unsupportedResponse("Anthropic Messages streaming is not implemented.");
  }

  mapError(response: Response, bodyText?: string): GatewayProviderError {
    const mapped = mapProviderStatus(response.status);
    return {
      status: response.status,
      type: mapped.type,
      code: mapped.code,
      retryable: mapped.retryable,
      message: anthropicErrorMessage(response, bodyText),
    };
  }
}

export function anthropicErrorMessage(response: Response, bodyText?: string): string {
  if (!bodyText) {
    return `Provider returned HTTP ${response.status}.`;
  }

  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; type?: string };
      message?: string;
    };
    return redactSensitiveText(parsed.error?.message ?? parsed.message ?? `Provider returned HTTP ${response.status}.`);
  } catch {
    return `Provider returned HTTP ${response.status}.`;
  }
}
