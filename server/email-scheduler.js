// server/email-scheduler.js — Slice 2B: import-safe scheduler around deliverNext.
//
// `createEmailScheduler(...)` wraps the bounded single-row email worker
// (`createEmailWorker(...).deliverNext`) with a polling loop and exposes
// {start, stop, tick, health, isRunning}. Importing the module installs NO
// timers; scheduling is explicit and idempotent. Every log line is fully
// redacted (fixed text + status/number sentinels) — no recipient, license key,
// payload, or provider error bodies are ever logged.
export function createEmailScheduler({
  deliverNext,
  queueHealth = () => ({}),
  intervalMs = 5000,
  drainMax = 20,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  // Validate injected collaborators + tunables eagerly so a bad config fails
  // at construction (when callers still see the stack), not on the first tick.
  if (typeof deliverNext !== "function") {
    throw new TypeError("createEmailScheduler: deliverNext must be a function");
  }
  if (typeof queueHealth !== "function") {
    throw new TypeError("createEmailScheduler: queueHealth must be a function");
  }
  if (typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") {
    throw new TypeError("createEmailScheduler: setIntervalFn/clearIntervalFn must be functions");
  }
  if (typeof now !== "function") {
    throw new TypeError("createEmailScheduler: now must be a function");
  }
  if (!(Number.isInteger(intervalMs) && intervalMs > 0)) {
    throw new RangeError("createEmailScheduler: intervalMs must be a positive integer");
  }
  if (!(Number.isInteger(drainMax) && drainMax > 0)) {
    throw new RangeError("createEmailScheduler: drainMax must be a positive integer");
  }

  let timer = null;
  let running = false;
  // Monotonic generation counter. Bumped on every start()/stop() boundary so a
  // queued-microtask immediate tick can detect that it has been orphaned by a
  // stop() and bail out before calling deliverNext. The counter is the
  // authoritative liveness signal for the immediate tick because `running`
  // alone races with the queueMicrotask callback running on the same tick.
  let generation = 0;
  let inFlight = false;
  let inFlightDone = null; // resolves when current tick settles (for stop())
  let lastTickAt = null;
  let lastTickState = "idle";
  // Tracks consecutive health() failures so /health keeps responding even if
  // the queueHealth delegate throws.
  let healthErrors = 0;

  // Safe aggregate merge: shallow-clone the queue snapshot, overlay the runtime
  // fields, and never rethrow. JSON-safe means every value is a primitive,
  // array, or plain object — no functions, Dates, or Buffers leak out.
  function readHealth() {
    let queue = {};
    try {
      const raw = queueHealth();
      if (raw && typeof raw === "object") queue = { ...raw };
    } catch {
      healthErrors += 1;
    }
    return {
      ...queue,
      enabled: running,
      running,
      inFlight,
      lastTickState,
      lastTickAt,
      intervalMs,
      drainMax,
      healthErrors,
    };
  }

  // One pass over the queue: deliver up to `drainMax` rows and continue while
  // each tick returns a state that says "still work to do". Idle / daily-cap /
  // stale are terminal — stop the pass and wait for the next interval.
  async function runDrain() {
    for (let i = 0; i < drainMax; i += 1) {
      let result;
      try {
        result = await deliverNext();
      } catch (err) {
        // Fixed redacted line. The error object itself is NEVER logged, only a
        // bounded status marker so we know a tick crashed without leaking
        // payloads, recipients, or provider bodies.
        const kind = err && err.fatal === true ? "fatal" : "transient";
        logger.error(`[email-scheduler] tick threw (${kind})`);
        lastTickAt = now();
        lastTickState = kind === "fatal" ? "fatal" : "transient";
        // Recoverable: leave the scheduler armed so the next interval can try
        // again. stop() still works because running is set false there.
        return;
      }
      lastTickAt = now();
      const state = (result && result.state) || "unknown";
      lastTickState = state;
      if (
        state === "sent" ||
        state === "retry" ||
        state === "dead" ||
        state === "suppressed"
      ) {
        // Row advanced — try again within the same drain pass.
        continue;
      }
      // idle / daily-cap / stale / unknown — nothing more to do this drain.
      return;
    }
  }

  async function tick() {
    if (inFlight) {
      // Single-flight guard. Return a redacted "busy" sentinel rather than
      // throwing — callers can choose to ignore it without crashing.
      return { state: "busy", sent: false };
    }
    inFlight = true;
    inFlightDone = new Promise((resolve) => {
      const done = () => {
        inFlight = false;
        inFlightDone = null;
        resolve();
      };
      // runDrain always settles on its own (it catches + returns on throw).
      runDrain().then(done, done);
    });
    await inFlightDone;
    return { state: lastTickState, sent: false };
  }

  function start() {
    if (running) return; // idempotent — repeat start() never doubles up.
    running = true;
    generation += 1;
    const startGeneration = generation;
    timer = setIntervalFn(() => {
      // The interval callback only fires while the timer is installed; stop()
      // clears the timer before bumping generation, so this branch is
      // naturally guarded. The generation check is belt-and-braces.
      if (!running || generation !== startGeneration) return;
      // Fire and forget. tick() resolves only after the drain settles, and the
      // interval itself is the steady heartbeat; overlapping ticks are guarded
      // by the single-flight check inside tick().
      tick().catch(() => {});
    }, intervalMs);
    // unref() if Node/Bun exposes it, so the timer never keeps the event loop
    // alive on its own. Best-effort; if unref isn't supported, that's fine —
    // explicit stop() still clears it.
    if (timer && typeof timer.unref === "function") {
      try {
        timer.unref();
      } catch {
        /* ignore — unref is best-effort */
      }
    }
    // Fire one immediate async tick so a freshly started scheduler doesn't
    // wait `intervalMs` for its first delivery attempt. Errors here are
    // swallowed the same way interval ticks are.
    //
    // Capture the generation so that if stop() runs before this microtask
    // settles, the tick is aborted before deliverNext is ever called. This is
    // the only safe way to guarantee "no delivery may begin after stop()
    // resolves" because the microtask is queued before stop() can possibly
    // observe or cancel it.
    const immediateGeneration = generation;
    queueMicrotask(() => {
      if (!running || generation !== immediateGeneration) return;
      tick().catch(() => {});
    });
  }

  async function stop() {
    running = false;
    // Bump generation FIRST so any pending queueMicrotask immediate tick (and
    // any racing interval callback) sees the invalidation before it gets a
    // chance to call deliverNext. Combined with the running check inside the
    // queued callback, this is what makes "start(); stop(); flush => no
    // delivery" hold.
    generation += 1;
    if (timer !== null) {
      try {
        clearIntervalFn(timer);
      } catch {
        /* ignore — clearing is best-effort */
      }
      timer = null;
    }
    // Await any in-flight drain so callers can rely on a quiet post-condition
    // when the returned promise resolves.
    if (inFlightDone) {
      try {
        await inFlightDone;
      } catch {
        /* drain already swallows; nothing to do */
      }
    }
  }

  function health() {
    try {
      return readHealth();
    } catch {
      // Belt-and-braces: readHealth already catches queueHealth, but the merge
      // itself must never throw to /health consumers.
      healthErrors += 1;
      return {
        enabled: running,
        running,
        inFlight,
        lastTickState,
        lastTickAt,
        intervalMs,
        drainMax,
        healthErrors,
      };
    }
  }

  function isRunning() {
    return running;
  }

  return { start, stop, tick, health, isRunning };
}
