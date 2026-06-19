# Implementation Plan

## Phase 0: Scaffold And Decisions

Deliverables:

- Package scaffold.
- Docs.
- Todos plan.
- Project registration.
- Tmux build agent handoff.

Acceptance criteria:

- `open-gateway` exists in the open-source workspace.
- Docs define product, architecture, API, adapters, routing, security, and release plan.
- Todos CLI contains a plan and concrete tasks.

## Phase 1: Minimal Local Gateway

Deliverables:

- CLI command: `gateway serve`.
- Config loader for `gateway.config.json`.
- `GET /health`.
- `GET /v1/models`.
- `POST /v1/chat/completions`.
- Gateway API key validation.
- OpenAI-compatible provider adapter.
- Non-streaming chat completion support.

Acceptance criteria:

- A local user can configure one OpenAI-compatible provider and call the gateway with an OpenAI SDK.
- Tests cover config validation, auth, model lookup, provider request construction, and response normalization.

## Phase 2: Streaming, Usage, And Errors

Deliverables:

- SSE streaming support.
- Provider streaming parser.
- Normalized usage.
- OpenAI-compatible error envelope.
- Retryable vs non-retryable error taxonomy.
- Timeout and request size controls.

Acceptance criteria:

- Streaming works with OpenAI-compatible clients.
- Usage is recorded for streaming and non-streaming requests.
- Error tests cover auth, bad model, provider rate limit, provider unavailable, and policy failure.

## Phase 3: Routing And Fallbacks

Deliverables:

- Model aliases.
- Candidate lists.
- Policy filtering.
- Fallback chains.
- Cost and latency scoring hooks.
- Route decision output.

Acceptance criteria:

- `model: "coding"` resolves through a configured fallback list.
- Gateway retries only safe retryable failures.
- Policy violations fail without attempting a provider request.
- Route decisions are testable and optionally returned to clients.

## Phase 4: Provider Expansion

Deliverables:

- DeepSeek adapter/config preset.
- DashScope/Qwen adapter/config preset.
- Kimi/Moonshot adapter/config preset.
- Z.AI/GLM adapter/config preset.
- SiliconFlow adapter/config preset.
- Anthropic adapter.
- OpenRouter adapter.

Acceptance criteria:

- At least five providers are tested with mock fixtures.
- At least two providers are verified live when API keys are present.
- Provider docs explain env vars, base URLs, supported features, and known quirks.

## Phase 5: Cost, Metrics, And Hasna Integration Points

Deliverables:

- Cost estimate interface.
- Integration path with `@hasna/economy` pricing.
- Local usage ledger.
- Metrics export.
- Hosted extension hooks for account, tenant policy, billing, and key vault.

Acceptance criteria:

- Open-source core works without hosted Hasna dependencies.
- Hosted extension interfaces are documented but not implemented in public code.
- Usage and estimated cost are available per request.

## Phase 6: Migration Of Existing Hasna Apps

Deliverables:

- `open-projects` migration plan from direct OpenRouter usage.
- `open-knowledge` migration plan from hard-coded provider registry.
- `open-browser` migration plan from direct Cerebras/Anthropic calls.
- `open-coders` provider registry compatibility plan.

Acceptance criteria:

- At least one existing Hasna open-source package can call the gateway in local development.
- No package loses streaming, tool calls, or usage tracking in the migration.

## Phase 7: Release

Deliverables:

- Public README.
- Examples.
- `.env.example`.
- `gateway.config.example.json`.
- Tests.
- Build.
- npm package release.
- GitHub publication metadata.

Acceptance criteria:

- `bun install`, `bun run typecheck`, `bun test`, and `bun run build` pass.
- Package can be installed and run from a clean checkout.
- A live smoke test works with the API keys available in the environment.
- The project is published only after the package is functional.
