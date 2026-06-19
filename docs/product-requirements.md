# Product Requirements

## Summary

Hasna Gateway should be an open-source AI gateway that gives every Hasna app, external developer, and self-hosted team one stable interface for many model providers. It should make provider choice a configuration and policy concern instead of hard-coding provider SDKs and API keys across each application.

The open-source package should let anyone run their own gateway. The hosted Hasna product should use the same core and add one Hasna API key, pooled provider keys, billing, credits, discounts, dashboards, and enterprise policy.

## Problem

Current Hasna open-source packages call providers directly in several different ways:

- Some packages use OpenRouter directly.
- Some packages maintain small provider registries.
- Some packages use direct provider SDKs or OpenAI-compatible URLs.
- Pricing and usage normalization already exists elsewhere and is not a shared gateway boundary.

That makes it harder to:

- Switch models per workflow.
- Add new providers once and reuse them everywhere.
- Support Chinese model providers consistently.
- Centralize spend controls and fallbacks.
- Offer a managed Hasna gateway with one key and plan-based discounts.

## Users

- Self-hosted developers who want one local endpoint and their own provider keys.
- Hasna internal apps that should stop embedding provider-specific logic.
- Teams that need explicit provider policy, such as no-China, China-only, no-training, no-logging, or BYOK-only.
- Hosted Hasna customers who want one Hasna API key and do not want to manage provider accounts.

## Goals

- Provide an OpenAI-compatible API for common chat workloads.
- Support OpenRouter-style routing while remaining provider-neutral.
- Support OpenAI-compatible providers, Anthropic, Google, and Chinese providers.
- Normalize streaming, non-streaming responses, tool calls, errors, usage, and cost.
- Keep the open-source package independently useful without Hasna cloud.
- Make the commercial hosted layer a clean wrapper, not a fork.

## Non-Goals

- Do not build hosted billing or accounts in the open-source package.
- Do not silently proxy all user traffic through Hasna.
- Do not hide provider identity, data policy, or region policy from users.
- Do not promise that every provider supports every OpenAI feature exactly.
- Do not implement a full observability SaaS product in the public core.

## Required Workflows

### Self-Hosted BYOK

1. User installs the package.
2. User creates `gateway.config.json`.
3. User sets provider API keys in environment variables.
4. User runs `gateway serve`.
5. User points an app at `http://localhost:8787/v1/chat/completions`.
6. User selects `model: "coding"` or an explicit model such as `deepseek/deepseek-chat`.

### Hasna Apps

1. App depends on `@hasna/gateway` or calls the local/hosted gateway endpoint.
2. App uses aliases such as `fast`, `reasoning`, `coding`, or `cheap`.
3. Gateway resolves policy and provider details.
4. App receives normalized OpenAI-compatible responses and usage.

### Hosted Hasna Gateway

1. Customer gets one Hasna API key.
2. Customer calls `https://gateway.hasna.com/v1/chat/completions`.
3. Hosted layer validates account, plan, entitlement, quotas, and tenant policy.
4. Gateway core routes to the best allowed provider.
5. Hosted layer records usage, cost, invoice lines, and discounts.

## Success Criteria

- A self-hosted user can route through at least five providers with their own keys.
- A Hasna app can switch from direct provider calls to the gateway without losing streaming or usage accounting.
- Chinese provider support is explicit, documented, and policy-controlled.
- Tests cover routing, fallback, provider error mapping, usage normalization, and no-cloud defaults.
- Package can be published as `@hasna/gateway`.
