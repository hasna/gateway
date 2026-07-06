import { OpenAICompatibleAdapter } from "./openai-compatible";
import type {
  GatewayModelCapability,
  GatewayProviderConfig,
  GatewayProviderError,
  ProviderAdapter,
  ProviderBuildInput,
  ProviderHttpRequest,
} from "../types";

export const googleGeminiOpenAIBaseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";

function withGeminiDefaults(provider: GatewayProviderConfig): GatewayProviderConfig {
  return {
    ...provider,
    baseUrl: provider.baseUrl ?? googleGeminiOpenAIBaseUrl,
  };
}

export class GoogleGeminiAdapter implements ProviderAdapter {
  readonly id = "google-gemini";
  readonly kind = "google";
  readonly supports: GatewayModelCapability[] = ["chat", "streaming", "tools", "json"];

  private readonly openAICompatibleAdapter = new OpenAICompatibleAdapter();

  buildRequest(input: ProviderBuildInput): ProviderHttpRequest {
    return this.openAICompatibleAdapter.buildRequest({
      ...input,
      provider: withGeminiDefaults(input.provider),
    });
  }

  send(input: ProviderBuildInput): Promise<Response> {
    return this.openAICompatibleAdapter.send({
      ...input,
      provider: withGeminiDefaults(input.provider),
    });
  }

  stream(input: ProviderBuildInput): Promise<Response> {
    return this.openAICompatibleAdapter.stream({
      ...input,
      provider: withGeminiDefaults(input.provider),
    });
  }

  mapError(response: Response, bodyText?: string): GatewayProviderError {
    return this.openAICompatibleAdapter.mapError(response, bodyText);
  }
}
