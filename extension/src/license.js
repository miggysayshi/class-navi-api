// src/license.js — Quick Mark Pro licensing (MAIN world).
//
// Pure status logic lives here (unit-testable). The actual validation runs
// in the background service worker (src/background.js); the MAIN world has
// no chrome.* access, so requests round-trip through the ISOLATED world
// bridge (src/content.js) → chrome.runtime.sendMessage → worker → back.
var QS = globalThis.QS || (globalThis.QS = {});

QS.license = (function () {
  // ── EDIT ME ──────────────────────────────────────────────
  // Stripe: create a Payment Link for the $10/mo price (Dashboard → Payment
  // links) and enable the Customer portal (Dashboard → Billing → Customer
  // portal → activate; the portal link appears there).
  const CHECKOUT_URL = "https://buy.stripe.com/test_14A8wP4Kpfr57ZIgDY8k800"; // TEST link — swap for the live one at launch
  const PORTAL_URL = "https://billing.stripe.com/p/login/REPLACE_WITH_PORTAL_ID";
  const PRICE_LABEL = "$10/seat/month";
  // ──────────────────────────────────────────────────────────────────
  const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7-day offline grace

  /**
   * Pure: derive the license state from the worker's raw status payload.
   * payload: { key, instance, debug, validation: {valid, expiresAt,
   * checkedAt} | null, cache: {valid, checkedAt} | null, error: string|null }
   * States: active | grace | invalid | unreachable | unlicensed.
   */
  function deriveState(payload, now) {
    const t = now || Date.now();
    const debug = payload && payload.debug;
    if (debug === "on") return { state: "active", reason: "debug-on" };
    if (debug === "off") return { state: "unlicensed", reason: "debug-off" };
    if (!payload || !payload.key) return { state: "unlicensed", reason: "no-key" };
    const v = payload.validation;
    if (v && v.valid === true) {
      return { state: "active", reason: "valid", expiresAt: v.expiresAt, checkedAt: v.checkedAt };
    }
    if (v && v.valid === false) {
      return { state: "invalid", reason: "rejected", message: v.error || "license rejected" };
    }
    // no fresh validation (offline / bridge hiccup): grace if a recent
    // cache says valid
    const c = payload.cache;
    if (c && c.valid === true && t - c.checkedAt < GRACE_MS) {
      return {
        state: "grace",
        reason: "offline-cache",
        remainingMs: GRACE_MS - (t - c.checkedAt),
        checkedAt: c.checkedAt,
      };
    }
    if (payload.error) return { state: "unreachable", reason: "network", message: payload.error };
    return { state: "unlicensed", reason: "no-validation" };
  }

  /** Pure: remaining grace in whole days (ceil; 0 when none). */
  function graceDays(status) {
    if (!status || !status.remainingMs) return 0;
    return Math.max(0, Math.ceil(status.remainingMs / (24 * 60 * 60 * 1000)));
  }

  /** Pure: "2026-09-01T00:00:00Z" → "Sep 1, 2026"; null → "". */
  function fmtDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) {
      return "";
    }
  }

  // ── bridge to the ISOLATED world / background worker ──
  const pending = {}; // requestId → {resolve, timer}
  let reqSeq = 0;

  function bridgeRequest(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      if (typeof window === "undefined") {
        resolve({ error: "no-window" });
        return;
      }
      const id = `qs-${++reqSeq}-${Date.now()}`;
      console.log(`[QuickSet] license request ${id} (${type})`);
      const timer = setTimeout(() => {
        delete pending[id];
        resolve({ error: "bridge-timeout" });
      }, timeoutMs || 4000);
      pending[id] = { resolve, timer };
      window.postMessage({ type, requestId: id, payload }, "*");
    });
  }

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      const data = event && event.data;
      if (!data || typeof data !== "object") return;
      // ONLY response types — window.postMessage delivers to the sender's
      // own listeners too, and the request messages carry a requestId that
      // would self-match the pending map and resolve with an empty result
      // (the "empty" bug: every request ate its own response).
      if (
        data.type !== "qs:license-status-response" &&
        data.type !== "qs:license-set-key-response" &&
        data.type !== "qs:license-set-debug-response"
      ) {
        return;
      }
      if (!data.requestId || !pending[data.requestId]) return;
      const p = pending[data.requestId];
      delete pending[data.requestId];
      clearTimeout(p.timer);
      console.log(`[QuickSet] license response for ${data.requestId}:`, JSON.stringify(data.result || {}).slice(0, 200));
      p.resolve(data.result || { error: "empty" });
    });
  }

  /** Ask the worker for the raw license status. */
  async function fetchStatus() {
    return bridgeRequest("qs:license-status-request");
  }

  /** Set (or clear, when "") the license key via the worker. */
  async function setKey(key) {
    return bridgeRequest("qs:license-set-key", { key });
  }

  /** Set the debug override ("on" | "off" | null) via the worker. */
  async function setDebug(value) {
    return bridgeRequest("qs:license-set-debug", { value });
  }

  let cachedStatus = null;

  /** Main entry: derived status, cached ~60s; force = re-check now. */
  async function getStatus(force) {
    if (!force && cachedStatus && Date.now() - cachedStatus.at < 60 * 1000) {
      return cachedStatus.status;
    }
    const raw = await fetchStatus();
    console.log("[QuickSet] license raw payload:", JSON.stringify(raw).slice(0, 400));
    const status = deriveState(raw, Date.now());
    status.instance = raw && raw.instance;
    cachedStatus = { at: Date.now(), status };
    return status;
  }

  const isActive = (status) => !!status && (status.state === "active" || status.state === "grace");

  // ── activation UI ──
  function gateBody(status) {
    const state = status && status.state;
    if (state === "active" || state === "grace") return "";
    let line = "";
    if (state === "invalid") line = `Your license key was rejected. Check it and try again.`;
    else if (state === "unreachable") line = `Could not reach the license server. If you just activated, wait a moment and reload.`;
    else line = `Class Navi Pro Tools is a ${PRICE_LABEL} subscription. Activate below to use the marking toolbar, patterns, and level stats.`;
    return line;
  }

  /**
   * Show (idempotent) the activation card. Returns the gate element or null.
   */
  function showGate(status) {
    try {
      if (typeof document === "undefined") return null;
      const state = status && status.state;
      let gate = document.getElementById("qs-license-gate");
      if (gate) return gate;
      gate = document.createElement("div");
      gate.id = "qs-license-gate";
      gate.style.cssText =
        "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:#fff;border:1px solid #2a6df4;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);padding:24px 28px;width:380px;max-width:92vw;font-size:13px;color:#1c3a5e;text-align:center;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;";
      const title = document.createElement("div");
      title.textContent = "Class Navi Pro Tools";
      title.style.cssText = "font-size:18px;font-weight:700;margin-bottom:4px;";
      const sub = document.createElement("div");
      sub.textContent = "Unlock the Class-Navi grading toolkit";
      sub.style.cssText = "font-size:12px;color:#8aa5b0;margin-bottom:14px;";
      const msg = document.createElement("div");
      msg.textContent = gateBody(status);
      msg.style.cssText = "font-size:12px;line-height:1.5;margin-bottom:14px;color:#47586e;";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Paste your license key";
      input.style.cssText =
        "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5dd;border-radius:6px;font-size:13px;margin-bottom:10px;text-align:center;";
      const err = document.createElement("div");
      err.style.cssText = "font-size:11px;color:#c0392b;min-height:14px;margin-bottom:8px;";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Activate";
      btn.style.cssText =
        "width:100%;padding:9px 0;background:#2a6df4;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:6px;";
      const buy = document.createElement("a");
      buy.href = CHECKOUT_URL;
      buy.target = "_blank";
      buy.rel = "noopener";
      buy.textContent = `Buy a license — ${PRICE_LABEL}`;
      buy.style.cssText = "display:block;font-size:12px;color:#2a6df4;margin:6px 0;";
      const portal = document.createElement("a");
      portal.href = PORTAL_URL;
      portal.target = "_blank";
      portal.rel = "noopener";
      portal.textContent = "Manage / restore your subscription";
      portal.style.cssText = "display:block;font-size:11px;color:#8aa5b0;margin-bottom:10px;";
      const stateLine = document.createElement("div");
      stateLine.textContent = state === "grace" ? "Offline grace active" : state;
      stateLine.style.cssText = "font-size:10px;color:#8aa5b0;text-transform:uppercase;letter-spacing:.4px;";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Checking…";
        const keyText = input.value.trim();
        // an empty input means "re-check what's already stored" — the card
        // can be stale (e.g. the key was activated from the console)
        const res = keyText ? await setKey(keyText) : { ok: true };
        const st = await getStatus(true);
        if (isActive(st)) {
          gate.remove();
          if (typeof window.__qsLicenseActivated === "function") window.__qsLicenseActivated();
          return;
        }
        err.textContent = res && res.message
          ? String(res.message)
          : keyText
            ? "Key not accepted yet — check it and retry."
            : "No key stored yet — paste your license key above, then Activate.";
        btn.disabled = false;
        btn.textContent = "Activate";
      });
      gate.appendChild(title);
      gate.appendChild(sub);
      gate.appendChild(msg);
      gate.appendChild(input);
      gate.appendChild(err);
      gate.appendChild(btn);
      gate.appendChild(buy);
      gate.appendChild(portal);
      gate.appendChild(stateLine);
      document.body.appendChild(gate);
      // self-healing: while the gate is visible, watch for the license
      // becoming active (activated in another tab, network blip, key
      // entered elsewhere) and unlock without a click
      const watcher = setInterval(async () => {
        try {
          if (!document.getElementById("qs-license-gate")) {
            clearInterval(watcher);
            return;
          }
          const st = await getStatus(true);
          if (isActive(st)) {
            clearInterval(watcher);
            gate.remove();
            if (typeof window.__qsLicenseActivated === "function") window.__qsLicenseActivated();
          }
        } catch (e) {
          /* keep watching */
        }
      }, 2000);
      gate.__qsWatcher = watcher;
      return gate;
    } catch (e) {
      return null;
    }
  }

  function hideGate() {
    try {
      const gate = document.getElementById("qs-license-gate");
      if (gate) {
        if (gate.__qsWatcher) clearInterval(gate.__qsWatcher);
        gate.remove();
      }
    } catch (e) {
      /* never throw */
    }
  }

  return {
    CHECKOUT_URL,
    PORTAL_URL,
    PRICE_LABEL,
    GRACE_MS,
    deriveState,
    graceDays,
    fmtDate,
    getStatus,
    setKey,
    setDebug,
    isActive,
    showGate,
    hideGate,
  };
})();
