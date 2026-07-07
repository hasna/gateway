import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("gateway contract CLI output", () => {
  test("emits decision envelope and capability-card contracts only behind --contract", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-contract-cli-"));
    try {
      const configPath = join(root, "gateway.config.json");
      writeFileSync(configPath, JSON.stringify(testConfig(), null, 2), "utf8");
      const env = {
        GATEWAY_API_KEY: "placeholder-gateway",
        OPENAI_API_KEY: "placeholder-openai",
        DEEPSEEK_API_KEY: "placeholder-deepseek",
      };

      const rawRoute = runGateway(["route", "--config", configPath, "--model", "coding", "--json"], env);
      expect(rawRoute.exitCode).toBe(0);
      const rawRoutePayload = JSON.parse(text(rawRoute.stdout)) as { schema?: string; selected?: string };
      expect(rawRoutePayload.schema).toBeUndefined();
      expect(rawRoutePayload.selected).toBe("openai/gpt-4.1-mini");

      const contractRoute = runGateway(["route", "--config", configPath, "--model", "coding", "--json", "--contract"], env);
      expect(contractRoute.exitCode).toBe(0);
      const contractRoutePayload = JSON.parse(text(contractRoute.stdout)) as {
        schema: string;
        decisionType: string;
        selected: Array<{ externalId?: string }>;
      };
      expect(contractRoutePayload.schema).toBe("hasna.decision_envelope.v1");
      expect(contractRoutePayload.decisionType).toBe("model_route");
      expect(contractRoutePayload.selected[0]?.externalId).toBe("openai/gpt-4.1-mini");

      const rawRoutes = runGateway(["routes", "--config", configPath, "--json"]);
      expect(rawRoutes.exitCode).toBe(0);
      const rawRoutesPayload = JSON.parse(text(rawRoutes.stdout)) as Array<{ schema?: string; id: string }>;
      expect(rawRoutesPayload[0]?.schema).toBeUndefined();
      expect(rawRoutesPayload[0]?.id).toBe("coding");

      const contractRoutes = runGateway(["routes", "--config", configPath, "--json", "--contract"]);
      expect(contractRoutes.exitCode).toBe(0);
      const contractRoutesPayload = JSON.parse(text(contractRoutes.stdout)) as Array<{
        schema: string;
        kind: string;
        name: string;
      }>;
      expect(contractRoutesPayload[0]?.schema).toBe("hasna.capability_card.v1");
      expect(contractRoutesPayload[0]?.kind).toBe("model");
      expect(contractRoutesPayload[0]?.name).toBe("openai/gpt-4.1-mini");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
