/**
 * CLI entry points.
 *   bun run src/index.ts login                 — verify credentials + auth flow
 *   bun run src/index.ts call <Method> '<json>' — one RPC call, prints Result
 */

import { loadConfig, loadDotEnv } from "./config";
import { ClassNaviClient, unwrap } from "./client";
import { TokenManager } from "./auth";
import { isKnownMethod } from "./methods";

await loadDotEnv();

async function cmdLogin(): Promise<void> {
  const config = loadConfig();
  const auth = new TokenManager(config);
  await auth.login();
  console.log("login OK — token expires", auth.expiresAt?.toISOString() ?? "unknown");
  console.log("user:", auth.userId);
}

async function cmdCall(method: string, paramsJson: string): Promise<void> {
  const config = loadConfig();
  if (!isKnownMethod(method)) {
    console.error(`Warning: '${method}' is not in the known method list — sending anyway.`);
  }
  const auth = new TokenManager(config);
  await auth.login();
  const client = new ClassNaviClient(config, auth);
  const response = await client.call(method, paramsJson ? JSON.parse(paramsJson) : {});
  // print the full envelope — the app keeps data fields (StudentList,
  // MainCenterID, ...) at the top level next to Result
  console.log(JSON.stringify(response, null, 2));
}

const [cmd, arg1, arg2] = process.argv.slice(2);
try {
  if (cmd === "login") {
    await cmdLogin();
  } else if (cmd === "call") {
    if (!arg1) throw new Error("usage: bun run src/index.ts call <Method> '<json>'");
    await cmdCall(arg1, arg2 ?? "{}");
  } else {
    console.log(
      [
        "class-navi-api CLI",
        "",
        "  bun run src/index.ts login",
        "  bun run src/index.ts call GetStudentStatus '{\"StudentID\":\"123\"}'",
      ].join("\n"),
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
