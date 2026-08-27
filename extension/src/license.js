// src/license.js — Quick Mark Pro licensing (MAIN world).
//
// Pure status logic lives here (unit-testable). The actual validation runs
// in the background service worker (src/background.js); the MAIN world has
// no chrome.* access, so requests round-trip through the ISOLATED world
// bridge (src/content.js) → chrome.runtime.sendMessage → worker → back.
//
// Slice 7A contract:
//  - Centralized product config (price, seat wording, Checkout/Portal/recovery
//    URLs) — no scattered price literals.
//  - Build-time browser-family seam (BROWSER_FAMILY) — NEVER inferred from the
//    browser's user-agent string. A Chrome build flips one constant.
//  - Stable reason→state/message mapping for every frozen server reason.
//  - Dual seat-limit CTAs (Manage installations + Buy another seat).
//  - Active billing surface (options page + unobtrusive control on the app UI).
//  - Accessibility: dialog semantics, focus, Esc rules, aria-live, focus styles.
var QS = globalThis.QS || (globalThis.QS = {});

QS.license = (function () {
  const CHECKOUT_URL = "https://buy.stripe.com/14A8wP4Kpfr57ZIgDY8k800";
  const PORTAL_URL = "https://billing.stripe.com/p/login/14A8wP4Kpfr57ZIgDY8k800";
  const RECOVERY_URL = "https://license.nimira-timer.com/portal";

  // Central product config. The single source of truth for price and wording;
  // UI strings are built from these, never hard-coded elsewhere.
  const PRODUCT = {
    price: "$7.99",
    priceLabel: "$7.99/month",
    seatWording: "another computer or browser profile",
    checkoutUrl: CHECKOUT_URL,
    portalUrl: PORTAL_URL,
    recoveryUrl: RECOVERY_URL,
  };

  // Build-time browser-family seam. The current package defaults to Edge; a
  // Chrome build flips this to BROWSER_FAMILIES.CHROME. Deterministic and
  // fixed — it is NEVER derived from the browser's user-agent string.
  const BROWSER_FAMILIES = { CHROME: "chrome", EDGE: "edge" };
  const BROWSER_FAMILY = BROWSER_FAMILIES.EDGE; // EDIT-ME: flip to CHROME for the Chrome build

  const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7-day offline grace

  /**
   * Pure: build a license-server request body that always carries the fixed
   * browser_family (snake_case; exactly "chrome" or "edge"), alongside
   * license_key/instance_id. Both activation and validation use this shape.
   * family: BROWSER_FAMILIES.CHROME | BROWSER_FAMILIES.EDGE (defaults to the
   * build-time BROWSER_FAMILY when omitted or unrecognized).
   */
  function buildRequest(family, base) {
    const f =
      family === BROWSER_FAMILIES.CHROME || family === BROWSER_FAMILIES.EDGE
        ? family
        : BROWSER_FAMILY;
    return Object.assign({}, base || {}, { browser_family: f });
  }

  /**
   * Stable mapping for every frozen server reason (reasons may arrive in the
   * `error` or `code` field). Returns null when the reason is unknown so the
   * caller falls back to a generic invalid state.
   */
  const REASON_COPY = {
    "slot-occupied": {
      state: "license-limit",
      message:
        "This license key is already in use on another installation. A reinstall or browser-profile change may only need a reset; another computer or browser profile needs another seat.",
      cta: ["manage", "buy"],
    },
    "slot-mismatch": {
      state: "license-limit",
      message:
        "This copy's browser family doesn't match the installation slot holding this license. Manage your installations to reset the slot.",
      cta: ["manage"],
    },
    "family-undetermined": {
      state: "invalid",
      message:
        "The license server could not determine the browser family for this copy. Please reinstall the extension.",
      cta: ["manage"],
    },
    "not-activated": {
      state: "unlicensed",
      message: "This license key has not been activated yet. Activate it below.",
      cta: ["buy"],
    },
    "license-canceled": {
      state: "canceled",
      message: "Your subscription was canceled. Access ends with your paid period.",
      cta: ["manage", "buy"],
    },
    "license-past_due": {
      state: "past-due",
      message: "Your payment is past due. Update your payment method to keep access.",
      cta: ["manage", "buy"],
    },
    "license-paused": {
      state: "paused",
      message: "Your subscription is paused. Resume it to restore access.",
      cta: ["manage", "buy"],
    },
    "license-incomplete": {
      state: "incomplete",
      message: "Your payment is incomplete. Finish checkout to keep access.",
      cta: ["manage", "buy"],
    },
    "license-canceling-at-period-end": {
      state: "active",
      canceling: true,
      message: "Your subscription cancels at the end of the current period.",
      cta: ["manage"],
    },
  };

  function mapReason(rawReason) {
    if (!rawReason) return null;
    const key = String(rawReason);
    return REASON_COPY[key] || null;
  }

  /**
   * Pure: true when the payload carries a NONBLANK failure `error`. Reasons
   * may arrive in the `error` field as well as `code`. A payload that says
   * success (valid:true / activated:true) while carrying a failure error is a
   * malformed/attack answer and must FAIL CLOSED — never treated as success.
   * `error:null`/`undefined`/empty string are NOT failures (genuine legacy /
   * frozen success may carry them).
   */
  function hasFailureError(o) {
    if (!o) return false;
    const e = o.error;
    if (e === null || e === undefined) return false;
    if (typeof e === "string") return e.trim() !== "";
    return true;
  }

  /**
   * Pure: derive the license state from the worker's raw status payload.
   * payload: { key, instance, debug, validation: {valid, reason, error,
   * expiresAt, checkedAt, currentPeriodEnd, cancelAtPeriodEnd} | null,
   * cache: {valid, checkedAt} | null, blocked, blockedReason, error }.
   * States: active | grace | invalid | unreachable | unlicensed | license-limit
   * | canceled | past-due | paused | incomplete.
   * A known/blocked response (authoritative server answer) NEVER enters grace;
   * only network failure may use a recent-valid offline cache for grace.
   */
  function deriveState(payload, now) {
    const t = now || Date.now();
    if (!payload || !payload.key) return { state: "unlicensed", reason: "no-key" };
    const v = payload.validation;
    if (v) {
      // FAIL CLOSED: valid:true is active ONLY when there is no code (legacy
      // validation success) or the code is exactly "ok" (frozen success), AND
      // there is no nonblank failure `error` (the reason may arrive in `error`
      // as well as `code`). A malformed/attack payload that says valid:true
      // while carrying a frozen failure code OR a failure error
      // (family-undetermined, license-canceled, ...) falls through to the
      // authoritative invalid mapping below — it must never derive active.
      if (v.valid === true && (!v.code || v.code === "ok") && !hasFailureError(v)) {
        const s = { state: "active", reason: "valid", expiresAt: v.expiresAt, checkedAt: v.checkedAt };
        if (v.currentPeriodEnd) s.periodEnd = v.currentPeriodEnd;
        if (v.cancelAtPeriodEnd) s.cancelAtPeriodEnd = true;
        if (v.cancelAtPeriodEnd) s.canceling = true;
        return s;
      }
      // invalid/blocked: the server gave an authoritative reason — never grace
      const raw = v.reason || v.code || v.error || "";
      const mapped = mapReason(raw);
      if (mapped) {
        const s = Object.assign({ reason: raw, checkedAt: v.checkedAt }, mapped);
        if (v.currentPeriodEnd) s.periodEnd = v.currentPeriodEnd;
        if (v.cancelAtPeriodEnd) s.cancelAtPeriodEnd = true;
        return s;
      }
      return { state: "invalid", reason: "rejected", message: v.error || "license rejected" };
    }
    // no fresh validation: an authoritative blocked response cleared the cache
    if (payload.blocked) {
      const mapped = mapReason(payload.blockedReason);
      if (mapped) return Object.assign({ reason: payload.blockedReason }, mapped);
      return { state: "invalid", reason: "blocked", message: payload.blockedMessage || "License was revoked." };
    }
    // only network failure keeps a recent-valid cache available for offline grace
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

  /**
   * Pure: "2026-09-01T00:00:00Z" → "Sep 1, 2026"; null → "".
   * The server persists Stripe period timestamps as INTEGER Unix SECONDS
   * (e.g. 1798761600). JavaScript's Date uses milliseconds, so any finite
   * numeric value < 1e12 (clearly seconds, not ms) is scaled by 1000 before
   * parsing — otherwise it would render as January 1970. ISO strings and
   * already-millisecond numbers (>= 1e12) pass through unchanged.
   */
  function fmtDate(iso) {
    if (iso === null || iso === undefined || iso === "") return "";
    try {
      const ms =
        typeof iso === "number" && Number.isFinite(iso) && iso < 1e12 ? iso * 1000 : iso;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) {
      return "";
    }
  }

  /** Pure: period-end copy for active/trialing statuses. */
  function periodEndCopy(status) {
    if (!status || !status.periodEnd) return "";
    const d = fmtDate(status.periodEnd);
    if (!d) return "";
    return status.cancelAtPeriodEnd
      ? `Your subscription cancels at period end — access stays active until ${d}.`
      : `Access stays active until the end of the current period (${d}).`;
  }

  /** The dual seat-limit CTA labels (exact, per frozen contract). */
  function slotCtas() {
    return {
      manage: "Manage installations",
      buy: `Buy another seat — ${PRODUCT.priceLabel}`,
    };
  }

  /** The four actions surfaced to active subscribers (options + app UI). */
  function billingLinks() {
    return [
      { key: "manage-subscription", label: "Manage subscription", href: PRODUCT.portalUrl },
      { key: "recover-license", label: "Recover license", href: PRODUCT.recoveryUrl },
      { key: "manage-installations", label: "Manage Chrome/Edge installations", href: PRODUCT.recoveryUrl },
      { key: "buy-another-seat", label: `Buy another seat — ${PRODUCT.priceLabel}`, href: PRODUCT.checkoutUrl },
    ];
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
      // would self-match the pending map and resolve with an empty result.
      if (
        data.type !== "qs:license-status-response" &&
        data.type !== "qs:license-set-key-response"
      ) {
        return;
      }
      if (!data.requestId || !pending[data.requestId]) return;
      const p = pending[data.requestId];
      delete pending[data.requestId];
      clearTimeout(p.timer);
      // never log the result payload — it can carry key-like data
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


  let cachedStatus = null;

  /** Main entry: derived status, cached ~60s; force = re-check now. */
  async function getStatus(force) {
    if (!force && cachedStatus && Date.now() - cachedStatus.at < 60 * 1000) {
      return cachedStatus.status;
    }
    const raw = await fetchStatus();
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
    if (status && status.message) return status.message;
    if (state === "invalid") return `Your license key was rejected. Check it and try again.`;
    if (state === "unreachable") return `Could not reach the license server. If you just activated, wait a moment and reload.`;
    return `Class Navi Pro Tools is a ${PRODUCT.priceLabel} subscription. Activate below to use the marking toolbar, patterns, and level stats.`;
  }

  /** Defensive attribute setter — DOM stubs may not implement setAttribute. */
  function setAttr(el, name, value) {
    try {
      if (el && typeof el.setAttribute === "function") el.setAttribute(name, value);
      else if (el) el[name] = value;
    } catch (e) {
      /* ignore in stubs */
    }
  }

  /** Defensive focus — stubs may not implement focus(). */
  function focusEl(el) {
    try {
      if (el && typeof el.focus === "function") el.focus();
    } catch (e) {
      /* ignore in stubs */
    }
  }

  /** Defensive CSS append — stubs may not implement addEventListener. */
  function addListener(el, type, fn) {
    try {
      if (el && typeof el.addEventListener === "function") el.addEventListener(type, fn);
    } catch (e) {
      /* ignore in stubs */
    }
  }

  /** Shared gate wiring: dialog semantics, focus, error region, focus styles. */

  /**
   * Show (idempotent) the activation card. Returns the gate element or null.
   * The gate is a REQUIRED license gate: Esc must NOT close it.
   */
  function showGate(status) {
    try {
      if (typeof document === "undefined") return null;
      const state = status && status.state;
      let gate = document.getElementById("qs-license-gate");
      if (gate) return gate;
      gate = document.createElement("div");
      gate.id = "qs-license-gate";
      setAttr(gate, "role", "dialog");
      setAttr(gate, "aria-modal", "true");
      setAttr(gate, "aria-labelledby", "qs-license-gate-title");
      setAttr(gate, "tabindex", "-1");
      gate.style.cssText =
        "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:#fff;border:1px solid #2a6df4;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);padding:24px 28px;width:380px;max-width:92vw;font-size:13px;color:#1c3a5e;text-align:center;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;";
      const focusCss =
        "outline:2px solid #2a6df4;outline-offset:2px;"; // visible focus style
      const title = document.createElement("div");
      title.id = "qs-license-gate-title";
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
      input.autocomplete = "off";
      input.style.cssText =
        "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5dd;border-radius:6px;font-size:13px;margin-bottom:10px;text-align:center;" +
        focusCss;
      const err = document.createElement("div");
      setAttr(err, "role", "alert"); // aria-live error region
      setAttr(err, "aria-live", "assertive");
      err.style.cssText = "font-size:11px;color:#c0392b;min-height:14px;margin-bottom:8px;";

      const isSlotLimit = state === "license-limit";
      let ctaNote = null;
      let manage = null;
      let buy = null;
      let portal = null;
      if (isSlotLimit) {
        // dual seat-limit CTAs — ALWAYS both, regardless of server `actions`
        const sCtas = slotCtas();
        manage = document.createElement("a");
        manage.href = PRODUCT.recoveryUrl;
        manage.target = "_blank";
        manage.rel = "noopener";
        manage.textContent = sCtas.manage;
        manage.style.cssText = "display:block;font-size:12px;color:#2a6df4;margin:6px 0;" + focusCss;
        buy = document.createElement("a");
        buy.href = PRODUCT.checkoutUrl;
        buy.target = "_blank";
        buy.rel = "noopener";
        buy.textContent = sCtas.buy;
        buy.style.cssText = "font-size:12px;color:#222;font-weight:600;margin:6px 0;" + focusCss;
        ctaNote = document.createElement("div");
        ctaNote.textContent =
          "A reinstall or browser-profile change may only need a reset (Manage installations). Another computer or browser profile needs another seat.";
        ctaNote.style.cssText = "font-size:11px;line-height:1.5;color:#8aa5b0;margin-bottom:10px;";
      } else {
        buy = document.createElement("a");
        buy.href = PRODUCT.checkoutUrl;
        buy.target = "_blank";
        buy.rel = "noopener";
        buy.textContent = `Buy a license — ${PRODUCT.priceLabel}`;
        buy.style.cssText = "display:block;font-size:12px;color:#2a6df4;margin:6px 0;" + focusCss;
        portal = document.createElement("a");
        portal.href = PRODUCT.portalUrl;
        portal.target = "_blank";
        portal.rel = "noopener";
        portal.textContent = "Manage / restore your subscription";
        portal.style.cssText = "display:block;font-size:11px;color:#8aa5b0;margin-bottom:10px;" + focusCss;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Activate";
      btn.style.cssText =
        "width:100%;padding:9px 0;background:#2a6df4;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:6px;" +
        focusCss;
      const stateLine = document.createElement("div");
      stateLine.textContent = state === "grace" ? "Offline grace active" : state;
      stateLine.style.cssText = "font-size:10px;color:#8aa5b0;text-transform:uppercase;letter-spacing:.4px;";

      addListener(btn, "click", async () => {
        btn.disabled = true;
        btn.textContent = "Checking…";
        const keyText = input.value.trim();
        const res = keyText ? await setKey(keyText) : { ok: true };
        // Activation-time slot-occupied (primary second-device flow): the key
        // was NOT stored, so a status re-read would show "unlicensed" and the
        // gate would lose its seat-limit semantics. Rebuild the gate as
        // license-limit so BOTH dual CTAs render. Clear the old watcher first
        // so it cannot re-run against the removed gate. The key value is never
        // surfaced here — only the boolean key flag plus the blocked reason.
        if (res && res.reason === "slot-occupied") {
          if (gate.__qsWatcher) clearInterval(gate.__qsWatcher);
          gate.remove();
          showGate(
            deriveState(
              {
                key: true,
                blocked: true,
                blockedReason: "slot-occupied",
                blockedMessage: res.message,
              },
              Date.now()
            )
          );
          return;
        }
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
      if (isSlotLimit && ctaNote) gate.appendChild(ctaNote);
      if (isSlotLimit && manage) gate.appendChild(manage);
      if (!isSlotLimit && portal) gate.appendChild(portal);
      gate.appendChild(stateLine);
      document.body.appendChild(gate);
      // focus moves into the blocking gate (cannot be bypassed by Esc)
      focusEl(input);
      // self-healing watcher
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

  /**
   * Active-subscriber billing surface — a management DIALOG (informational,
   * NOT the license gate, so Esc dismisses it). Renders the four actions.
   * Returns the surface element or null.
   */
  function showBillingSurface() {
    try {
      if (typeof document === "undefined") return null;
      let surf = document.getElementById("qs-billing-surface");
      if (surf) return surf;
      surf = document.createElement("div");
      surf.id = "qs-billing-surface";
      setAttr(surf, "role", "dialog");
      setAttr(surf, "aria-modal", "true");
      setAttr(surf, "aria-labelledby", "qs-billing-surface-title");
      setAttr(surf, "tabindex", "-1");
      surf.style.cssText =
        "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999998;background:#fff;border:1px solid #d0d7de;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);padding:22px 26px;width:340px;max-width:92vw;font-size:13px;color:#1c3a5e;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;";
      const focusCss = "outline:2px solid #2a6df4;outline-offset:2px;";
      const title = document.createElement("div");
      title.id = "qs-billing-surface-title";
      title.textContent = "License & billing";
      title.style.cssText = "font-size:17px;font-weight:700;margin-bottom:12px;";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.style.cssText =
        "position:absolute;top:10px;right:12px;background:none;border:none;color:#2a6df4;font-size:12px;cursor:pointer;" +
        focusCss;
      const list = document.createElement("div");
      list.style.cssText = "display:flex;flex-direction:column;gap:10px;margin-top:6px;";
      for (const link of billingLinks()) {
        const a = document.createElement("a");
        a.href = link.href;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = link.label;
        a.style.cssText = "display:block;color:#2a6df4;font-size:13px;text-decoration:none;" + focusCss;
        list.appendChild(a);
      }
      const period = document.createElement("div");
      period.textContent = "Active";
      period.style.cssText = "font-size:10px;color:#8aa5b0;text-transform:uppercase;letter-spacing:.4px;margin-top:12px;";
      const onEsc = (e) => {
        if (e.key === "Escape" || e.key === "Esc") {
          document.removeEventListener("keydown", onEsc);
          surf.remove();
        }
      };
      addListener(document, "keydown", onEsc);
      addListener(close, "click", () => {
        document.removeEventListener("keydown", onEsc);
        surf.remove();
      });
      surf.appendChild(title);
      surf.appendChild(close);
      surf.appendChild(list);
      surf.appendChild(period);
      setAttr(surf, "aria-label", "License and billing");
      document.body.appendChild(surf);
      focusEl(close);
      return surf;
    } catch (e) {
      return null;
    }
  }

  /**
   * Unobtrusive control attached to EXISTING app UI (the header stats band) —
   * NOT a floating persistent panel. Clicking it opens the billing surface.
   */
  function attachAppUiControl() {
    try {
      if (typeof document === "undefined") return null;
      let ctrl = document.getElementById("qs-license-billing-control");
      if (ctrl) return ctrl;
      ctrl = document.createElement("a");
      ctrl.id = "qs-license-billing-control";
      ctrl.href = "#";
      ctrl.textContent = "License & billing";
      ctrl.title = "Manage subscription, recovery, and installations";
      const focusCss = "outline:2px solid #2a6df4;outline-offset:2px;";
      ctrl.style.cssText =
        "display:inline-block;margin-left:8px;font-size:11px;color:#2a6df4;text-decoration:none;cursor:pointer;vertical-align:middle;" +
        focusCss;
      addListener(ctrl, "click", (e) => {
        if (e && e.preventDefault) e.preventDefault();
        showBillingSurface();
      });
      addListener(ctrl, "keydown", (e) => {
        if (e && (e.key === "Enter" || e.key === " ")) {
          if (e.preventDefault) e.preventDefault();
          showBillingSurface();
        }
      });
      let container = null;
      try {
        const anchor = document.getElementById("qs-aggregate") || document.querySelector(".progress-model-select-selected-view");
        if (anchor && anchor.parentElement) container = anchor.parentElement;
      } catch (e) {
        container = null;
      }
      // ANCHOR-ONLY: never fall back to document.body. A billing control
      // floating detached from the app UI is forbidden — if no existing app
      // header anchor is present, append nothing and return null.
      if (!container || typeof container.appendChild !== "function") return null;
      container.appendChild(ctrl);
      return ctrl;
    } catch (e) {
      return null;
    }
  }

  return {
    PRODUCT,
    BROWSER_FAMILY,
    BROWSER_FAMILIES,
    CHECKOUT_URL,
    PORTAL_URL,
    RECOVERY_URL,
    PRICE_LABEL: PRODUCT.priceLabel,
    GRACE_MS,
    buildRequest,
    mapReason,
    deriveState,
    graceDays,
    fmtDate,
    periodEndCopy,
    slotCtas,
    billingLinks,
    getStatus,
    setKey,

    isActive,
    showGate,
    hideGate,
    showBillingSurface,
    attachAppUiControl,
  };
})();
