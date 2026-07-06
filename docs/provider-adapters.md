# Provider Adapters

## Adapter Contract

Each adapter should implement a shared contract:

```ts
type ProviderAdapter = {
  id: string;
  kind: string;
  supports: ProviderCapabilities;
  buildRequest(input: GatewayRequest): ProviderHttpRequest;
  parseResponse(response: Response): Promise<GatewayResponse>;
  parseStream(response: Response): AsyncIterable<GatewayStreamChunk>;
  parseUsage(raw: unknown): GatewayUsage;
  mapError(error: unknown): GatewayError;
};
```

Adapters should not own billing, Hasna accounts, tenant policy, or hosted credentials. They only know how to talk to a provider.

## First Adapter Families

### OpenAI-Compatible

This should be the first implementation because it covers many providers with the same base shape:

- OpenAI-compatible chat completions path.
- Bearer API key.
- Request body close to OpenAI chat completions.
- SSE streaming close to OpenAI streaming.

Providers likely covered by this adapter include OpenAI-compatible endpoints from DeepSeek, DashScope/Qwen, Kimi/Moonshot, Z.AI/GLM, SiliconFlow, Groq, Together, Fireworks, Mistral, and OpenRouter.

### Anthropic

Anthropic has a different message and streaming format. The adapter should convert between gateway common request and Anthropic Messages API shape.

### Google

Google Gemini can be reached through Google's OpenAI-compatible chat completions endpoint for the first gateway adapter. Native Gemini `generateContent` support can still be added later for provider-specific content, tool, safety, and streaming controls.

The built-in `google` preset is intentionally conservative about data policy. Operators should explicitly allow the required provider logging/training policy in a route, or override the provider policy after verifying the account tier and Google terms for their own key.

### OpenRouter

OpenRouter can be supported as a provider adapter and as a routing backend. It should not be the only gateway strategy. Hasna Gateway should still be able to call providers directly.

## Chinese Provider Priority

These providers should be first-class because they are important for cost, coding, and international model access:

- `deepseek`: DeepSeek chat and reasoning models.
- `qwen`: Alibaba DashScope/Qwen OpenAI-compatible endpoint.
- `kimi`: Moonshot/Kimi OpenAI-compatible endpoint.
- `zai`: Z.AI/GLM models.
- `siliconflow`: Aggregated Chinese and open models through SiliconFlow.

Each provider entry must document:

- Provider base URL.
- Environment variable name.
- Supported model IDs.
- Region and data handling notes.
- Supported capabilities.
- Streaming behavior.
- Usage field quirks.
- Retryable and non-retryable errors.

## Suggested Environment Variables

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=
DASHSCOPE_API_KEY=
MOONSHOT_API_KEY=
ZAI_API_KEY=
SILICONFLOW_API_KEY=
```

## Usage Normalization

Normalize usage into this internal shape:

```ts
type GatewayUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
};
```

Provider-specific names such as `prompt_tokens`, `completion_tokens`, `input_tokens`, `output_tokens`, cached token fields, or reasoning token fields should be normalized in adapters.

## Error Mapping

Provider status codes should map to gateway categories:

- 400: bad request or unsupported feature.
- 401/403: provider auth or account policy error.
- 404: model not found or path misconfigured.
- 408/429: retryable rate/concurrency condition when safe.
- 500/502/503/504: retryable provider availability condition when safe.

The router should only retry idempotent or safe request attempts. Streaming failures after partial output should not blindly restart unless the caller opted into that behavior.
