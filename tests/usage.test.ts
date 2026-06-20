import { describe, expect, test } from "bun:test";
import { estimateCostUsd, normalizeUsage, toOpenAIUsage } from "../src/usage";

describe("usage normalization", () => {
  test("normalizes OpenAI usage details", () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });

    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cachedInputTokens: 25,
      reasoningTokens: 10,
    });
    expect(toOpenAIUsage(usage)).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
  });

  test("estimates configured cost", () => {
    const usage = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
    expect(
      estimateCostUsd(usage, {
        id: "openai/gpt-4.1-mini",
        providerId: "openai",
        providerModel: "gpt-4.1-mini",
        aliases: [],
        capabilities: ["chat"],
        inputUsdPerMillionTokens: 0.4,
        outputUsdPerMillionTokens: 1.6,
      }),
    ).toBe(0.0012);
  });

  test("returns unknown cost when a used token side has no configured price", () => {
    const usage = normalizeUsage({ prompt_tokens: 1, completion_tokens: 1_000_000, total_tokens: 1_000_001 });
    expect(
      estimateCostUsd(usage, {
        id: "partial/model",
        providerId: "partial",
        providerModel: "model",
        aliases: [],
        capabilities: ["chat"],
        inputUsdPerMillionTokens: 0.4,
      }),
    ).toBeUndefined();
  });
});
