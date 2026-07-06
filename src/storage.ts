import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { GatewayHttpError } from "./errors";
import type { GatewayUsageLedgerRecord } from "./ledger";
import type { GatewayCloudStorageConfig, GatewayConfig } from "./types";

type StorageEnv = Record<string, string | undefined>;

type GatewayCloudDb = {
  run(sql: string, ...params: any[]): unknown | Promise<unknown>;
  all(sql: string, ...params: any[]): any[] | Promise<any[]>;
  exec(sql: string): void | Promise<void>;
  close(): void | Promise<void>;
};

type LedgerRow = {
  record_json?: string;
  recordJson?: string;
};

const zeroRetryDelayMs = 25;
const cloudOperationTimeoutMs = 5000;

export function hasUsageLedgerBackend(config: GatewayConfig): boolean {
  return Boolean(config.storage.usageLedgerPath || config.storage.cloud);
}

export function usageLedgerBackendMode(config: GatewayConfig): "none" | "jsonl" | "cloud" | "jsonl+cloud" {
  const hasJsonl = Boolean(config.storage.usageLedgerPath);
  const hasCloud = Boolean(config.storage.cloud);
  if (hasJsonl && hasCloud) return "jsonl+cloud";
  if (hasCloud) return "cloud";
  if (hasJsonl) return "jsonl";
  return "none";
}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("SQLITE_BUSY") || message.includes("SQLITE_BUSY_RECOVERY");
}

async function withCloudOperationTimeout<T>(operation: T | Promise<T>): Promise<T> {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new GatewayHttpError({
              status: 504,
              type: "gateway_storage_error",
              code: "usage_ledger_cloud_timeout",
              message: "Cloud usage ledger operation timed out.",
            }),
          );
        }, cloudOperationTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withStorageRetry<T>(fn: () => T | Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await withCloudOperationTimeout(fn());
    } catch (error) {
      lastError = error;
      if (!isSqliteBusy(error) || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, zeroRetryDelayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

async function openCloudDatabase(storage: GatewayCloudStorageConfig, env: StorageEnv = process.env): Promise<GatewayCloudDb> {
  const cloud = await import("@hasna/cloud");
  if (storage.backend === "sqlite") {
    return new cloud.SqliteAdapter(storage.sqlitePath);
  }

  const connectionString = storage.connectionString ?? (storage.connectionStringEnv ? env[storage.connectionStringEnv] : undefined);
  if (!connectionString) {
    throw new GatewayHttpError({
      status: 500,
      type: "gateway_config_error",
      code: "storage_cloud_config_missing",
      message: "storage.cloud postgres backend requires a connectionString or a populated connectionStringEnv.",
    });
  }
  return new cloud.PgAdapterAsync(connectionString);
}

async function ensureCloudLedgerSchema(db: GatewayCloudDb): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_usage_ledger (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      route_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      context_json TEXT,
      usage_json TEXT,
      estimated_cost_usd REAL,
      budgets_json TEXT,
      error_type TEXT,
      error_code TEXT,
      record_json TEXT NOT NULL
    )
  `);
  await db.exec("CREATE INDEX IF NOT EXISTS idx_gateway_usage_ledger_timestamp ON gateway_usage_ledger(timestamp)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_gateway_usage_ledger_status ON gateway_usage_ledger(status)");
}

function cloudStorageOperationError(operation: "read" | "write", error: unknown): GatewayHttpError {
  if (error instanceof GatewayHttpError) return error;
  return new GatewayHttpError({
    status: 500,
    type: "gateway_storage_error",
    code: `usage_ledger_${operation}_failed`,
    message: `Cloud usage ledger ${operation} failed.`,
  });
}

async function withCloudLedger<T>(
  config: GatewayConfig,
  env: StorageEnv | undefined,
  fn: (db: GatewayCloudDb) => T | Promise<T>,
): Promise<T> {
  const storage = config.storage.cloud;
  if (!storage) {
    throw new GatewayHttpError({
      status: 500,
      type: "gateway_config_error",
      code: "storage_cloud_config_missing",
      message: "storage.cloud must be configured before opening the cloud usage ledger backend.",
    });
  }

  const db = await withStorageRetry(() => openCloudDatabase(storage, env));
  try {
    await withStorageRetry(() => ensureCloudLedgerSchema(db));
    return await withStorageRetry(() => fn(db));
  } finally {
    try {
      await db.close();
    } catch {
      // Ignore close errors so the original storage operation remains authoritative.
    }
  }
}

export async function readLocalUsageLedger(path: string | undefined): Promise<GatewayUsageLedgerRecord[]> {
  if (!path) return [];
  let text = "";
  try {
    text = await Bun.file(path).text();
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as GatewayUsageLedgerRecord];
      } catch {
        return [];
      }
    });
}

async function appendLocalUsageLedger(path: string | undefined, record: GatewayUsageLedgerRecord): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function appendCloudUsageLedger(
  config: GatewayConfig,
  record: GatewayUsageLedgerRecord,
  env: StorageEnv | undefined,
): Promise<void> {
  try {
    await withCloudLedger(config, env, async (db) => {
      await db.run(
        `
          INSERT INTO gateway_usage_ledger (
            id,
            timestamp,
            provider,
            model,
            provider_model,
            route_mode,
            status,
            context_json,
            usage_json,
            estimated_cost_usd,
            budgets_json,
            error_type,
            error_code,
            record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        crypto.randomUUID(),
        record.timestamp,
        record.provider,
        record.model,
        record.providerModel,
        record.routeMode,
        record.status,
        record.context ? JSON.stringify(record.context) : null,
        record.usage ? JSON.stringify(record.usage) : null,
        record.estimatedCostUsd ?? null,
        record.budgets ? JSON.stringify(record.budgets) : null,
        record.errorType ?? null,
        record.errorCode ?? null,
        JSON.stringify(record),
      );
    });
  } catch (error) {
    throw cloudStorageOperationError("write", error);
  }
}

export async function appendUsageLedgerRecord(
  config: GatewayConfig,
  record: GatewayUsageLedgerRecord,
  options: { env?: StorageEnv } = {},
): Promise<void> {
  await appendLocalUsageLedger(config.storage.usageLedgerPath, record);
  if (config.storage.cloud) {
    await appendCloudUsageLedger(config, record, options.env);
  }
}

export async function readCloudUsageLedger(
  config: GatewayConfig,
  options: { env?: StorageEnv } = {},
): Promise<GatewayUsageLedgerRecord[]> {
  if (!config.storage.cloud) return [];
  try {
    return await withCloudLedger(config, options.env, async (db) => {
      const rows = await db.all("SELECT record_json FROM gateway_usage_ledger ORDER BY timestamp ASC, id ASC") as LedgerRow[];
      return rows.flatMap((row) => {
        const json = row.record_json ?? row.recordJson;
        if (!json) return [];
        try {
          return [JSON.parse(json) as GatewayUsageLedgerRecord];
        } catch {
          return [];
        }
      });
    });
  } catch (error) {
    throw cloudStorageOperationError("read", error);
  }
}

function dedupeLedgerRecords(records: GatewayUsageLedgerRecord[]): GatewayUsageLedgerRecord[] {
  const seen = new Set<string>();
  const deduped: GatewayUsageLedgerRecord[] = [];
  for (const record of records) {
    const key = JSON.stringify(record);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(record);
  }
  return deduped;
}

export async function readBudgetLedgerRecords(
  config: GatewayConfig,
  options: { env?: StorageEnv } = {},
): Promise<GatewayUsageLedgerRecord[]> {
  const localRecords = await readLocalUsageLedger(config.storage.usageLedgerPath);
  if (!config.storage.cloud) return localRecords;
  const cloudRecords = await readCloudUsageLedger(config, options);
  return dedupeLedgerRecords([...localRecords, ...cloudRecords]);
}

export async function readUsageLedgerRecords(
  config: GatewayConfig,
  options: { env?: StorageEnv } = {},
): Promise<GatewayUsageLedgerRecord[]> {
  const localRecords = await readLocalUsageLedger(config.storage.usageLedgerPath);
  if (!config.storage.cloud) return localRecords;
  const cloudRecords = await readCloudUsageLedger(config, options);
  return dedupeLedgerRecords([...localRecords, ...cloudRecords]);
}
