import type { GatewayProviderError } from "./types";

export function redactSensitiveText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.]{8,}/gi, "$1[redacted]");
}

export class GatewayHttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly raw?: unknown;

  constructor(input: {
    message: string;
    status: number;
    type: string;
    code: string;
    retryable?: boolean;
    provider?: string;
    raw?: unknown;
  }) {
    super(redactSensitiveText(input.message));
    this.name = "GatewayHttpError";
    this.status = input.status;
    this.type = input.type;
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.provider = input.provider;
    this.raw = input.raw;
  }
}

export function providerErrorToGateway(error: GatewayProviderError): GatewayHttpError {
  return new GatewayHttpError({
    message: redactSensitiveText(error.message),
    status: error.status,
    type: error.type,
    code: error.code,
    retryable: error.retryable,
    provider: error.provider,
    raw: error.raw,
  });
}

export function gatewayErrorResponse(error: unknown): Response {
  if (error instanceof GatewayHttpError) {
    return jsonError(error.status, error.message, error.type, error.code);
  }

  const message = error instanceof Error ? error.message : "Unexpected gateway error.";
  return jsonError(500, message, "gateway_internal_error", "internal_error");
}

export function jsonError(status: number, message: string, type: string, code: string): Response {
  return Response.json(
    {
      error: {
        message: redactSensitiveText(message),
        type,
        code,
      },
    },
    { status },
  );
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function mapProviderStatus(status: number): {
  type: string;
  code: string;
  retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { type: "provider_auth_error", code: "provider_auth", retryable: false };
  }
  if (status === 404) {
    return { type: "provider_bad_request", code: "provider_model_not_found", retryable: false };
  }
  if (status === 400 || status === 422) {
    return { type: "provider_bad_request", code: "provider_bad_request", retryable: false };
  }
  if (status === 408 || status === 429) {
    return { type: "provider_rate_limit", code: "provider_rate_limit", retryable: true };
  }
  if (status >= 500) {
    return { type: "provider_unavailable", code: "provider_unavailable", retryable: true };
  }
  return {
    type: "provider_stream_error",
    code: "provider_error",
    retryable: isRetryableStatus(status),
  };
}
