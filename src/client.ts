/**
 * Class-Navi RPC client, faithful to the Angular app's `callInner`:
 *
 *  POST {apiUrl}/{Method}/{requestId}   (requestId = client-side counter)
 *  headers: Content-Type/Accept: application/json, Authorization: Bearer,
 *           X-User-ID
 *  response: { ID: string, Result: { ResultCode: number, ... } }
 *  resolve when `Result` present; HTTP status maps to typed reasons.
 *
 * Deviations (deliberate, for a library):
 *  - the app rejects with ClientBusy when a call overlaps the previous one;
 *    here calls are serialized through a queue instead.
 *  - base64 fields (InkData, RedComment, SoundRecord, CsvFile, ...) are
 *    decoded to Uint8Array on parse and re-encoded on stringify, matching the
 *    services' stringifyReplaceSetting / parseReviverSetting.
 */

import type { ClassNaviConfig } from "./config";
import { TokenManager } from "./auth";
import { METHODS_BY_NAME } from "./methods";

/** Error reasons observed in the bundle's error enum. */
export const ErrorReason = {
  Communication: "Communication",
  Interrupted: "Interrupted",
  Server: "Server",
  ServiceUnavailable: "ServiceUnavailable",
  Conflict: "Conflict",
  Timeout: "Timeout",
  NotLogin: "NotLogin",
  TokenExpired: "TokenExpired",
  ClientBusy: "ClientBusy",
  ServerApp: "ServerApp",
  Authenticate: "Authenticate",
} as const;
export type ErrorReason = (typeof ErrorReason)[keyof typeof ErrorReason];

export class ApiError extends Error {
  constructor(
    public readonly reason: ErrorReason,
    public readonly status?: number,
    public readonly payload?: unknown,
  ) {
    super(`Class-Navi API error: ${reason}${status ? ` (HTTP ${status})` : ""}`);
  }
}

/** Raw response envelope as returned by the server. */
export interface ApiResponse<TResult = unknown> {
  ID: string;
  Result: TResult & { ResultCode: number };
}

/** Fields the server base64-encodes; decoded to Uint8Array on parse. */
const BASE64_FIELDS = new Set([
  "InkData",
  "GradingResultData",
  "RedComment",
  "TagComment",
  "SoundComment",
  "SoundRecord",
  "CsvFile",
]);

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Match the app's stringifyReplaceSetting: byte arrays → base64 strings. */
function stringifyReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return toBase64(value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  return value;
}

/** Match the app's parseReviverSetting: known base64 fields → Uint8Array. */
function parseReviver(key: string, value: unknown): unknown {
  if (typeof value === "string" && BASE64_FIELDS.has(key)) {
    try {
      return fromBase64(value);
    } catch {
      return value;
    }
  }
  return value;
}

function mapHttpError(status: number): ErrorReason {
  switch (status) {
    case 0:
    case 400:
      return ErrorReason.Communication;
    case 401:
      return ErrorReason.Interrupted;
    case 403:
    case 500:
      return ErrorReason.Server;
    case 503:
      return ErrorReason.ServiceUnavailable;
    case 409:
      return ErrorReason.Conflict;
    default:
      return status ? ErrorReason.Communication : ErrorReason.Timeout;
  }
}

export class ClassNaviClient {
  private requestId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: ClassNaviConfig,
    private readonly auth: TokenManager,
  ) {}

  /**
   * Call one RPC method. Serialized behind other in-flight calls (the app
   * allows a single in-flight request per client). Resolves with the raw
   * envelope — use `unwrap()` for the Result payload.
   *
   * Wire format (verified against real browser traffic):
   *   URL:  {apiUrl}/{screenId}/{method}
   *   Body: {...params, id: "<counter>", client: {applicationName, version,
   *         programName, os, machineName}}
   */
  call<TResult = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<ApiResponse<TResult>> {
    const spec = METHODS_BY_NAME.get(method);
    if (!spec) {
      throw new ApiError(
        ErrorReason.Communication,
        undefined,
        new Error(`Unknown method '${method}' — no screen ID in registry`),
      );
    }
    const run = async (): Promise<ApiResponse<TResult>> => {
      await this.auth.ensureFresh();
      const url = `${this.config.apiUrl}/${spec.screenId}/${method}`;
      const body = JSON.stringify(
        {
          ...params,
          id: String(this.requestId++),
          client: {
            applicationName: "Class-Navi",
            version: "1.0.0.0",
            programName: "Class-Navi",
            os: `Bun/${typeof Bun !== "undefined" ? Bun.version : "runtime"}`,
            machineName: "-",
          },
        },
        stringifyReplacer,
      );
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...this.auth.authHeaders(),
          },
          body,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new ApiError(ErrorReason.Timeout);
        }
        throw new ApiError(ErrorReason.Communication, 0, err);
      }
      if (!res.ok) throw new ApiError(mapHttpError(res.status), res.status);
      const envelope = JSON.parse(await res.text(), parseReviver) as ApiResponse<TResult>;
      if (!envelope || typeof envelope.Result !== "object") {
        throw new ApiError(ErrorReason.ServerApp, res.status, envelope);
      }
      return envelope;
    };
    // serialize through the queue, keep the chain alive even on failure
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** Throw if ResultCode != 0 (SUCCESS); otherwise return the Result payload. */
export function unwrap<TResult>(response: ApiResponse<TResult>): TResult {
  if (response.Result.ResultCode !== 0) {
    throw new ApiError(ErrorReason.ServerApp, undefined, response.Result);
  }
  return response.Result;
}

/** One-shot helper: build a client + token manager from the environment. */
export async function createClient(config: ClassNaviConfig): Promise<{
  client: ClassNaviClient;
  auth: TokenManager;
}> {
  const auth = new TokenManager(config);
  await auth.login();
  return { client: new ClassNaviClient(config, auth), auth };
}
