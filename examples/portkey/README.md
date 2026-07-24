# Portkey AI Gateway

Use the `portkey` preset when you want Hasna Gateway to call a Portkey gateway config as an OpenAI-compatible upstream.

```json
{
  "presets": ["portkey"],
  "routes": [
    {
      "id": "portkey-coding",
      "mode": "fallback",
      "modelAliases": ["portkey-coding"],
      "fallbackModelIds": ["portkey/openai/gpt-4.1-mini"],
      "dataPolicy": {
        "allowTraining": false,
        "allowLogging": true,
        "allowedRegions": ["global"]
      }
    }
  ]
}
```

Set these environment variables as needed:

```bash
PORTKEY_API_KEY=
PORTKEY_CONFIG_ID=
PORTKEY_PROVIDER=
PORTKEY_VIRTUAL_KEY=
```

The preset uses generic header auth: `x-portkey-api-key`, plus optional config/provider headers.
