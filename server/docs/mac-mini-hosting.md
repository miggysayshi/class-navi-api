# License server hosting — Cynthia's Mac mini (local, Cloudflare Tunnel)

> Decision (2026-08-12): host the license server on Cynthia's Mac mini
> (always-on desktop at home) instead of Railway/Render. Cost $0. Migration
> to Railway later = copy one SQLite file.
>
> Access: SSH over Tailscale (`cynthias-mac-mini`, 100.120.135.5). The
> deploy key `~/.ssh/classnavi_license` (ed25519) must be authorized on the
> mini before any of this runs.

## Prerequisites

- SSH access to the mini (see AUTHORIZE.md / the one-liner in the chat).
- The active Cloudflare zone for `nimira-timer.com`. The named tunnel uses the
  stable, proxied hostname `license.nimira-timer.com`; never use a temporary
  quick-tunnel URL for webhooks.
- The worktree `server/` (Bun + bun:sqlite + stripe) and its `.env`.

## 1. Install Bun on the mini

```sh
curl -fsSL https://bun.sh/install | bash
# verify
~/.bun/bin/bun --version
```

## 2. Copy the server + secrets

From this Mac (over Tailscale SSH):

```sh
rsync -avz -e "ssh -i ~/.ssh/classnavi_license" \
  --exclude .env --exclude license.db --exclude "*.db-journal" \
  server/ <user>@cynthias-mac-mini:~/class-navi-license-server/
```

⚠️ **ALWAYS exclude `.env` (and `license.db`) from deploys** — the local
dev `.env` has localhost `BASE_URL` and would clobber the mini's production
values (hit 2026-08-14: Phase 2 deploy reverted BASE_URL to localhost).
The `.env` is managed ON the mini only. First deploy: rsync once WITH
`.env` (or scp it separately), then never again.

## 3. `.env` on the mini

Edit `~/class-navi-license-server/.env`:

```ini
STRIPE_SECRET_KEY=sk_live_...      # or sk_test_... until launch
STRIPE_WEBHOOK_SECRET=whsec_...    # real one, 40+ chars
BASE_URL=https://license.<domain>
PORT=8787
ADMIN_TOKEN=<long random>
MANAGEMENT_TOKEN_SECRET=<64 hex chars from: openssl rand -hex 32>
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...
EMAIL_FROM="Class Navi Pro Tools <licenses@send.nimira-timer.com>"
EMAIL_REPLY_TO=support@nimira-timer.com
DB_PATH=/Users/<user>/class-navi-license-server/license.db
DOWNLOAD_FILE=/Users/<user>/class-navi-license-server/class-navi-pro-tools-1.0.0.zip
```

`MAX_INSTANCES` is obsolete. Entitlement is now one Chrome slot plus one Edge
slot per license. Keep `BASE_URL` on public HTTPS in production; recovery link
construction intentionally rejects public HTTP origins.

## 4. launchd — auto-start + keep-alive

`~/Library/LaunchAgents/com.classnavi.license.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.classnavi.license</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/<user>/.bun/bin/bun</string>
    <string>index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/<user>/class-navi-license-server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/<user>/class-navi-license-server/server.log</string>
  <key>StandardErrorPath</key><string>/Users/<user>/class-navi-license-server/server.err.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.classnavi.license.plist
curl -s localhost:8787/health   # expect ok
```

## 5. Never sleep (it's a plugged-in desktop)

```sh
sudo pmset -a sleep 0 disksleep 0
sudo pmset -a womp 1            # optional: wake on network access
```

## 6. Cloudflare Tunnel (stable public HTTPS, zero open ports)

```sh
brew install cloudflared        # or the pkg from cloudflare.com
cloudflared tunnel login        # one-time browser auth to the Cloudflare account
cloudflared tunnel create classnavi-license
cloudflared tunnel route dns classnavi-license license.<domain>
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: classnavi-license
credentials-file: /Users/<user>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: license.<domain>
    service: http://localhost:8787
  - service: http_status:404
```

Run it as a service so it survives reboots:

```sh
sudo cloudflared service install
```

Verify: `curl -s https://license.<domain>/health` from anywhere.

## 7. Point everything at the public URL

- Stripe dashboard → webhooks: endpoint `https://license.<domain>/api/stripe/webhook`,
  events: checkout.session.completed, customer.subscription.updated,
  customer.subscription.deleted, invoice.payment_succeeded. Copy the NEW
  whsec into the mini's `.env` and restart (launchctl kickstart).
- Extension swaps (before store submission):
  - manifest `host_permissions`: replace localhost + placeholder with
    `https://license.<domain>/*`
  - `src/background.js`: `API_BASE`
  - `src/license.js`: `CHECKOUT_URL` (live payment link), `PORTAL_URL`,
    `RECOVERY_URL=https://license.<domain>/portal`
- Rebuild zip + strip `qsLicenseDebug` + bump version.
- Resend dashboard → webhook endpoint:
  `https://license.<domain>/api/resend/webhook`. Store its Svix signing secret
  as `RESEND_WEBHOOK_SECRET`, restart, then verify a signed event.

## 8. Backup and rollback

Do not rsync a live SQLite file. Under rollback-journal mode, a file copy can
be internally inconsistent. Before the first boot that applies new migrations,
make a consistent snapshot on the mini:

```sh
cd ~/class-navi-license-server
mkdir -p backups
snapshot="backups/license-predeploy-$(date +%Y%m%d-%H%M%S).db"
/usr/bin/sqlite3 license.db ".backup '$snapshot'"
/usr/bin/sqlite3 "$snapshot" "PRAGMA integrity_check;"
```

Require `ok` from `PRAGMA integrity_check` before restarting the service. Then
rsync the completed snapshot file to the MacBook and keep the last N snapshots.
Use the same SQLite `.backup` method for nightly backups. Migrations are
forward-only; restoring a verified pre-deploy snapshot is the rollback path.

## Verification checklist

- [ ] `curl https://license.<domain>/health` → ok
- [ ] `POST /api/license/validate` with a seeded key → `{valid: true}`
- [ ] `/portal`, `/manage`, `/privacy`, and `/admin` load
- [ ] legacy `/api/portal/keys` returns 404
- [ ] known and unknown recovery requests return the same neutral response
- [ ] Resend signed webhook test succeeds; no raw key/email appears in logs
- [ ] Stripe test checkout → webhook → server log shows new key
- [ ] Extension on localhost test → prod server: activate with the key
- [ ] Reboot the mini → server + tunnel come back (launchd + cloudflared
      service) → health still ok

## Known risks (accepted)

- Home internet/power outage = server down. Extension has 24h cache + 7-day
  grace; Stripe retries webhooks 3 days. Realistically invisible at this
  scale.
- The mini is now a prod box — keep macOS updates on, keep the firewall on
  (no inbound ports needed; tunnel is outbound-only), and treat `.env` as
  production secrets.
- If the mini ever needs to travel/relocate, migrate to Railway: copy
  `license.db` to the volume, set `DB_PATH`, redeploy.
