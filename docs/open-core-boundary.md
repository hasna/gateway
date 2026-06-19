# Open-Core Boundary

## Decision

Hasna Gateway should be open source as a reusable gateway core. The commercial hosted product should be a private wrapper around that core.

This keeps the project trustworthy and useful while preserving the business value of Hasna's hosted service.

## Open Source

The public `open-gateway` repository should own:

- Provider adapter contracts.
- OpenAI-compatible HTTP API.
- Local CLI.
- Local config schema.
- Model registry format.
- Alias and routing engine.
- Policy engine.
- Fallback engine.
- Usage normalization.
- Cost estimation hooks.
- Local metrics storage.
- SDK exports.
- Tests and fixtures.
- Documentation.
- Public release checks.

Open source users should be able to run a complete gateway with their own provider keys.

## Private Hasna Hosted Layer

The private hosted platform should own:

- User accounts.
- Organizations and teams.
- Hasna API keys.
- Provider key vault.
- Pooled provider contracts.
- Discounts, coupons, credits, and plans.
- Entitlements.
- Abuse detection.
- Tenant rate limits.
- Hosted usage dashboards.
- Billing records and invoices.
- Production deployment.
- Hosted observability storage.
- Enterprise policy management.

This private layer can call into the open gateway core as a library or run it as an internal service.

## Boundary Rules

- Public core must not contain Hasna production secrets, private provider keys, or private URLs.
- Public core must not require Hasna cloud to pass tests.
- Hosted-only fields must be isolated behind explicit extension interfaces.
- Public docs can mention hosted Hasna as an optional deployment mode.
- Public defaults should be local-first and BYOK-friendly.
- Commercial features should enhance convenience, not break self-hosted functionality.

## Business Model

Open source positioning:

> Run your own AI gateway with your own keys.

Hosted positioning:

> Use one Hasna key for many models, managed routing, spend controls, discounts, team billing, and fewer provider accounts.

The open-source project creates adoption, integrations, and trust. The hosted product monetizes convenience, reliability, negotiated discounts, support, and team operations.
