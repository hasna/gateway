import type { GatewayModelConfig, GatewayUsage, OpenAIUsage } from "./types";

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeUsage(raw: unknown): GatewayUsage {
  const usage = objectFrom(raw);
  const promptDetails = objectFrom(usage.prompt_tokens_details);
  const completionDetails = objectFrom(usage.completion_tokens_details);
  const anthropicInputTokens = numberFrom(usage.input_tokens);
  const anthropicCacheReadInputTokens = numberFrom(usage.cache_read_input_tokens);
  const anthropicCacheCreationInputTokens = numberFrom(usage.cache_creation_input_tokens);

  // Anthropic reports uncached input, cache creation, and cache reads separately.
  // OpenAI-compatible prompt_tokens should include all prompt-side tokens.
  const inputTokens =
    numberFrom(usage.prompt_tokens) ??
    (anthropicInputTokens === undefined
      ? undefined
      : anthropicInputTokens + (anthropicCacheReadInputTokens ?? 0) + (anthropicCacheCreationInputTokens ?? 0)) ??
    numberFrom(usage.inputTokens) ??
    0;
  const outputTokens =
    numberFrom(usage.completion_tokens) ??
    numberFrom(usage.output_tokens) ??
    numberFrom(usage.outputTokens) ??
    0;
  const computedTotalTokens = inputTokens + outputTokens;
  const explicitTotalTokens = numberFrom(usage.total_tokens) ?? numberFrom(usage.totalTokens);
  const totalTokens = explicitTotalTokens === undefined ? computedTotalTokens : Math.max(explicitTotalTokens, computedTotalTokens);

  const cachedInputTokens =
    numberFrom(promptDetails.cached_tokens) ??
    numberFrom(usage.cached_input_tokens) ??
    anthropicCacheReadInputTokens;
  const reasoningTokens =
    numberFrom(completionDetails.reasoning_tokens) ??
    numberFrom(usage.reasoning_tokens) ??
    numberFrom(usage.reasoningTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    raw,
  };
}

export function toOpenAIUsage(usage: GatewayUsage): OpenAIUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  };
}

export function estimateCostUsd(usage: GatewayUsage, model: GatewayModelConfig): number | undefined {
  const inputPrice = model.inputUsdPerMillionTokens;
  const outputPrice = model.outputUsdPerMillionTokens;
  const billableInputTokens = Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0));

  if (
    (billableInputTokens > 0 && inputPrice === undefined) ||
    (usage.outputTokens > 0 && outputPrice === undefined)
  ) {
    return undefined;
  }

  const inputCost = (billableInputTokens * (inputPrice ?? 0)) / 1_000_000;
  const outputCost = (usage.outputTokens * (outputPrice ?? 0)) / 1_000_000;
  return Number((inputCost + outputCost).toFixed(12));
}
