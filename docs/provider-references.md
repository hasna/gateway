# 2026 Provider References

These notes capture provider docs checked during project setup, rechecked during implementation on 2026-06-16, and rechecked for multi-gateway routing on 2026-06-22. Model names change quickly, so release smoke tests should still prefer provider `/models` APIs when credentials are available.

## DeepSeek

- Docs: https://api-docs.deepseek.com/
- OpenAI-compatible base URL: `https://api.deepseek.com`
- Anthropic-compatible base URL: `https://api.deepseek.com/anthropic`
- Current docs list `deepseek-v4-flash` and `deepseek-v4-pro`.
- Current docs say `deepseek-chat` and `deepseek-reasoner` are compatibility names scheduled for deprecation on 2026-07-24 at 15:59 UTC.

## Alibaba Cloud DashScope / Qwen

- Docs: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
- OpenAI-compatible base URLs:
  - Singapore: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
  - US Virginia: `https://dashscope-us.aliyuncs.com/compatible-mode/v1`
  - China Beijing: `https://dashscope.aliyuncs.com/compatible-mode/v1`
  - Hong Kong China: `https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1`
- Useful current model families include `qwen-plus`, `qwen3.5-plus`, `qwen-flash`, `qwen3-coder-plus`, and `qwen3-coder-flash`.

## Kimi / Moonshot

- Docs: https://platform.kimi.ai/docs/guide/start-using-kimi-api
- OpenAI-compatible base URL: `https://api.moonshot.ai/v1`
- Current model list includes `kimi-k2.7-code` and `kimi-k2.7-code-highspeed` as the newest code-focused models.
- `kimi-k2.6` remains available as a 256K context model, but first release defaults should prefer K2.7 Code for coding routes.

## Z.AI / GLM

- Docs: https://docs.z.ai/guides/llm/glm-5.1
- OpenAI SDK base URL: `https://api.z.ai/api/paas/v4/`
- Current docs describe `glm-5.1` as the latest flagship model and `glm-5` as a new-generation foundation model.
- Coding Plan integrations use the dedicated endpoint `https://api.z.ai/api/coding/paas/v4`; general OpenAI-compatible API usage should default to `https://api.z.ai/api/paas/v4/`.

## SiliconFlow

- Docs: https://docs.siliconflow.cn/en/api-reference/chat-completions/chat-completions
- Chat completions URL: `https://api.siliconflow.cn/v1/chat/completions`
- Auth: `Authorization: Bearer <api-key>`
- Example model: `Pro/zai-org/GLM-4.7`
- Usage includes normal OpenAI token fields plus reasoning and cache details on some models.

## OpenRouter

- Docs: https://openrouter.ai/docs/guides/routing/provider-selection
- Auto Router docs: https://openrouter.ai/docs/guides/routing/routers/auto-router
- OpenAI-compatible base URL: `https://openrouter.ai/api/v1`
- Provider routing uses a `provider` object with fields such as `order`, `only`, `ignore`, `sort`, `max_price`, `allow_fallbacks`, `zdr`, and `data_collection`.
- Auto Router uses model `openrouter/auto`; per-request Auto Router settings use an `auto-router` plugin with `allowed_models` and `cost_quality_tradeoff`.
- Hasna Gateway maps only these documented fields and strips other gateway-only fields for direct providers.

## Vercel AI Gateway

- Docs: https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
- OpenAI-compatible base URL: `https://ai-gateway.vercel.sh/v1`
- Provider options use `providerOptions.gateway` with `order`, `only`, `caching`, and `providerTimeouts`.
- BYOK credentials are managed in Vercel AI Gateway settings; requests should not include provider secrets through Hasna Gateway.

## LiteLLM Proxy

- Docs: https://docs.litellm.ai/docs/routing
- Proxy load balancing docs: https://docs.litellm.ai/docs/proxy/load_balancing
- OpenAI-compatible proxy base URL is deployment-specific, commonly `http://127.0.0.1:4000/v1`.
- LiteLLM owns its internal routing strategies such as weighted pick, latency-based, cost-based, and order fallback. Hasna Gateway treats the LiteLLM proxy as one upstream candidate unless route config adds additional candidates.

## Portkey AI Gateway

- Config docs: https://portkey.ai/docs/product/ai-gateway/configs
- Load balancing docs: https://portkey.ai/docs/product/ai-gateway/load-balancing
- OpenAI-compatible gateway URL: `https://api.portkey.ai/v1`
- Gateway config selection can be passed with `x-portkey-config`; generic header auth supports `x-portkey-api-key` and optional provider/virtual-key headers.

## Cloudflare AI Gateway

- REST API docs: https://developers.cloudflare.com/ai-gateway/usage/rest-api/
- OpenAI-compatible REST base URL: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1`
- Deprecated compat base URL: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat`
- Auth uses a Cloudflare API token in `Authorization`.

## Helicone AI Gateway

- Docs: https://docs.helicone.ai/gateway/overview
- Integration docs: https://docs.helicone.ai/gateway/integrations/overview
- OpenAI-compatible base URL: `https://ai-gateway.helicone.ai/v1`
- The preset uses `Helicone-Auth: Bearer <HELICONE_API_KEY>`.

## Kong AI Gateway

- Docs: https://developer.konghq.com/ai-gateway/
- Load balancing docs: https://developer.konghq.com/ai-gateway/load-balancing/
- Base URL and auth depend on the deployed Kong route and plugins.
- Kong can perform its own load balancing, retries, fallback, and semantic routing. Hasna Gateway records Kong as one upstream attempt unless configured with additional local fallback candidates.

## RouteLLM

- Repo: https://github.com/lm-sys/routellm
- RouteLLM is useful for prompt-aware routing and evaluations, but it is not embedded in this implementation. The current smart routing is deterministic and config-driven inside Hasna Gateway. The `open-router` companion repo is the future extraction point for prompt-aware/eval routing when reusable package code exists.
