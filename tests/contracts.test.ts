import { describe, expect, test } from "bun:test";
import { SCHEMA_IDS } from "@hasna/contracts";
import type { GatewayBudgetStatus } from "../src/budget";
import { toCapabilityCards, toCostEstimate, toDecisionEnvelope } from "../src/lib/contracts";
import { resolveRoute } from "../src/router";
import type { GatewayUsageLedgerRecord } from "../src/ledger";
import { testConfig } from "./helpers";

describe("contract adapters", () => {
  test("maps gateway spend and ledger records to canonical cost estimates", () => {
    const spend = toCostEstimate(
      {
        usd: 0.012345,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        unknownCostEvents: 0,
      },
      { id: "gateway_cost_test", createdAt: "2026-07-06T00:00:00.000Z" },
    );

    expect(spend.schema).toBe(SCHEMA_IDS.costEstimate);
    expect(spend.amountMicros).toBe(12345);
    expect(spend.promptTokens).toBe(1000);
    expect(spend.completionTokens).toBe(500);
    expect(spend.totalTokens).toBe(1500);

    const record: GatewayUsageLedgerRecord = {
      timestamp: "2026-07-06T00:01:00.000Z",
      provider: "placeholder-provider",
      model: "placeholder-provider/placeholder-model",
      providerModel: "placeholder-model",
      routeMode: "fallback",
      attempts: [],
      usage: {
        inputTokens: 40,
        outputTokens: 2,
        totalTokens: 42,
      },
      estimatedCostUsd: 0.000042,
      status: "success",
    };
    const fromRecord = toCostEstimate(record);
    expect(fromRecord.schema).toBe(SCHEMA_IDS.costEstimate);
    expect(fromRecord.provider).toBe("placeholder-provider");
    expect(fromRecord.model).toBe("placeholder-provider/placeholder-model");
    expect(fromRecord.amountMicros).toBe(42);
  });

  test("maps budget statuses to cost estimates and denial decisions", () => {
    const status: GatewayBudgetStatus = {
      budget: {
        id: "daily",
        window: "daily",
        mode: "hard",
        maxUsd: 1,
        scope: {
          gatewayKey: "raw-gateway-key-value",
        },
      },
      context: {
        gatewayKey: "raw-request-key-value",
        tenant: "tenant-a",
        requestedModel: "coding",
      },
      windowStart: "2026-07-06T00:00:00.000Z",
      spent: {
        usd: 1.25,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        unknownCostEvents: 0,
      },
      remaining: {
        usd: 0,
      },
      exhausted: true,
      exceeded: true,
      warnings: ["USD budget exceeded"],
    };

    const estimate = toCostEstimate(status, { createdAt: "2026-07-06T00:00:00.000Z" });
    expect(estimate.schema).toBe(SCHEMA_IDS.costEstimate);
    expect(estimate.basis).toBe("budget");
    expect(estimate.resourceRefs[0]?.kind).toBe("budget");
    expect(JSON.stringify(estimate.metadata)).not.toContain("raw-gateway-key-value");
    expect(JSON.stringify(estimate.metadata)).not.toContain("raw-request-key-value");
    expect(JSON.stringify(estimate.metadata)).toContain("sha256:");

    const denial = toDecisionEnvelope({ status }, { createdAt: "2026-07-06T00:00:00.000Z" });
    expect(denial.schema).toBe(SCHEMA_IDS.decisionEnvelope);
    expect(denial.decisionType).toBe("budget");
    expect(denial.status).toBe("denied");
    expect(denial.skipped[0]?.externalId).toBe("daily");
    expect(denial.costEstimate?.schema).toBe(SCHEMA_IDS.costEstimate);
    expect(JSON.stringify(denial.metadata)).not.toContain("raw-gateway-key-value");
    expect(JSON.stringify(denial.metadata)).not.toContain("raw-request-key-value");
  });

  test("maps routing decisions and configured models to contracts", () => {
    const config = testConfig();
    const route = resolveRoute(
      {
        config,
        env: {
          GATEWAY_API_KEY: "placeholder-gateway",
          OPENAI_API_KEY: "placeholder-openai",
          DEEPSEEK_API_KEY: "placeholder-deepseek",
        },
      },
      {
        model: "coding",
        messages: [{ role: "user", content: "hi" }],
      },
    );

    const decision = toDecisionEnvelope(route.decision, { createdAt: "2026-07-06T00:00:00.000Z" });
    expect(decision.schema).toBe(SCHEMA_IDS.decisionEnvelope);
    expect(decision.decisionType).toBe("model_route");
    expect(decision.status).toBe("selected");
    expect(decision.selected[0]?.externalId).toBe("openai/gpt-4.1-mini");

    const cards = toCapabilityCards(config, { createdAt: "2026-07-06T00:00:00.000Z" });
    expect(cards).toHaveLength(3);
    expect(cards[0]?.schema).toBe(SCHEMA_IDS.capabilityCard);
    expect(cards[0]?.kind).toBe("model");
    expect(cards[0]?.metadata?.sourcePackage).toBe("@hasna/gateway");
    const openAiCard = cards.find((card) => card.name === "openai/gpt-4.1-mini");
    const routes = (openAiCard?.metadata?.routes ?? []) as Array<{ id: string }>;
    expect(routes.map((route) => route.id).sort()).toEqual(["china-coding", "coding"]);
  });
});
