import { describe, expect, test } from "bun:test";
import { estimateCostUsd, normalizeUsage, toOpenAIEmbeddingsUsage, toOpenAIUsage } from "../src/usage";

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

  test("normalizes Anthropic cache usage without undercounting prompt totals", () => {
    const usage = normalizeUsage({
      input_tokens: 11,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 6,
    });

    expect(usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
      totalTokens: 24,
      cachedInputTokens: 3,
    });
    expect(toOpenAIUsage(usage)).toEqual({
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
      prompt_tokens_details: { cached_tokens: 3 },
    });
  });

  test("does not let explicit total usage undercount normalized tokens", () => {
    const usage = normalizeUsage({
      input_tokens: 11,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 6,
      total_tokens: 15,
    });

    expect(toOpenAIUsage(usage)).toMatchObject({
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
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

  test("estimates configured cost from normalized Anthropic cache usage", () => {
    const usage = normalizeUsage({
      input_tokens: 11,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 6,
    });

    expect(
      estimateCostUsd(usage, {
        id: "anthropic/claude-3-5-sonnet",
        providerId: "anthropic",
        providerModel: "claude-3-5-sonnet-latest",
        aliases: [],
        capabilities: ["chat"],
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
      }),
    ).toBe(0.000111);
  });

  test("serializes embeddings usage without chat completion fields", () => {
    const usage = normalizeUsage({ prompt_tokens: 12, total_tokens: 12 });
    expect(toOpenAIEmbeddingsUsage(usage)).toEqual({
      prompt_tokens: 12,
      total_tokens: 12,
    });
    expect(toOpenAIEmbeddingsUsage(usage)).not.toHaveProperty("completion_tokens");
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
