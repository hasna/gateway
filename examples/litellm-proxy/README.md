# LiteLLM Proxy

Use the `litellm-proxy` preset when LiteLLM owns an internal model group and Hasna Gateway owns external policy, budgets, and metadata.

```bash
LITELLM_PROXY_BASE_URL=http://127.0.0.1:4000/v1
LITELLM_API_KEY=
```

```json
{
  "presets": ["litellm-proxy"],
  "routes": [
    {
      "id": "litellm-coding",
      "mode": "fallback",
      "modelAliases": ["litellm-coding"],
      "fallbackModelIds": ["litellm-proxy/coding"],
      "dataPolicy": {
        "allowTraining": false,
        "allowLogging": false,
        "allowedRegions": ["private"]
      }
    }
  ]
}
```

Keep LiteLLM routing details in LiteLLM config. Hasna Gateway treats the proxy as one upstream candidate.
