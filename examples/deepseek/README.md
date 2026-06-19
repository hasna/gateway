# DeepSeek

DeepSeek is disabled by policy unless Chinese providers or `cn` regions are explicitly allowed.

```bash
export GATEWAY_API_KEY=local-dev-key
export DEEPSEEK_API_KEY=...
bun run src/cli/index.ts serve --config gateway.config.china.example.json
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"china-coding","messages":[{"role":"user","content":"Write a TypeScript debounce helper."}]}'
```
