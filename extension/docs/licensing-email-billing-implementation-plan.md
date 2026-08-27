# Licensing, Email, and Billing v2 Implementation Plan

> **For Hermes:** Execute this plan one slice at a time with TDD. Do not change production until the full local suite and signed webhook smoke tests pass. Preserve the existing uncommitted `constructEventAsync()` fix in `server/index.js`.

**Goal:** Deliver safe Stripe-to-license fulfillment, Resend Free email delivery, one Chrome plus one Edge slot per license, secure recovery and reset, $7.99 billing, a one-month-free promotion, individually controlled family-and-friends access, seat-limit purchase prompts, and easy cancellation.

**Architecture:** Stripe remains the billing source of truth for paid and one-month-free subscriptions. One Stripe subscription creates exactly one license and one seat. The Bun server commits the entitlement and an email outbox row in one SQLite transaction, then a worker sends through Resend. Family-and-friends access uses server-minted, one-time invite codes that create individually revocable free-forever licenses without Stripe or a payment card.

**Tech stack:** Bun, `bun:sqlite`, Stripe SDK, Resend HTTP API and webhooks, Chrome/Edge MV3 extension, Cloudflare Tunnel, Mac mini launchd services.

---

## Frozen product decisions

1. Public price: **$7.99 USD per seat per month**.
2. One Stripe subscription = one license key = one logical computer.
3. One license permits one Chrome profile slot and one Edge profile slot.
4. Buying another seat creates another Stripe subscription and another license key. Do not add subscription quantity or a `licenses.seats` field.
5. Resend Free is the launch email provider. Its daily limit is an operational threshold, never a reason to drop an outbox row.
6. Raw license keys are delivered only to the authoritative purchase or invite email.
7. Public lookup responses are neutral. No unauthenticated route returns a key or confirms that an email exists.
8. Public promotion: Stripe coupon `percent_off=100`, `duration=once`, product-restricted, entered at Checkout. It gives the first monthly invoice free. The checkout still collects a payment method for month two.
9. Family and friends: admin-minted one-time invite codes. A redeemed invite creates one `family_free` license with no Stripe subscription and no expiry. Each license can be revoked separately. Never use a reusable Stripe `duration=forever` promotion code.
10. Cancellation uses Stripe Customer Portal with cancellation at period end. Access remains active until Stripe sends the final cancellation/deletion state. Customers can resume before period end.
11. The extension always shows both **Manage installations** and **Buy another seat — $7.99/month** when a family slot is occupied.
12. Offline grace applies only to network failure. A known server revocation or billing failure must overwrite the valid cache and must not receive offline grace.

## Rejected models

- A generic three-device counter.
- Multiple paid seats stored on one license key.
- Stripe Payment Link quantity as the application seat model.
- One shared family-and-friends forever coupon.
- Public `{email -> keys}` lookup.
- Validation that creates a browser binding.
- Email sending inside the Stripe webhook request.
- Raw license keys in logs, URLs, or unauthenticated pages.

---

## Slice 1 — Versioned schema and fulfillment correctness

**Objective:** Create a safe migration base and remove the webhook replay defect before email is connected.

**Files:**
- Modify: `server/db.js`
- Modify: `server/index.js`
- Modify: `server/test/license.test.js`
- Create: `server/test/webhook.test.js`

**Changes:**

1. Add a `schema_migrations` table and ordered, transaction-wrapped migrations.
2. Keep the existing `licenses.key` primary key for v1 compatibility.
3. Add license fields:
   - `source`: `stripe_paid | stripe_promo | family_free | admin`
   - `current_period_end`
   - `cancel_at_period_end`
   - `last_stripe_event_created`
4. Add `processed_stripe_events` with `event_id` as primary key.
5. Fix `upsertLicense()` so a subscription conflict returns the persisted key, not the discarded candidate.
6. Normalize email in the DB function.
7. Replace raw-key logs with subscription ID and a masked key identifier.
8. Make Stripe event application reject older events for the same subscription.
9. Preserve `constructEventAsync()` and log webhook failure metadata without secrets.

**RED tests:**

- A second `upsertLicense()` call with a new candidate returns the first key.
- The same Stripe event ID changes state once.
- An old `active` event cannot overwrite a newer `canceled` event.
- No captured log line contains a full `QMP-` key.
- Migration runs twice without changing schema or data.

**Verification:**

```sh
cd server
bun test
```

Expected: all existing and new server tests pass.

---

## Slice 2 — Durable Resend outbox

**Objective:** Queue every transactional message durably and send outside the Stripe request.

**Files:**
- Modify: `server/db.js`
- Modify: `server/index.js`
- Modify: `server/.env.example`
- Create: `server/email.js`
- Create: `server/email-worker.js`
- Create: `server/test/email.test.js`

**Schema:**

`email_outbox`:
- `id`
- `kind`
- `license_key`
- `recipient_email`
- `payload_json`
- `idempotency_key` unique
- `provider_message_id`
- `status`: `pending | sending | sent | retry | dead`
- `attempts`
- `next_attempt_at`
- `last_error`
- `created_at`
- `sent_at`

`email_suppressions`:
- normalized email primary key
- reason
- provider event ID
- created time

`resend_events`:
- provider event ID primary key
- event type
- provider message ID
- received time

**Changes:**

1. Add environment names without secrets:
   - `RESEND_API_KEY`
   - `RESEND_WEBHOOK_SECRET`
   - `EMAIL_FROM`
   - `EMAIL_REPLY_TO`
2. Default sender: `Class Navi Pro Tools <licenses@send.nimira-timer.com>`.
3. Default reply-to: `support@nimira-timer.com`.
4. Stripe checkout handling commits the license, processed event, and welcome outbox row in one transaction.
5. The webhook returns after commit. It never waits for Resend.
6. The worker claims one row with a lease, sends with `Idempotency-Key: <outbox idempotency_key>`, and records the result.
7. Temporary failures retry with bounded exponential backoff.
8. Permanent failures and suppressed recipients stop automatic retries.
9. Add a verified Resend webhook endpoint for delivered, delayed, bounced, complained, failed, and suppressed events.
10. Add queue-health data to `/health` without exposing recipients or keys.
11. Alert or log a warning before 80 sends in one UTC day. Keep later rows pending if the free-plan daily cap blocks sending.

**RED tests:**

- Duplicate checkout creates one intended welcome message.
- Worker restart preserves pending rows.
- Ambiguous provider failure reuses the same idempotency key.
- Temporary failure retries; permanent failure does not.
- Duplicate Resend event is a no-op.
- Bounce creates a suppression.
- A suppressed email does not send again without an explicit administrative override.

**Verification:**

```sh
cd server
bun test
```

---

## Slice 3 — Secure email recovery and management tokens

**Objective:** Remove email enumeration and make key recovery and installation management email-authenticated.

**Files:**
- Modify: `server/db.js`
- Modify: `server/index.js`
- Modify: `server/test/license.test.js`
- Create: `server/test/recovery.test.js`

**Schema:**

`management_tokens`:
- `token_hash` primary key
- `email`
- `license_key`
- `purpose`: `recover | reset_chrome | reset_edge | reset_all`
- `expires_at`
- `used_at`
- `created_at`

`request_limits`:
- hashed subject key
- action
- window start
- count

**Changes:**

1. Remove `GET /api/portal/keys?email=...`.
2. Replace the portal with an email form that posts to a neutral recovery endpoint.
3. Always return: `If a matching purchase exists, we sent an email.`
4. Recovery sends the raw key by email. The browser response never contains it.
5. Management links use random tokens. Store only SHA-256 hashes.
6. Tokens expire in 20 minutes and work once.
7. The management page shows masked license identity and Chrome/Edge slot state, not the raw key.
8. Slot reset is requested on the authenticated management page and confirmed by email or by the current valid token scope.
9. Add per-email and per-IP rate limits. Do not log raw email, tokens, or keys.
10. Keep Stripe billing management separate from license recovery.

**RED tests:**

- Existing and unknown emails receive the same HTTP response and shape.
- Old lookup routes return 404.
- Token plaintext never appears in SQLite.
- Expired and reused tokens fail.
- A Chrome-scoped token cannot reset Edge.
- Reset-both clears only the selected license.

---

## Slice 4 — Chrome and Edge family slots

**Objective:** Replace the flat instance counter with one browser-family slot per license.

**Files:**
- Modify: `server/db.js`
- Modify: `server/index.js`
- Modify: `server/test/license.test.js`

**Schema:**

`browser_slots`:
- `license_key`
- `browser_family`: `chrome | edge`
- `instance_id`
- `activated_at`
- `last_seen_at`
- primary key: `(license_key, browser_family)`
- unique: `instance_id`

**Rules:**

- Activation can claim an empty family slot.
- Activation by the current family and instance is idempotent.
- A second instance for the family returns `slot-occupied`.
- Validation is read-only.
- Validation of an empty slot returns `not-activated`.
- Validation of another instance returns `slot-mismatch`.
- Unknown family returns `family-undetermined` and receives no slot.
- Active and trialing licenses may activate.
- Canceled, paused, incomplete, and other blocked statuses may not activate or validate.
- Concurrency is protected by the primary key and transaction.

**Legacy installation transition:**

- Migration v5 keeps the old `instances` table but does not guess a browser family or backfill slots.
- The Extension background worker validates first. On the exact `not-activated` result, it makes one separate activation request with the stored key, fixed build-time browser family, and existing instance ID, then validates again.
- Validation remains read-only. The transition never loops and never exposes the stored key to the page or logs.
- A slot conflict or activation error fails closed and clears stale valid cache; it does not enter offline grace.
- Rollout order is Extension first, then the server route switch. This lets the new Extension work with the old tolerant server before the server begins requiring `browser_family`.

**RED tests:**

- Chrome A activates; Chrome A activates again idempotently.
- Edge A activates on the same license.
- Chrome B loses a concurrent activation race.
- Validation never inserts a row.
- Unknown family never creates a third pool.
- Reset Chrome does not alter Edge.
- Cancellation invalidates both slots.

---

## Slice 5 — Family-and-friends invite codes

**Objective:** Let the owner issue individually controlled free-forever access without Stripe or a card.

**Files:**
- Modify: `server/db.js`
- Modify: `server/index.js`
- Modify: `server/.env.example`
- Modify: `server/test/license.test.js`
- Create: `server/test/invites.test.js`

**Schema:**

`invite_codes`:
- `code_hash` primary key
- `label`
- `created_at`
- `expires_at`
- `redeemed_at`
- `redeemed_email`
- `license_key`
- `revoked_at`

`admin_audit`:
- action
- masked subject
- detail JSON without secrets
- created time

**Changes:**

1. Add an admin action to mint one or more random, human-copyable invite codes.
2. Each invite is one-time and has an expiration selected at mint time.
3. Store only a hash of each invite code.
4. A public invite redemption form accepts code plus email.
5. Successful redemption creates one `source=family_free` license and queues its email in the same transaction.
6. A redeemed or invalid code receives a neutral result that does not expose account data.
7. Family-free licenses have no Stripe subscription and no expiry.
8. Admin can revoke one family-free license without affecting other invitees.
9. Stripe reconciliation ignores `family_free` licenses.
10. Protect admin routes with bearer authentication, constant-time token comparison, rate limiting, and audit rows.

**RED tests:**

- One invite redeems once.
- Concurrent redemption creates one license.
- Invite plaintext is absent from SQLite and logs.
- Expired invite fails.
- Family-free license validates until individually revoked.
- Stripe events cannot mutate a family-free license.

---

## Slice 6 — $7.99 price, one-month-free promotion, and cancellation state

**Objective:** Configure Stripe and store enough subscription state for correct customer messaging.

**Dashboard configuration:**

1. Create a new immutable monthly Price on the existing product: USD `799` cents.
2. Leave any existing $10 subscription on its original Price unless deliberately migrated.
3. Create a new Payment Link for the $7.99 Price.
4. Enable customer-entered promotion codes on the public link.
5. Create a product-restricted coupon:
   - `percent_off=100`
   - `duration=once`
6. Create the public promotion code with:
   - first-time-customer restriction when test mode confirms the expected subscription-link behavior
   - explicit maximum redemptions
   - explicit expiration date
7. Keep payment-method collection enabled so month two can charge $7.99.
8. Enable Customer Portal cancellation at period end.
9. Keep portal promotion-code and plan-change features disabled.
10. Keep cancellation reasons enabled if available.

**Server changes:**

1. Store Stripe price ID, promotion/coupon ID when available, `current_period_end`, and `cancel_at_period_end`.
2. `cancel_at_period_end=true` keeps the license active and displays the cancellation date.
3. A resume event clears the pending-cancellation state without changing the key.
4. `customer.subscription.deleted` revokes the paid license.
5. A new subscription creates a new license. Do not silently reuse a canceled key.
6. Add `invoice.payment_failed`, refund, and dispute event policy handling before live launch.

**RED tests:**

- First free invoice does not create a second key.
- Paid renewal keeps the original key.
- Cancellation at period end stays active.
- Resume preserves key and slots.
- Deletion revokes.
- Two subscriptions for one email create two independent keys.
- Canceling one does not revoke the other.

**Official references:**

- https://docs.stripe.com/products-prices/how-products-and-prices-work
- https://docs.stripe.com/payment-links/promotions
- https://docs.stripe.com/api/coupons/create
- https://docs.stripe.com/api/promotion_codes/create
- https://docs.stripe.com/customer-management/configure-portal
- https://docs.stripe.com/billing/subscriptions/cancel

---

## Slice 7 — Extension license UX and seat purchase prompt

**Objective:** Explain every license state and keep billing and installation management available to active users.

**Files:**
- Modify: `extension/src/license.js`
- Modify: `extension/src/background.js`
- Modify: `extension/src/content.js`
- Modify: `extension/src/content-main.js`
- Modify: `extension/options.html`
- Modify: `extension/options.js`
- Modify: `extension/test/license.test.js`

**Changes:**

1. Change the displayed price to `$7.99/seat/month`.
2. Add `browser_family` to activation and validation payloads.
3. Use build-time browser-family constants for the Chrome and Edge packages. Do not use user-agent parsing as the entitlement authority.
4. Add states and copy for:
   - `slot-occupied`
   - `slot-mismatch`
   - `family-undetermined`
   - `not-activated`
   - canceled
   - past due
   - paused
   - canceling at period end
5. The slot-occupied card always shows:
   - **Manage installations**
   - **Buy another seat — $7.99/month**
6. Copy explains that a reinstall can use the old slot and that buying is needed only for another computer or profile.
7. Buying another seat opens the normal $7.99 Payment Link. The resulting subscription produces a new emailed key.
8. Add a visible **License & billing** action for active users in the extension options page and an unobtrusive entry in the existing integrated app UI. Do not add a floating persistent panel.
9. The active surface links to:
   - Manage subscription
   - Recover license
   - Manage Chrome/Edge installations
   - Buy another seat
10. Non-entitled states keep features gated. Informational and management UI is dismissible and accessible.
11. Add dialog semantics, keyboard focus handling, Esc support, visible focus styles, and `aria-live` errors.
12. A known revocation clears valid cache. Offline grace is used only after a network error.

**RED tests:**

- Every server reason maps to one stable state and customer message.
- Slot-occupied UI contains both required actions.
- Active users can reach billing management without first becoming locked.
- Known revocation does not enter grace.
- Network failure with a recent valid cache enters grace.
- Chrome and Edge builds send their fixed family values.

---

## Slice 8 — Production wiring and release hardening

**Objective:** Deploy the completed design without losing production data or exposing test controls.

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/src/background.js`
- Modify: `extension/src/content.js`
- Modify: `extension/src/license.js`
- Modify: `server/index.js` privacy policy content
- Modify: `extension/docs/extension-description.md`
- Modify: `extension/docs/production-rollout-plan.md`

**Changes:**

1. Add Resend as a processor in the privacy policy.
2. Document purchase email, delivery events, browser family, management tokens, and retention.
3. Remove localhost and placeholder host permissions from release packages.
4. Point all license requests, including fallback paths, at `https://license.nimira-timer.com`.
5. Install the live $7.99 Payment Link and Customer Portal URL.
6. Remove `qsLicenseDebug` from release builds.
7. Create separate Chrome and Edge packages from the same source with fixed browser-family constants.
8. Back up the Mac mini SQLite database before migration.
9. Deploy with `.env`, `license.db`, and journal files excluded from rsync.
10. Restart through launchd and verify migration state, health, outbox, Stripe webhook, and Resend webhook.
11. Run a full Stripe test purchase before live mode.
12. Run one real low-risk live purchase and refund only after test mode passes.
13. Verify Mac mini sleep prevention, reboot survival, DB backups, dead-letter alerts, and Resend daily-volume warnings.

---

## End-to-end acceptance

The release is complete only when all of these pass:

1. A normal $7.99 test purchase creates one license and one welcome email.
2. A duplicate and concurrent Stripe event creates no second key or intended email.
3. The one-month-free code creates the same entitlement as a normal purchase and charges the new price on the next cycle in Stripe test mode.
4. A family invite creates one free-forever license with no card and no Stripe subscription.
5. Chrome and Edge can activate the same license.
6. A second Chrome profile receives the limit prompt with both management and purchase actions.
7. Buying another seat creates another subscription and another key.
8. Email recovery reveals nothing in the HTTP response and sends the key only to the authoritative email.
9. A one-time management token resets Chrome without resetting Edge.
10. Cancellation at period end keeps access and shows the date.
11. Resuming before period end keeps the same key.
12. Final cancellation revokes the license on the next known validation response.
13. Network failure uses offline grace; a known revoked response does not.
14. Bounced or complained recipients enter suppression state.
15. No raw key, invite code, token, API key, or customer email appears in application logs.
16. `bun test` passes in both `server/` and `extension/`.
17. `git diff --check` passes.
18. The deployed `/health` reports a healthy database and no stale email queue without exposing customer data.

## Dependency graph and parallel implementation waves

The slices do not form one serial chain. Use the following waves.

### Wave 0 — Shared foundation; blocking

Complete and accept Slice 1 before parallel server implementation begins:

- versioned migrations
- persisted-key replay fix
- Stripe event deduplication and event-order guard
- redacted logging
- frozen request, response, reason-code, and table contracts

This wave blocks Slices 2–7 because each lane depends on stable persistence and API contracts.

### Wave 1 — Parallel implementation after Slice 1

Run these lanes in isolated Git worktrees from the same accepted Slice 1 baseline:

1. **Email lane:** Slice 2 outbox, Resend adapter, worker, provider webhook, and email tests.
2. **Browser-slot lane:** Slice 4 browser-slot persistence, activation, read-only validation, reset service, and server tests.
3. **Stripe commercial lane:** Slice 6 test-mode Price, Payment Link, promotion code, Customer Portal configuration, lifecycle fields, and webhook tests.
4. **Extension lane:** the contract-driven part of Slice 7, using fixed server fixtures for browser family, reason states, limit CTAs, billing entry, accessibility, and extension tests.
5. **Invite core lane:** the code-generation, hashing, expiration, redemption-race, revocation, and audit parts of Slice 5. Final invite email delivery waits for the email lane.
6. **Recovery core lane:** the hashing, expiry, single-use token, neutral-response, and rate-limit parts of Slice 3. Final recovery email and slot-reset integration wait for the email and browser-slot lanes.

Do not let these workers share one Git index. Do not give more than one worker broad ownership of `server/db.js` or `server/index.js`. Prefer new focused modules and tests in each worktree. Use one integration owner for migrations, shared DB exports, and route registration.

### Wave 2 — Ordered integration gates

Integrate accepted lanes in this order:

1. Email outbox and sender.
2. Browser-slot service and API contract.
3. Secure recovery plus management-token email and slot reset.
4. Family invite redemption plus welcome email.
5. Stripe lifecycle and commercial configuration.
6. Extension UX against the integrated server contract.

Run the full server and extension suites after each integration. Reject any lane that changes the frozen one-subscription/one-license model or exposes raw keys.

### Wave 3 — Sequential end-to-end and release work

Slice 8 and final acceptance remain sequential:

- migrate a database copy and test rollback/restart behavior
- run Stripe and Resend test-mode flows
- run purchase, recovery, reset, invite, cancellation, and second-seat tests
- configure production secrets and DNS
- back up and migrate production
- deploy the server contract
- build Chrome and Edge packages
- run production smoke tests and release

Do not deploy a partial server contract that the released extension does not understand.
