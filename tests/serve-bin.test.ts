import { describe, expect, test } from "bun:test";
import { gatewayVersion } from "../src/version";

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}

describe("gateway-serve bin wrapper", () => {
  test("prints version without starting the server", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "src/serve.ts", "--version"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout).trim()).toBe(gatewayVersion);
    expect(text(result.stderr)).toBe("");
  });
});
