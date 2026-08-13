# Store submission plan — Class Navi Pro Tools (Chrome Web Store + Edge Add-ons)

> Status: research complete (2026-08-12). Requirements verified against the
> official Chrome developer docs and Microsoft Learn pages the same day.
> Product name DECIDED 2026-08-12: **Class Navi Pro Tools** (Miguel).
> Remaining decisions are marked below.

## TL;DR

- **Chrome Web Store (CWS)**: $5 one-time developer registration, zip upload,
  listing + privacy form, review (typically a few days for new items).
- **Edge Add-ons**: free developer account (Partner Center), same zip,
  equivalent forms, certification review.
- Both stores require: a **privacy policy URL**, **permission
  justifications**, a **data-use disclosure**, **screenshots + promo
  tiles**, and a **YouTube demo video**.
- Biggest risk: the extension only runs inside Class-Navi behind instructor
  login — reviewers cannot test it. Mitigation plan below (demo key + video
  + detailed test notes).

## Decisions (status)

1. ~~Product name~~ — **DONE (2026-08-12): "Class Navi Pro Tools"** (manifest,
   options page, license gate, description doc all updated; version bumped
   to 1.0.0; Edge `short_description` added). Internal license brand stays
   "Quick Mark Pro" (QMP- keys, Stripe) — optionally rename the Stripe
   product for consistency later.
2. **License server must be deployed** (pending todo): public HTTPS URL,
   persistent DB. Everything below depends on it.
3. **Privacy policy host.** Easiest: add `/privacy` page to the license
   server (it already has a `/portal` page pattern). Alternative: GitHub
   Pages. Both stores need the URL.
4. **Demo video.** Both stores ask for a YouTube link. A 60–90s screen
   recording (unlisted is fine) of: pattern click → marking toolbar → red
   comment → stats chip.
5. **Kumon legal check** (from licensing research): confirm Class-Navi /
   franchise terms don't prohibit distributing automation for the app
   before going public.
6. **Trademark watch**: "Class-Navi" in the product name may draw a
   justification request from reviewers — description must clearly state
   "unofficial, not affiliated with Kumon".

## Part A — Release hardening (code, ~1 hour)

1. `extension/manifest.json`:
   - `name` → final product name (decision 1).
   - `version` → `1.0.0`.
   - Add `"short_description"` (~132 chars) — Edge displays it; without it
     Edge truncates the description.
   - `host_permissions`: **remove `http://localhost:8787/*`**; replace
     `https://YOUR-LICENSE-SERVER.example.com/*` with the deployed server
     URL (e.g. `https://qmp.example.com/*`).
   - `description` → sync with the store one-liner.
2. `src/background.js`: `API_BASE` → production server URL.
3. `src/license.js`: `CHECKOUT_URL` / `PORTAL_URL` → **production** Stripe
   payment link + billing portal (currently test-mode links).
4. **Strip `qsLicenseDebug`** bypass from the worker before shipping
   (TEST-ONLY flag).
5. **Truth-check the listing copy**: `docs/extension-description.md` says
   "no data leaves your browser" — now FALSE. License key + anonymous
   install ID go to the license server; email goes to Stripe/portal.
   Rewrite the "Private by design" section.
6. **Test in Chrome** (so far everything was verified in Edge — Chrome is
   the CWS requirement; same Chromium APIs, but confirm once):
   load-unpacked in `chrome://extensions`, run the pattern/marking flows.
7. Build the zip (existing recipe, excluding test/docs):
   `cd extension && zip -r ../class-navi-pro-tools-1.0.0.zip . -x "test/*" -x "docs/*"`

## Part B — Store assets (~1–2 hours)

1. **Icon**: current icon128 is a solid blue square (placeholder).
   Redesign a simple mark (monogram or check/pen glyph on the blue
   square) — store prominence is partly image quality. Keep 16/48/128.
2. **Screenshots** (1280×800, at least 1, up to 5). Miguel captures from
   his live Edge session:
   1. Set editor with the Study pattern section (4-3-3 / 3-2-3-2 rows)
   2. Marking screen with the Quick Mark toolbar
   3. Typed red-ink comment on a worksheet
   4. Study-session stats chip (editor header)
   5. Level stats row on the assign screen
3. **440×280 small promo tile** (PNG/JPEG) — required. **1400×560 marquee**
   — optional.
4. **YouTube video** — decision 4.

## Part C — Accounts + privacy policy (~30 min)

1. **CWS developer account**: dedicated Google email (CWS recommends a new
   one — the account email cannot be changed later), register at
   `chrome.google.com/webstore/devconsole`, accept the developer
   agreement, pay the one-time fee (~$5).
2. **Edge developer account**: free. Partner Center with a Microsoft
   account → register for the Microsoft Edge program ("Register as a
   Microsoft Edge extension developer").
3. **Privacy policy page** (serve at `/privacy` on the license server).
   Outline: what is collected (email — key lookup/billing; license key;
   anonymous install ID; subscription status), why (license validation,
   key delivery, billing via Stripe), storage/retention, no selling,
   HTTPS-only, contact email, deletion request path (delete email →
   revoke/delete associated data).

## Part D — Chrome Web Store submission

Steps (dashboard → Add new item → upload zip → edit tabs):

1. **Store listing tab**: detailed description (finalize
   `docs/extension-description.md`, removing the "no data leaves your
   browser" claim), category (Productivity), language, 128×128 icon,
   1–5 screenshots, YouTube video, 440×280 tile, optional marquee.
2. **Privacy practices tab** (draft answers):
   - *Single purpose*: "Helps Kumon instructors assign homework and grade
     worksheets faster inside the Class-Navi web app: one-click study
     patterns, one-click page marking, typed red-ink comments, and study
     stats."
   - *Permissions justification*:
     - `storage` → "Stores the instructor's pattern preferences, license
       state cache, and comment calibration settings locally."
     - `class-navi.digital.kumon.com` → "The only site the extension
       enhances; it injects its UI there and saves through the
       instructor's existing Class-Navi session."
     - license server host → "Validates the subscription license key over
       HTTPS; sends only the key and an anonymous install ID."
   - *Remote code*: **No** (all code ships in the package).
   - *Data usage*: disclose email (key delivery/lookup), device identifier
     (anonymous install ID), purchase/subscription info (collected by
     Stripe at checkout, not the extension). Certify limited use
     (data used only for license verification + support). No analytics,
     no ads, no location, no web history.
   - *Privacy policy URL*: `https://<server>/privacy`.
3. **Distribution / visibility**: start **Unlisted** (installable only via
   link) to smoke-test the exact store package from Miguel's own browser,
   then flip to Public.
4. **Test instructions** (critical — see Part F): reviewers cannot log
   into Class-Navi. Provide the demo key, install steps, what-to-check
   list, video link.
5. Submit → review (typically a few days for new items).

## Part E — Edge Add-ons submission

Partner Center → Edge card → Create new extension:

1. Upload the same zip (package validation runs here; manifest `name` /
   `description` / `short_description` populate the listing and are
   read-only at Partner Center — get them right in the manifest).
2. **Availability**: visibility (submit hidden until ready) + markets.
3. **Properties**: developer name, support contact, categories.
4. **Privacy**: purpose, permission justifications (same answers as
   Chrome), remote code = No, data-use certification, privacy policy URL.
5. **Store listing per language**: long description, YouTube video, search
   terms (e.g. "kumon, class-navi, marking, grading, worksheet, instructor,
   homework, quick mark").
6. **Certification testing notes**: same test instructions + demo key as
   Chrome.
7. Submit → certification review.

## Part F — The reviewer-can't-login problem (biggest rejection risk)

Class-Navi requires a paid Kumon instructor account; store reviewers have
none. Without test access, both stores can reject with "cannot verify".
Mitigation stack:

1. **Demo license key**: mint a reviewer key on the production server
   (admin endpoint / admin page), give it in the test instructions with
   the step "enter this key on the activation card".
2. **Detailed test notes**: exact click path (Set List → student → Start
   Setting → dropdown → Study pattern), marking toolbar, stats chip.
3. **Video walkthrough** covering all three areas.
4. If rejected anyway: appeal with the same material; some teams accept
   documented video evidence for auth-gated apps.

## Cost + time summary

| Item | Chrome | Edge |
|---|---|---|
| Developer registration | ~$5 one-time | Free |
| Review time (new item, typical) | days (varies) | days (varies) |
| Recurring | $0 (no per-listing fee) | $0 |

Prerequisites in order: name decision → server deploy + prod URLs →
privacy policy → demo key → assets (icon, screenshots, tiles, video) →
manifest hardening → Chrome test → zip → register accounts → submit both.

## Open questions for Miguel

1. ~~Final product name?~~ — decided: **Class Navi Pro Tools**
2. License server deploy target (Railway/Render?) — needed for prod URLs.
3. Privacy policy on the license server OK?
4. Can he record the demo video, or should the plan include a recording
   script?
5. Kumon ToS check — proceed assuming OK, or verify first?
6. Rename the Stripe product/brand from "Quick Mark Pro" to match, or keep
   as-is?
