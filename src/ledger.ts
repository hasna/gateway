import { dirname } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { GatewayConfig, GatewayModelConfig, GatewayProviderConfig, GatewayRouteDecision, GatewayUsage } from "./types";
import type { GatewayBudgetContext, GatewayBudgetStatus } from "./budget";

export type GatewayUsageLedgerRecord = {
  timestamp: string;
  provider: string;
  model: string;
  providerModel: string;
  routeMode: string;
  attempts: GatewayRouteDecision["attempts"];
  context?: GatewayBudgetContext;
  usage?: Omit<GatewayUsage, "raw">;
  estimatedCostUsd?: number;
  budgets?: Array<{
    id: string;
    mode: string;
    exhausted: boolean;
    exceeded: boolean;
    warnings: string[];
  }>;
  status: "success" | "error";
  errorType?: string;
  errorCode?: string;
};

export async function appendUsageLedger(input: {
  config: GatewayConfig;
  provider: GatewayProviderConfig;
  model: GatewayModelConfig;
  decision: GatewayRouteDecision;
  context?: GatewayBudgetContext;
  usage?: GatewayUsage;
  estimatedCostUsd?: number;
  budgets?: GatewayBudgetStatus[];
  status: "success" | "error";
  errorType?: string;
  errorCode?: string;
}): Promise<void> {
  const path = input.config.storage.usageLedgerPath;
  if (!path) return;

  const record: GatewayUsageLedgerRecord = {
    timestamp: new Date().toISOString(),
    provider: input.provider.id,
    model: input.model.id,
    providerModel: input.model.providerModel,
    routeMode: input.decision.mode,
    attempts: input.decision.attempts,
    ...(input.context ? { context: input.context } : {}),
    ...(input.usage
      ? {
          usage: {
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            ...(input.usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: input.usage.cachedInputTokens }),
            ...(input.usage.reasoningTokens === undefined ? {} : { reasoningTokens: input.usage.reasoningTokens }),
          },
        }
      : {}),
    ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.estimatedCostUsd }),
    ...(input.budgets
      ? {
          budgets: input.budgets.map((status) => ({
            id: status.budget.id,
            mode: status.budget.mode,
            exhausted: status.exhausted,
            exceeded: status.exceeded,
            warnings: status.warnings,
          })),
        }
      : {}),
    status: input.status,
    ...(input.errorType ? { errorType: input.errorType } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}
