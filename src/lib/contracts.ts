import { parseContract, SCHEMA_IDS } from "@hasna/contracts";
import type {
  CapabilityCard,
  CapabilityCardInput,
  CostEstimate,
  CostEstimateInput,
  DecisionEnvelope,
  DecisionEnvelopeInput,
  ResourcePointerInput,
} from "@hasna/contracts";
import { fingerprintGatewayKey, type GatewayBudgetSpend, type GatewayBudgetStatus } from "../budget";
import type { GatewayUsageLedgerRecord } from "../ledger";
import type {
  GatewayBudgetConfig,
  GatewayBudgetScope,
  GatewayConfig,
  GatewayModelConfig,
  GatewayProviderConfig,
  GatewayRouteDecision,
  GatewayRoutePolicy,
} from "../types";

const sourcePackage = "@hasna/gateway";
const defaultCreatedAt = "1970-01-01T00:00:00.000Z";

export type GatewayBudgetDenial = {
  status: GatewayBudgetStatus;
  reason?: string;
};

export type ContractAdapterOptions = {
  id?: string;
  createdAt?: string;
  resourceRefs?: ResourcePointerInput[];
  metadata?: Record<string, unknown>;
};

type CostEstimateOptions = ContractAdapterOptions & {
  basis?: CostEstimateInput["basis"];
  provider?: string;
  model?: string;
  accountId?: string;
};

type DecisionEnvelopeOptions = ContractAdapterOptions & {
  traceId?: string;
  actor?: DecisionEnvelopeInput["actor"];
};

type CapabilityCardOptions = ContractAdapterOptions & {
  route?: GatewayRoutePolicy;
  routes?: GatewayRoutePolicy[];
};

function safeId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return normalized || "unknown";
}

function amountMicrosFromUsd(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value * 1_000_000));
}

function safeGatewayKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `sha256:${fingerprintGatewayKey(value)}`;
}

function safeBudgetScope(scope: GatewayBudgetScope | undefined): GatewayBudgetScope | undefined {
  if (!scope) return undefined;
  return {
    ...scope,
    ...(scope.gatewayKey ? { gatewayKey: safeGatewayKey(scope.gatewayKey) } : {}),
  };
}

function safeBudgetConfig(budget: GatewayBudgetConfig): GatewayBudgetConfig {
  return {
    ...budget,
    ...(budget.scope ? { scope: safeBudgetScope(budget.scope) } : {}),
  };
}

function safeBudgetContext(context: GatewayBudgetStatus["context"]): GatewayBudgetStatus["context"] {
  return {
    ...context,
    ...(context.gatewayKey ? { gatewayKey: safeGatewayKey(context.gatewayKey) } : {}),
  };
}

function tokensFromSpend(spend: GatewayBudgetSpend): Pick<CostEstimateInput, "promptTokens" | "completionTokens" | "totalTokens"> {
  return {
    promptTokens: Math.max(0, spend.inputTokens),
    completionTokens: Math.max(0, spend.outputTokens),
    ...(spend.totalTokens === spend.inputTokens + spend.outputTokens ? { totalTokens: Math.max(0, spend.totalTokens) } : {}),
  };
}

function costResourceRefs(input: GatewayBudgetStatus | GatewayUsageLedgerRecord | GatewayBudgetSpend): ResourcePointerInput[] {
  if (isBudgetStatus(input)) {
    return [
      {
        kind: "budget",
        id: `gateway_budget_${safeId(input.budget.id)}`,
        externalId: input.budget.id,
        sourcePackage,
        tags: ["gateway-budget"],
      },
    ];
  }
  if (isUsageLedgerRecord(input)) {
    return [
      {
        kind: "model",
        id: `gateway_model_${safeId(input.model)}`,
        externalId: input.model,
        sourcePackage,
        tags: ["gateway-route"],
      },
    ];
  }
  return [];
}

function modelPointer(modelId: string, name?: string): ResourcePointerInput {
  return {
    kind: "model",
    id: `gateway_model_${safeId(modelId)}`,
    name,
    externalId: modelId,
    sourcePackage,
    tags: ["gateway-model"],
  };
}

function budgetPointer(status: GatewayBudgetStatus): ResourcePointerInput {
  return {
    kind: "budget",
    id: `gateway_budget_${safeId(status.budget.id)}`,
    name: status.budget.id,
    externalId: status.budget.id,
    sourcePackage,
    tags: ["gateway-budget"],
  };
}

function isBudgetStatus(input: GatewayBudgetStatus | GatewayUsageLedgerRecord | GatewayBudgetSpend): input is GatewayBudgetStatus {
  return "budget" in input && "spent" in input;
}

function isUsageLedgerRecord(input: GatewayBudgetStatus | GatewayUsageLedgerRecord | GatewayBudgetSpend): input is GatewayUsageLedgerRecord {
  return "routeMode" in input && "attempts" in input;
}

function spendFromCostInput(input: GatewayBudgetStatus | GatewayUsageLedgerRecord | GatewayBudgetSpend): GatewayBudgetSpend {
  if (isBudgetStatus(input)) return input.spent;
  if (isUsageLedgerRecord(input)) {
    return {
      usd: input.estimatedCostUsd ?? 0,
      inputTokens: input.usage?.inputTokens ?? 0,
      outputTokens: input.usage?.outputTokens ?? 0,
      totalTokens: input.usage?.totalTokens ?? 0,
      unknownCostEvents: input.estimatedCostUsd === undefined && (input.usage?.totalTokens ?? 0) > 0 ? 1 : 0,
    };
  }
  return input;
}

function costId(input: GatewayBudgetStatus | GatewayUsageLedgerRecord | GatewayBudgetSpend): string {
  if (isBudgetStatus(input)) return `gateway_cost_budget_${safeId(input.budget.id)}`;
  if (isUsageLedgerRecord(input)) return `gateway_cost_ledger_${safeId(`${input.timestamp}_${input.provider}_${input.model}`)}`;
  return `gateway_cost_spend_${safeId(`${input.usd}_${input.inputTokens}_${input.outputTokens}_${input.totalTokens}`)}`;
}

function costCreatedAt(input: GatewayBudgetStatus | GatewayUsageLedgerRecord | GatewayBudgetSpend, options?: CostEstimateOptions): string {
  if (options?.createdAt) return options.createdAt;
  if (isUsageLedgerRecord(input)) return input.timestamp;
  return defaultCreatedAt;
}

function costMetadata(
  input: GatewayBudgetStatus | GatewayUsageLedgerRecord | GatewayBudgetSpend,
  options?: CostEstimateOptions,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    sourcePackage,
    ...options?.metadata,
  };
  if (isBudgetStatus(input)) {
    metadata.gatewayBudget = {
      id: input.budget.id,
      window: input.budget.window,
      mode: input.budget.mode,
      scope: safeBudgetScope(input.budget.scope),
      exhausted: input.exhausted,
      exceeded: input.exceeded,
      warnings: input.warnings,
      remaining: input.remaining,
      context: safeBudgetContext(input.context),
    };
  } else if (isUsageLedgerRecord(input)) {
    metadata.gatewayLedger = {
      routeMode: input.routeMode,
      providerModel: input.providerModel,
      attempts: input.attempts,
      status: input.status,
      errorType: input.errorType,
      errorCode: input.errorCode,
      budgets: input.budgets,
    };
  }
  return metadata;
}

export function toCostEstimate(
  input: GatewayBudgetStatus | GatewayUsageLedgerRecord | GatewayBudgetSpend,
  options: CostEstimateOptions = {},
): CostEstimate {
  const spend = spendFromCostInput(input);
  const provider = options.provider ?? (isUsageLedgerRecord(input) ? input.provider : undefined);
  const model = options.model ?? (isUsageLedgerRecord(input) ? input.model : undefined);
  const draft: CostEstimateInput = {
    schema: SCHEMA_IDS.costEstimate,
    id: options.id ?? costId(input),
    createdAt: costCreatedAt(input, options),
    amountMicros: amountMicrosFromUsd(spend.usd),
    currency: "USD",
    basis: options.basis ?? (isBudgetStatus(input) ? "budget" : "estimated"),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(options.accountId ? { accountId: options.accountId } : {}),
    ...tokensFromSpend(spend),
    resourceRefs: options.resourceRefs ?? costResourceRefs(input),
    metadata: costMetadata(input, options),
  };
  return parseContract(SCHEMA_IDS.costEstimate, draft);
}

function routeDecisionId(decision: GatewayRouteDecision): string {
  return `gateway_decision_route_${safeId(`${decision.requested_model}_${decision.selected ?? decision.reason}`)}`;
}

function skippedModelPointers(decision: GatewayRouteDecision): ResourcePointerInput[] {
  return decision.attempts
    .filter((attempt) => attempt.status === "skipped")
    .map((attempt) => ({
      ...modelPointer(attempt.model),
      tags: ["gateway-model", "skipped"],
    }));
}

function toRoutingDecisionEnvelope(decision: GatewayRouteDecision, options: DecisionEnvelopeOptions = {}): DecisionEnvelope {
  const selected = decision.selected ? [modelPointer(decision.selected)] : [];
  const status: DecisionEnvelopeInput["status"] = selected.length > 0 ? "selected" : "denied";
  const draft: DecisionEnvelopeInput = {
    schema: SCHEMA_IDS.decisionEnvelope,
    id: options.id ?? routeDecisionId(decision),
    createdAt: options.createdAt ?? defaultCreatedAt,
    decisionType: "model_route",
    status,
    reason: decision.reason || "gateway route decision",
    selected,
    skipped: skippedModelPointers(decision),
    obligations: status === "selected" ? ["record-cost"] : ["adjust-gateway-routing-policy"],
    ...(status === "denied" ? { policyBundleId: "gateway-routing-policy" } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    metadata: {
      sourcePackage,
      requestedModel: decision.requested_model,
      resolvedCandidates: decision.resolved_candidates,
      mode: decision.mode,
      policy: decision.policy,
      attempts: decision.attempts,
      ...options.metadata,
    },
  };
  return parseContract(SCHEMA_IDS.decisionEnvelope, draft);
}

function toBudgetDenialEnvelope(denial: GatewayBudgetDenial, options: DecisionEnvelopeOptions = {}): DecisionEnvelope {
  const draft: DecisionEnvelopeInput = {
    schema: SCHEMA_IDS.decisionEnvelope,
    id: options.id ?? `gateway_decision_budget_${safeId(denial.status.budget.id)}`,
    createdAt: options.createdAt ?? defaultCreatedAt,
    decisionType: "budget",
    status: "denied",
    reason: denial.reason ?? `Budget '${denial.status.budget.id}' denied gateway usage.`,
    skipped: [budgetPointer(denial.status)],
    obligations: ["reduce-usage-or-increase-budget"],
    policyBundleId: "gateway-budget-policy",
    costEstimate: toCostEstimate(denial.status, {
      id: `gateway_cost_budget_${safeId(denial.status.budget.id)}`,
      createdAt: options.createdAt,
    }),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    metadata: {
      sourcePackage,
      budget: safeBudgetConfig(denial.status.budget),
      remaining: denial.status.remaining,
      warnings: denial.status.warnings,
      context: safeBudgetContext(denial.status.context),
      ...options.metadata,
    },
  };
  return parseContract(SCHEMA_IDS.decisionEnvelope, draft);
}

function isBudgetDenial(input: GatewayRouteDecision | GatewayBudgetDenial): input is GatewayBudgetDenial {
  return "status" in input && typeof input.status === "object" && input.status !== null && "budget" in input.status;
}

export function toDecisionEnvelope(
  input: GatewayRouteDecision | GatewayBudgetDenial,
  options: DecisionEnvelopeOptions = {},
): DecisionEnvelope {
  if (isBudgetDenial(input)) {
    return toBudgetDenialEnvelope(input, options);
  }
  return toRoutingDecisionEnvelope(input, options);
}

function modelCostEstimate(model: GatewayModelConfig, provider: GatewayProviderConfig, createdAt: string): CostEstimate | undefined {
  if (model.inputUsdPerMillionTokens === undefined || model.outputUsdPerMillionTokens === undefined) return undefined;
  return toCostEstimate(
    {
      usd: model.inputUsdPerMillionTokens + model.outputUsdPerMillionTokens,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      unknownCostEvents: 0,
    },
    {
      id: `gateway_cost_model_${safeId(model.id)}`,
      createdAt,
      provider: provider.id,
      model: model.id,
      basis: "estimated",
      resourceRefs: [modelPointer(model.id, model.providerModel)],
      metadata: {
        sourcePackage,
        pricingBasis: "one million input tokens plus one million output tokens",
      },
    },
  );
}

function routeLimitations(provider: GatewayProviderConfig, model: GatewayModelConfig, routes: GatewayRoutePolicy[]): string[] {
  return [
    provider.apiKeyEnv ? `requires env ${provider.apiKeyEnv}` : "provider key env is not configured",
    ...(provider.enabled === false ? ["provider disabled"] : []),
    ...(provider.regions?.length ? [`regions: ${provider.regions.join(",")}`] : []),
    ...routes.flatMap((route) => [
      ...(route.providerAllowlist?.length ? [`route ${route.id} allowlist: ${route.providerAllowlist.join(",")}`] : []),
      ...(route.providerBlocklist?.length ? [`route ${route.id} blocklist: ${route.providerBlocklist.join(",")}`] : []),
    ]),
    ...(model.contextWindow === undefined ? [] : [`context window: ${model.contextWindow}`]),
  ];
}

function riskLevel(provider: GatewayProviderConfig): CapabilityCardInput["riskLevel"] {
  if (provider.enabled === false) return "unknown";
  if (provider.dataPolicy?.allowTraining !== false || provider.dataPolicy?.allowLogging !== false) return "high";
  if (provider.regions?.includes("cn")) return "medium";
  return "low";
}

export function toCapabilityCard(
  input: { provider: GatewayProviderConfig; model: GatewayModelConfig },
  options: CapabilityCardOptions = {},
): CapabilityCard {
  const createdAt = options.createdAt ?? defaultCreatedAt;
  const costEstimate = modelCostEstimate(input.model, input.provider, createdAt);
  const routes = options.routes ?? (options.route ? [options.route] : []);
  const routeCapabilities = routes.length
    ? [...new Set(routes.map((route) => `route:${route.mode}`))]
    : ["route:direct"];
  const draft: CapabilityCardInput = {
    schema: SCHEMA_IDS.capabilityCard,
    id: options.id ?? `gateway_capability_model_${safeId(input.model.id)}`,
    createdAt,
    kind: "model",
    name: input.model.id,
    version: input.model.providerModel,
    status: input.provider.enabled === false ? "unavailable" : "available",
    capabilities: [...input.model.capabilities, `provider:${input.provider.kind}`, ...routeCapabilities],
    limitations: routeLimitations(input.provider, input.model, routes),
    riskLevel: riskLevel(input.provider),
    ...(costEstimate ? { costEstimate } : {}),
    metadata: {
      sourcePackage,
      provider: {
        id: input.provider.id,
        displayName: input.provider.displayName,
        kind: input.provider.kind,
        regions: input.provider.regions,
        jurisdiction: input.provider.jurisdiction,
      },
      model: input.model,
      routes: routes.map((route) => ({
        id: route.id,
        mode: route.mode,
        modelAliases: route.modelAliases ?? [],
        fallbackModelIds: route.fallbackModelIds ?? [],
      })),
      ...options.metadata,
    },
  };
  return parseContract(SCHEMA_IDS.capabilityCard, draft);
}

export function toCapabilityCards(config: GatewayConfig, options: ContractAdapterOptions = {}): CapabilityCard[] {
  const providers = new Map(config.providers.map((provider) => [provider.id, provider]));
  const { id: _id, ...cardOptions } = options;
  return config.models.flatMap((model) => {
    const provider = providers.get(model.providerId);
    if (!provider) return [];
    const routes = config.routes.filter((candidate) => candidate.fallbackModelIds?.includes(model.id) || candidate.id === model.id);
    return [toCapabilityCard({ provider, model }, { ...cardOptions, routes })];
  });
}
