# Codewith Handoff Prompt

Use this prompt for the dedicated build agent:

```text
You are working in /home/hasna/workspace/hasna/opensource/open-gateway.

Start a goal for this project: fully build, verify, and publish Hasna Gateway as the open-source AI gateway core. Do not stop at planning. Continue until the app is implemented, working locally, tested, and published or until a real external blocker makes publication impossible.

Context:
- Hasna Gateway should be an open-source OpenRouter-style gateway core, not a hosted-only product.
- It must let anyone self-host their own gateway with their own provider keys.
- It should expose OpenAI-compatible endpoints first, especially /v1/chat/completions.
- It should support one client gateway key and many provider keys behind it.
- It should support model aliases, routing policy, provider allowlists/blocklists, fallbacks, usage normalization, and estimated cost.
- It must especially support Chinese model providers: DeepSeek, Qwen/DashScope, Kimi/Moonshot, Z.AI/GLM, and SiliconFlow.
- It must keep hosted Hasna billing/accounts/discounts/private provider contracts out of the open-source core.

Read all docs in docs/ before editing. Then implement the app.

Required implementation:
1. Build the Bun/TypeScript package and CLI.
2. Implement gateway serve with health, models, and OpenAI-compatible chat completions endpoints.
3. Implement config loading, schema validation, env var key loading, and examples.
4. Implement OpenAI-compatible provider adapter first.
5. Add provider presets for OpenAI, OpenRouter, DeepSeek, DashScope/Qwen, Kimi/Moonshot, Z.AI/GLM, and SiliconFlow.
6. Implement Anthropic if time permits before publishing; otherwise leave a documented task and do not block the first release if the core works.
7. Implement streaming, usage normalization, error mapping, route decisions, fallback routing, and policy enforcement.
8. Add tests for config, auth, routing, policy, provider request construction, streaming parser, usage normalization, and errors.
9. Run bun install, bun run typecheck, bun test, and bun run build.
10. Run live smoke tests using whatever API keys are available in the environment. Do not print secrets.
11. Publish only after the package is genuinely working. If publishing requires credentials that are not available, document the exact blocker and leave the package release-ready.

Use the todos plan already created for this project. Keep the todos status updated as you work.
```
