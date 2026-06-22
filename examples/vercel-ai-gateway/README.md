# Vercel AI Gateway

Use the `vercel-ai-gateway` preset for Vercel's OpenAI-compatible gateway endpoint.

```json
{
  "presets": ["vercel-ai-gateway"],
  "routes": [
    {
      "id": "vercel-coding",
      "mode": "fallback",
      "modelAliases": ["vercel-coding"],
      "fallbackModelIds": ["vercel-ai-gateway/openai/gpt-4.1-mini"],
      "dataPolicy": {
        "allowTraining": false,
        "allowLogging": true,
        "allowedRegions": ["global"]
      }
    }
  ]
}
```

Request with Vercel gateway provider options:

```json
{
  "model": "vercel-coding",
  "messages": [{ "role": "user", "content": "Implement a small TypeScript helper." }],
  "gateway": {
    "provider_order": ["bedrock", "anthropic", "openai"],
    "provider_only": ["bedrock", "anthropic", "openai"],
    "caching": "auto",
    "provider_timeouts": {
      "byok": { "anthropic": 3000, "openai": 5000 }
    }
  }
}
```

Set `AI_GATEWAY_API_KEY`. Keep provider credentials in Vercel's gateway settings when using BYOK.
