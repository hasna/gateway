# Hasna App Migration Plan

This plan covers the first low-risk migrations from direct provider integrations to Hasna Gateway.

## Compatibility Surface

The first migration wave should rely only on the stable open-source gateway surface:

- OpenAI-compatible `POST /v1/chat/completions`
- SSE streaming with `data: ...` chunks and `[DONE]`
- `GET /v1/models` for configured aliases
- Gateway bearer auth through `GATEWAY_API_KEY`
- Provider keys supplied by server-side environment variables
- Model aliases such as `fast`, `coding`, `coding:no-china`, `china-fast`, and `china-coding`
- Gateway policy overrides under the request `gateway` field

## First Low-Risk Target

`open-projects` is the best first target because it already uses OpenRouter-style OpenAI-compatible calls. The migration should replace direct OpenRouter base URL/key handling with:

- `baseURL=http://127.0.0.1:8787/v1` for local development
- `Authorization: Bearer $GATEWAY_API_KEY`
- model aliases instead of provider-specific model IDs where possible

Keep the existing OpenRouter path as a temporary rollback option until streaming and usage parity are verified.

## Package Notes

### open-projects

- Replace direct `OPENROUTER_API_KEY` use in app code with `GATEWAY_API_KEY`.
- Move provider keys to the gateway process environment.
- Start with `model: "coding:no-china"` for conservative defaults.
- Add tests for non-streaming and streaming chat calls through a mock gateway.

### open-knowledge

- Replace hard-coded provider registry reads with gateway aliases.
- Preserve usage accounting by reading normalized `usage` and optional `gateway.estimated_cost_usd`.
- Add policy tests for `blocked_regions: ["cn"]` and zero-data-retention routes before changing defaults.

### open-browser

- Migrate provider-specific chat calls behind gateway aliases after confirming tool-call compatibility.
- Keep direct Anthropic/Cerebras paths until native non-OpenAI adapters are added or the target provider exposes a compatible endpoint.
- Add browser workflow tests that assert streamed chunks render without provider-specific parsing.

### open-coders

- Treat the existing provider registry as an input source for gateway config generation.
- Start with code-generation workflows using `coding` and `china-coding`.
- Add tests for route decision metadata so users can see which provider/model handled a code edit.

## Required Verification Before Switching Defaults

- Gateway local server smoke passes for health, models, non-streaming chat, and streaming chat.
- App test suite passes with a mock gateway.
- At least one live provider smoke passes with the provider keys available to the operator.
- No app sends provider API keys from the client to the gateway.
- No hosted Hasna account, billing, discount, or private provider contract logic is introduced into open-source packages.
