import { OpenAICompatibleAdapter } from "./openai-compatible";
import type { GatewayProviderConfig, ProviderAdapter } from "../types";

const openAICompatibleAdapter = new OpenAICompatibleAdapter();

export function adapterForProvider(provider: GatewayProviderConfig): ProviderAdapter {
  if (provider.kind === "openai-compatible" || provider.kind === "openai" || provider.kind === "openrouter") {
    return openAICompatibleAdapter;
  }

  return openAICompatibleAdapter;
}

export { OpenAICompatibleAdapter, toProviderChatBody } from "./openai-compatible";
