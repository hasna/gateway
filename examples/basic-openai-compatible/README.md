# Basic OpenAI-Compatible Provider

Use `gateway.config.example.json` and set at least one provider key plus the local gateway key.

```bash
export GATEWAY_API_KEY=local-dev-key
export OPENAI_API_KEY=sk-...
bun run src/cli/index.ts serve --config gateway.config.example.json
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"Say hello."}]}'
```
