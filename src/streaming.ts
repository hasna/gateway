import type { GatewayModelConfig, GatewayProviderConfig, GatewayRouteDecision } from "./types";

export type StreamCompletionResult = {
  status: "success" | "error";
  rawUsage?: unknown;
  errorType?: string;
  errorCode?: string;
};

export type StreamTransformOptions = {
  provider: GatewayProviderConfig;
  model: GatewayModelConfig;
  decision: GatewayRouteDecision;
  includeGatewayMetadata: boolean;
  onUsage?: (rawUsage: unknown) => Promise<void> | void;
  onComplete?: (result: StreamCompletionResult) => Promise<void> | void;
};

const doneFrame = "data: [DONE]\n\n";

function gatewayMetadata(options: StreamTransformOptions): Record<string, unknown> {
  return {
    provider: options.provider.id,
    provider_model: options.model.providerModel,
    route_mode: options.decision.mode,
    attempts: options.decision.attempts.filter((attempt) => attempt.status !== "skipped").length || 1,
  };
}

type NormalizedChunk = {
  payload: string;
  done: boolean;
  rawUsage?: unknown;
};

function normalizeChunk(raw: string, options: StreamTransformOptions): NormalizedChunk {
  if (raw.trim() === "[DONE]") return { payload: "[DONE]", done: true };

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const rawUsage = parsed.usage;
  parsed.model = options.model.id;
  if (options.includeGatewayMetadata) {
    parsed.gateway = gatewayMetadata(options);
  }
  return { payload: JSON.stringify(parsed), done: false, rawUsage };
}

function providerStreamError(message: string): string {
  return JSON.stringify({
    error: {
      message,
      type: "provider_stream_error",
      code: "provider_stream_invalid_chunk",
    },
  });
}

function streamErrorDetails(error: unknown): { message: string; type: string; code: string } {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    message: error instanceof Error ? error.message : "Gateway stream processing failed.",
    type: typeof record.type === "string" ? record.type : "gateway_stream_error",
    code: typeof record.code === "string" ? record.code : "gateway_stream_failed",
  };
}

function gatewayStreamError(error: unknown): string {
  const details = streamErrorDetails(error);
  return JSON.stringify({
    error: {
      message: details.message,
      type: details.type,
      code: details.code,
    },
  });
}

function eventBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function dataPayloads(event: string): string[] {
  const payloads: string[] = [];
  let current: string[] = [];
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith(":") || line.length === 0) continue;
    if (!line.startsWith("data:")) continue;
    current.push(line.slice(5).trimStart());
  }

  if (current.length > 0) {
    payloads.push(current.join("\n"));
  }
  return payloads.filter((payload) => payload.length > 0);
}

export function transformOpenAICompatibleStream(response: Response, options: StreamTransformOptions): Response {
  if (!response.body) {
    return new Response(doneFrame, {
      headers: streamingHeaders(),
    });
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneSent = false;
  let closed = false;
  let completed = false;
  let streamFailed = false;
  let rawUsage: unknown;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.enqueue(encoder.encode(doneFrame));
        controller.close();
        return;
      }

      function closeOnce(): void {
        if (!closed) {
          controller.close();
          closed = true;
        }
      }

      async function completeOnce(result: StreamCompletionResult): Promise<void> {
        if (completed) return;
        await options.onComplete?.(result);
        completed = true;
      }

      async function failStream(errorPayload: string, result: StreamCompletionResult): Promise<void> {
        streamFailed = true;
        controller.enqueue(encoder.encode(`data: ${errorPayload}\n\n`));
        if (!doneSent) {
          controller.enqueue(encoder.encode(doneFrame));
          doneSent = true;
        }
        await completeOnce(result);
        closeOnce();
      }

      async function completeSuccessBeforeDone(): Promise<boolean> {
        try {
          await completeOnce({ status: "success", rawUsage });
          return true;
        } catch (error) {
          const details = streamErrorDetails(error);
          await failStream(gatewayStreamError(error), {
            status: "error",
            errorType: details.type,
            errorCode: details.code,
          });
          return false;
        }
      }

      async function enqueuePayload(payload: string): Promise<void> {
        let normalized: NormalizedChunk;
        try {
          normalized = normalizeChunk(payload, options);
        } catch {
          await failStream(providerStreamError("Provider stream chunk was not valid JSON."), {
            status: "error",
            errorType: "provider_stream_error",
            errorCode: "provider_stream_invalid_chunk",
          });
          return;
        }

        if (normalized.rawUsage !== undefined) {
          rawUsage = normalized.rawUsage;
          try {
            await options.onUsage?.(normalized.rawUsage);
          } catch (error) {
            const details = streamErrorDetails(error);
            await failStream(gatewayStreamError(error), {
              status: "error",
              errorType: details.type,
              errorCode: details.code,
            });
            return;
          }
        }

        if (normalized.done) {
          if (!doneSent) {
            const completedOk = await completeSuccessBeforeDone();
            if (!completedOk) return;
            controller.enqueue(encoder.encode(doneFrame));
            doneSent = true;
          }
          return;
        }

        controller.enqueue(encoder.encode(`data: ${normalized.payload}\n\n`));
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = eventBoundary(buffer);
          while (boundary) {
            const event = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary.length);
            for (const payload of dataPayloads(event)) {
              await enqueuePayload(payload);
              if (doneSent) break;
            }
            if (doneSent) break;
            boundary = eventBoundary(buffer);
          }
          if (doneSent) break;
        }

        const trailing = buffer.trim();
        if (!doneSent && trailing.length > 0) {
          for (const payload of dataPayloads(trailing)) {
            await enqueuePayload(payload);
            if (doneSent) break;
          }
        }
        if (!doneSent) {
          const completedOk = await completeSuccessBeforeDone();
          if (completedOk) {
            controller.enqueue(encoder.encode(doneFrame));
            doneSent = true;
          }
        }
        closeOnce();
      } catch (error) {
        streamFailed = true;
        await completeOnce({
          status: "error",
          errorType: "provider_stream_error",
          errorCode: "provider_stream_read_failed",
        });
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, { headers: streamingHeaders() });
}

export function streamingHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}
