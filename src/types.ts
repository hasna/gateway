export type GatewayProviderKind =
  | "openai-compatible"
  | "openai"
  | "anthropic"
  | "google"
  | "bedrock"
  | "vertex"
  | "openrouter";

export type GatewayModelCapability =
  | "chat"
  | "streaming"
  | "tools"
  | "json"
  | "vision"
  | "reasoning"
  | "embeddings";

export type GatewayRoutingMode =
  | "explicit"
  | "fallback"
  | "cheapest"
  | "lowest-latency"
  | "highest-throughput"
  | "balanced";

export type GatewayDataPolicy = {
  allowTraining?: boolean;
  allowLogging?: boolean;
  allowedRegions?: string[];
  blockedRegions?: string[];
  allowedProviders?: string[];
  blockedProviders?: string[];
  zeroDataRetentionRequired?: boolean;
  allowChineseProviders?: boolean;
  byokOnly?: boolean;
};

export type GatewayProviderConfig = {
  id: string;
  displayName: string;
  kind: GatewayProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  enabled?: boolean;
  regions?: string[];
  jurisdiction?: string;
  dataPolicy?: GatewayDataPolicy & {
    zeroDataRetentionAvailable?: boolean;
    byokOnly?: boolean;
  };
};

export type GatewayModelConfig = {
  id: string;
  providerId: string;
  providerModel: string;
  aliases?: string[];
  capabilities: GatewayModelCapability[];
  contextWindow?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
};

export type GatewayRoutePolicy = {
  id: string;
  mode: GatewayRoutingMode;
  modelAliases?: string[];
  providerAllowlist?: string[];
  providerBlocklist?: string[];
  maxInputUsdPerMillionTokens?: number;
  maxOutputUsdPerMillionTokens?: number;
  maxLatencyMs?: number;
  fallbackModelIds?: string[];
  dataPolicy?: GatewayDataPolicy;
};

export type GatewayServerConfig = {
  host: string;
  port: number;
  requestTimeoutMs: number;
  maxRequestBodyBytes: number;
  includeGatewayMetadata: boolean;
  maxFallbackAttempts: number;
};

export type GatewayAuthConfig = {
  apiKeyEnv: string;
  required: boolean;
};

export type GatewayGlobalPolicy = GatewayDataPolicy & {
  allowChineseProviders?: boolean;
  allowRequestPolicyExpansion?: boolean;
};

export type GatewayStorageConfig = {
  usageLedgerPath?: string;
};

export type GatewayBudgetWindow = "per-request" | "daily" | "monthly" | "lifetime";

export type GatewayBudgetMode = "hard" | "soft";

export type GatewayBudgetScope = {
  gatewayKey?: string;
  tenant?: string;
  modelAlias?: string;
};

export type GatewayBudgetConfig = {
  id: string;
  scope?: GatewayBudgetScope;
  window: GatewayBudgetWindow;
  mode: GatewayBudgetMode;
  maxUsd?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  warningThreshold?: number;
  resetAt?: string;
};

export type GatewayConfig = {
  server: GatewayServerConfig;
  auth: GatewayAuthConfig;
  storage: GatewayStorageConfig;
  policy: GatewayGlobalPolicy;
  providers: GatewayProviderConfig[];
  models: GatewayModelConfig[];
  routes: GatewayRoutePolicy[];
  budgets: GatewayBudgetConfig[];
};

export type GatewayConfigInput = Partial<GatewayConfig> & {
  presets?: string[];
};

export type GatewayConfigValidationResult =
  | { ok: true; config: GatewayConfig; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export type ChatRole = "system" | "user" | "assistant" | "tool" | "developer";

export type ChatMessage = {
  role: ChatRole;
  content?: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export type GatewayRequestOptions = {
  routing?: GatewayRoutingMode;
  allowed_providers?: string[];
  blocked_providers?: string[];
  allowed_regions?: string[];
  blocked_regions?: string[];
  allow_chinese_providers?: boolean;
  allow_training?: boolean;
  allow_logging?: boolean;
  zero_data_retention_required?: boolean;
  byok_only?: boolean;
  tenant?: string;
  max_input_usd_per_million_tokens?: number;
  max_output_usd_per_million_tokens?: number;
  include_gateway_metadata?: boolean;
  strict_openai_compatibility?: boolean;
};

export type OpenAIChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  stream_options?: unknown;
  parallel_tool_calls?: boolean;
  logprobs?: boolean;
  top_logprobs?: number;
  metadata?: unknown;
  store?: boolean;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  modalities?: unknown;
  audio?: unknown;
  prediction?: unknown;
  service_tier?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  seed?: number;
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  gateway?: GatewayRequestOptions;
  provider_options?: Record<string, unknown>;
  [key: string]: unknown;
};

export type GatewayUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
};

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: unknown;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type GatewayRouteAttempt = {
  provider: string;
  model: string;
  providerModel: string;
  status: "selected" | "failed" | "skipped";
  reason?: string;
  errorType?: string;
  errorCode?: string;
  retryable?: boolean;
  latencyMs?: number;
};

export type GatewayRouteDecision = {
  requested_model: string;
  resolved_candidates: string[];
  selected?: string;
  mode: GatewayRoutingMode;
  policy: {
    allowed_providers?: string[];
    blocked_providers?: string[];
    allowed_regions?: string[];
    blocked_regions?: string[];
    allow_training?: boolean;
    allow_logging?: boolean;
    allow_chinese_providers?: boolean;
    zero_data_retention_required?: boolean;
    byok_only?: boolean;
  };
  reason: string;
  attempts: GatewayRouteAttempt[];
};

export type GatewayRouteCandidate = {
  model: GatewayModelConfig;
  provider: GatewayProviderConfig;
};

export type ProviderHttpRequest = {
  url: string;
  init: RequestInit;
};

export type GatewayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ProviderAdapter = {
  id: string;
  kind: GatewayProviderKind;
  supports: GatewayModelCapability[];
  buildRequest(input: ProviderBuildInput): ProviderHttpRequest;
  send(input: ProviderBuildInput): Promise<Response>;
  stream(input: ProviderBuildInput): Promise<Response>;
  mapError(response: Response, bodyText?: string): GatewayProviderError;
};

export type ProviderBuildInput = {
  provider: GatewayProviderConfig;
  model: GatewayModelConfig;
  request: OpenAIChatCompletionRequest;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: GatewayFetch;
  signal?: AbortSignal;
};

export type GatewayProviderError = {
  message: string;
  status: number;
  type: string;
  code: string;
  retryable: boolean;
  provider?: string;
  raw?: unknown;
};

export type GatewayRuntimeOptions = {
  config: GatewayConfig;
  env?: Record<string, string | undefined>;
  fetchImpl?: GatewayFetch;
  budgetContext?: {
    gatewayKey?: string;
    tenant?: string;
  };
};
