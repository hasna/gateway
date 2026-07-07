import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testConfig } from "./helpers";

function runGateway(args: string[], env: Record<string, string | undefined> = {}) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: "/tmp/bun-cache",
      TMPDIR: "/tmp/bun-tmp",
      XDG_CACHE_HOME: "/tmp/.cache",
      ...env,
    },
  });
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}

describe("gateway budget CLI", () => {
  test("defines, inspects, queries, and resets a budget in the config file", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-budget-cli-"));
    try {
      const configPath = join(root, "gateway.config.json");
      const ledgerPath = join(root, "usage.jsonl");
      const config = testConfig();
      config.storage.usageLedgerPath = ledgerPath;
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

      const add = runGateway([
        "budget-add",
        "--config",
        configPath,
        "--id",
        "cli-budget",
        "--window",
        "lifetime",
        "--mode",
        "hard",
        "--tenant",
        "acme",
        "--model",
        "coding",
        "--max-usd",
        "0.25",
        "--max-total-tokens",
        "1000",
      ]);
      expect(add.exitCode).toBe(0);
      expect(text(add.stdout)).toContain("cli-budget");

      const remaining = runGateway(["budget-remaining", "--config", configPath, "--id", "cli-budget", "--json"]);
      expect(remaining.exitCode).toBe(0);
      const payload = JSON.parse(text(remaining.stdout)) as Array<{
        budget: { id: string };
        remaining: { usd: number; totalTokens: number };
      }>;
      expect(payload[0]?.budget.id).toBe("cli-budget");
      expect(payload[0]?.remaining.usd).toBe(0.25);
      expect(payload[0]?.remaining.totalTokens).toBe(1000);

      const contractRemaining = runGateway(["budget-remaining", "--config", configPath, "--id", "cli-budget", "--json", "--contract"]);
      expect(contractRemaining.exitCode).toBe(0);
      const contractPayload = JSON.parse(text(contractRemaining.stdout)) as Array<{
        schema: string;
        id: string;
        amountMicros: number;
        resourceRefs: Array<{ kind: string; externalId?: string }>;
      }>;
      expect(contractPayload[0]?.schema).toBe("hasna.cost_estimate.v1");
      expect(contractPayload[0]?.id).toContain("cli_budget");
      expect(contractPayload[0]?.amountMicros).toBe(0);
      expect(contractPayload[0]?.resourceRefs[0]?.kind).toBe("budget");
      expect(contractPayload[0]?.resourceRefs[0]?.externalId).toBe("cli-budget");

      const reset = runGateway(["budget-reset", "--config", configPath, "--id", "cli-budget"]);
      expect(reset.exitCode).toBe(0);
      const updated = JSON.parse(readFileSync(configPath, "utf8")) as { budgets?: Array<{ id: string; resetAt?: string }> };
      expect(updated.budgets?.find((budget) => budget.id === "cli-budget")?.resetAt).toBeString();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
