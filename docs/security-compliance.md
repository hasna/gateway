# Security And Compliance

## Default Stance

The gateway handles prompts, responses, provider API keys, and usage records. Treat it as sensitive infrastructure.

The secure default is:

- No hosted Hasna calls unless configured.
- No provider call unless the provider key exists and policy allows it.
- No silent routing to Chinese providers or regions.
- No logging of full prompts by default.
- No secrets in route decision logs.
- Fail closed on unknown data policy.

Runtime mode must also match the deployment:

- `local` is the self-hosted default and keeps `/health` as liveness only.
- `production-cloud` is for cloud ingress and requires gateway auth, non-loopback binding, secret-aware health readiness, and cloud-safe provider endpoint validation.

## Secrets

Provider keys should be loaded from environment variables or a configured secret provider. They must not be stored in plaintext config files by default.

Recommended open-source env variables:

- `GATEWAY_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `OPENROUTER_API_KEY`
- `AI_GATEWAY_API_KEY`
- `LITELLM_PROXY_BASE_URL`
- `LITELLM_API_KEY`
- `PORTKEY_API_KEY`
- `PORTKEY_CONFIG_ID`
- `PORTKEY_PROVIDER`
- `PORTKEY_VIRTUAL_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_AI_GATEWAY_BASE_URL`
- `HELICONE_API_KEY`
- `KONG_AI_GATEWAY_BASE_URL`
- `KONG_AI_GATEWAY_API_KEY`
- `DEEPSEEK_API_KEY`
- `DASHSCOPE_API_KEY`
- `MOONSHOT_API_KEY`
- `ZAI_API_KEY`
- `SILICONFLOW_API_KEY`

Hosted Hasna can use a private key vault and tenant-scoped provider credentials.

In `production-cloud` mode, `/health` returns `503` until the gateway key is available and every configured route has an eligible provider with its key available. The response reports only generic readiness state and runtime mode; it must not reveal environment variable names or secret values.

## Logging

Default local logs should include:

- request id.
- route decision.
- provider id.
- model id.
- latency.
- status.
- usage.
- estimated cost.

Default local logs should not include:

- full prompts.
- full responses.
- provider API keys.
- Hasna API keys.
- tool payloads that may contain secrets.

Prompt/response logging can be opt-in for local debugging.

## Region And Provider Policy

Provider policy must be explicit. Important examples:

- `allow_chinese_providers: false`
- `allow_chinese_providers: true`
- `allowed_regions: ["us", "eu"]`
- `blocked_regions: ["cn"]`
- `zero_data_retention_required: true`
- `allow_training: false`
- `allow_logging: false`
- `byok_only: true`

If provider terms, retention, or region are unknown, the gateway should treat the provider as unavailable for restricted routes.

Provider service discovery must be explicit for production cloud runtime. Enabled providers must use configured `baseUrl` values, and operators can set `runtime.serviceDiscovery.allowedProviderBaseUrls` to a list of exact provider origins. Local/private endpoints and non-HTTPS provider URLs are rejected by default in production cloud mode. These are static config checks; DNS resolution and cloud egress policy remain operator responsibilities.

Gateway providers such as Portkey, Cloudflare, Vercel, Helicone, Kong, and LiteLLM may perform their own logging, routing, fallback, billing, or retention. Configure their `dataPolicy` conservatively and only enable them on routes whose logging, region, and BYOK requirements they can satisfy.

## Abuse Controls

Open-source self-hosted mode should include basic controls:

- Gateway API key requirement.
- Per-key rate limit.
- Max request body size.
- Max output token setting.
- Timeout per provider attempt.
- Max fallback attempts.

Hosted Hasna should add:

- Account abuse scoring.
- Payment and credit checks.
- IP and org throttles.
- Provider-specific quotas.
- Fraud controls.

## Compliance Notes

This project should not present itself as solving legal compliance by default. It should provide primitives that help operators enforce their policies.

Docs must tell operators to verify provider terms, data retention, training use, regional processing, export restrictions, and regulated data handling before enabling providers for production traffic.
