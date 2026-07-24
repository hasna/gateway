# Hasna Gateway

Hasna Gateway is the open-source AI gateway core for Hasna apps and self-hosted teams. It exposes one stable OpenAI-compatible API while routing requests across providers, including OpenAI, Google Gemini, OpenRouter, DeepSeek, Qwen/DashScope, Kimi/Moonshot, Z.AI/GLM, and SiliconFlow.

The open-source package is useful on its own. Anyone can run it locally or on their own server, bring their own provider keys, define routing policy, and point applications at one endpoint. The hosted Hasna gateway can build on the same core while keeping accounts, billing, pooled provider contracts, discounts, tenant policy, and hosted observability private.

## Product Shape

- OpenAI-compatible HTTP API first, starting with `/v1/chat/completions`.
- One gateway key for clients, many provider keys behind the gateway.
- Bring-your-own-key mode for self-hosted users.
- Routing by model alias, provider allowlist/blocklist, region policy, price ceilings, fallback, and capability.
- Explicit China/provider policy so requests are never silently routed to a region or provider class the caller did not allow.
- Usage normalization, estimated cost hooks, route decision metadata, and optional local JSONL usage ledger.
- Hard or soft budgets by gateway key, tenant, and model alias across USD plus input/output/total tokens.
- Local-first defaults: no hosted Hasna calls unless explicitly configured.

## Quick Start

Install the published CLI when you want to run the gateway without a source
checkout:

```bash
bun install -g @hasna/gateway
gateway --help
```

For source development:

```bash
bun install
cp .env.example .env
cp gateway.config.example.json gateway.config.json
```

Set `GATEWAY_API_KEY` and at least one provider key in your environment, then run:

```bash
bun run build
bun dist/cli/index.js serve --config gateway.config.json
```

Call the gateway with any OpenAI-compatible client or curl:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"Say hello."}]}'
```

## Commands

```bash
bun run typecheck
bun test
bun run build
bun dist/cli/index.js validate --config gateway.config.example.json
bun dist/cli/index.js validate --config gateway.config.production-cloud.example.json
bun dist/cli/index.js smoke --config gateway.config.example.json --model fast
bun dist/cli/index.js smoke --config gateway.config.example.json --all
bun dist/cli/index.js budget-add --config gateway.config.json --id team-daily --window daily --tenant acme --model fast --max-usd 5 --max-total-tokens 100000
bun dist/cli/index.js budget-remaining --config gateway.config.json --id team-daily --json
```

After installation as a package, the CLI binary is `gateway`:

```bash
gateway serve --config gateway.config.json
gateway-serve --config gateway.config.json
gateway-mcp --config gateway.config.json
```

`gateway-serve` is the package-level service binary for local and self-hosted
HTTP runtime smoke checks. It exposes `GET /health`, authenticated `GET /ready`,
`GET /version`, `GET /v1/models`, and `POST /v1/chat/completions`.

`gateway-mcp` is a stdio MCP server for local agents. It validates and inspects config, explains route choices without provider calls, manages budget definitions, checks remaining budgets, and summarizes the configured usage ledger. Long-running `serve` and live `smoke` checks stay CLI-only. See [Gateway MCP server](docs/mcp.md).

## Configuration

Required config examples:

- `gateway.config.example.json`: mixed provider routes with explicit China-allowed aliases.
- `gateway.config.production-cloud.example.json`: production cloud runtime with non-loopback binding, fail-closed health, gateway auth, HTTPS provider endpoints, and explicit provider endpoint allowlist.
- `gateway.config.no-china.example.json`: OpenAI/OpenRouter-only policy with `cn` blocked.
- `gateway.config.china.example.json`: Chinese provider routes with explicit `cn`/`sg` allowance.

Provider keys are loaded from environment variables only. Do not put provider secrets in config files.

Budgets live in the same JSON config and spend is calculated from the usage ledger. JSONL append through `storage.usageLedgerPath` is the local-first default. Daily, monthly, and lifetime budgets require either `storage.usageLedgerPath` or an explicit `storage.cloud` backend; per-request budgets can run without cumulative storage. Use `mode: "hard"` to block exhausted budgets with an OpenAI-compatible `402` error, or `mode: "soft"` to keep serving while exposing warnings in gateway metadata and ledger records.

### Runtime Modes

The default runtime mode is `local`. It preserves local-first behavior: the server binds to `127.0.0.1`, provider discovery is driven by the local JSON config, and `/health` stays a lightweight liveness check that does not require secrets.

Set `runtime.mode` to `production-cloud` when running the gateway behind a cloud load balancer, API gateway, or Hasna-hosted wrapper. Production cloud mode makes the cloud path explicit and fail-closed:

- `auth.required` must be `true`.
- `server.host` must not be a loopback host; use `0.0.0.0` for container ingress.
- `runtime.health.requireRuntimeSecrets` must be `true`, so `/health` returns `503` until the gateway key is present and every configured route has an eligible provider with its key present.
- enabled providers must declare `apiKeyEnv`.
- enabled provider `baseUrl` values must be HTTPS and must not be local/private endpoints unless an explicit local endpoint allowlist is configured. This is a static URL check; DNS and network egress controls remain operator responsibilities.
- `runtime.serviceDiscovery.allowedProviderBaseUrls` can restrict enabled providers to exact provider URL origins.

Production cloud mode does not create DNS, ACM, API Gateway, secrets, provider keys, or cloud infrastructure. Those deployment steps require an operator-owned deployment workflow outside this package.

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api-contract.md)
- [Provider adapters](docs/provider-adapters.md)
- [2026 provider references](docs/provider-references.md)
- [Routing and policy](docs/routing-and-policy.md)
- [Gateway MCP server](docs/mcp.md)
- [Open-core boundary](docs/open-core-boundary.md)
- [Security and compliance](docs/security-compliance.md)
- [Implementation plan](docs/implementation-plan.md)
- [Publishing and release](docs/publishing-and-release.md)
- [Hasna app migration plan](docs/migration-plan.md)
- [Agent handoff prompt](docs/handoff-prompt.md)

## Status

The gateway core is implemented and locally verified for the first release surface: CLI server, MCP server, health/models/chat endpoints, OpenAI-compatible provider adapter, provider presets, routing policy, fallbacks, streaming, usage normalization, optional local ledger, examples, tests, build, and package dry-run.

Publication is gated on a passing live smoke check with valid provider credentials.
