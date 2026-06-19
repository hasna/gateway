# No-China Policy

This example blocks `cn` regions and includes only OpenAI/OpenRouter presets.

```bash
export GATEWAY_API_KEY=local-dev-key
export OPENAI_API_KEY=...
bun run src/cli/index.ts serve --config gateway.config.no-china.example.json
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"coding:no-china","messages":[{"role":"user","content":"Stay on non-China providers."}]}'
```
