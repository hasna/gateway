#!/usr/bin/env bun
import { loadGatewayConfig, validateRuntimeSecrets } from "./config";
import { startGatewayServer } from "./server";
import { gatewayVersion } from "./version";

const args = process.argv.slice(2);

function flagString(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(gatewayVersion);
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`Hasna Gateway ${gatewayVersion}

Usage:
  gateway-serve --config gateway.config.json [--host 127.0.0.1] [--port 8787]
`);
} else {
  const configPath = flagString("config", "gateway.config.json");
  const config = await loadGatewayConfig(configPath);
  config.server.host = flagString("host", config.server.host);
  config.server.port = Number(flagString("port", String(config.server.port)));

  const runtimeErrors = validateRuntimeSecrets(config, process.env);
  if (runtimeErrors.length > 0) {
    for (const error of runtimeErrors) console.error(error);
    process.exit(1);
  }

  const server = startGatewayServer({ config });
  console.log(`Hasna Gateway ${gatewayVersion} listening on http://${server.hostname}:${server.port}`);
}
