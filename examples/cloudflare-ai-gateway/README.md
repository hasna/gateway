# Cloudflare AI Gateway

Use the `cloudflare-ai-gateway` preset with an account-specific base URL.

```bash
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_AI_GATEWAY_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1
```

```json
{
  "presets": ["cloudflare-ai-gateway"],
  "routes": [
    {
      "id": "cloudflare-coding",
      "mode": "fallback",
      "modelAliases": ["cloudflare-coding"],
      "fallbackModelIds": ["cloudflare-ai-gateway/openai/gpt-4.1-mini"],
      "dataPolicy": {
        "allowTraining": false,
        "allowLogging": true,
        "allowedRegions": ["global"]
      }
    }
  ]
}
```

Cloudflare's current REST API exposes an OpenAI-compatible chat completions path under `/ai/v1`; the gateway adapter appends `/chat/completions`.
