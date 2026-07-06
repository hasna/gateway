import { AnthropicMessagesAdapter } from "./anthropic";
import { OpenAICompatibleAdapter } from "./openai-compatible";
import type { GatewayProviderConfig, ProviderAdapter } from "../types";

const anthropicAdapter = new AnthropicMessagesAdapter();
const openAICompatibleAdapter = new OpenAICompatibleAdapter();

export function adapterForProvider(provider: GatewayProviderConfig): ProviderAdapter {
  if (provider.kind === "anthropic") {
    return anthropicAdapter;
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
export { OpenAICompatibleAdapter, toProviderChatBody } from "./openai-compatible";
