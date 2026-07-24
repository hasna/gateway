# Routing And Policy

## Principles

Routing is useful only when it is transparent and policy-controlled. The gateway must never silently send requests to providers, regions, or data policies that the caller or tenant did not allow.

The default self-hosted behavior should be conservative:

- Use explicit model selection when provided.
- Use aliases only from local config.
- Do not call a provider without a configured key.
- Do not call a hosted Hasna endpoint unless the user configured it.
- Do not route to China-region or China-owned providers unless the route or config allows them.

Production cloud behavior must be explicit instead of inferred from deployment context. A config with `runtime.mode: "production-cloud"` should bind to a non-loopback interface, keep gateway auth required, require runtime secrets and route readiness for `/health`, and constrain provider discovery to HTTPS provider URLs plus any exact origins listed in `runtime.serviceDiscovery.allowedProviderBaseUrls`.

## Model Names

Recommended naming:

- Explicit provider model: `deepseek/deepseek-chat`
- Alias: `coding`
- Alias with policy: `coding:no-china`
- Hosted Hasna alias: `hasna/coding`

Aliases should resolve to ordered candidate lists, not single hard-coded models.

## Built-In Alias Ideas

- `fast`: low-latency everyday assistant.
- `cheap`: low-cost model for bulk tasks.
- `coding`: strong code generation and editing.
- `reasoning`: stronger deliberate reasoning.
- `long-context`: high context window.
- `china-fast`: fast route that allows Chinese providers.
- `china-coding`: coding route that allows Chinese providers.
- `local`: local or private endpoint when configured.

Aliases must be editable in config.

## Route Decision

Every request should produce a route decision:

```json
{
  "requested_model": "coding",
  "resolved_candidates": [
    "deepseek/deepseek-chat",
    "qwen/qwen-plus",
    "openai/gpt-4.1-mini"
  ],
  "selected": "deepseek/deepseek-chat",
  "mode": "fallback",
  "policy": {
    "blocked_regions": ["cn"],
    "allow_training": false
  },
  "reason": "first eligible model in fallback list"
}
```

Route decisions are important for debugging, tests, hosted audit logs, and user trust.

## Policy Inputs

Policy can come from several levels, in this order:

1. Hosted Hasna tenant policy.
2. Gateway config file.
3. API key policy.
4. Request-level `gateway` override.
5. Model alias defaults.

Hosted tenant policy should be able to reduce permissions, not expand them beyond what the gateway operator allows.

## Provider Data Policy

Each provider config should support:

- `regions`
- `jurisdiction`
- `allowsTraining`
- `logsPrompts`
- `zeroDataRetentionAvailable`
- `byokOnly`

If these values are unknown, the gateway should treat them as restrictive by default and require explicit opt-in for sensitive routes.

The implemented open-source defaults are fail-closed:

- `allowTraining: false`
- `allowLogging: false`
- `allowChineseProviders: false`
- `byokOnly: true`

Routes that intentionally use providers known to log prompts must set `allowLogging: true` explicitly.

Service discovery is also fail-closed in production cloud mode. Enabled providers must have an `apiKeyEnv`, local/private provider endpoints are rejected by default, and non-HTTPS endpoints require an explicit local endpoint allowlist. Dynamic model names can only select providers already present in config, so runtime requests cannot discover arbitrary provider hosts. The static URL checks do not resolve DNS; operators should still enforce network egress and private-address controls at the runtime boundary.

## Fallbacks

Fallbacks should handle:

- Provider outage.
- Provider rate limit.
- Model unavailable.
- Context window too small.
- Unsupported tool or response format.

Fallbacks should not hide:

- Policy violations.
- Provider authentication errors.
- User input errors.
- Unsafe region or data policy mismatches.

## Cost Controls

Cost controls should support:

- Per-request max estimated cost.
- Per-model input/output token price.
- Per-provider budget.
- Per-key budget in hosted mode.
- Daily/monthly budget in hosted mode.

The open-source core should calculate and expose cost. Hosted Hasna should enforce billable account budgets.

## Observability

Local observability should include:

- route attempts.
- selected provider/model.
- latency.
- status.
- retry/fallback reason.
- usage.
- estimated cost.

Hosted observability can add tenant dashboards, exports, alerts, and long-term analytics.
