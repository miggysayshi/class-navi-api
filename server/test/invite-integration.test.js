import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";

const ADMIN_TOKEN = "invite-admin-token-32-bytes-safe";
const RATE_SECRET = "invite-rate-secret-32-bytes-safe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

let child;
let dir;
let dbPath;
let baseUrl;
let logs = "";

beforeAll(async () => {
  const port = await freePort();
  dir = mkdtempSync(join(tmpdir(), "qmp-invite-http-"));
  dbPath = join(dir, "invite.db");
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(import.meta.dir, "../index.js")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      BASE_URL: baseUrl,
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "",
      RESEND_WEBHOOK_SECRET: "",
      MANAGEMENT_TOKEN_SECRET: RATE_SECRET,
      ADMIN_TOKEN,
      RECOVERY_MIN_RESPONSE_MS: "1",
      INVITE_MIN_RESPONSE_MS: "1",
      INVITE_IP_LIMIT: "20",
      INVITE_CODE_LIMIT: "5",
      INVITE_ADMIN_IP_LIMIT: "20",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("invite integration server did not start");
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(2000),
    ]);
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("real HTTP invite page and bearer-only mint/redeem/revoke lifecycle", async () => {
  const page = await fetch(`${baseUrl}/invite`);
  expect(page.status).toBe(200);
  const csp = page.headers.get("content-security-policy") || "";
  expect(csp).toContain("'nonce-");
  const html = await page.text();
  expect(html).toContain("/api/invites/redeem");
  const nonce = html.match(/<script nonce="([^"]+)"/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain(`'nonce-${nonce}'`);
  expect(html).not.toContain(ADMIN_TOKEN);
  expect(html).not.toContain(RATE_SECRET);

  const mintBody = {
    label: "Family test",
    count: 1,
    expires_at: Date.now() + 86_400_000,
  };
  const bodyTokenOnly = await fetch(`${baseUrl}/api/admin/invites/mint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...mintBody, token: ADMIN_TOKEN }),
  });
  expect(bodyTokenOnly.status).toBe(403);

  const mint = await fetch(`${baseUrl}/api/admin/invites/mint`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "cf-connecting-ip": "203.0.113.80",
    },
    body: JSON.stringify(mintBody),
  });
  expect(mint.status).toBe(200);
  const minted = await mint.json();
  expect(minted.codes).toHaveLength(1);
  const inviteCode = minted.codes[0];
  expect(inviteCode).toMatch(/^FAM-/);

  const invalid = await fetch(`${baseUrl}/api/invites/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.81" },
    body: JSON.stringify({ code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "nobody@example.com" }),
  });
  const redeem = await fetch(`${baseUrl}/api/invites/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.82" },
    body: JSON.stringify({ code: inviteCode, email: "family@example.com" }),
  });
  expect(invalid.status).toBe(202);
  expect(redeem.status).toBe(202);
  expect(await invalid.json()).toEqual(await redeem.json());

  const db = new Database(dbPath);
  let licenseKey;
  try {
    const inviteRows = db.query("SELECT code_hash FROM invite_codes").all();
    expect(inviteRows).toHaveLength(1);
    expect(inviteRows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(inviteRows)).not.toContain(inviteCode);
    const license = db.query("SELECT key, status, source FROM licenses WHERE source='family_free'").get();
    expect(license.status).toBe("active");
    licenseKey = license.key;
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox WHERE kind='family_welcome'").get().n).toBe(1);
  } finally {
    db.close();
  }

  const revoke = await fetch(`${baseUrl}/api/admin/family/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "cf-connecting-ip": "203.0.113.83",
    },
    body: JSON.stringify({ license_key: licenseKey }),
  });
  expect(revoke.status).toBe(200);
  const revoked = await revoke.json();
  expect(revoked).toEqual({ revoked: true, code: "revoked", licenseTail: licenseKey.slice(-4) });
  expect(JSON.stringify(revoked)).not.toContain(licenseKey);

  const check = new Database(dbPath, { readonly: true });
  try {
    expect(check.query("SELECT status FROM licenses WHERE key=?").get(licenseKey).status).toBe("revoked");
  } finally {
    check.close();
  }

  expect(logs).not.toContain(inviteCode);
  expect(logs).not.toContain("family@example.com");
  expect(logs).not.toContain(licenseKey);
  expect(logs).not.toContain(ADMIN_TOKEN);
  expect(logs).not.toContain(RATE_SECRET);
});
