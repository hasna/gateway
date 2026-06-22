# Kong AI Gateway

Use the `kong-ai-gateway` preset for a self-hosted Kong AI Gateway or Kong route that exposes an OpenAI-compatible endpoint.

```bash
KONG_AI_GATEWAY_BASE_URL=https://kong.example.com/v1
KONG_AI_GATEWAY_API_KEY=
```

```json
{
  "presets": ["kong-ai-gateway"],
  "routes": [
    {
      "id": "kong-coding",
      "mode": "fallback",
      "modelAliases": ["kong-coding"],
      "fallbackModelIds": ["kong-ai-gateway/coding"],
      "dataPolicy": {
        "allowTraining": false,
        "allowLogging": false,
        "allowedRegions": ["private"]
      }
    }
  ]
}
```

Kong can perform its own load balancing and semantic routing. Hasna Gateway still records the Kong route as one upstream attempt.
