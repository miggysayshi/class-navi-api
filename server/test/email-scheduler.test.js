// server/test/email-scheduler.test.js — Slice 2B: scheduler around deliverNext.
// Pure unit tests: no DB, no network, no real keys. Fakes timer + deliverNext.
// Strict RED-first behavior assertions + redaction sentinel guard.
import { test, expect, describe } from "bun:test";
import { createEmailScheduler } from "../email-scheduler.js";

// ── fakes ────────────────────────────────────────────────────────────────────

// Manual clock so we never depend on wall time; defaults to 0 so any value is
// deterministic.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// Fake interval registry. Each `schedule` is an opaque handle the test can
// fire on demand. Mirrors Node's setInterval enough for the scheduler: a
// handle with `.unref()` and a `clearIntervalFn` that removes the entry.
function makeFakeInterval() {
  const handles = new Set();
  const setIntervalFn = (cb, ms) => {
    const handle = { cb, ms, fired: 0, unrefed: false };
    handle.unref = () => {
      handle.unrefed = true;
    };
    handles.add(handle);
    return handle;
  };
  const clearIntervalFn = (handle) => {
    handles.delete(handle);
  };
  return {
    setIntervalFn,
    clearIntervalFn,
    handles,
    fire: (handle) => {
      handle.fired += 1;
      // Mimic real setInterval: callback runs async. Return the promise so
      // tests can `await` to let microtasks settle.
      return Promise.resolve().then(() => handle.cb());
    },
  };
}

// Capturing logger. Each call records the full message so a redaction test can
// scan every line for leaked secrets.
function makeLogger() {
  const lines = [];
  return {
    info: (msg) => lines.push(["info", msg]),
    warn: (msg) => lines.push(["warn", msg]),
    error: (msg) => lines.push(["error", msg]),
    log: (msg) => lines.push(["log", msg]),
    lines,
    joined: () => lines.map(([, m]) => m).join("\n"),
  };
}

// deferred() — returns a Promise + its resolve/reject so a test can interleave
// the deliverNext fake with assertions on overlap, in-flight, etc.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush microtasks until empty so the scheduler's queueMicrotask immediate
// tick + drain settles deterministically.
async function flushMicrotasks(rounds = 25) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("createEmailScheduler — shape + import safety", () => {
  test("returns the documented API surface", () => {
    const sched = createEmailScheduler({ deliverNext: () => ({}) });
    expect(typeof sched.start).toBe("function");
    expect(typeof sched.stop).toBe("function");
    expect(typeof sched.tick).toBe("function");
    expect(typeof sched.health).toBe("function");
    expect(typeof sched.isRunning).toBe("function");
    expect(sched.isRunning()).toBe(false);
  });

  test("importing / constructing never starts a timer (no side effects)", () => {
    const fake = makeFakeInterval();
    const sched = createEmailScheduler({
      deliverNext: () => ({ state: "idle", sent: false }),
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    expect(fake.handles.size).toBe(0);
    expect(sched.isRunning()).toBe(false);
    // tick is callable explicitly; still no timer installed.
    sched.tick();
    expect(fake.handles.size).toBe(0);
  });

  test("rejects missing deliverNext / non-positive tunables", () => {
    expect(() => createEmailScheduler()).toThrow(TypeError);
    expect(() => createEmailScheduler({ deliverNext: "nope" })).toThrow(TypeError);
    expect(() => createEmailScheduler({ deliverNext: () => ({}), intervalMs: 0 })).toThrow(
      RangeError
    );
    expect(() => createEmailScheduler({ deliverNext: () => ({}), intervalMs: -1 })).toThrow(
      RangeError
    );
    expect(() =>
      createEmailScheduler({ deliverNext: () => ({}), drainMax: 0 })
    ).toThrow(RangeError);
  });

  test("rejects non-integer tunables and non-function now", () => {
    // Non-integer tunables must throw RangeError.
    expect(() =>
      createEmailScheduler({ deliverNext: () => ({}), intervalMs: 1.5 })
    ).toThrow(RangeError);
    expect(() =>
      createEmailScheduler({ deliverNext: () => ({}), intervalMs: NaN })
    ).toThrow(RangeError);
    expect(() =>
      createEmailScheduler({ deliverNext: () => ({}), drainMax: 1.5 })
    ).toThrow(RangeError);
    expect(() =>
      createEmailScheduler({ deliverNext: () => ({}), drainMax: Infinity })
    ).toThrow(RangeError);
    // Integers (including falsy values like 0) must throw.
    expect(() =>
      createEmailScheduler({ deliverNext: () => ({}), drainMax: 3.7 })
    ).toThrow(RangeError);
    // now must be a function.
    expect(() =>
      createEmailScheduler({ deliverNext: () => ({}), now: 123 })
    ).toThrow(TypeError);
    expect(() =>
      createEmailScheduler({ deliverNext: () => ({}), now: null })
    ).toThrow(TypeError);
  });
});

describe("createEmailScheduler — start / stop / interval", () => {
  test("start installs exactly one interval and unrefs it", async () => {
    const fake = makeFakeInterval();
    const sched = createEmailScheduler({
      deliverNext: () => ({ state: "idle", sent: false }),
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    sched.start();
    expect(sched.isRunning()).toBe(true);
    expect(fake.handles.size).toBe(1);
    const handle = [...fake.handles][0];
    expect(handle.unrefed).toBe(true);
    await sched.stop();
    expect(fake.handles.size).toBe(0);
    expect(sched.isRunning()).toBe(false);
  });

  test("start is idempotent — second start does not install a second interval", async () => {
    const fake = makeFakeInterval();
    const sched = createEmailScheduler({
      deliverNext: () => ({ state: "idle", sent: false }),
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    sched.start();
    sched.start();
    sched.start();
    expect(fake.handles.size).toBe(1);
    await sched.stop();
  });

  test("fires one immediate async tick on start, then keeps firing on interval", async () => {
    const fake = makeFakeInterval();
    let calls = 0;
    const sched = createEmailScheduler({
      deliverNext: async () => {
        calls += 1;
        return { state: "idle", sent: false };
      },
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    sched.start();
    // Wait for the queueMicrotask immediate tick to land.
    await flushMicrotasks();
    expect(calls).toBeGreaterThanOrEqual(1);
    const afterImmediate = calls;
    const handle = [...fake.handles][0];
    await fake.fire(handle);
    await flushMicrotasks();
    expect(calls).toBeGreaterThan(afterImmediate);
    await sched.stop();
  });

  test("stop clears the timer and awaits in-flight drain", async () => {
    const fake = makeFakeInterval();
    const d = deferred();
    const sched = createEmailScheduler({
      deliverNext: () => d.promise,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    sched.start();
    await flushMicrotasks();
    expect(sched.isRunning()).toBe(true);
    const stopPromise = sched.stop();
    // stop() must NOT resolve while a tick is in flight.
    let settled = false;
    stopPromise.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    // Resolve the in-flight deliver; stop() should now settle.
    d.resolve({ state: "sent", sent: true });
    await stopPromise;
    expect(settled).toBe(true);
    expect(sched.isRunning()).toBe(false);
    expect(fake.handles.size).toBe(0);
  });

  test("start(); await stop(); flush microtasks => queued immediate tick is aborted, zero deliverNext calls", async () => {
    const fake = makeFakeInterval();
    let calls = 0;
    const sched = createEmailScheduler({
      deliverNext: async () => {
        calls += 1;
        return { state: "sent", sent: true };
      },
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    sched.start();
    // Schedule stop synchronously (before the queueMicrotask fires). This is
    // the exact race the spec calls out: start() queues a microtask tick, then
    // stop() runs before that microtask gets to run.
    const stopPromise = sched.stop();
    // Flush generously so any leaked microtask would have run by now.
    await flushMicrotasks();
    await stopPromise;
    await flushMicrotasks();
    expect(calls).toBe(0);
    expect(sched.isRunning()).toBe(false);
    expect(fake.handles.size).toBe(0);
  });

  test("manual tick() while stopped still works (only the queued start tick is suppressed)", async () => {
    let calls = 0;
    const sched = createEmailScheduler({
      deliverNext: async () => {
        calls += 1;
        return { state: "idle", sent: false };
      },
    });
    // Manual tick before start should still execute deliverNext — that path is
    // outside the start/stop lifecycle and remains available.
    await sched.tick();
    expect(calls).toBe(1);
    // start(); await stop() — queued immediate tick must be aborted.
    sched.start();
    await sched.stop();
    await flushMicrotasks();
    expect(calls).toBe(1);
    // A manual tick after stop is still allowed by the API.
    await sched.tick();
    expect(calls).toBe(2);
  });
});

describe("createEmailScheduler — tick semantics", () => {
  test("tick is single-flight — overlap returns busy and does not double deliver", async () => {
    const d = deferred();
    let calls = 0;
    const sched = createEmailScheduler({
      // First call: pending (lets us hold the in-flight state).
      // Second call: idle (terminates the drain cleanly).
      deliverNext: () => {
        calls += 1;
        if (calls === 1) return d.promise;
        return Promise.resolve({ state: "idle", sent: false });
      },
    });
    const first = sched.tick();
    const second = sched.tick();
    // Second tick resolves synchronously-ish with busy, without invoking deliver again.
    const secondResult = await second;
    expect(secondResult.state).toBe("busy");
    // While the first tick is in flight, no second deliverNext has been called.
    expect(calls).toBe(1);
    // Now resolve the first deliver so the drain advances, then idles out.
    d.resolve({ state: "sent", sent: true });
    await first;
    // Exactly one extra deliver (the terminator). Total = 2.
    expect(calls).toBe(2);
  });

  test("bounded drain: continues while rows advance, stops on idle", async () => {
    const states = ["sent", "retry", "dead", "suppressed", "idle"];
    let i = 0;
    const sched = createEmailScheduler({
      deliverNext: async () => {
        const state = states[i] || "idle";
        i += 1;
        return { state, sent: state === "sent" };
      },
      drainMax: 10,
    });
    await sched.tick();
    // 4 advancing rows + 1 idle terminator = 5 deliverNext calls.
    expect(i).toBe(5);
    expect(sched.health().lastTickState).toBe("idle");
  });

  test("bounded drain stops once drainMax is reached, even if more rows are pending", async () => {
    let i = 0;
    const sched = createEmailScheduler({
      deliverNext: async () => {
        i += 1;
        return { state: "sent", sent: true };
      },
      drainMax: 3,
    });
    await sched.tick();
    expect(i).toBe(3);
  });

  test("terminal stop conditions: daily-cap and stale end the drain pass", async () => {
    for (const terminal of ["daily-cap", "stale"]) {
      let i = 0;
      const sched = createEmailScheduler({
        deliverNext: async () => {
          i += 1;
          // One advancing row, then the terminal state.
          if (i === 1) return { state: "sent", sent: true };
          return { state: terminal, sent: false };
        },
      });
      await sched.tick();
      expect(i).toBe(2);
      expect(sched.health().lastTickState).toBe(terminal);
    }
  });

  test("thrown deliverNext is caught, logged redacted, and recovered on next tick", async () => {
    const logger = makeLogger();
    const sched = createEmailScheduler({
      deliverNext: async () => {
        throw new Error("SECRET recipient=user@example.com provider_body=oops");
      },
      logger,
    });
    // Must not throw out of tick().
    await sched.tick();
    expect(sched.health().lastTickState).toBe("transient");
    // Recovery: a fresh tick after the throw still attempts a delivery.
    let recovered = 0;
    const sched2 = createEmailScheduler({
      deliverNext: async () => {
        recovered += 1;
        if (recovered === 1) throw new Error("boom");
        return { state: "idle", sent: false };
      },
      logger,
    });
    await sched2.tick();
    await sched2.tick();
    expect(recovered).toBe(2);

    // Redaction: scan every log line for the secret payload / recipient.
    const joined = logger.joined();
    expect(joined).not.toContain("user@example.com");
    expect(joined).not.toContain("provider_body=oops");
    expect(joined).not.toContain("boom");
    expect(joined).toContain("[email-scheduler]");
    expect(joined).toContain("transient");
  });
});

describe("createEmailScheduler — health", () => {
  test("health is JSON-safe and merges runtime + queue aggregates", () => {
    const sched = createEmailScheduler({
      deliverNext: () => ({ state: "idle", sent: false }),
      queueHealth: () => ({ pending: 3, dailySent: 12, dead: 1 }),
    });
    const h = sched.health();
    expect(h.enabled).toBe(false);
    expect(h.running).toBe(false);
    expect(h.inFlight).toBe(false);
    expect(h.lastTickState).toBe("idle");
    expect(h.lastTickAt).toBeNull();
    expect(h.intervalMs).toBe(5000);
    expect(h.drainMax).toBe(20);
    expect(h.pending).toBe(3);
    expect(h.dailySent).toBe(12);
    expect(h.dead).toBe(1);
    expect(h.healthErrors).toBe(0);
    // JSON-safety: round-trip via JSON without throwing.
    const round = JSON.parse(JSON.stringify(h));
    expect(round.enabled).toBe(false);
  });

  test("health never throws even when queueHealth throws", () => {
    const sched = createEmailScheduler({
      deliverNext: () => ({ state: "idle", sent: false }),
      queueHealth: () => {
        throw new Error("queue is on fire");
      },
    });
    let h;
    expect(() => {
      h = sched.health();
    }).not.toThrow();
    expect(h.healthErrors).toBe(1);
    expect(h.enabled).toBe(false);
    // Each subsequent call increments the bounded error counter.
    sched.health();
    expect(sched.health().healthErrors).toBe(3);
  });

  test("health reflects live runtime state after a tick", async () => {
    const clock = makeClock(1_000);
    const sched = createEmailScheduler({
      deliverNext: async () => ({ state: "sent", sent: true }),
      now: clock.now,
    });
    await sched.tick();
    const h = sched.health();
    expect(h.lastTickState).toBe("sent");
    expect(h.lastTickAt).toBe(1_000);
    expect(h.inFlight).toBe(false);
  });

  test("queueHealth fields must NOT override authoritative runtime fields", () => {
    // Even if queueHealth returns bogus / hostile values for the reserved
    // runtime keys, health() must keep the scheduler's authoritative values.
    const sched = createEmailScheduler({
      deliverNext: () => ({ state: "idle", sent: false }),
      queueHealth: () => ({
        enabled: "WRONG",
        running: "WRONG",
        inFlight: "WRONG",
        lastTickState: "WRONG",
        lastTickAt: "WRONG",
        intervalMs: "WRONG",
        drainMax: "WRONG",
        healthErrors: "WRONG",
        // These should pass through as they are not reserved.
        pending: 7,
        dead: 2,
      }),
      intervalMs: 5000,
      drainMax: 20,
    });
    const h = sched.health();
    expect(h.enabled).toBe(false);
    expect(h.running).toBe(false);
    expect(h.inFlight).toBe(false);
    expect(h.lastTickState).toBe("idle");
    expect(h.lastTickAt).toBeNull();
    expect(h.intervalMs).toBe(5000);
    expect(h.drainMax).toBe(20);
    expect(h.healthErrors).toBe(0);
    // Non-reserved queue fields still pass through.
    expect(h.pending).toBe(7);
    expect(h.dead).toBe(2);
  });
});
