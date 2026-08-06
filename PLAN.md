# Weekly Lunch Orders — Build Plan

## Goal

Collect lunch orders each week. Cut off Friday, cook Sunday, deliver Monday. No server to babysit,
no auth system, no payment integration. The Google Sheet is the admin UI.

## Architecture

```
Static page          ──GET──►   Apps Script     ──►  Google Sheet (private)
(GitHub Pages)       ◄─menu──   web app              ├── Menu tab
media in repo        ──POST─►                        └── Orders tab
                     ◄─{ok}──
```

- **Static page** — one `index.html`, vanilla JS, no build step. Media files committed to the repo.
- **Apps Script** — bound to the sheet, deployed "Execute as: Me" / "Who has access: Anyone".
  The entire backend.
- **Sheet** — never public. Never File → Share → Publish to web.

Timezone: `Australia/Sydney` (sheet locale + script constant).

## The one rule

**No public endpoint ever reads the Orders tab.**

`doGet` returns menu data only. `doPost` writes a row and returns `{ok:true}` — never counts, never
row contents, never "you already ordered". The response surface of these two functions is the entire
security boundary. Every feature below was chosen to keep that rule absolute.

## Data model

### Menu tab

| week | status | id | name | description | price | allergens | media |
|------|--------|----|------|-------------|-------|-----------|-------|
| 2026-08-10 | live | m01 | Chicken rice | ... | 14.00 | soy | media/rice.jpg,media/rice.mp4 |
| 2026-08-03 | archive | m00 | Laksa | ... | 14.00 | shellfish | media/laksa.jpg |

- `week` — the delivery Monday, `YYYY-MM-DD`. Drives the cutoff.
- `status` — `live` (orderable) or `archive` (history). Publishing next week: paste rows as `live`,
  flip last week to `archive`.
- `media` — comma-separated repo-relative paths. Type inferred from extension. Empty is fine.
- `id` — stable and never reused. Old order rows point at it.

### Orders tab

| order_id | timestamp | week | name | email | dish_id | qty | unit_price | line_total | notes | void | paid |
|----------|-----------|------|------|-------|---------|-----|------------|------------|-------|------|------|

One row per line item, rows of one order share `order_id`.

- **Prices are snapshotted.** `unit_price` written from the Menu tab at submit time, never looked up
  later. Editing next week's prices must not silently restate last week's orders.
- **No dedupe.** Someone ordering twice just makes more rows. You read the sheet Friday and sort it
  out in chat.
- `void` — manual escape hatch. Tick it, formulas ignore the row. Zero code.
- `paid` — you tick it Monday at handover.

## Endpoints

**`doGet`** — no params: the live week. `?view=archive`: past weeks.

```json
{ "week": "2026-08-10", "is_open": true, "closes_at": "2026-08-07T23:59:59+10:00",
  "dishes": [ { "id": "m01", "name": "...", "price": 14.00, "media": ["media/rice.jpg"] } ] }
```

**`doPost`** — validates, appends rows, sends the receipt email, returns `{ok:true}` or
`{ok:false, error:"..."}`.

## Cutoff

Derived server-side: **Friday 23:59 Australia/Sydney**, computed from the live week's Monday date.
Nothing to remember on a Friday night.

Checked on both `doGet` (`is_open` flag, so the page renders a closed state) and `doPost` (the actual
enforcement). Browser clock is never trusted — any countdown on the page is cosmetic.

## Payment

Out of band. Cash or PayID on delivery.

**The PayID never appears on the public page** — not as text, not as an image. OCR is cheap and bots
run it. It goes in the confirmation email only, sent by `MailApp.sendEmail()` on successful order,
alongside the order summary and total.

Consequence: email is required and unverified. A typo means they get no payment details and you won't
know until Monday. Mitigations, both cheap: the confirmation screen echoes the address back
("receipt sent to j@example.com — wrong? reorder"), and bounces land in your Gmail because the script
sends as you.

MailApp free-tier quota is 100 emails/day. Not a constraint here.

## Security

Threat model: **a colleague being a dick.** The URL is unlisted, shared by you into a work chat,
`noindex`/`nofollow` + `robots.txt` disallow. Not the open internet. A fake order costs one wasted
portion, because no money moves at submit time.

Read side — covered by the one rule above.

Write side — the POST endpoint is public. All mitigations server-side:

- **Honeypot** — a visually hidden input (`position:absolute; left:-9999px`, *not* `type="hidden"`,
  which bots skip). Filled → return `{ok:true}` and discard silently.
- **Timing check** — reject submissions under ~3s after the form rendered.
- **Validation** — `dish_id` must exist in the live week, `qty` an integer 1–5 per line, max 10 lines,
  name/email/notes length-capped, submissions after the cutoff rejected.

No shared secret in the JS — it's visible in page source and protects nothing.

No `?email=...` edit or cancel links — anyone could swap in a colleague's address and read their
order. If editing is ever wanted: mint a random token at submit, store it in a column, look up by
token only.

No Turnstile. Unlisted + honeypot is proportionate; revisit only if the page goes public.

## Capacity

No cap. Server rejects `qty > 5` per line to stop a fat-finger 500. Total capacity lives in your head;
if a week runs hot, archive the menu early to close it. A real cap would need `doGet` or `doPost` to
count the Orders tab, and Apps Script has no transactions — two concurrent submits both pass the
check anyway without `LockService`.

## Frontend

Single `index.html`, inline CSS + JS, no build step, no dependencies.

- Menu cards: name, description, price, allergen tags, media carousel (images + `<video muted
  playsinline preload="metadata">`, swipe/arrow nav, poster from the first image).
- Quantity stepper per dish. Running order total updates live.
- Form fields: name, email, optional notes, honeypot. **No delivery location field** — you already
  know where everyone is.
- Closed state when `is_open` is false: menu still visible, form replaced by "orders closed, back
  Monday".
- History section: archived weeks, dishes and prices, collapsed by default. Menus only — no order
  data, no counts.
- POST with `Content-Type: text/plain`. Apps Script does not answer CORS preflight (OPTIONS), and
  `text/plain` avoids triggering one.

Client-computed totals are display only. The script recomputes from the Menu tab before writing.

## Media

Committed to the repo under `media/`, referenced by relative path in the sheet.

Publishing a week is spreadsheet-only **when reusing existing dishes**. A new dish with new media
means a commit and a push.

Compress before committing — raw phone video is permanent repo weight:

```
ffmpeg -i in.mov -vcodec h264 -crf 28 -vf scale=720:-2 -an out.mp4
```

## Hosting

GitHub Pages, deploy on push to `main`. Custom domain optional.

## Sheet-side admin

- **Shopping list** — `=SUMIFS(qty, dish_id, "m01", week, $W$1, void, FALSE)` per dish. The thing that
  gets used most.
- **Money** — `SUMIF` of `line_total` by `order_id` for per-person totals, by `week` for the week.
- **Wednesday reminder** — time-based Apps Script trigger, emails the group a nudge. Does more for
  order numbers than any amount of frontend polish.

## Why not a hosted backend

The sheet already is the admin UI: pivot tables, shopping-list totals, payment tracking. A hosted
backend means owning deploys, secrets, a database *and* building a dashboard to look at the data.

**Revisit if:** payments move in-app, per-person edit links are needed, or this outgrows one office.
At that point: Cloudflare Pages Functions + D1, and Turnstile instead of a honeypot.

## Build order

1. Create the sheet — Menu and Orders tabs, headers, one week of real dishes.
2. Write and deploy `doGet`. Verify the JSON in a browser.
3. Build `index.html` against the live endpoint — menu, carousel, steppers, totals.
4. Add `doPost` — validation, honeypot, timing check, cutoff, receipt email.
5. Deploy the page, post the link, run one real week.
6. Add the Wednesday trigger and the shopping-list formulas.

Deploy note: redeploying Apps Script mints a new URL unless you publish to the **existing
deployment** (Deploy → Manage deployments → edit → New version). Keep the URL stable.
