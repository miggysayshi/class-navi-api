# Production rollout plan — Class Navi Pro Tools

> Status: **PLANNING COMPLETE (2026-08-12).** Master checklist that chains
> the pieces: store plan (`extension/docs/store-submission-plan.md`), server
> deploy runbook (`server/docs/mac-mini-hosting.md`), licensing skill
> (`extension-subscription-licensing`). Work bottom-up: each phase's
> prerequisites are in the phase above it. Critical path: **deploy the
> license server first** — the prod URL feeds Phase 4 (manifest/API_BASE)
> and Phase 3 (Stripe webhook).

## State today (2026-08-12)

- ✅ Product renamed "Class Navi Pro Tools" v1.0.0 (manifest, options,
  license.js, README, description doc — **changes uncommitted**)
- ✅ License server built + Stripe test-mode E2E verified (activation,
  webhook, admin minting, /download)
- ✅ Store submission research complete (CWS + Edge requirements)
- ✅ Hosting decision: Cynthia's Mac mini + Cloudflare Tunnel
- ❌ Server NOT deployed (SSH key auth on mini pending, domain TBD)
- ❌ No /privacy page (server route does not exist yet)
- ❌ Stripe live mode not set up (test-mode links still in extension)
- ❌ qsLicenseDebug still in the worker; localhost still in host_permissions
- ❌ Store assets (icon, screenshots, tiles, video) not made
- ❌ Store accounts not registered
- ❌ Old `quick-mark-pro-0.2.0.zip` sits in the worktree root (delete)

## Open decisions (need Miguel)

1. **Domain** for the tunnel: own a domain? Cloudflare account exists?
   (Runbook example: `license.<domain>`; Stripe webhook URL must never
   change, so no quick-tunnel URLs.)
2. **Mini access**: authorize `~/.ssh/classnavi_license` on the mini — one
   command on the mini (or `ssh-copy-id` from the MacBook over Tailscale).
   Who runs it — Miguel or Cynthia?
3. **Stripe live onboarding**: business account + SSN/EIN + bank done?
   (Personal accounts cannot run payment links/subscriptions.)
4. **Demo video**: Miguel records 60–90s in Edge, or script a recording?
5. **Kumon ToS check**: verify franchise terms before going public, or
   proceed and accept the risk?
6. Rename the Stripe product from "Quick Mark Pro" → "Class Navi Pro Tools",
   or keep the internal brand?

---

## Phase 0 — Code freeze + commit (~15 min)

1. Commit the pending rename changes in the worktree:
   `extension/manifest.json`, `extension/src/license.js`,
   `extension/options.html`, `extension/README.md`,
   `extension/docs/extension-description.md`,
   `extension/docs/store-submission-plan.md`, `server/docs/`.
2. Delete `quick-mark-pro-0.2.0.zip` (stale build).
3. Update `CONTEXT.md`/skill status once the rollout starts.

## Phase 1 — Deploy license server (Mac mini + Cloudflare Tunnel) — CRITICAL PATH

Follow `server/docs/mac-mini-hosting.md` step by step:

1. **SSH access** (decision 2): authorize the deploy key on the mini.
   Verify: `ssh -i ~/.ssh/classnavi_license <user>@cynthias-mac-mini echo ok`.
2. **Domain** (decision 1): Cloudflare free plan, named tunnel
   `classnavi-license`, hostname `license.<domain>`.
3. Install Bun on the mini (`curl -fsSL https://bun.sh/install | bash`).
4. `rsync -avz -e "ssh -i ~/.ssh/classnavi_license" server/ <user>@cynthias-mac-mini:~/class-navi-license-server/`
   (includes `.env` — secrets live ONLY on the mini).
5. `.env` on the mini: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `BASE_URL=https://license.<domain>`, `PORT=8787`, `MAX_INSTANCES=3`,
   `ADMIN_TOKEN=<long random>`, `DB_PATH`, `DOWNLOAD_FILE`.
6. launchd plist (RunAtLoad + KeepAlive) → `launchctl load` →
   `curl -s localhost:8787/health` = ok.
7. `sudo pmset -a sleep 0 disksleep 0`.
8. cloudflared: `brew install cloudflared` → `tunnel login` →
   `tunnel create classnavi-license` → `route dns` → config.yml →
   `sudo cloudflared service install`.
9. **Verify from this Mac**: `curl https://license.<domain>/health` → ok;
   seed a key in the DB, `POST /api/license/validate` → `{valid:true}`;
   `/portal` + `/admin` load.

## Phase 2 — Privacy policy page (~30 min)

1. Add `GET /privacy` to `server/index.js` (static HTML, follow the `/portal`
   pattern): what is collected (email for key lookup/billing, license key,
   anonymous install ID, subscription status), why, retention, no selling,
   HTTPS-only, contact email, deletion path.
2. Re-rsync + `launchctl kickstart` the service; curl the page.
3. Both stores need this URL — put `https://license.<domain>/privacy` in
   every submission form.

## Phase 3 — Stripe live (~30–60 min, Miguel's dashboard)

1. Complete live onboarding (decision 3): business info, SSN/EIN, payout
   bank. Account type: sole proprietor.
2. Create the live price: product + **$10/month recurring**, tax code
   `txcd_10100000` (SaaS).
3. Live **payment link** (Buy button) + **customer portal** (Manage
   subscription) — copy both URLs.
4. Live **webhook endpoint** `https://license.<domain>/api/stripe/webhook`,
   events: `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_succeeded`. Copy the
   REAL `whsec_` (40+ chars) into the mini's `.env`, restart.
5. Mint Miguel's own owner seat via `/admin` (no Stripe fee on owner seats).

## Phase 4 — Release hardening (~1 hr)

1. `extension/manifest.json`: `host_permissions` → drop
   `http://localhost:8787/*` + placeholder, keep only
   `https://class-navi.digital.kumon.com/*` and `https://license.<domain>/*`.
2. `src/background.js`: `API_BASE` → `https://license.<domain>`.
   **Strip the `qsLicenseDebug` bypass entirely** (test-only flag).
3. `src/license.js`: `CHECKOUT_URL`/`PORTAL_URL` → LIVE payment link + portal.
4. Truth-check `extension/docs/extension-description.md`: remove the
   "no data leaves your browser" claim (license key + anonymous install ID
   now go to the license server; email goes to Stripe).
5. **Test in Chrome** load-unpacked (everything so far was Edge — CWS
   reviewers run Chrome): pattern flow, marking, comment, stats chip,
   license gate with a locally-seeded key.
6. Rebuild the zip: `cd extension && zip -r ../class-navi-pro-tools-1.0.0.zip . -x "test/*" -x "docs/*"`
   (delete the old 0.2.0 zip first).
7. **Live E2E**: mint a test key on PROD via /admin → Edge full reload
   (extension + page) → activate → features unlock → reload → still unlocked
   (cache) → `DELETE FROM instances` before handing the key to reviewers.
8. Commit the hardening changes.

## Phase 5 — Store assets (~1–2 hrs, Miguel captures)

1. **Icon**: replace the solid-blue placeholder with a simple mark
   (monogram / check+pen glyph) at 16/48/128.
2. **Screenshots** (1280×800, 1–5, captured from Miguel's live Edge):
   1. Set editor with the Study pattern section
   2. Marking screen with the Quick Mark toolbar
   3. Typed red-ink comment on a worksheet
   4. Study-session stats chip (editor header)
   5. Level stats row (assign screen)
3. **440×280 small promo tile** (required) + optional **1400×560 marquee**.
4. **Demo video** (decision 4): 60–90 s, unlisted YouTube:
   pattern click → marking toolbar → red comment → stats chip.
   Script: `extension/docs/demo-video-script.md` (write it in Phase 5).

## Phase 6 — Accounts (~30 min, Miguel)

1. **CWS developer account**: dedicated Google email (account email cannot
   change later) → `chrome.google.com/webstore/devconsole` → developer
   agreement → **$5 one-time**.
2. **Edge developer account**: free — Microsoft Partner Center → register
   as Edge extension developer.

## Phase 7 — Submissions (order matters)

1. **CWS first**: Add new item → upload zip → listing tab (description,
   Productivity category, icon, screenshots, video, tiles) → privacy
   practices tab (permissions justification: `storage`, the Class-Navi
   host, the license server; remote code = No; data-use disclosure) →
   privacy policy URL → **distribution = Unlisted** → submit.
2. **Smoke-test the exact store package**: install from the Unlisted link
   in Miguel's own Edge (not load-unpacked) — this validates the zip.
3. Flip CWS to **Public**.
4. **Edge**: same zip → hidden visibility → properties → privacy →
   listing (long description, video, search terms: "kumon, class-navi,
   marking, grading, worksheet, instructor, homework, quick mark") →
   certification notes.
5. **Reviewer kit** (in both submissions' test instructions): fresh demo
   key minted on prod (mint per-reviewer; 3-device cap!), install steps,
   click path (Set List → student → Start Setting → dropdown → Study
   pattern; marking toolbar; stats chip), video link. Reviewers cannot log
   into Class-Navi — this kit is the mitigation.

## Phase 8 — Launch + post-launch

1. Kumon ToS check (decision 5) — do BEFORE going public.
2. Nightly DB backup: rsync `license.db` from the mini to the MacBook
   (launchd/cron, keep last N).
3. Watch `server.log` for the first days; support contact in the store
   listing = Miguel's email.
4. Keep the mini patched (macOS updates, firewall on — tunnel is
   outbound-only, no open ports).

---

## Timeline estimate

| Phase | Time | Who |
|---|---|---|
| 0 Code freeze | 15 min | Bell |
| 1 Server deploy | 1–2 hr | Bell + mini access |
| 2 Privacy page | 30 min | Bell |
| 3 Stripe live | 30–60 min | Miguel (dashboard) |
| 4 Hardening | 1 hr | Bell + Chrome test |
| 5 Assets | 1–2 hr | Miguel (captures) + Bell (icon/tiles) |
| 6 Accounts | 30 min | Miguel |
| 7 Submissions | 30 min + review days | Miguel + Bell |
| 8 Launch | ongoing | both |

Hands-on total: ~6–8 hours across 2–3 sessions; store review adds days
after submission. First session (recommended): Phase 0 + 1 + 2 — get the
server live, everything else unlocks from there.
