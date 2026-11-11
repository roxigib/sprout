# Sprout Baby Log

A private, offline baby tracker that you install on an Android phone as an app (PWA). No account, no subscription, no server: all data is stored on the phone.

## Features
- **One-tap logging**: Wet / Dirty / Both diapers, Nurse Left / Right timers, Sleep timer. Every log has **Undo** and **Edit**.
- **Nursing timer**: tap a side to start, tap the other side to switch, tap the running side to pause. It suggests which side to use next. Timers keep running if the app is closed.
- **Bottle, pumping (L/R), medicine (remembers recent meds), growth (weight/length/head), diapers (dry, poop color, notes)**.
- **"Past entry"** for anything you forgot to log, plus "5m / 15m / 30m / 1h ago" time shortcuts on every form.
- **24h / Today summary** with newborn day-of-life diaper goals and the 8–12 feeds/day guideline.
- **Predictions**: next sleep window (age-based wake windows, tuned to your logged sleeps), next feed estimate, and bedtime.
- **Timeline** grouped by day, with filters and a daily summary. Tap any entry to edit or delete it.
- **Trends**: 7-day charts and a weight chart that shows % change since birth weight.
- **Dark mode** for night feeds; ml/oz and kg/lb units.
- **Backup / restore** (JSON) and CSV export.

## Installing on your phone
The app needs to be served over HTTPS once so Chrome can install it. After that it works offline.

**Option A: Netlify Drop (easiest, free)**
1. On your computer, open https://app.netlify.com/drop and drag this whole folder onto the page.
2. Open the URL it gives you in **Chrome on your phone** → menu **⋮** → **Install app** (or **Add to Home screen**).

**Option B: GitHub Pages / Cloudflare Pages / any static host.** Upload these files: `index.html, styles.css, app.js, sw.js, manifest.webmanifest, icons/`.

The URL is public, but it contains only the empty app. Your baby's data never leaves the phone.

⚠️ Keep using the same URL. Data is tied to the address the app was installed from.

## Data safety
- Use **Settings → Back up** regularly and share the file to Google Drive or email it to yourself. The app reminds you weekly.
- Clearing Chrome's site data or uninstalling the app deletes the log. Restore it from a backup.

## Updating the app
Edit the files and re-upload them to the same host. The installed app picks up the new version the next time it is opened twice. If you change the file list, bump `CACHE` in `sw.js`.

## Local testing
`npx serve .` (or any static server), then open http://localhost:3000.
Regenerate the icons with `node tools/make-icons.js`.
