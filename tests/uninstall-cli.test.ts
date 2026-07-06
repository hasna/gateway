import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testConfig } from "./helpers";

function runGateway(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}

function writeLocalState(root: string): { configPath: string; ledgerPath: string } {
  const configPath = join(root, "gateway.config.json");
  const ledgerPath = join(root, "usage.jsonl");
  const config = testConfig();
  config.storage.usageLedgerPath = ledgerPath;
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  writeFileSync(ledgerPath, '{"totalTokens":1}\n', "utf8");
  return { configPath, ledgerPath };
}

describe("gateway uninstall CLI", () => {
  test("refuses to remove local state without --yes", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-uninstall-cli-"));
    try {
      const { configPath, ledgerPath } = writeLocalState(root);

      const result = runGateway(["uninstall", "--config", configPath]);

      expect(result.exitCode).toBe(1);
      expect(text(result.stderr)).toContain("--yes");
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(ledgerPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses valued --yes arguments that are not bare confirmation flags", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-uninstall-cli-"));
    try {
      const { configPath, ledgerPath } = writeLocalState(root);

      const result = runGateway(["uninstall", "--config", configPath, "--yes", "false"]);

      expect(result.exitCode).toBe(1);
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(ledgerPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes the selected config and configured usage ledger with --yes", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-uninstall-cli-"));
    try {
      const { configPath, ledgerPath } = writeLocalState(root);
      const unrelatedPath = join(root, "unrelated.jsonl");
      writeFileSync(unrelatedPath, "keep\n", "utf8");

      const result = runGateway(["uninstall", "--config", configPath, "--yes"]);

      expect(result.exitCode).toBe(0);
      expect(text(result.stdout)).toContain("Removed");
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(ledgerPath)).toBe(false);
      expect(existsSync(unrelatedPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supports remove --all as an uninstall alias", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-remove-cli-"));
    try {
      const { configPath, ledgerPath } = writeLocalState(root);

      const result = runGateway(["remove", "--config", configPath, "--all", "--yes"]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses remove without --all", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-remove-cli-"));
    try {
      const { configPath, ledgerPath } = writeLocalState(root);

      const result = runGateway(["remove", "--config", configPath, "--yes"]);

      expect(result.exitCode).toBe(1);
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(ledgerPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
