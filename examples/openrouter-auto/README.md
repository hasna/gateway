# OpenRouter Auto Router

Use the built-in `openrouter` preset with the `openrouter/auto` model preset when you want OpenRouter to choose the underlying model. Hasna Gateway still applies local policy before calling OpenRouter.

```json
{
  "presets": ["openrouter"],
  "routes": [
    {
      "id": "openrouter-auto",
      "mode": "fallback",
      "modelAliases": ["gateway-auto"],
      "fallbackModelIds": ["openrouter/auto"],
      "dataPolicy": {
        "allowTraining": false,
        "allowLogging": false,
        "allowedRegions": ["global"]
      }
    }
  ]
}
```

Request with provider routing and Auto Router options:

```json
{
  "model": "gateway-auto",
  "messages": [{ "role": "user", "content": "Pick the right model for this task." }],
  "gateway": {
    "provider_order": ["anthropic", "openai"],
    "provider_only": ["anthropic", "openai"],
    "allow_fallbacks": true,
    "zero_data_retention_required": true,
    "cost_quality_tradeoff": 3,
    "sticky_session_id": "conversation-123"
  },
  "provider_options": {
    "openrouter": {
      "allowed_models": ["anthropic/*", "openai/gpt-5*"]
    }
  }
}
```

Set `OPENROUTER_API_KEY`. The preset sends OpenRouter attribution headers through generic provider headers.
