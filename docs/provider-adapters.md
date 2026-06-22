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

Google Gemini has different content, tool, safety, and streaming shapes. The adapter should be implemented after the OpenAI-compatible and Anthropic adapters are stable.

### OpenRouter

OpenRouter can be supported as a provider adapter and as a routing backend. It should not be the only gateway strategy. Hasna Gateway should still be able to call providers directly.

The current implementation keeps OpenRouter on the OpenAI-compatible adapter and maps only documented request body controls to `provider`, `plugins`, and `session_id`. This avoids an adapter fork while still supporting provider selection, ZDR, data collection, max price, and Auto Router options.

## Generic Gateway Provider Config

OpenAI-compatible providers and gateways can be configured without code changes:

```json
{
  "id": "example-gateway",
  "displayName": "Example Gateway",
  "kind": "openai-compatible",
  "baseUrlEnv": "EXAMPLE_GATEWAY_BASE_URL",
  "auth": {
    "type": "header",
    "apiKeyEnv": "EXAMPLE_GATEWAY_KEY",
    "headerName": "x-api-key",
    "prefix": ""
  },
  "headers": {
    "x-config-id": { "env": "EXAMPLE_GATEWAY_CONFIG_ID" },
    "x-static": "static-value"
  },
  "dataPolicy": {
    "allowTraining": false,
    "allowLogging": false,
    "byokOnly": true
  }
}
```

Supported provider config fields:

- `baseUrl`: static OpenAI-compatible base URL.
- `baseUrlEnv`: environment variable containing the base URL.
- `apiKeyEnv`: shorthand for bearer auth.
- `auth.type`: `bearer`, `header`, or `none`.
- `auth.apiKeyEnv`, `auth.headerName`, `auth.prefix`: custom credential header settings.
- `headers`: static values or `{ "env": "...", "prefix": "...", "required": true }`.

Built-in gateway presets:

- `vercel-ai-gateway`
- `litellm-proxy`
- `portkey`
- `cloudflare-ai-gateway`
- `helicone-ai-gateway`
- `kong-ai-gateway`

These remain normal route candidates. If the upstream gateway performs its own fallback or load balancing, Hasna Gateway records that upstream as one provider attempt unless the route config lists additional Hasna candidates.

## Provider Option Mapping

Direct providers receive only OpenAI-compatible request fields. Gateway-specific fields are stripped.

Mapped gateway bodies:

- OpenRouter: `provider.order`, `only`, `ignore`, `sort`, `max_price`, `allow_fallbacks`, `zdr`, `data_collection`, `quantizations`, `preferred_min_throughput`, and Auto Router plugin `allowed_models` / `cost_quality_tradeoff`.
- Vercel AI Gateway: `providerOptions.gateway.order`, `only`, `caching`, and `providerTimeouts`.

Portkey, Cloudflare, LiteLLM, Helicone, and Kong are supported through provider config headers/auth and OpenAI-compatible model IDs. Their own routing/load-balancing configs stay in those systems.

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
