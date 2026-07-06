import type { GatewayKeyRateLimitConfig, GatewayUsage } from "./types";

const DEFAULT_WINDOW_MS = 60_000;
const ANONYMOUS_GATEWAY_KEY = "anonymous";

type RateLimitBucket = {
  windowStartMs: number;
  requests: number;
  tokens: number;
};

export type GatewayRateLimitKind = "requests" | "tokens";

export type GatewayRateLimitExceeded = {
  kind: GatewayRateLimitKind;
  limit: number;
  used: number;
  retryAfterSeconds: number;
};

export type GatewayRateLimitCheck =
  | { allowed: true }
  | { allowed: false; exceeded: GatewayRateLimitExceeded };

export type GatewayKeyRateLimiterOptions = {
  now?: () => number;
  windowMs?: number;
};

export function gatewayRateLimitKey(gatewayKeyFingerprint: string | undefined): string {
  return gatewayKeyFingerprint ?? ANONYMOUS_GATEWAY_KEY;
}

export class GatewayKeyRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(options: GatewayKeyRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  checkAndConsumeRequest(key: string, config: GatewayKeyRateLimitConfig | undefined): GatewayRateLimitCheck {
    if (!rateLimitConfigured(config)) return { allowed: true };

    const now = this.now();
    const bucket = this.bucketFor(key, now);
    if (config?.tokensPerMinute !== undefined && bucket.tokens >= config.tokensPerMinute) {
      return {
        allowed: false,
        exceeded: this.exceeded("tokens", config.tokensPerMinute, bucket.tokens, bucket, now),
      };
    }

    if (config?.requestsPerMinute !== undefined && bucket.requests >= config.requestsPerMinute) {
      return {
        allowed: false,
        exceeded: this.exceeded("requests", config.requestsPerMinute, bucket.requests, bucket, now),
      };
    }

    bucket.requests += 1;
    return { allowed: true };
  }

  recordUsage(key: string, config: GatewayKeyRateLimitConfig | undefined, usage: GatewayUsage): void {
    if (config?.tokensPerMinute === undefined) return;
    const totalTokens = Math.max(0, Math.trunc(usage.totalTokens));
    if (totalTokens === 0) return;
    const bucket = this.bucketFor(key, this.now());
    bucket.tokens += totalTokens;
  }

  private bucketFor(key: string, now: number): RateLimitBucket {
    this.pruneExpired(now);

    const existing = this.buckets.get(key);
    if (existing && now >= existing.windowStartMs && now < existing.windowStartMs + this.windowMs) {
      return existing;
    }

    const bucket: RateLimitBucket = {
      windowStartMs: now,
      requests: 0,
      tokens: 0,
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private exceeded(
    kind: GatewayRateLimitKind,
    limit: number,
    used: number,
    bucket: RateLimitBucket,
    now: number,
  ): GatewayRateLimitExceeded {
    return {
      kind,
      limit,
      used,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartMs + this.windowMs - now) / 1000)),
    };
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.windowStartMs + this.windowMs * 2) {
        this.buckets.delete(key);
      }
    }
  }
}

function rateLimitConfigured(config: GatewayKeyRateLimitConfig | undefined): boolean {
  return config?.requestsPerMinute !== undefined || config?.tokensPerMinute !== undefined;
}
