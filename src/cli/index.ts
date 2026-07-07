#!/usr/bin/env bun
import { lstat, unlink } from "node:fs/promises";
import { loadGatewayConfig, validateConfig, validateRuntimeSecrets } from "../config";
import { getBudgetStatuses } from "../budget";
import { GatewayHttpError } from "../errors";
import { toCapabilityCards, toCostEstimate, toDecisionEnvelope } from "../lib/contracts";
import { resolveRoute } from "../router";
import type { GatewayConfigInput, GatewayRouteDecision, OpenAIChatCompletionRequest } from "../types";
import { runAvailableProviderSmokeChecks, runLiveSmokeCheck } from "../smoke";
import { startGatewayServer } from "../server";
import { gatewayVersion } from "../version";

type ParsedArgs = {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      flags[index.toString()] = arg;
      continue;
    }
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { command, args: rest.filter((arg) => !arg.startsWith("--")), flags };
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

function optionalFlagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function optionalFlagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const value = flags[key];
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${key} must be a non-negative number.`);
  }
  return parsed;
}

function hasBareFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true;
}

async function readRawConfig(path: string): Promise<GatewayConfigInput> {
  return JSON.parse(await Bun.file(path).text()) as GatewayConfigInput;
}

async function writeRawConfig(path: string, config: GatewayConfigInput): Promise<void> {
  const result = validateConfig(config);
  if (!result.ok) {
    throw new Error(result.errors.join(" "));
  }
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeFileIfPresent(path: string, label: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (stats.isDirectory()) {
    throw new Error(`Refusing to remove ${label} because it is a directory: ${path}`);
  }

  await unlink(path);
  return true;
}

function printJsonOrText(value: unknown, flags: Record<string, string | boolean>, textValue: string): void {
  if (flags.json) console.log(JSON.stringify(value, null, 2));
  else console.log(textValue);
}

function contractJson(flags: Record<string, string | boolean>): boolean {
  return Boolean(flags.json && flags.contract);
}

function help(): string {
  return `Hasna Gateway ${gatewayVersion}

Usage:
  gateway serve --config gateway.config.json [--host 127.0.0.1] [--port 8787]
  gateway validate --config gateway.config.json
  gateway smoke --config gateway.config.json [--model fast]
  gateway smoke --config gateway.config.json --all
  gateway budget-add --config gateway.config.json --id daily --window daily [--tenant acme] [--model coding] [--max-usd 1] [--max-total-tokens 100000]
  gateway budget-list --config gateway.config.json [--json]
  gateway budget-remaining --config gateway.config.json [--id daily] [--json] [--contract]
  gateway budget-reset --config gateway.config.json --id daily
  gateway route --config gateway.config.json --model coding [--json] [--contract]
  gateway routes --config gateway.config.json [--json] [--contract]
  gateway uninstall --config gateway.config.json --yes
  gateway remove --config gateway.config.json --all --yes
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

  if (parsed.command === "budget-add") {
    const raw = await readRawConfig(configPath);
    const budget = {
      id: flagString(parsed.flags, "id", ""),
      window: flagString(parsed.flags, "window", "lifetime") as "per-request" | "daily" | "monthly" | "lifetime",
      mode: flagString(parsed.flags, "mode", "hard") as "hard" | "soft",
      scope: {
        ...(optionalFlagString(parsed.flags, "gateway-key") ? { gatewayKey: optionalFlagString(parsed.flags, "gateway-key") } : {}),
        ...(optionalFlagString(parsed.flags, "tenant") ? { tenant: optionalFlagString(parsed.flags, "tenant") } : {}),
        ...(optionalFlagString(parsed.flags, "model") ? { modelAlias: optionalFlagString(parsed.flags, "model") } : {}),
      },
      ...(optionalFlagNumber(parsed.flags, "max-usd") === undefined
        ? {}
        : { maxUsd: optionalFlagNumber(parsed.flags, "max-usd") }),
      ...(optionalFlagNumber(parsed.flags, "max-input-tokens") === undefined
        ? {}
        : { maxInputTokens: optionalFlagNumber(parsed.flags, "max-input-tokens") }),
      ...(optionalFlagNumber(parsed.flags, "max-output-tokens") === undefined
        ? {}
        : { maxOutputTokens: optionalFlagNumber(parsed.flags, "max-output-tokens") }),
      ...(optionalFlagNumber(parsed.flags, "max-total-tokens") === undefined
        ? {}
        : { maxTotalTokens: optionalFlagNumber(parsed.flags, "max-total-tokens") }),
      ...(optionalFlagNumber(parsed.flags, "warning-threshold") === undefined
        ? {}
        : { warningThreshold: optionalFlagNumber(parsed.flags, "warning-threshold") }),
    };
    if (!budget.id) throw new Error("--id is required.");
    raw.budgets = [...(raw.budgets ?? []).filter((item) => item.id !== budget.id), budget];
    await writeRawConfig(configPath, raw);
    printJsonOrText({ budget }, parsed.flags, `Budget ${budget.id} saved.`);
    return;
  }

  if (parsed.command === "budget-list") {
    const config = await loadGatewayConfig(configPath);
    printJsonOrText(config.budgets, parsed.flags, config.budgets.map((budget) => budget.id).join("\n") || "No budgets configured.");
    return;
  }

  if (parsed.command === "budget-remaining") {
    const config = await loadGatewayConfig(configPath);
    const statuses = await getBudgetStatuses(
      config,
      {
        tenant: optionalFlagString(parsed.flags, "tenant"),
        requestedModel: optionalFlagString(parsed.flags, "model"),
      },
      { budgetId: optionalFlagString(parsed.flags, "id") },
    );
    if (contractJson(parsed.flags)) {
      const createdAt = new Date().toISOString();
      console.log(JSON.stringify(statuses.map((status) => toCostEstimate(status, { createdAt })), null, 2));
      return;
    }
    printJsonOrText(
      statuses,
      parsed.flags,
      statuses
        .map((status) => `${status.budget.id}: ${JSON.stringify(status.remaining)}`)
        .join("\n") || "No matching budgets.",
    );
    return;
  }

  if (parsed.command === "route") {
    const config = await loadGatewayConfig(configPath);
    const model = flagString(parsed.flags, "model", "");
    if (!model) throw new Error("--model is required.");
    const request: OpenAIChatCompletionRequest = {
      model,
      messages: [{ role: "user", content: "" }],
      ...(parsed.flags.stream ? { stream: true } : {}),
    };
    try {
      const result = resolveRoute({ config }, request);
      if (contractJson(parsed.flags)) {
        console.log(JSON.stringify(toDecisionEnvelope(result.decision, { createdAt: new Date().toISOString() }), null, 2));
        return;
      }
      printJsonOrText(result.decision, parsed.flags, result.decision.selected ?? result.decision.reason);
      return;
    } catch (error) {
      if (error instanceof GatewayHttpError && error.raw) {
        if (contractJson(parsed.flags)) {
          console.log(JSON.stringify(toDecisionEnvelope(error.raw as GatewayRouteDecision, { createdAt: new Date().toISOString() }), null, 2));
          process.exitCode = 1;
          return;
        }
        printJsonOrText(error.raw, parsed.flags, error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  if (parsed.command === "routes") {
    const config = await loadGatewayConfig(configPath);
    const routes = config.routes.map((route) => ({
      id: route.id,
      mode: route.mode,
      modelAliases: route.modelAliases ?? [],
      fallbackModelIds: route.fallbackModelIds ?? [],
    }));
    if (contractJson(parsed.flags)) {
      console.log(JSON.stringify(toCapabilityCards(config, { createdAt: new Date().toISOString() }), null, 2));
      return;
    }
    printJsonOrText(routes, parsed.flags, routes.map((route) => route.id).join("\n") || "No routes configured.");
    return;
  }

  if (parsed.command === "budget-reset") {
    const raw = await readRawConfig(configPath);
    const id = flagString(parsed.flags, "id", "");
    if (!id) throw new Error("--id is required.");
    const budgets = raw.budgets ?? [];
    const budget = budgets.find((item) => item.id === id);
    if (!budget) throw new Error(`Budget not found: ${id}`);
    budget.resetAt = new Date().toISOString();
    raw.budgets = budgets;
    await writeRawConfig(configPath, raw);
    printJsonOrText({ budget }, parsed.flags, `Budget ${id} reset.`);
    return;
  }

  if (parsed.command === "uninstall" || parsed.command === "remove") {
    if (parsed.command === "remove" && !hasBareFlag(parsed.flags, "all")) {
      throw new Error("gateway remove requires --all.");
    }
    if (!hasBareFlag(parsed.flags, "yes")) {
      console.error("Refusing to purge local gateway state without --yes.");
      process.exitCode = 1;
      return;
    }

    const raw = await readRawConfig(configPath);
    const ledgerPath = raw.storage?.usageLedgerPath;
    const removedLedger = ledgerPath ? await removeFileIfPresent(ledgerPath, "usage ledger") : false;
    const removedConfig = await removeFileIfPresent(configPath, "config");

    printJsonOrText(
      {
        configPath,
        usageLedgerPath: ledgerPath,
        removed: {
          config: removedConfig,
          usageLedger: removedLedger,
        },
      },
      parsed.flags,
      [
        `${removedConfig ? "Removed" : "No config file found at"} ${configPath}.`,
        ledgerPath
          ? `${removedLedger ? "Removed" : "No usage ledger found at"} ${ledgerPath}.`
          : "No usage ledger configured.",
      ].join("\n"),
    );
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
