import { createHash } from "node:crypto";
import { getBudgetStatuses } from "./budget";
import type { GatewayBudgetStatus } from "./budget";
import type {
  GatewayBudgetConfig,
  GatewayConfig,
  GatewayMetricsRecorder,
  GatewayRouteAttempt,
} from "./types";

type MetricType = "counter" | "gauge";

type MetricMetadata = {
  type: MetricType;
  help: string;
};

type MetricSample = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

const metricMetadata: Record<string, MetricMetadata> = {
  gateway_http_requests_total: {
    type: "counter",
    help: "HTTP requests handled by the gateway.",
  },
  gateway_chat_completions_total: {
    type: "counter",
    help: "Chat completion requests observed by the gateway.",
  },
  gateway_tokens_total: {
    type: "counter",
    help: "Chat completion tokens observed by the gateway.",
  },
  gateway_estimated_cost_usd_total: {
    type: "counter",
    help: "Estimated chat completion cost in USD observed by the gateway.",
  },
  gateway_route_decisions_total: {
    type: "counter",
    help: "Route decisions made by the gateway.",
  },
  gateway_route_attempts_total: {
    type: "counter",
    help: "Provider route attempts made by the gateway.",
  },
  gateway_budget_remaining_usd: {
    type: "gauge",
    help: "Remaining budget amount in USD.",
  },
  gateway_budget_remaining_tokens: {
    type: "gauge",
    help: "Remaining budget amount in tokens.",
  },
  gateway_budget_exhausted: {
    type: "gauge",
    help: "Whether a budget is exhausted.",
  },
  gateway_budget_exceeded: {
    type: "gauge",
    help: "Whether a budget is exceeded.",
  },
  gateway_metrics_scrape_errors_total: {
    type: "counter",
    help: "Metrics scrape sections that failed to collect.",
  },
};

function labelValue(value: string | number | boolean | undefined): string {
  if (value === undefined || value === "") return "unknown";
  return String(value);
}

function fingerprintLabel(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function safeCode(value: string | undefined): string {
  if (!value) return "none";
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 80);
  return normalized || "unknown";
}

function statusClass(status: number): string {
  if (!Number.isFinite(status)) return "unknown";
  return `${Math.floor(status / 100)}xx`;
}

function sortedLabels(labels: Record<string, string | number | boolean | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, labelValue(value)]),
  );
}

function metricKey(name: string, labels: Record<string, string>): string {
  return `${name}:${JSON.stringify(labels)}`;
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatSample(sample: MetricSample): string {
  const labels = Object.entries(sample.labels);
  const labelText = labels.length
    ? `{${labels.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`
    : "";
  return `${sample.name}${labelText} ${formatNumber(sample.value)}`;
}

function budgetLabels(budget: GatewayBudgetConfig): Record<string, string> {
  return sortedLabels({
    budget_id: fingerprintLabel(budget.id),
    mode: budget.mode,
    window: budget.window,
  });
}

function budgetGaugeSamples(status: GatewayBudgetStatus): MetricSample[] {
  const labels = budgetLabels(status.budget);
  const samples: MetricSample[] = [
    {
      name: "gateway_budget_exhausted",
      labels,
      value: status.exhausted ? 1 : 0,
    },
    {
      name: "gateway_budget_exceeded",
      labels,
      value: status.exceeded ? 1 : 0,
    },
  ];

  if (status.remaining.usd !== undefined) {
    samples.push({
      name: "gateway_budget_remaining_usd",
      labels,
      value: status.remaining.usd,
    });
  }

  for (const [dimension, value] of [
    ["input", status.remaining.inputTokens],
    ["output", status.remaining.outputTokens],
    ["total", status.remaining.totalTokens],
  ] as const) {
    if (value === undefined) continue;
    samples.push({
      name: "gateway_budget_remaining_tokens",
      labels: sortedLabels({ ...labels, dimension }),
      value,
    });
  }

  return samples;
}

export function normalizeMetricsEndpoint(pathname: string): string {
  if (pathname === "/health") return "/health";
  if (pathname === "/metrics") return "/metrics";
  if (pathname === "/v1/models") return "/v1/models";
  if (pathname === "/v1/chat/completions") return "/v1/chat/completions";
  if (pathname.startsWith("/v1/")) return "/v1/*";
  return "unknown";
}

export class GatewayMetricsCollector implements GatewayMetricsRecorder {
  private readonly counters = new Map<string, MetricSample>();

  recordHttpRequest(input: { method: string; endpoint: string; status: number }): void {
    this.increment("gateway_http_requests_total", {
      endpoint: input.endpoint,
      method: input.method.toUpperCase(),
      status: String(input.status),
      status_class: statusClass(input.status),
    });
  }

  recordChatError(input: Parameters<GatewayMetricsRecorder["recordChatError"]>[0]): void {
    this.increment("gateway_chat_completions_total", {
      model: "none",
      provider: "none",
      route_mode: "none",
      status: "error",
      stream: String(input.stream),
    });
  }

  recordChatCompletion(input: Parameters<GatewayMetricsRecorder["recordChatCompletion"]>[0]): void {
    const provider = input.provider ?? selectedAttempt(input.decision)?.provider ?? "none";
    const model = input.model ?? selectedAttempt(input.decision)?.model ?? "none";
    const baseLabels = {
      model,
      provider,
      route_mode: input.decision.mode,
      status: input.status,
      stream: String(input.stream),
    };

    this.increment("gateway_chat_completions_total", baseLabels);
    this.increment("gateway_route_decisions_total", baseLabels);

    for (const attempt of input.decision.attempts) {
      if (attempt.status === "skipped") continue;
      this.increment("gateway_route_attempts_total", {
        error_code: safeCode(attempt.errorCode),
        model: attempt.model,
        provider: attempt.provider,
        route_mode: input.decision.mode,
        status: attempt.status,
        stream: String(input.stream),
      });
    }

    if (input.usage) {
      this.increment("gateway_tokens_total", { ...baseLabels, type: "input" }, input.usage.inputTokens);
      this.increment("gateway_tokens_total", { ...baseLabels, type: "output" }, input.usage.outputTokens);
      this.increment("gateway_tokens_total", { ...baseLabels, type: "total" }, input.usage.totalTokens);
    }

    if (input.estimatedCostUsd !== undefined) {
      this.increment("gateway_estimated_cost_usd_total", baseLabels, input.estimatedCostUsd);
    }
  }

  async renderOpenMetrics(config: GatewayConfig): Promise<string> {
    const gauges: MetricSample[] = [];
    try {
      const statuses = await getBudgetStatuses(config);
      for (const status of statuses) {
        gauges.push(...budgetGaugeSamples(status));
      }
    } catch (error) {
      this.increment("gateway_metrics_scrape_errors_total", {
        code: safeCode(error && typeof error === "object" && "code" in error ? String(error.code) : undefined),
        section: "budgets",
      });
    }

    const samples = [...this.counters.values(), ...gauges];
    const lines: string[] = [];
    for (const [name, metadata] of Object.entries(metricMetadata)) {
      lines.push(`# HELP ${name} ${escapeHelp(metadata.help)}`);
      lines.push(`# TYPE ${name} ${metadata.type}`);
      for (const sample of samples.filter((candidate) => candidate.name === name)) {
        lines.push(formatSample(sample));
      }
    }
    lines.push("# EOF");
    return `${lines.join("\n")}\n`;
  }

  private increment(name: string, rawLabels: Record<string, string | number | boolean | undefined>, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) return;
    const labels = sortedLabels(rawLabels);
    const key = metricKey(name, labels);
    const current = this.counters.get(key);
    if (current) {
      current.value += amount;
      return;
    }
    this.counters.set(key, { name, labels, value: amount });
  }
}

function selectedAttempt(decision: { attempts: GatewayRouteAttempt[] }): GatewayRouteAttempt | undefined {
  return decision.attempts.find((attempt) => attempt.status === "selected");
}
