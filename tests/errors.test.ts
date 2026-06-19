import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "../src/errors";

describe("error redaction", () => {
  test("redacts provider key fragments in messages", () => {
    const fakeProviderKey = ["sk", "proj", "masked", "tail"].join("-");
    const redacted = redactSensitiveText(`Incorrect API key provided: "${fakeProviderKey}".`);

    expect(redacted).not.toContain("proj");
    expect(redacted).toContain("[redacted-api-key]");
    expect(redactSensitiveText("Authorization: Bearer secret-token-12345")).toContain("Bearer [redacted]");
  });
});
