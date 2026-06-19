# Kimi / Moonshot

Kimi uses the OpenAI-compatible Moonshot endpoint and `MOONSHOT_API_KEY`. The default coding route prefers `kimi-k2.7-code` when the key is valid.

```bash
export GATEWAY_API_KEY=local-dev-key
export MOONSHOT_API_KEY=...
bun run src/cli/index.ts serve --config gateway.config.china.example.json
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"kimi/kimi-k2.7-code","messages":[{"role":"user","content":"Return a compact JSON checklist."}],"gateway":{"allow_chinese_providers":true,"allowed_regions":["cn"]}}'
```
