import type { GatewayProviderConfig, GatewayProviderHeaderValue } from "./types";

export function providerCredentialEnv(provider: GatewayProviderConfig): string | undefined {
  if (provider.auth?.type === "none") return undefined;
  return provider.auth?.apiKeyEnv ?? provider.apiKeyEnv;
}

export function providerRequiresCredential(provider: GatewayProviderConfig): boolean {
  return provider.auth?.type !== "none";
}

export function providerBaseUrl(
  provider: GatewayProviderConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (provider.baseUrl) return provider.baseUrl;
  return provider.baseUrlEnv ? env[provider.baseUrlEnv] : undefined;
}

function resolveHeaderValue(
  name: string,
  value: GatewayProviderHeaderValue,
  env: Record<string, string | undefined>,
): string | undefined {
  if (typeof value === "string") return value;

  const rawValue = value.value ?? (value.env ? env[value.env] : undefined);
  if (rawValue === undefined || rawValue.length === 0) {
    if (value.required) {
      throw new Error(`Provider header ${name} requires environment variable ${value.env ?? "(none)"}.`);
    }
    return undefined;
  }

  return `${value.prefix ?? ""}${rawValue}`;
}

export function buildProviderHeaders(input: {
  provider: GatewayProviderConfig;
  apiKey: string;
  env?: Record<string, string | undefined>;
}): Record<string, string> {
  const env = input.env ?? process.env;
  const headers: Record<string, string> = {};
  const auth = input.provider.auth ?? {};

  if (auth.type !== "none") {
    const authType = auth.type ?? "bearer";
    const headerName = auth.headerName ?? "authorization";
    const defaultPrefix = authType === "bearer" ? "Bearer " : "";
    headers[headerName] = `${auth.prefix ?? defaultPrefix}${input.apiKey}`;
  }

  for (const [name, value] of Object.entries(input.provider.headers ?? {})) {
    const resolved = resolveHeaderValue(name, value, env);
    if (resolved !== undefined) headers[name] = resolved;
  }

  return headers;
}

export function missingRequiredProviderHeaderEnvs(
  provider: GatewayProviderConfig,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const missing: string[] = [];

  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    if (typeof value === "string" || !value.required) continue;
    const rawValue = value.value ?? (value.env ? env[value.env] : undefined);
    if (rawValue === undefined || rawValue.length === 0) {
      missing.push(value.env ?? name);
    }
  }

  return missing;
}
