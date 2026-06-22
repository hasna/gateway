# Hasna Gateway Docs

Read these documents before implementation:

1. [Product requirements](product-requirements.md)
2. [Architecture](architecture.md)
3. [API contract](api-contract.md)
4. [Provider adapters](provider-adapters.md)
5. [2026 provider references](provider-references.md)
6. [Routing and policy](routing-and-policy.md)
7. [Open-core boundary](open-core-boundary.md)
8. [Security and compliance](security-compliance.md)
9. [Implementation plan](implementation-plan.md)
10. [Publishing and release](publishing-and-release.md)
11. [Hasna app migration plan](migration-plan.md)
12. [Codewith handoff prompt](handoff-prompt.md)

## Current Decision

The gateway should be open source as a self-hostable core. The commercial Hasna product should be a hosted wrapper that adds one Hasna API key, billing, pooled provider keys, discounts, dashboards, and enterprise controls.

## Build Contract

The first implementation should prioritize a small working gateway over broad incomplete abstractions:

- A working CLI server.
- OpenAI-compatible chat completions.
- OpenAI-compatible provider adapter.
- Config validation.
- Model aliases.
- Fallback routing.
- Smart cost/quality/latency routing.
- Explicit provider policy.
- Config-driven provider auth and headers.
- Streaming.
- Usage normalization.
- Tests.

Provider breadth should stay on the generic OpenAI-compatible adapter when the upstream gateway uses standard chat completions plus headers or documented request-body provider options.

## Gateway Examples

- [OpenRouter Auto Router](../examples/openrouter-auto/README.md)
- [Vercel AI Gateway](../examples/vercel-ai-gateway/README.md)
- [Portkey AI Gateway](../examples/portkey/README.md)
- [Cloudflare AI Gateway](../examples/cloudflare-ai-gateway/README.md)
- [LiteLLM Proxy](../examples/litellm-proxy/README.md)
- [Helicone AI Gateway](../examples/helicone-ai-gateway/README.md)
- [Kong AI Gateway](../examples/kong-ai-gateway/README.md)
