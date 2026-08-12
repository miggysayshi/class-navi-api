// server/scripts/issue-key.js — manually issue license key(s).
// Use for: testing, free comps, manual seats, or when the webhook path
// isn't involved. Each key is a full active license (3-device cap).
//
// Usage:
//   bun run scripts/issue-key.js --email demo@quickmark.test          # 1 key
//   bun run scripts/issue-key.js --email demo@quickmark.test --count 5
//   bun run scripts/issue-key.js --email x@y.z --db /tmp/license.db
import { openDb, generateKey, upsertLicense } from "../db.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const email = arg("--email", "");
const count = Math.max(1, Number(arg("--count", "1")) || 1);
const dbPath = arg("--db", "license.db");

if (!email) {
  console.error("usage: bun run scripts/issue-key.js --email <email> [--count N] [--db path]");
  process.exit(1);
}

const db = openDb(dbPath);
for (let i = 0; i < count; i++) {
  const key = generateKey();
  upsertLicense(db, {
    key,
    email,
    customerId: "manual",
    subscriptionId: `manual-${Date.now()}-${i}`,
    status: "active",
  });
  console.log(key);
}
console.log(`issued ${count} key(s) for ${email} → ${dbPath}`);
