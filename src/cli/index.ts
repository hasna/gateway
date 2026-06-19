#!/usr/bin/env bun
import { loadGatewayConfig, validateConfig, validateRuntimeSecrets } from "../config";
import type { GatewayConfigInput } from "../types";
import { runAvailableProviderSmokeChecks, runLiveSmokeCheck } from "../smoke";
import { startGatewayServer } from "../server";
import { gatewayVersion } from "../version";

type ParsedArgs = {
  command: string;
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { command, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string, fallback: string): string {
  const value = flags[key];
  return typeof value === "string" ? value : fallback;
}

function flagNumber(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = flags[key];
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function help(): string {
  return `Hasna Gateway ${gatewayVersion}

Usage:
  gateway serve --config gateway.config.json [--host 127.0.0.1] [--port 8787]
  gateway validate --config gateway.config.json
  gateway smoke --config gateway.config.json [--model fast]
  gateway smoke --config gateway.config.json --all
  gateway help
`;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  const configPath = flagString(parsed.flags, "config", "gateway.config.json");

  if (parsed.command === "help" || parsed.flags.help) {
    console.log(help());
    return;
  }

  if (parsed.command === "validate") {
    const raw = JSON.parse(await Bun.file(configPath).text()) as unknown;
    const result = validateConfig(raw as GatewayConfigInput);
    if (!result.ok) {
      for (const error of result.errors) console.error(error);
      process.exitCode = 1;
      return;
    }
    for (const warning of result.warnings) console.warn(warning);
    console.log(`Config ${configPath} is valid.`);
    return;
  }

  if (parsed.command === "smoke") {
    const config = await loadGatewayConfig(configPath);
    if (parsed.flags.all) {
      const suite = await runAvailableProviderSmokeChecks({ config });
      for (const result of suite.results) {
        const prefix =
          result.status === "passed" ? "PASS" : result.status === "failed" ? "FAIL" : "SKIP";
        console.log(`${prefix} ${result.message}`);
      }
      console.log(`Smoke summary: ${suite.passed} passed, ${suite.failed} failed, ${suite.skipped} skipped.`);
      if (suite.failed > 0 || suite.passed === 0) {
        process.exitCode = 1;
      }
      return;
    }

    const result = await runLiveSmokeCheck({
      config,
      model: flagString(parsed.flags, "model", "fast"),
    });
    if (result.status === "passed") {
      console.log(result.message);
      return;
    }
    if (result.status === "skipped") {
      console.log(`Smoke check skipped: ${result.message}`);
      return;
    }
    console.error(`Smoke check failed: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.command === "serve") {
    const config = await loadGatewayConfig(configPath);
    config.server.host = flagString(parsed.flags, "host", config.server.host);
    config.server.port = flagNumber(parsed.flags, "port", config.server.port);

    const runtimeErrors = validateRuntimeSecrets(config, process.env);
    if (runtimeErrors.length > 0) {
      for (const error of runtimeErrors) console.error(error);
      process.exitCode = 1;
      return;
    }

    const server = startGatewayServer({ config });
    console.log(`Hasna Gateway ${gatewayVersion} listening on http://${server.hostname}:${server.port}`);
    return;
  }

  console.error(`Unknown command '${parsed.command}'.`);
  console.log(help());
  process.exitCode = 1;
}

if (import.meta.main) {
  await runCli();
}
