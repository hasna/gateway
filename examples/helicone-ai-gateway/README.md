# Helicone AI Gateway

Use the `helicone-ai-gateway` preset when Helicone owns the upstream gateway and observability layer.

```json
{
  "presets": ["helicone-ai-gateway"],
  "routes": [
    {
      "id": "helicone-coding",
      "mode": "fallback",
      "modelAliases": ["helicone-coding"],
      "fallbackModelIds": ["helicone-ai-gateway/openai/gpt-4.1-mini"],
      "dataPolicy": {
        "allowTraining": false,
        "allowLogging": true,
        "allowedRegions": ["global"]
      }
    }
  ]
}
```

Set `HELICONE_API_KEY`. The preset uses generic header auth through `Helicone-Auth: Bearer <key>`.
