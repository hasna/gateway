# Publishing And Release

## Release Targets

- npm package: `@hasna/gateway`
- CLI binary: `gateway`
- GitHub repository: `hasna/open-gateway`
- License: Apache-2.0

## Public Release Gate

Before publishing:

```bash
bun install
bun run typecheck
bun test
bun run build
bun dist/cli/index.js smoke --config gateway.config.example.json --all
```

The release should also run a no-cloud boundary check once implemented:

- No private Hasna URLs in public defaults.
- No bundled API keys.
- No hosted calls during tests.
- No requirement for Hasna accounts in self-hosted mode.

## Required Examples

Add these examples before first release:

- `examples/basic-openai-compatible`
- `examples/deepseek`
- `examples/qwen-dashscope`
- `examples/kimi`
- `examples/openrouter`
- `examples/fallback-routing`
- `examples/no-china-policy`
- `examples/china-allowed-policy`

## Required Config Files

Add:

- `.env.example`
- `gateway.config.example.json`
- `gateway.config.china.example.json`
- `gateway.config.no-china.example.json`

## Versioning

Use semver:

- Patch: bug fixes and docs.
- Minor: new providers, routes, config fields with backward compatibility.
- Major: breaking API, config, or adapter contract changes.

## First Public Version

The first useful version should not be a placeholder. It should include:

- Running CLI server.
- OpenAI-compatible chat endpoint.
- Streaming.
- At least three providers.
- Routing aliases.
- Fallbacks.
- Tests.
- Clear docs.

Do not publish a package that only contains types and docs.
