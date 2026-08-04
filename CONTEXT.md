# Class-Navi API — Shared Vocabulary (Ubiquitous Language)

Terms we use when talking about this project and the API-capture pipeline.
Keep this list updated as we add terms.

## Core terms

- **API** — Application Programming Interface. The rules a server defines for clients to send/receive data. Class-Navi's API is private: no public docs; we reverse-engineered it.
- **Endpoint** — one specific URL + method pair on an API (e.g. `POST .../USA/api/GetStudentList/{requestId}`). "Calling an endpoint" = sending a request to it.
- **RPC** — Remote Procedure Call. Calling a server function by name as if it were local. Class-Navi's API is RPC-style: `POST /api/{MethodName}/{requestId}`.
- **SPA** — Single Page Application. A web app that loads once and updates via JavaScript (Class-Navi is Angular). No page reloads; all data flows through XHR/fetch calls.
- **HAR** — HTTP Archive. JSON file recording a complete browser↔server traffic transcript: URLs, headers, request/response bodies, timing. Ground truth for reverse engineering. ⚠️ Contains live tokens + real data — never commit to git, never share.
- **XHR** — XMLHttpRequest. The legacy browser API for JavaScript→server HTTP calls (AJAX). In DevTools, "Fetch/XHR" filter = the app's API calls (not images/fonts).
- **fetch** — the modern built-in API (browser + Bun/Node) for HTTP requests. Promise-based: `fetch(url, opts) → Response`.
- **MCP** — Model Context Protocol. Open standard connecting AI agents to external tools/data ("USB-C for agents"). An MCP server exposes typed tools; an agent calls them. Our `src/mcp.ts` exposes each Class-Navi method as one tool.
- **Token** — a credential string the server issues after login; sent on each request (Authorization header) to prove identity. Class-Navi: OAuth2 password grant + SHA-256 password hashing.
- **Bundle** — the minified JS file(s) the SPA ships. Contains the full endpoint list + auth logic; we scan it statically (no login needed).
- **DevTools** — browser built-in debugging tools. The Network tab is the traffic inspector; source of the HAR capture.
- **Lockfile** — file pinning exact dependency versions (`bun.lock` for Bun, `package-lock.json` for npm). Not code; never edit by hand.
- **readOnly** — our flag in methods.ts: a data fetch (Get*) vs a write (Register*/Update*). Recon guardrails: agents only get readOnly tools.
- **Cron** — scheduled job; runs a script or prompt on a timer (e.g. daily queue check).
- **Shield** — the read-only request guard used during recon; allowed GET/HEAD/OPTIONS + read-named POST Get*, blocked everything else.

## Pipeline (our workflow)

bundle scan (static) → HAR capture (live) → typed client (client.ts) → MCP server (mcp.ts) → agents / cron / dashboards
