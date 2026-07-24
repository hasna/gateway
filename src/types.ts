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
  | "balanced"
  | "smart";

export type GatewayRuntimeMode = "local" | "production-cloud";

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
  baseUrlEnv?: string;
  apiKeyEnv?: string;
  auth?: GatewayProviderAuthConfig;
  headers?: Record<string, GatewayProviderHeaderValue>;
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
  qualityScore?: number;
  averageLatencyMs?: number;
  successRate?: number;
  throughputTokensPerSecond?: number;
};

export type GatewayProviderAuthConfig = {
  type?: "bearer" | "header" | "none";
  apiKeyEnv?: string;
  headerName?: string;
  prefix?: string;
};

export type GatewayProviderHeaderValue =
  | string
  | {
      value?: string;
      env?: string;
      prefix?: string;
      required?: boolean;
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

export type GatewayKeyRateLimitConfig = {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
};

export type GatewayRateLimitConfig = {
  perGatewayKey?: GatewayKeyRateLimitConfig;
};

export type GatewayServerConfig = {
  host: string;
  port: number;
  requestTimeoutMs: number;
  maxRequestBodyBytes: number;
  includeGatewayMetadata: boolean;
  maxFallbackAttempts: number;
  corsAllowedOrigins: string[];
  rateLimits?: GatewayRateLimitConfig;
  responseCache: GatewayResponseCacheConfig;
};

export type GatewayAuthConfig = {
  apiKeyEnv: string;
  required: boolean;
};

export type GatewayResponseCacheConfig = {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  bypassHeader: string;
};

export type GatewayGlobalPolicy = GatewayDataPolicy & {
  allowChineseProviders?: boolean;
  allowRequestPolicyExpansion?: boolean;
};

export type GatewayCloudStorageConfig =
  | {
      backend: "sqlite";
      sqlitePath: string;
    }
  | {
      backend: "postgres";
      connectionString?: string;
      connectionStringEnv?: string;
    };

export type GatewayStorageConfig = {
  usageLedgerPath?: string;
  cloud?: GatewayCloudStorageConfig;
};

export type GatewayServiceDiscoveryConfig = {
  allowLocalProviderEndpoints: boolean;
  allowedProviderBaseUrls?: string[];
};

export type GatewayHealthConfig = {
  requireRuntimeSecrets: boolean;
};

export type GatewayRuntimeConfig = {
  mode: GatewayRuntimeMode;
  serviceDiscovery: GatewayServiceDiscoveryConfig;
  health: GatewayHealthConfig;
};

export type GatewayRuntimeConfigInput = Partial<Omit<GatewayRuntimeConfig, "serviceDiscovery" | "health">> & {
  serviceDiscovery?: Partial<GatewayServiceDiscoveryConfig>;
  health?: Partial<GatewayHealthConfig>;
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
  runtime: GatewayRuntimeConfig;
  server: GatewayServerConfig;
  auth: GatewayAuthConfig;
  storage: GatewayStorageConfig;
  policy: GatewayGlobalPolicy;
  providers: GatewayProviderConfig[];
  models: GatewayModelConfig[];
  routes: GatewayRoutePolicy[];
  budgets: GatewayBudgetConfig[];
};

export type GatewayServerConfigInput = Partial<Omit<GatewayServerConfig, "responseCache">> & {
  responseCache?: Partial<GatewayResponseCacheConfig>;
};

export type GatewayConfigInput = Omit<Partial<GatewayConfig>, "runtime" | "server"> & {
  runtime?: GatewayRuntimeConfigInput;
  server?: GatewayServerConfigInput;
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
  task?: string;
  priority?: "cost" | "quality" | "latency" | "balanced";
  cost_quality_tradeoff?: number;
  sticky_session_id?: string;
  session_id?: string;
  min_quality?: number;
  min_context_tokens?: number;
  expected_input_tokens?: number;
  required_capabilities?: GatewayModelCapability[];
  provider_order?: string[];
  provider_only?: string[];
  provider_ignore?: string[];
  provider_sort?: string | Record<string, unknown>;
  allow_fallbacks?: boolean;
  zdr?: boolean;
  data_collection?: "allow" | "deny";
  max_price?: Record<string, number>;
  caching?: "auto";
  provider_timeouts?: Record<string, unknown>;
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

export type GatewayRoutableRequest = {
  model: string;
  user?: string;
  gateway?: GatewayRequestOptions;
  [key: string]: unknown;
};

export type OpenAIChatCompletionRequest = GatewayRoutableRequest & {
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
  provider_options?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
  provider?: unknown;
  plugins?: unknown;
  session_id?: string;
  [key: string]: unknown;
};

export type OpenAIEmbeddingsInput = string | string[] | number[] | number[][];

export type OpenAIEmbeddingsRequest = GatewayRoutableRequest & {
  input: OpenAIEmbeddingsInput;
  encoding_format?: "float" | "base64" | string;
  dimensions?: number;
  provider_options?: Record<string, unknown>;
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

export type OpenAIEmbeddingsUsage = {
  prompt_tokens: number;
  total_tokens: number;
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

export type GatewayRouteScore = {
  provider: string;
  model: string;
  providerModel: string;
  score: number;
  reason: string;
  components: Record<string, number>;
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
  scores?: GatewayRouteScore[];
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
  buildEmbeddingsRequest?(input: ProviderEmbeddingsBuildInput): ProviderHttpRequest;
  send(input: ProviderBuildInput): Promise<Response>;
  stream(input: ProviderBuildInput): Promise<Response>;
  embed?(input: ProviderEmbeddingsBuildInput): Promise<Response>;
  mapError(response: Response, bodyText?: string): GatewayProviderError;
};

export type ProviderBuildBaseInput = {
  provider: GatewayProviderConfig;
  model: GatewayModelConfig;
  apiKey: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: GatewayFetch;
  signal?: AbortSignal;
};

export type ProviderBuildInput = ProviderBuildBaseInput & {
  request: OpenAIChatCompletionRequest;
};

export type ProviderEmbeddingsBuildInput = ProviderBuildBaseInput & {
  request: OpenAIEmbeddingsRequest;
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
  rateLimit?: {
    onUsage?: (usage: GatewayUsage) => Promise<void> | void;
    requiresStreamingUsage?: boolean;
  };
  requestContext?: {
    responseCacheBypass?: boolean;
  };
};
