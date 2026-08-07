# Lunch orders

Static page + Apps Script + a private Google Sheet. See [PLAN.md](PLAN.md) for the decisions and why.

## Setup

1. **Sheet** — new Google Sheet, File → Settings → locale/timezone `Australia/Sydney`.
   Extensions → Apps Script. Paste `apps-script/Code.gs`, and set the timezone in the manifest
   (⚙ Project Settings → show `appsscript.json`, then paste `apps-script/appsscript.json`).
2. Run `setupSheets()` once from the editor. Creates the Menu and Orders tabs with headers.
   Grant the permissions it asks for.
3. Set `PAYID` and `BUSINESS_NAME` at the top of `Code.gs`.
4. Fill the Menu tab with one week: `week` = the delivery Monday (`2026-08-10`), `status` = `live`.
5. **Deploy** → New deployment → Web app → Execute as **Me**, Access **Anyone**. Copy the `/exec` URL.
   Open it in a browser — you should see menu JSON.
6. Paste that URL into `ENDPOINT` in `index.html`.
7. Push to GitHub, enable Pages on `main`.

## Weekly rhythm

- **Publish** — in the Menu tab, set last week's rows to `archive`, paste new rows as `live` with next
  Monday's date. No deploy.
- **Friday** — read the Orders tab. Orders after Friday 5pm are rejected automatically.
- **Monday** — tick `paid` at handover.

New dishes with new media need the files committed under `media/` and pushed. Compress first:

```
ffmpeg -i in.mov -vcodec h264 -crf 28 -vf scale=720:-2 -an media/dish.mp4
```

## Redeploying the script

Deploy → **Manage deployments** → edit the existing one → New version. Creating a *new* deployment
mints a new URL and silently breaks the live page.

## Rules that are load-bearing

- No public endpoint reads the Orders tab. `doGet` returns menu data only; `doPost` returns `{ok}`.
- Never File → Share → Publish to web on the sheet.
- The PayID lives in the receipt email, never on the page.
