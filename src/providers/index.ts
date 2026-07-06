import { AnthropicMessagesAdapter } from "./anthropic";
import { GoogleGeminiAdapter } from "./google-gemini";
import { OpenAICompatibleAdapter } from "./openai-compatible";
import type { GatewayProviderConfig, ProviderAdapter } from "../types";

const anthropicAdapter = new AnthropicMessagesAdapter();
const googleGeminiAdapter = new GoogleGeminiAdapter();
const openAICompatibleAdapter = new OpenAICompatibleAdapter();

export function adapterForProvider(provider: GatewayProviderConfig): ProviderAdapter {
  if (provider.kind === "anthropic") {
    return anthropicAdapter;
  }

  if (provider.kind === "google") {
    return googleGeminiAdapter;
  }

  if (provider.kind === "openai-compatible" || provider.kind === "openai" || provider.kind === "openrouter") {
    return openAICompatibleAdapter;
  }

  return openAICompatibleAdapter;
}

export {
  AnthropicMessagesAdapter,
  anthropicErrorMessage,
  toAnthropicMessagesBody,
  toOpenAIChatCompletionResponse,
} from "./anthropic";
export { GoogleGeminiAdapter, googleGeminiOpenAIBaseUrl } from "./google-gemini";
export { OpenAICompatibleAdapter, toProviderChatBody } from "./openai-compatible";
