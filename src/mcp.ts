/**
 * MCP server exposing Class-Navi RPC methods as tools (stdio transport).
 *
 * Credentials from CLASSNAVI_USERNAME / CLASSNAVI_PASSWORD env vars.
 *
 * Register in Hermes config.yaml:
 *   mcp_servers:
 *     class-navi:
 *       command: bun
 *       args: ["run", "/Users/miguel/class-navi-api/src/mcp.ts"]
 *       env: { CLASSNAVI_USERNAME: "...", CLASSNAVI_PASSWORD: "..." }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig, loadDotEnv } from "./config";
import { ClassNaviClient, unwrap } from "./client";
import { TokenManager } from "./auth";
import { METHODS } from "./methods";

await loadDotEnv();
const config = loadConfig();
const auth = new TokenManager(config);
await auth.login();
const client = new ClassNaviClient(config, auth);

const server = new McpServer({
  name: "class-navi",
  version: "0.1.0",
});

for (const method of METHODS) {
  server.registerTool(
    `classnavi_${method.name}`,
    {
      title: `${method.name} (${method.screenId})`,
      description: `${method.readOnly ? "Read" : "Write"} — Class-Navi RPC ${method.name}`
        + ` [screen ${method.screenId}]. Params: JSON object; field names TBD from HAR capture.`
        + " Result is the API Result payload (ResultCode 0 = success).",
      inputSchema: z.object({
        params: z.record(z.string(), z.unknown()).default({}),
      }),
    },
    async (args: { params: Record<string, unknown> }) => {
      try {
        const response = await client.call(method.name, args.params ?? {});
        return { content: [{ type: "text", text: JSON.stringify(unwrap(response)) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
