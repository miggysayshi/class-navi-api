// server/index.js — Quick Mark Pro license server.
// Routes:
//   POST /api/license/activate {license_key, instance_id} → bind + validate
//   POST /api/license/validate {license_key, instance_id} → validate
//   POST /api/stripe/webhook                                   → Stripe events
//   GET  /api/portal/keys?email=...                            → key lookup
//   GET  /portal                                                → portal page
// Environment: see .env.example.
import { openDb, generateKey, upsertLicense, setSubscriptionStatus, activateInstance, licensesForEmail } from "./db.js";

const SECRET = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const PORT = Number(process.env.PORT || 8787);
const MAX_INSTANCES = Number(process.env.MAX_INSTANCES || 3);
const DB_PATH = process.env.DB_PATH || "license.db";

const db = openDb(DB_PATH);
const stripe = SECRET && SECRET.startsWith("sk_") ? (await import("stripe")).default(SECRET) : null;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function readJson(req) {
  try {
    return await req.json();
  } catch (e) {
    return null;
  }
}

/** Stripe webhook: subscription lifecycle → license lifecycle. */
async function handleWebhook(req) {
  if (!stripe || !WEBHOOK_SECRET) return json(500, { error: "stripe not configured" });
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (e) {
    return json(400, { error: `webhook signature invalid: ${e.message}` });
  }
  switch (event.type) {
    case "checkout.session.completed": {
      const cs = event.data.object;
      const subId = cs.subscription || null;
      const email = cs.customer_details && cs.customer_details.email ? cs.customer_details.email : null;
      if (subId) {
        const key = upsertLicense(db, {
          key: generateKey(),
          email,
          customerId: cs.customer || null,
          subscriptionId: subId,
          status: "active",
        });
        console.log(`[license] new license ${key} for ${email || cs.customer} (${subId})`);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object;
      const statusMap = {
        active: "active",
        trialing: "trialing",
        past_due: "past_due",
        unpaid: "past_due",
        canceled: "canceled",
        incomplete: "incomplete",
        incomplete_expired: "canceled",
        paused: "paused",
      };
      const st = statusMap[sub.status] || "canceled";
      const key = setSubscriptionStatus(db, sub.id, st);
      if (key) console.log(`[license] ${sub.id} → ${st} (${key})`);
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const key = setSubscriptionStatus(db, sub.id, "canceled");
      if (key) console.log(`[license] ${sub.id} deleted → canceled (${key})`);
      break;
    }
    case "invoice.payment_succeeded": {
      const inv = event.data.object;
      const subId = inv.subscription;
      if (subId) {
        const key = setSubscriptionStatus(db, subId, "active");
        if (key) console.log(`[license] renewal paid → active (${key})`);
      }
      break;
    }
    default:
      break;
  }
  return json(200, { received: true });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return json(204, {});
    }

    if (req.method === "POST" && path === "/api/license/activate") {
      const body = await readJson(req);
      if (!body || !body.license_key || !body.instance_id) {
        return json(400, { error: "license_key and instance_id required" });
      }
      const r = activateInstance(db, String(body.license_key).trim(), String(body.instance_id), MAX_INSTANCES);
      return json(r.valid ? 200 : 403, {
        activated: r.valid,
        valid: r.valid,
        expiresAt: r.expiresAt,
        error: r.valid ? null : r.reason,
      });
    }

    if (req.method === "POST" && path === "/api/license/validate") {
      const body = await readJson(req);
      if (!body || !body.license_key || !body.instance_id) {
        return json(400, { error: "license_key and instance_id required" });
      }
      const r = activateInstance(db, String(body.license_key).trim(), String(body.instance_id), MAX_INSTANCES);
      return json(r.valid ? 200 : 403, {
        valid: r.valid,
        expiresAt: r.expiresAt,
        error: r.valid ? null : r.reason,
      });
    }

    if (req.method === "POST" && path === "/api/stripe/webhook") {
      return handleWebhook(req);
    }

    if (req.method === "GET" && path === "/api/portal/keys") {
      const email = url.searchParams.get("email");
      if (!email) return json(400, { error: "email required" });
      const keys = licensesForEmail(db, email.toLowerCase().trim());
      return json(200, { keys });
    }

    if (req.method === "GET" && path === "/portal") {
      return new Response(PORTAL_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (req.method === "GET" && path === "/health") {
      return json(200, { ok: true });
    }

    return json(404, { error: "not found" });
  },
});

console.log(`[license] server on ${BASE_URL}:${PORT} (stripe ${stripe ? "configured" : "NOT configured"})`);

const PORTAL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Quick Mark Pro — License keys</title>
<style>
  body { font-family: -apple-system,'Segoe UI',Roboto,sans-serif; background:#f4f7f9; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { background:#fff; border:1px solid #d9e2e6; border-radius:12px; padding:28px 32px; width:420px; max-width:92vw; box-shadow:0 8px 24px rgba(0,0,0,.08); }
  h1 { font-size:18px; color:#1c3a5e; margin:0 0 4px; }
  p { font-size:12px; color:#8aa5b0; margin:0 0 16px; }
  input { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid #cbd5dd; border-radius:6px; font-size:13px; margin-bottom:10px; }
  button { width:100%; padding:10px 0; background:#2a6df4; color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; }
  .key { font-family: ui-monospace, Menlo, monospace; background:#f0f6ff; border:1px solid #cfe0ff; border-radius:6px; padding:8px 10px; font-size:13px; margin:8px 0; color:#1c3a5e; }
  .status { font-size:11px; color:#8aa5b0; text-transform:uppercase; letter-spacing:.4px; margin-top:8px; }
</style></head>
<body><div class="card">
  <h1>Quick Mark Pro</h1>
  <p>Enter the email you paid with to see your license key(s).</p>
  <input id="email" type="email" placeholder="you@example.com">
  <button id="go">Find my keys</button>
  <div id="out"></div>
</div>
<script>
  const go = document.getElementById('go'), out = document.getElementById('out'), email = document.getElementById('email');
  go.addEventListener('click', async () => {
    out.innerHTML = '';
    const e = email.value.trim();
    if (!e) return;
    const r = await fetch('/api/portal/keys?email=' + encodeURIComponent(e));
    const j = await r.json();
    if (!j.keys || j.keys.length === 0) { out.innerHTML = '<div class="status">No keys found for that email.</div>'; return; }
    for (const k of j.keys) {
      const div = document.createElement('div');
      div.className = 'key';
      div.textContent = k.key + '  (' + k.status + ')';
      out.appendChild(div);
    }
    out.appendChild(Object.assign(document.createElement('div'), { className: 'status', textContent: 'Paste the key into the Quick Mark Pro activation screen.' }));
  });
  email.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
</script></body></html>`;
