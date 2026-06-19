# Fallback Routing

The `coding` route in `gateway.config.example.json` tries configured models in order and retries only retryable provider failures.

```bash
export GATEWAY_API_KEY=local-dev-key
export OPENAI_API_KEY=...
export DEEPSEEK_API_KEY=...
bun run src/cli/index.ts serve --config gateway.config.example.json
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"coding","messages":[{"role":"user","content":"Create a retry helper."}],"gateway":{"routing":"fallback"}}'
```
