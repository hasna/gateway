import { describe, expect, test } from "bun:test";
import {
  GatewayHttpError,
  gatewayErrorResponse,
  isRetryableStatus,
  mapProviderStatus,
  redactSensitiveText,
} from "../src/errors";

describe("error redaction", () => {
  test("redacts provider key fragments in messages", () => {
    const fakeProviderKey = ["sk", "proj", "masked", "tail"].join("-");
    const redacted = redactSensitiveText(`Incorrect API key provided: "${fakeProviderKey}".`);

    expect(redacted).not.toContain("proj");
    expect(redacted).toContain("[redacted-api-key]");
    expect(redactSensitiveText("Authorization: Bearer secret-token-12345")).toContain("Bearer [redacted]");
  });

  test("maps provider HTTP statuses to gateway error metadata", () => {
    expect(mapProviderStatus(401)).toEqual({
      type: "provider_auth_error",
      code: "provider_auth",
      retryable: false,
    });
    expect(mapProviderStatus(404)).toMatchObject({ code: "provider_model_not_found", retryable: false });
    expect(mapProviderStatus(429)).toMatchObject({ code: "provider_rate_limit", retryable: true });
    expect(mapProviderStatus(503)).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(mapProviderStatus(418)).toMatchObject({ code: "provider_error" });
  });

  test("classifies retryable HTTP statuses", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });

  test("returns structured gateway error responses", async () => {
    const response = gatewayErrorResponse(
      new GatewayHttpError({
        status: 401,
        type: "gateway_auth_error",
        code: "unauthorized",
        message: "bad token",
      }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });

  test("returns internal error for unexpected throwables", async () => {
    const response = gatewayErrorResponse(new Error("boom"));
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal_error");
  });
});
