# Sprout Baby Log

A private, offline baby tracker that you install on an Android phone as an app (PWA). No subscription. By default all data stays on the phone. You can optionally turn on a **shared log**, so two parents can log on their own phones and see the same data (see below).

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
- **Shared log (optional)**: sign in with Google on both phones and see each other's entries, running timers, baby name and birth date, live. Logging still works offline and syncs later.

## Installing on your phone
The app needs to be served over HTTPS once so Chrome can install it. After that it works offline.

**Option A: Netlify Drop (easiest, free)**
1. On your computer, open https://app.netlify.com/drop and drag this whole folder onto the page.
2. Open the URL it gives you in **Chrome on your phone** → menu **⋮** → **Install app** (or **Add to Home screen**).

**Option B: GitHub Pages / Cloudflare Pages / any static host.** Upload these files: `index.html, styles.css, app.js, sync.js, firebase-config.js, sw.js, manifest.webmanifest, icons/`.

The URL is public, but it contains only the empty app. Without the shared log, your baby's data never leaves the phone. With it, data is stored in your own Firebase project, and only the Google accounts in your family can read it.

⚠️ Keep using the same URL. Data is tied to the address the app was installed from.

## Shared log (optional)
The app's files stay on whatever host you use (GitHub Pages is fine). The shared data lives in a free Firebase project that you own. Setup takes about 10 minutes and is done once, on a computer:

1. **Create the project.** Go to https://console.firebase.google.com → **Create a project** (any name, e.g. `sprout-baby`). You can turn off Google Analytics.
2. **Add a web app.** On the project overview, click the **</>** (Web) icon, give it a nickname, and skip Firebase Hosting. Firebase shows a `firebaseConfig = { ... }` block. Copy those values into `firebase-config.js`, replacing `export default null;` with `export default { apiKey: '...', authDomain: '...', ... };`.
3. **Turn on Google sign-in.** Go to **Build → Authentication → Get started → Sign-in method → Google → Enable**, pick a support email, and click **Save**. Then open **Settings → Authorized domains → Add domain** and add the domain your app is served from (e.g. `yourname.github.io` or `your-site.netlify.app`). `localhost` is already allowed for testing.
4. **Create the database.** Go to **Build → Firestore Database → Create database**, choose a location near you, and start in **production mode**.
5. **Lock it down.** In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and click **Publish**. This makes sure only your family can see your data.
6. **Re-upload the app** with the updated `firebase-config.js`, then open it twice on each phone so it picks up the new version.

**Connecting the phones**
1. Parent 1: **Settings → Shared log → Sign in with Google → Create a new shared log**. Everything already on this phone is uploaded.
2. Parent 1: enter Parent 2's Google email under **Invite** and tap **Send invite**.
3. Parent 2: **Settings → Shared log → Sign in with Google → Join …'s log**. Any entries already on that phone are merged in.

**What's shared:** all entries, running nursing/sleep timers, and the baby's name and birth date. Units and theme stay per phone.
**Offline:** logging works without a signal. Changes upload automatically when you're back online.
**Signing out:** the log stays on that phone, but stops syncing until you sign in again.
**Cost:** a baby log stays far within Firebase's free (Spark) plan.
**"Delete all data"** while signed in deletes the shared log for everyone.

## Data safety
- Backups are still worth making with the shared log on, since a mistaken delete syncs to both phones.
- Use **Settings → Back up** regularly and share the file to Google Drive or email it to yourself. The app reminds you weekly.
- Clearing Chrome's site data or uninstalling the app deletes the log. Restore it from a backup.

## Updating the app
Edit the files and re-upload them to the same host. The installed app picks up the new version the next time it is opened twice. If you change the file list, bump `CACHE` in `sw.js`. If you change `firestore.rules`, publish them again in the Firebase console.

## Local testing
`npx serve .` (or any static server), then open http://localhost:3000.
Regenerate the icons with `node tools/make-icons.js`.
