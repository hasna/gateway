import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, GATEWAY_MCP_TOOLS, parseMcpArgs } from "../src/mcp/index";
import { gatewayVersion } from "../src/version";
import { testConfig } from "./helpers";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-mcp-"));
  tempDirs.push(dir);
  return dir;
}

async function writeConfig(path: string): Promise<void> {
  const config = testConfig();
  config.storage.usageLedgerPath = join(tempDir(), "usage.jsonl");
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function connectClient(
  defaultConfigPath: string,
  options: { allowConfigPathOverrides?: boolean } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ defaultConfigPath, allowConfigPathOverrides: options.allowConfigPathOverrides });
  const client = new Client({ name: "gateway-mcp-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? "{}");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway MCP server", () => {
  test("asserts the startup contract and validates config", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    await writeConfig(configPath);
    const { client, close } = await connectClient(configPath);
    try {
      expect(client.getServerVersion()).toEqual({ name: "gateway", version: gatewayVersion });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...GATEWAY_MCP_TOOLS].sort());
      const budgetAddSchema = tools.tools.find((tool) => tool.name === "gateway_budget_add")?.inputSchema as any;
      expect(budgetAddSchema).toMatchObject({
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          window: { type: "string", enum: ["per-request", "daily", "monthly", "lifetime"] },
          max_total_tokens: { type: "integer", minimum: 0 },
          confirm_write: { type: "boolean" },
        },
      });
      const routeSchema = tools.tools.find((tool) => tool.name === "gateway_explain_route")?.inputSchema as any;
      expect(routeSchema).toMatchObject({
        type: "object",
        required: ["request"],
        additionalProperties: false,
        properties: {
          request: {
            type: "object",
            required: ["model"],
            properties: {
              model: { type: "string", minLength: 1 },
            },
          },
        },
      });

      const health = parseToolText(await client.callTool({ name: "gateway_health", arguments: {} }));
      expect(health).toMatchObject({
        ok: true,
        name: "gateway-mcp",
        version: gatewayVersion,
        defaultConfigPath: configPath,
      });
      expect(health.tools).toEqual([...GATEWAY_MCP_TOOLS]);
      expect(parseMcpArgs(["--config", configPath, "--allow-config-path-overrides"])).toEqual({
        configPath,
        allowConfigPathOverrides: true,
      });

      const result = parseToolText(await client.callTool({ name: "gateway_validate_config", arguments: {} }));
      expect(result.ok).toBe(true);
      expect(result.path).toBe(configPath);
    } finally {
      await close();
    }
  });

  test("inspects config and dry-runs route selection without provider traffic", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    await writeConfig(configPath);
    const { client, close } = await connectClient(configPath);
    try {
      const inspect = parseToolText(await client.callTool({ name: "gateway_inspect_config", arguments: {} }));
      expect(inspect.providers.map((provider: { id: string }) => provider.id)).toContain("openai");
      expect(inspect.providers[0]).not.toHaveProperty("apiKey");

      const route = parseToolText(
        await client.callTool({
          name: "gateway_explain_route",
          arguments: {
            request: { model: "coding", messages: [{ role: "user", content: "hello" }] },
            env_present: ["OPENAI_API_KEY", "DEEPSEEK_API_KEY"],
            use_process_env: false,
          },
        }),
      );
      expect(route.ok).toBe(true);
      expect(route.selected).toBe("openai/gpt-4.1-mini");
    } finally {
      await close();
    }
  });

  test("redacts passthrough secrets from config validation and inspection", async () => {
    const previousSecret = process.env.MCP_REVIEW_SECRET;
    process.env.MCP_REVIEW_SECRET = "review-secret-value";
    const configPath = join(tempDir(), "gateway.config.json");
    const config = testConfig() as any;
    config.providers[0].apiKey = "${MCP_REVIEW_SECRET}";
    config.providers[0].headers = { authorization: "Bearer ${MCP_REVIEW_SECRET}" };
    config.routes[0].dataPolicy = {
      ...config.routes[0].dataPolicy,
      secretToken: "${MCP_REVIEW_SECRET}",
    };
    config.budgets = [
      {
        id: "key-budget",
        window: "per-request",
        mode: "hard",
        scope: { gatewayKey: "${MCP_REVIEW_SECRET}", tenant: "acme" },
        maxTotalTokens: 100,
      },
    ];
    config.storage.usageLedgerPath = join(tempDir(), "${MCP_REVIEW_SECRET}.jsonl");
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const { client, close } = await connectClient(configPath);
    try {
      const validationText = JSON.stringify(
        parseToolText(await client.callTool({ name: "gateway_validate_config", arguments: {} })),
      );
      const inspectionText = JSON.stringify(
        parseToolText(await client.callTool({ name: "gateway_inspect_config", arguments: {} })),
      );
      const budgetText = JSON.stringify(
        parseToolText(await client.callTool({ name: "gateway_budget_list", arguments: {} })),
      );
      const usageText = JSON.stringify(
        parseToolText(await client.callTool({ name: "gateway_usage_summary", arguments: {} })),
      );
      expect(validationText).not.toContain("review-secret-value");
      expect(inspectionText).not.toContain("review-secret-value");
      expect(budgetText).not.toContain("review-secret-value");
      expect(usageText).not.toContain("review-secret-value");
      expect(inspectionText).not.toContain("secretToken");
    } finally {
      await close();
      if (previousSecret === undefined) delete process.env.MCP_REVIEW_SECRET;
      else process.env.MCP_REVIEW_SECRET = previousSecret;
    }
  });

  test("redacts secrets from invalid config errors", async () => {
    const previousSecret = process.env.MCP_REVIEW_SECRET;
    process.env.MCP_REVIEW_SECRET = "review-secret-value";
    const configPath = join(tempDir(), "gateway.config.json");
    const config = testConfig() as any;
    config.providers[0].id = "${MCP_REVIEW_SECRET}";
    delete config.providers[0].baseUrl;
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const { client, close } = await connectClient(configPath);
    try {
      for (const name of ["gateway_validate_config", "gateway_inspect_config", "gateway_budget_list", "gateway_budget_remaining"]) {
        const result = await client.callTool({ name, arguments: {} });
        const text = JSON.stringify(parseToolText(result));
        expect(result.isError === true || text.includes('"ok":false')).toBe(true);
        expect(text).not.toContain("review-secret-value");
      }
    } finally {
      await close();
      if (previousSecret === undefined) delete process.env.MCP_REVIEW_SECRET;
      else process.env.MCP_REVIEW_SECRET = previousSecret;
    }
  });

  test("omits cloud storage connection strings from config inspection", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    const config = testConfig();
    config.storage.cloud = {
      backend: "postgres",
      connectionString: "redaction-sentinel-value",
      connectionStringEnv: "GATEWAY_POSTGRES_URL",
    };
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const { client, close } = await connectClient(configPath);
    try {
      const inspect = parseToolText(await client.callTool({ name: "gateway_inspect_config", arguments: {} }));
      const text = JSON.stringify(inspect);
      expect(inspect.storage.cloud).toEqual({
        backend: "postgres",
        connectionStringConfigured: true,
        connectionStringEnv: "GATEWAY_POSTGRES_URL",
      });
      expect(text).not.toContain("redaction-sentinel-value");
    } finally {
      await close();
    }
  });

  test("denies per-call config path overrides by default", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    const otherConfigPath = join(tempDir(), "other-gateway.config.json");
    await writeConfig(configPath);
    await writeConfig(otherConfigPath);

    const { client, close } = await connectClient(configPath);
    try {
      const result = await client.callTool({
        name: "gateway_validate_config",
        arguments: { config_path: otherConfigPath },
      });
      const payload = parseToolText(result);
      expect(result.isError).toBe(true);
      expect(payload.error.message).toContain("config_path overrides are disabled");
    } finally {
      await close();
    }
  });

  test("returns structured redacted errors for invalid tool inputs", async () => {
    const previousSecret = process.env.MCP_REVIEW_SECRET;
    const previousProviderKey = process.env.OPENAI_API_KEY;
    const fakeProviderKey = ["sk", "review-provider-key-1234567890"].join("-");
    process.env.MCP_REVIEW_SECRET = "review-secret-value";
    process.env.OPENAI_API_KEY = fakeProviderKey;
    const configPath = join(tempDir(), "gateway.config.json");
    await writeConfig(configPath);

    const { client, close } = await connectClient(configPath);
    try {
      const budgetResult = await client.callTool({
        name: "gateway_budget_add",
        arguments: {
          id: "",
          max_total_tokens: "not-a-number",
          [process.env.MCP_REVIEW_SECRET]: true,
          [process.env.OPENAI_API_KEY]: true,
        },
      });
      const budgetPayload = parseToolText(budgetResult);
      const budgetText = JSON.stringify(budgetPayload);
      expect(budgetResult.isError).toBe(true);
      expect(budgetPayload.error).toMatchObject({
        type: "gateway_mcp_validation_error",
        code: "invalid_tool_input",
        tool: "gateway_budget_add",
      });
      expect(budgetPayload.error.issues.map((issue: { path: string }) => issue.path)).toContain("id");
      expect(budgetPayload.error.issues.map((issue: { path: string }) => issue.path)).toContain("max_total_tokens");
      expect(budgetText).not.toContain("review-secret-value");
      expect(budgetText).not.toContain(fakeProviderKey);

      const writeConfirmResult = await client.callTool({
        name: "gateway_budget_add",
        arguments: { id: "team-daily", max_total_tokens: 100 },
      });
      const writeConfirmPayload = parseToolText(writeConfirmResult);
      expect(writeConfirmResult.isError).toBe(true);
      expect(writeConfirmPayload.error).toMatchObject({
        type: "gateway_mcp_validation_error",
        code: "invalid_tool_input",
        tool: "gateway_budget_add",
      });
      expect(writeConfirmPayload.error.issues.map((issue: { path: string }) => issue.path)).toContain("confirm_write");

      const routeResult = await client.callTool({
        name: "gateway_explain_route",
        arguments: { request: { messages: [{ role: "user", content: "hello" }] } },
      });
      const routePayload = parseToolText(routeResult);
      expect(routeResult.isError).toBe(true);
      expect(routePayload.error).toMatchObject({
        type: "gateway_mcp_validation_error",
        code: "invalid_tool_input",
        tool: "gateway_explain_route",
      });
      expect(routePayload.error.issues.map((issue: { path: string }) => issue.path)).toContain("request.model");

      for (const toolName of GATEWAY_MCP_TOOLS) {
        const result = await client.callTool({
          name: toolName,
          arguments: { [process.env.MCP_REVIEW_SECRET]: process.env.OPENAI_API_KEY },
        });
        const payload = parseToolText(result);
        const text = JSON.stringify(payload);
        expect(result.isError).toBe(true);
        expect(payload.error).toMatchObject({
          type: "gateway_mcp_validation_error",
          code: "invalid_tool_input",
          tool: toolName,
        });
        expect(text).not.toContain("review-secret-value");
        expect(text).not.toContain(fakeProviderKey);
      }
    } finally {
      await close();
      if (previousSecret === undefined) delete process.env.MCP_REVIEW_SECRET;
      else process.env.MCP_REVIEW_SECRET = previousSecret;
      if (previousProviderKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousProviderKey;
    }
  });

  test("adds, checks, resets budgets, and summarizes usage ledger", async () => {
    const configPath = join(tempDir(), "gateway.config.json");
    await writeConfig(configPath);
    const { client, close } = await connectClient(configPath);
    try {
      const added = parseToolText(
        await client.callTool({
          name: "gateway_budget_add",
          arguments: {
            id: "team-daily",
            window: "daily",
            tenant: "acme",
            model: "fast",
            max_total_tokens: 1000,
            confirm_write: true,
          },
        }),
      );
      expect(added.budget.id).toBe("team-daily");

      const duplicate = await client.callTool({
        name: "gateway_budget_add",
        arguments: {
          id: "team-daily",
          window: "daily",
          tenant: "acme",
          model: "fast",
          max_total_tokens: 2000,
          confirm_write: true,
        },
      });
      expect(duplicate.isError).toBe(true);

      const replaced = parseToolText(
        await client.callTool({
          name: "gateway_budget_add",
          arguments: {
            id: "team-daily",
            window: "daily",
            tenant: "acme",
            model: "fast",
            max_total_tokens: 1000,
            replace: true,
            confirm_write: true,
          },
        }),
      );
      expect(replaced.budget.id).toBe("team-daily");

      const remaining = parseToolText(
        await client.callTool({
          name: "gateway_budget_remaining",
          arguments: { id: "team-daily", tenant: "acme", model: "fast" },
        }),
      );
      expect(remaining.statuses[0].remaining.totalTokens).toBe(1000);

      const reset = parseToolText(
        await client.callTool({
          name: "gateway_budget_reset",
          arguments: { id: "team-daily", reset_at: "2026-06-24T00:00:00.000Z", confirm_write: true },
        }),
      );
      expect(reset.budget.resetAt).toBe("2026-06-24T00:00:00.000Z");

      const futureReset = await client.callTool({
        name: "gateway_budget_reset",
        arguments: {
          id: "team-daily",
          reset_at: new Date(Date.now() + 86_400_000).toISOString(),
          confirm_write: true,
        },
      });
      expect(futureReset.isError).toBe(true);

      const config = JSON.parse(await Bun.file(configPath).text()) as { storage: { usageLedgerPath: string } };
      await Bun.write(
        config.storage.usageLedgerPath,
        `${JSON.stringify({
          timestamp: "2026-06-24T00:01:00.000Z",
          provider: "openai",
          model: "openai/gpt-4.1-mini",
          status: "success",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          estimatedCostUsd: 0.00001,
        })}\n`,
      );

      const summary = parseToolText(await client.callTool({ name: "gateway_usage_summary", arguments: { limit: 1 } }));
      expect(summary.records).toBe(1);
      expect(summary.totals.totalTokens).toBe(15);
    } finally {
      await close();
    }
  });
});
