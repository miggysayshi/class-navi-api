# class-navi-api

Typed API client + MCP server for **Kumon Class-Navi**, reverse-engineered from
the app's JS bundle. No official API — this speaks the same RPC protocol the
Angular SPA uses.

## How it works

| Piece | Detail |
|---|---|
| Auth | OAuth2 password grant → `POST {tokenUrl}` with `grant_type=password`, password pre-hashed `base64(sha256(sha256(pw) + username))`; auto-refresh via `grant_type=refresh_token` 30s before expiry |
| API call | `POST {apiUrl}/{Method}/{requestId}` — `requestId` is a client counter (starts at 1, like the app) |
| Headers | `Content-Type: application/json`, `Accept: application/json`, `Authorization: Bearer <token>`, `X-User-ID: <userName>` |
| Response | `{ ID, Result: { ResultCode, ... } }` — `ResultCode 0` = success; `unwrap()` throws otherwise |
| Errors | HTTP status → typed reasons: 401 → `Interrupted`, 403/500 → `Server`, 503 → `ServiceUnavailable`, 409 → `Conflict`, timeout → `Timeout` |
| Concurrency | Calls serialize through a queue (the web app allows one in-flight request per client) |
| Binary fields | `InkData`, `RedComment`, `SoundRecord`, `CsvFile`, … arrive base64 — decoded to `Uint8Array` on parse, re-encoded on send |

~68 RPC methods are registered (students, study results, messages, class notes,
goals, scoring, CSV export). See `src/methods.ts` for the full list with screen IDs.

## Setup

```bash
bun install
cp .env.example .env   # fill in CLASSNAVI_USERNAME / CLASSNAVI_PASSWORD
```

## CLI

```bash
bun run src/index.ts login                                    # verify credentials
bun run src/index.ts call GetStudentStatus '{"StudentID":"1"}'  # one RPC call
```

## MCP server (stdio)

```bash
CLASSNAVI_USERNAME=... CLASSNAVI_PASSWORD=... bun run src/mcp.ts
```

Tools are named `classnavi_<Method>` (e.g. `classnavi_GetStudentStatus`,
`classnavi_CsvOutput`). Register in Hermes `config.yaml`:

```yaml
mcp_servers:
  class-navi:
    command: bun
    args: ["run", "/Users/miguel/class-navi-api/src/mcp.ts"]
    env:
      CLASSNAVI_USERNAME: "..."
      CLASSNAVI_PASSWORD: "..."
```

## Tests

```bash
bun test    # stubbed fetch — no live account needed
```

## Status / next steps

- ✅ Bundle analysis: endpoint surface, auth flow, ~68 methods + screen IDs
- ✅ Client + auth layer + MCP server, tested against a stubbed transport
- ✅ Hash verified against an independent implementation
- ⏳ **Exact param/response field shapes are unknown** — the web app's forms
  construct the request bodies; minified code is ambiguous. Capture a HAR
  (DevTools → Network → Fetch/XHR → right-click → *Copy all as HAR*) and drop it
  in `~/Downloads/class-navi.har` — the client's `params` are open records until
  then, and types can be filled in from real responses.

## Security

Credentials come from env vars only. `.har` files and `.env` are gitignored —
HARs contain live tokens.
