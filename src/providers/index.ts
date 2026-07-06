import { GoogleGeminiAdapter } from "./google-gemini";
import { OpenAICompatibleAdapter } from "./openai-compatible";
import type { GatewayProviderConfig, ProviderAdapter } from "../types";

const googleGeminiAdapter = new GoogleGeminiAdapter();
const openAICompatibleAdapter = new OpenAICompatibleAdapter();

export function adapterForProvider(provider: GatewayProviderConfig): ProviderAdapter {
  if (provider.kind === "google") {
    return googleGeminiAdapter;
  }

  if (provider.kind === "openai-compatible" || provider.kind === "openai" || provider.kind === "openrouter") {
    return openAICompatibleAdapter;
  }

  return openAICompatibleAdapter;
}

export { GoogleGeminiAdapter, googleGeminiOpenAIBaseUrl } from "./google-gemini";
export { OpenAICompatibleAdapter, toProviderChatBody } from "./openai-compatible";
