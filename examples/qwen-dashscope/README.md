# Qwen / DashScope

The Qwen preset uses DashScope OpenAI-compatible mode and `DASHSCOPE_API_KEY`.

```bash
export GATEWAY_API_KEY=local-dev-key
export DASHSCOPE_API_KEY=...
bun run src/cli/index.ts serve --config gateway.config.china.example.json
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"china-fast","messages":[{"role":"user","content":"Summarize gateway routing in one sentence."}]}'
```
