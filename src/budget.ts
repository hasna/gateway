import { createHash } from "node:crypto";
import type { GatewayBudgetConfig, GatewayConfig, GatewayUsage, OpenAIChatCompletionRequest } from "./types";
import { GatewayHttpError } from "./errors";
import { hasUsageLedgerBackend, readBudgetLedgerRecords } from "./storage";

export type GatewayBudgetContext = {
  gatewayKey?: string;
  tenant?: string;
  requestedModel?: string;
  selectedModel?: string;
};

export type GatewayBudgetSpend = {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  unknownCostEvents: number;
};

export type GatewayBudgetStatus = {
  budget: GatewayBudgetConfig;
  context: GatewayBudgetContext;
  windowStart: string | null;
  spent: GatewayBudgetSpend;
  remaining: {
    usd?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  exhausted: boolean;
  exceeded: boolean;
  warnings: string[];
};

type LedgerLikeRecord = {
  timestamp?: string;
  status?: string;
  context?: GatewayBudgetContext;
  usage?: Partial<GatewayUsage>;
  estimatedCostUsd?: number;
};

const zeroSpend: GatewayBudgetSpend = {
  usd: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  unknownCostEvents: 0,
};

function roundMoney(value: number): number {
  return Number(value.toFixed(12));
}

function hasContext(input: GatewayBudgetContext): boolean {
  return Boolean(input.gatewayKey || input.tenant || input.requestedModel || input.selectedModel);
}

export function fingerprintGatewayKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function budgetContextFromRequest(
  request: OpenAIChatCompletionRequest,
  base: GatewayBudgetContext = {},
): GatewayBudgetContext {
  return {
    ...base,
    tenant: base.tenant ?? request.gateway?.tenant ?? request.user,
    requestedModel: request.model,
  };
}

function scopeContext(budget: GatewayBudgetConfig): GatewayBudgetContext {
  return {
    gatewayKey: budget.scope?.gatewayKey,
    tenant: budget.scope?.tenant,
    requestedModel: budget.scope?.modelAlias,
  };
}

function gatewayKeyMatches(scopeKey: string, contextKey: string | undefined): boolean {
  if (!contextKey) return false;
  const normalizedScope = scopeKey.startsWith("sha256:") ? scopeKey.slice("sha256:".length) : scopeKey;
  return normalizedScope === contextKey || fingerprintGatewayKey(scopeKey) === contextKey;
}

function modelMatches(scopeModel: string, context: GatewayBudgetContext): boolean {
  return scopeModel === context.requestedModel || scopeModel === context.selectedModel;
}

function budgetMatchesContext(budget: GatewayBudgetConfig, context: GatewayBudgetContext): boolean {
  const scope = budget.scope ?? {};
  if (scope.gatewayKey && !gatewayKeyMatches(scope.gatewayKey, context.gatewayKey)) return false;
  if (scope.tenant && scope.tenant !== context.tenant) return false;
  if (scope.modelAlias && !modelMatches(scope.modelAlias, context)) return false;
  return true;
}

function addSpend(a: GatewayBudgetSpend, b: Partial<GatewayBudgetSpend>): GatewayBudgetSpend {
  return {
    usd: roundMoney(a.usd + (b.usd ?? 0)),
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
    unknownCostEvents: a.unknownCostEvents + (b.unknownCostEvents ?? 0),
  };
}

export function spendFromUsage(usage: GatewayUsage | undefined, estimatedCostUsd: number | undefined): GatewayBudgetSpend {
  if (!usage) {
    return { ...zeroSpend, usd: estimatedCostUsd ?? 0 };
  }
  return {
    usd: estimatedCostUsd ?? 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    unknownCostEvents: estimatedCostUsd === undefined && usage.totalTokens > 0 ? 1 : 0,
  };
}

function windowStartFor(budget: GatewayBudgetConfig, now = new Date()): string | null {
  const resetAt = budget.resetAt ? new Date(budget.resetAt) : undefined;
  let start: Date | null = null;
  if (budget.window === "daily") {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  } else if (budget.window === "monthly") {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else if (budget.window === "lifetime") {
    start = null;
  } else {
    return null;
  }

  if (resetAt && (!start || resetAt > start)) return resetAt.toISOString();
  return start?.toISOString() ?? null;
}

function recordInWindow(record: LedgerLikeRecord, budget: GatewayBudgetConfig, now: Date): boolean {
  if (budget.window === "per-request") return false;
  const start = windowStartFor(budget, now);
  if (!start) return true;
  if (!record.timestamp) return false;
  return new Date(record.timestamp).getTime() >= new Date(start).getTime();
}

function spendFromRecord(record: LedgerLikeRecord): GatewayBudgetSpend {
  const inputTokens = typeof record.usage?.inputTokens === "number" ? record.usage.inputTokens : 0;
  const outputTokens = typeof record.usage?.outputTokens === "number" ? record.usage.outputTokens : 0;
  const totalTokens = typeof record.usage?.totalTokens === "number" ? record.usage.totalTokens : 0;
  const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || totalTokens > 0;
  return {
    usd: typeof record.estimatedCostUsd === "number" ? record.estimatedCostUsd : 0,
    inputTokens,
    outputTokens,
    totalTokens,
    unknownCostEvents: typeof record.estimatedCostUsd === "number" || !hasTokenUsage ? 0 : 1,
  };
}

function remainingValue(limit: number | undefined, spent: number): number | undefined {
  return limit === undefined ? undefined : Math.max(0, roundMoney(limit - spent));
}

function remainingTokenValue(limit: number | undefined, spent: number): number | undefined {
  return limit === undefined ? undefined : Math.max(0, limit - spent);
}

function limitExceeded(limit: number | undefined, spent: number): boolean {
  return limit !== undefined && spent > limit;
}

function limitExhausted(limit: number | undefined, spent: number): boolean {
  return limit !== undefined && spent >= limit;
}

function warningsFor(budget: GatewayBudgetConfig, spent: GatewayBudgetSpend): string[] {
  const threshold = budget.warningThreshold ?? (budget.mode === "soft" ? 0.8 : undefined);
  const warnings: string[] = [];
  if (budget.maxUsd !== undefined && spent.unknownCostEvents > 0) {
    warnings.push("USD budget cannot be verified because model pricing is missing");
  }
  const check = (label: string, limit: number | undefined, value: number) => {
    if (limit === undefined) return;
    if (value > limit) {
      warnings.push(`${label} budget exceeded`);
    } else if (threshold !== undefined && limit > 0 && value >= limit * threshold) {
      warnings.push(`${label} budget at or above ${Math.round(threshold * 100)}%`);
    }
  };
  check("USD", budget.maxUsd, spent.usd);
  check("input token", budget.maxInputTokens, spent.inputTokens);
  check("output token", budget.maxOutputTokens, spent.outputTokens);
  check("total token", budget.maxTotalTokens, spent.totalTokens);
  return warnings;
}

function buildStatus(budget: GatewayBudgetConfig, context: GatewayBudgetContext, spent: GatewayBudgetSpend, now: Date): GatewayBudgetStatus {
  const unknownCostBlocksUsdBudget = budget.maxUsd !== undefined && spent.unknownCostEvents > 0;
  const exceeded =
    unknownCostBlocksUsdBudget ||
    limitExceeded(budget.maxUsd, spent.usd) ||
    limitExceeded(budget.maxInputTokens, spent.inputTokens) ||
    limitExceeded(budget.maxOutputTokens, spent.outputTokens) ||
    limitExceeded(budget.maxTotalTokens, spent.totalTokens);
  const exhausted =
    unknownCostBlocksUsdBudget ||
    limitExhausted(budget.maxUsd, spent.usd) ||
    limitExhausted(budget.maxInputTokens, spent.inputTokens) ||
    limitExhausted(budget.maxOutputTokens, spent.outputTokens) ||
    limitExhausted(budget.maxTotalTokens, spent.totalTokens);
  return {
    budget,
    context,
    windowStart: windowStartFor(budget, now),
    spent,
    remaining: {
      ...(budget.maxUsd === undefined
        ? {}
        : { usd: unknownCostBlocksUsdBudget ? 0 : remainingValue(budget.maxUsd, spent.usd) }),
      ...(budget.maxInputTokens === undefined
        ? {}
        : { inputTokens: remainingTokenValue(budget.maxInputTokens, spent.inputTokens) }),
      ...(budget.maxOutputTokens === undefined
        ? {}
        : { outputTokens: remainingTokenValue(budget.maxOutputTokens, spent.outputTokens) }),
      ...(budget.maxTotalTokens === undefined
        ? {}
        : { totalTokens: remainingTokenValue(budget.maxTotalTokens, spent.totalTokens) }),
    },
    exhausted,
    exceeded,
    warnings: warningsFor(budget, spent),
  };
}

function assertLedgerConfiguredForBudget(config: GatewayConfig, budget: GatewayBudgetConfig): void {
  if (budget.window === "per-request" || hasUsageLedgerBackend(config)) return;
  throw new GatewayHttpError({
    status: 500,
    type: "gateway_config_error",
    code: "budget_ledger_missing",
    message: `Budget '${budget.id}' uses a ${budget.window} window and requires a usage ledger backend for cumulative enforcement.`,
    raw: budget,
  });
}

export async function getBudgetStatuses(
  config: GatewayConfig,
  context: GatewayBudgetContext = {},
  options: {
    budgetId?: string;
    includeUnmatched?: boolean;
    currentSpend?: GatewayBudgetSpend;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<GatewayBudgetStatus[]> {
  const includeUnmatched = options.includeUnmatched ?? !hasContext(context);
  const now = new Date();
  const records = hasUsageLedgerBackend(config) ? await readBudgetLedgerRecords(config, { env: options.env }) : [];
  const budgets = options.budgetId ? config.budgets.filter((budget) => budget.id === options.budgetId) : config.budgets;
  const statuses: GatewayBudgetStatus[] = [];

  for (const budget of budgets) {
    const effectiveContext = hasContext(context) ? context : scopeContext(budget);
    if (!includeUnmatched && !budgetMatchesContext(budget, effectiveContext)) continue;
    assertLedgerConfiguredForBudget(config, budget);

    let spent = { ...zeroSpend };
    for (const record of records) {
      const recordContext = record.context ?? {};
      if (!budgetMatchesContext(budget, recordContext)) continue;
      if (!recordInWindow(record, budget, now)) continue;
      spent = addSpend(spent, spendFromRecord(record));
    }
    if (options.currentSpend && budgetMatchesContext(budget, effectiveContext)) {
      spent = addSpend(spent, options.currentSpend);
    }
    statuses.push(buildStatus(budget, effectiveContext, spent, now));
  }

  return statuses;
}

function budgetExceededMessage(status: GatewayBudgetStatus): string {
  const scope = status.budget.scope ?? {};
  const details = [
    scope.gatewayKey ? `gatewayKey=${scope.gatewayKey}` : undefined,
    scope.tenant ? `tenant=${scope.tenant}` : undefined,
    scope.modelAlias ? `model=${scope.modelAlias}` : undefined,
  ].filter(Boolean);
  return `Budget '${status.budget.id}' exceeded${details.length ? ` (${details.join(", ")})` : ""}.`;
}

export async function assertBudgetPreflight(
  config: GatewayConfig,
  context: GatewayBudgetContext,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<GatewayBudgetStatus[]> {
  const statuses = await getBudgetStatuses(config, context, { includeUnmatched: false, env: options.env });
  const blocked = statuses.find((status) => status.budget.mode === "hard" && status.exhausted);
  if (blocked) {
    throw new GatewayHttpError({
      status: 402,
      type: "gateway_budget_error",
      code: "budget_exceeded",
      message: budgetExceededMessage(blocked),
      raw: blocked,
    });
  }
  return statuses;
}

export async function evaluateBudgetPostflight(
  config: GatewayConfig,
  context: GatewayBudgetContext,
  currentSpend: GatewayBudgetSpend,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<GatewayBudgetStatus[]> {
  return getBudgetStatuses(config, context, { includeUnmatched: false, currentSpend, env: options.env });
}

export function assertBudgetPostflight(statuses: GatewayBudgetStatus[]): void {
  const blocked = statuses.find((status) => status.budget.mode === "hard" && status.exceeded);
  if (blocked) {
    throw new GatewayHttpError({
      status: 402,
      type: "gateway_budget_error",
      code: "budget_exceeded",
      message: budgetExceededMessage(blocked),
      raw: blocked,
    });
  }
}
