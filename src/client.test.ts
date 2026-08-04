/**
 * Client logic tests with a stubbed fetch — no live Class-Navi needed.
 * Run: bun test
 */

import { test, expect, mock } from "bun:test";

import { ClassNaviClient, unwrap, ApiError, ErrorReason } from "./client";
import { TokenManager } from "./auth";

const fakeConfig = {
  username: "u",
  password: "p",
  apiUrl: "https://fake/api",
  tokenUrl: "https://fake/token",
  requestTimeoutMs: 5000,
};

/** TokenManager whose ensureFresh() does nothing (already "logged in"). */
function authedAuth(): TokenManager {
  const auth = new TokenManager(fakeConfig);
  // @ts-expect-error reach into privates for the test
  auth.accessToken = "tok";
  // @ts-expect-error reach into privates for the test
  auth.xUserID = "u";
  // @ts-expect-error reach into privates for the test
  auth.expiresAtInternal = new Date(Date.now() + 60_000);
  // @ts-expect-error reach into privates for the test
  auth.refreshToken = "rt";
  return auth;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  // @ts-expect-error test-only global swap
  globalThis.fetch = mock(handler);
}

test("call() builds the right URL, headers, body, and unwraps Result", async () => {
  const seen: { value: { url: string; headers: Record<string, string>; body: string } | null } =
    { value: null };
  stubFetch(async (url, init) => {
    seen.value = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
    return new Response(
      JSON.stringify({ ID: "7", Result: { ResultCode: 0, StudentName: "Aiko" } }),
      { status: 200 },
    );
  });

  const client = new ClassNaviClient(fakeConfig, authedAuth());
  const res = await client.call<{ ResultCode: number; StudentName: string }>(
    "GetStudentStatus",
    { StudentID: "42" },
  );

  expect(seen.value?.url).toBe("https://fake/api/GetStudentStatus/1");
  expect(seen.value?.headers["Authorization"]).toBe("Bearer tok");
  expect(seen.value?.headers["X-User-ID"]).toBe("u");
  expect(seen.value?.headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(seen.value?.body ?? "{}")).toEqual({ StudentID: "42" });
  expect(unwrap(res)).toEqual({ ResultCode: 0, StudentName: "Aiko" });
});

test("request id increments across calls", async () => {
  const urls: string[] = [];
  stubFetch(async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ ID: "x", Result: { ResultCode: 0 } }), { status: 200 });
  });

  const client = new ClassNaviClient(fakeConfig, authedAuth());
  await client.call("GetAnnounce");
  await client.call("GetAnnounce");
  expect(urls).toEqual([
    "https://fake/api/GetAnnounce/1",
    "https://fake/api/GetAnnounce/2",
  ]);
});

test("non-zero ResultCode throws via unwrap()", async () => {
  stubFetch(async () =>
    new Response(JSON.stringify({ ID: "x", Result: { ResultCode: 1, Message: "nope" } }), { status: 200 }),
  );

  const client = new ClassNaviClient(fakeConfig, authedAuth());
  const res = await client.call("GetAnnounce");
  expect(() => unwrap(res)).toThrow(ApiError);
});

test("HTTP 401 maps to Interrupted reason", async () => {
  stubFetch(async () => new Response("", { status: 401 }));

  const client = new ClassNaviClient(fakeConfig, authedAuth());
  await expect(client.call("GetAnnounce")).rejects.toMatchObject({
    reason: ErrorReason.Interrupted,
    status: 401,
  });
});

test("base64 fields round-trip: CsvFile string -> Uint8Array on parse", async () => {
  const csv = Buffer.from("a,b,c\n1,2,3").toString("base64");
  stubFetch(async () =>
    new Response(JSON.stringify({ ID: "x", Result: { ResultCode: 0, CsvFile: csv } }), { status: 200 }),
  );

  const client = new ClassNaviClient(fakeConfig, authedAuth());
  const res = await client.call<{ ResultCode: number; CsvFile: unknown }>("CsvOutput");
  const result = unwrap(res);
  expect(result.CsvFile).toBeInstanceOf(Uint8Array);
  expect(Buffer.from(result.CsvFile as Uint8Array).toString()).toBe("a,b,c\n1,2,3");
});

test("calls are serialized (one in-flight at a time)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  stubFetch(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Bun.sleep(20);
    inFlight--;
    return new Response(JSON.stringify({ ID: "x", Result: { ResultCode: 0 } }), { status: 200 });
  });

  const client = new ClassNaviClient(fakeConfig, authedAuth());
  await Promise.all([
    client.call("GetAnnounce"),
    client.call("GetAnnounce"),
    client.call("GetAnnounce"),
  ]);
  expect(maxInFlight).toBe(1);
});
