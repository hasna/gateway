# Architecture

## Layers

### HTTP Server

The server exposes public endpoints:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- Later: `/v1/responses`, `/v1/embeddings`, `/v1/images`, `/v1/audio`

The server should be lightweight and embeddable. It can run as a CLI process, be imported into another Bun service, or be wrapped by a hosted Hasna service.

### Request Normalizer

The gateway accepts OpenAI-compatible request bodies. It should normalize:

- `model`
- `messages`
- `tools`
- `tool_choice`
- `response_format`
- `stream`
- `temperature`
- `top_p`
- `max_tokens`
- provider-specific options under a namespaced field such as `provider_options`

The normalized request becomes the internal common request shape used by every adapter.

### Policy Engine

The policy engine decides which providers and models are eligible before routing begins. It evaluates:

- Provider allowlist and blocklist.
- Model capability requirements.
- Data policy.
- Region policy.
- BYOK-only policy.
- Cost ceilings.
- Tenant or request-level overrides.

The policy engine must fail closed. If a policy cannot be proven safe, the request should not be routed.

### Router

The router receives a normalized request and eligible model candidates. It chooses a provider/model pair using one of these modes:

- `explicit`: exact provider/model requested.
- `fallback`: try models in configured order.
- `cheapest`: choose lowest expected cost.
- `lowest-latency`: choose lowest recent p95 or configured latency.
- `highest-throughput`: choose provider with best recent success and throughput.
- `balanced`: weighted score from cost, latency, success rate, and quality hints.

Routing should always produce a route decision object that can be logged and tested.

### Provider Adapter Layer

Adapters convert the internal request to provider-specific requests and normalize responses back into the gateway response shape. A provider adapter owns:

- URL construction.
- Auth headers.
- Request body conversion.
- Streaming chunk conversion.
- Error mapping.
- Usage parsing.
- Capability declarations.

The first adapter class should be OpenAI-compatible because many providers expose a compatible chat-completions API.

### Usage and Cost

The gateway should normalize token usage into a shared shape:

- input tokens.
- output tokens.
- cached input tokens.
- reasoning tokens when available.
- total tokens.
- provider raw usage.

Cost estimation should integrate with `open-economy` pricing data rather than inventing a second pricing source.

### Storage

Open source defaults should be local-first:

- JSON config file for providers, models, routes, and aliases.
- Optional local SQLite for metrics, latency, failures, and usage.
- No Hasna cloud writes unless explicitly configured.

The hosted Hasna platform can replace or extend storage with private tenant databases.

## Request Lifecycle

1. Client sends an OpenAI-compatible request.
2. Gateway validates auth for the gateway itself.
3. Request body is parsed and normalized.
4. Model alias is resolved.
5. Policy engine filters providers and models.
6. Router selects the first route attempt.
7. Provider adapter sends the request.
8. If retryable failure occurs, router attempts the next fallback.
9. Response or stream is normalized.
10. Usage and cost are recorded.
11. Client receives an OpenAI-compatible response.

## Package Boundaries

Recommended internal modules:

- `src/server`: HTTP server and route handlers.
- `src/cli`: CLI entry point.
- `src/config`: config loading, schema validation, env interpolation.
- `src/providers`: adapter contracts and provider implementations.
- `src/models`: model registry and alias resolution.
- `src/router`: policy, routing, fallback, scoring.
- `src/usage`: usage normalization and cost estimation.
- `src/storage`: local metrics and usage storage.
- `src/errors`: provider error taxonomy.
- `src/sdk`: embeddable TypeScript API.

## Existing Hasna Code To Reuse

- Provider conversion ideas from `open-aicopilot`.
- Provider adapters and registry ideas from `open-coders`.
- OpenRouter usage pattern from `open-projects`.
- Pricing normalization from `open-economy`.
- Open-core boundary rules from `open-economy/docs`.
