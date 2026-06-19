# API Contract

## Compatibility Principle

The public API should be OpenAI-compatible where possible. Existing OpenAI SDK clients should be able to point `baseURL` at the gateway and keep using `chat.completions.create`.

Compatibility does not mean hiding provider differences. If a provider cannot support a feature, the gateway should return a clear capability error or route to an allowed provider that can support it.

## Authentication

Self-hosted mode:

```http
Authorization: Bearer <local-gateway-key>
```

Hosted Hasna mode:

```http
Authorization: Bearer <hasna-api-key>
```

Provider keys are never sent by the client unless explicit BYOK request support is added. Initial BYOK should be configured through server-side environment variables.

## `GET /health`

Returns service status.

```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

## `GET /v1/models`

Returns configured gateway models and aliases, including provider and capability metadata that is safe to expose.

```json
{
  "object": "list",
  "data": [
    {
      "id": "coding",
      "object": "model",
      "owned_by": "hasna-gateway",
      "providers": ["deepseek", "qwen", "openai"],
      "capabilities": ["chat", "streaming", "tools"]
    }
  ]
}
```

## `POST /v1/chat/completions`

The initial critical endpoint. It should support:

- `model`
- `messages`
- `stream`
- `tools`
- `tool_choice`
- `response_format`
- `temperature`
- `top_p`
- `max_tokens`
- `stop`
- `seed` when provider supports it

Example:

```json
{
  "model": "coding",
  "messages": [
    {
      "role": "user",
      "content": "Implement a retry helper in TypeScript."
    }
  ],
  "stream": true,
  "gateway": {
    "routing": "fallback",
    "allowed_providers": ["deepseek", "qwen", "openai"],
    "blocked_regions": ["cn"],
    "max_output_usd_per_million_tokens": 10
  }
}
```

The optional `gateway` field is a gateway-specific extension. It should be ignored before forwarding to providers.

## Response Shape

Non-streaming responses should match OpenAI chat completion shape:

```json
{
  "id": "chatcmpl_gateway_...",
  "object": "chat.completion",
  "created": 1781590000,
  "model": "deepseek/deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  },
  "gateway": {
    "provider": "deepseek",
    "provider_model": "deepseek-chat",
    "route_mode": "fallback",
    "attempts": 1,
    "estimated_cost_usd": 0.00012
  }
}
```

The `gateway` response field is non-standard and should be configurable. Some clients may require strict OpenAI compatibility with no extra top-level fields.

## Error Shape

Errors should use OpenAI-compatible error envelopes:

```json
{
  "error": {
    "message": "No allowed provider can satisfy model alias 'coding' with blocked_regions=['cn'].",
    "type": "gateway_policy_error",
    "code": "no_route"
  }
}
```

Recommended error types:

- `gateway_auth_error`
- `gateway_config_error`
- `gateway_policy_error`
- `gateway_routing_error`
- `provider_auth_error`
- `provider_rate_limit`
- `provider_unavailable`
- `provider_bad_request`
- `provider_stream_error`

## Streaming

Streaming should use Server-Sent Events compatible with OpenAI clients:

```text
data: {"id":"...","object":"chat.completion.chunk","choices":[...]}

data: [DONE]
```

When providers expose final usage only at stream end, the gateway should emit usage in the final chunk when OpenAI-compatible clients can accept it, and always record it internally.
