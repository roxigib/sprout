'use strict';
(() => {
// =====================================================================
// Constants & helpers
// =====================================================================
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const ML_PER_OZ = 29.5735, G_PER_OZ = 28.3495, CM_PER_IN = 2.54;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const round = (v, d = 0) => { const f = 10 ** d; return Math.round(v * f) / f; };
const vibrate = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} };

const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtDateTime = t => `${fmtDate(t)}, ${fmtTime(t)}`;
function dayLabel(t) {
  const d = startOfDay(t), today = startOfDay(Date.now());
  if (d === today) return 'Today';
  if (d === today - DAY) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`;
}
const fmtSecs = s => (s < 60 ? `${Math.round(s)}s` : fmtDur(s * 1000));
const ago = t => { const d = Date.now() - t; return d < MIN ? 'just now' : `${fmtDur(d)} ago`; };
const toLocalInput = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = s => (s ? new Date(s).getTime() : NaN);

// =====================================================================
// Storage (IndexedDB on the phone; optionally mirrored to a shared log, see sync.js)
// =====================================================================
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sprout-baby', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('entries', { keyPath: 'id' }); d.createObjectStore('kv'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  all() { return this.tx('entries', 'readonly', s => s.getAll()); },
  put(e) { return this.tx('entries', 'readwrite', s => { s.put(e); }); },
  putMany(list) { return this.tx('entries', 'readwrite', s => { list.forEach(e => s.put(e)); }); },
  del(id) { return this.tx('entries', 'readwrite', s => { s.delete(id); }); },
  clear() { return this.tx('entries', 'readwrite', s => { s.clear(); }); },
  get(k) { return this.tx('kv', 'readonly', s => s.get(k)); },
  set(k, v) { return this.tx('kv', 'readwrite', s => { s.put(v, k); }); },
};

const DEFAULTS = {
  babyName: 'Baby', birth: null, vol: 'ml', measure: 'metric', theme: 'auto',
  sumMode: '24h', lastBackup: null, recentMeds: [], bottleLast: null, bottleKind: 'breast', installDismissed: false,
};
const S = {
  entries: [], settings: { ...DEFAULTS }, timers: { sleep: null, nurse: null },
  tab: 'home', filter: 'all', days: 7, sel: {}, installPrompt: null, persisted: null,
};

let Sync = null; // shared-log module, loaded at boot when firebase-config.js is filled in
const sortEntries = () => S.entries.sort((a, b) => b.start - a.start);
async function addEntry(e) {
  e.id = e.id || uid(); e.created = e.created || Date.now(); e.updated = Date.now();
  S.entries = S.entries.filter(x => x.id !== e.id); S.entries.push(e); sortEntries();
  await DB.put(e); Sync?.pushEntry(e); return e;
}
async function updateEntry(e) {
  e.updated = Date.now();
  const i = S.entries.findIndex(x => x.id === e.id);
  if (i >= 0) S.entries[i] = e; else S.entries.push(e);
  sortEntries(); await DB.put(e); Sync?.pushEntry(e);
}
async function deleteEntry(id) { S.entries = S.entries.filter(x => x.id !== id); await DB.del(id); Sync?.pushDelete(id); }
const saveSettings = () => DB.set('settings', S.settings);
async function saveTimers() { S.timers.updated = Date.now(); await DB.set('timers', S.timers); Sync?.pushTimers(); }
// Baby name & birth date are shared with the family; units/theme stay per phone.
async function saveProfile() { S.settings.profileUpdated = Date.now(); await saveSettings(); Sync?.pushProfile(); }

// ---------- Applying changes that arrive from the shared log ----------
const stampOf = e => e.updated || e.created || 0;
let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    // Don't wipe what someone is typing in Settings; re-render once they leave the field.
    const a = document.activeElement;
    if (a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { a.addEventListener('blur', renderSoon, { once: true }); return; }
    render();
  }, 50);
}
const syncBridge = {
  state: () => S,
  changed: renderSoon,
  async applyEntries(list) {
    const byId = new Map(S.entries.map(e => [e.id, e]));
    const puts = [], dels = [];
    for (const r of list) {
      const cur = byId.get(r.id);
      if (r.deleted) { if (cur && stampOf(r) >= stampOf(cur)) { byId.delete(r.id); dels.push(r.id); } }
      else if (TYPES[r.type] && isFinite(r.start) && r.data && (!cur || stampOf(r) > stampOf(cur))) { byId.set(r.id, r); puts.push(r); }
    }
    if (!puts.length && !dels.length) return;
    S.entries = [...byId.values()]; sortEntries();
    if (puts.length) await DB.putMany(puts);
    for (const id of dels) await DB.del(id);
    renderSoon();
  },
  async applyTimers(t) {
    S.timers = { sleep: t.sleep || null, nurse: t.nurse || null, updated: t.updated };
    await DB.set('timers', S.timers); renderSoon();
  },
  async applyProfile(p) {
    Object.assign(S.settings, { babyName: p.babyName || 'Baby', birth: p.birth ?? null, profileUpdated: p.updated });
    await saveSettings(); renderSoon();
  },
};

// =====================================================================
// Units
// =====================================================================
const isOz = () => S.settings.vol === 'oz';
const isImp = () => S.settings.measure === 'imperial';
const volUnit = () => (isOz() ? 'oz' : 'ml');
const volIn = ml => (isOz() ? round(ml / ML_PER_OZ, 2) : Math.round(ml));
const volToMl = v => (isOz() ? v * ML_PER_OZ : v);
const volOut = ml => (isOz() ? `${round(ml / ML_PER_OZ, 1)} oz` : `${Math.round(ml)} ml`);
function weightOut(g) {
  if (!isImp()) return `${round(g / 1000, 3)} kg`;
  const oz = g / G_PER_OZ, lb = Math.floor(oz / 16);
  return `${lb} lb ${round(oz - lb * 16, 1)} oz`;
}
const lenOut = cm => (isImp() ? `${round(cm / CM_PER_IN, 2)} in` : `${round(cm, 1)} cm`);

// =====================================================================
// Entry types & descriptions
// =====================================================================
const TYPES = {
  nurse: { label: 'Nursing', icon: '🤱', cls: 'nurse' },
  bottle: { label: 'Bottle', icon: '🍼', cls: 'bottle' },
  pump: { label: 'Pumping', icon: '🥛', cls: 'pump' },
  diaper: { label: 'Diaper', icon: '🧷', cls: 'wet' },
  sleep: { label: 'Sleep', icon: '😴', cls: 'sleep' },
  med: { label: 'Medicine', icon: '💊', cls: 'med' },
  growth: { label: 'Growth', icon: '📏', cls: 'growth' },
};
const DIAPER = {
  wet: { label: 'Wet', icon: '💧', cls: 'wet' },
  dirty: { label: 'Dirty', icon: '💩', cls: 'dirty' },
  mixed: { label: 'Wet + dirty', icon: '💩', cls: 'dirty' },
  dry: { label: 'Dry', icon: '⚪', cls: 'wet' },
};
const POOP_COLORS = { yellow: 'Yellow', green: 'Green', brown: 'Brown', black: 'Black / tar', other: 'Other' };
const BOTTLE_KINDS = { breast: 'Breast milk', formula: 'Formula', mixed: 'Mixed' };
const isFeed = e => e.type === 'nurse' || e.type === 'bottle';
const isWet = e => e.type === 'diaper' && (e.data.kind === 'wet' || e.data.kind === 'mixed');
const isDirty = e => e.type === 'diaper' && (e.data.kind === 'dirty' || e.data.kind === 'mixed');

const entryCls = e => (e.type === 'diaper' ? (DIAPER[e.data.kind] || DIAPER.wet).cls : TYPES[e.type].cls);
const entryIcon = e => (e.type === 'diaper' ? (DIAPER[e.data.kind] || DIAPER.wet).icon : TYPES[e.type].icon);
function entryTitle(e) {
  if (e.type === 'diaper') return `${(DIAPER[e.data.kind] || DIAPER.wet).label} diaper`;
  if (e.type === 'med') return e.data.name || 'Medicine';
  if (e.type === 'bottle') return `Bottle · ${volOut(e.data.amount || 0)}`;
  return TYPES[e.type].label;
}
function entryDetail(e) {
  const d = e.data || {}, p = [];
  switch (e.type) {
    case 'nurse': {
      const l = d.left || 0, r = d.right || 0;
      if (l) p.push(`L ${fmtSecs(l)}`);
      if (r) p.push(`R ${fmtSecs(r)}`);
      if (l && r) p.push(`total ${fmtSecs(l + r)}`);
      if (d.last) p.push(`ended ${d.last === 'L' ? 'left' : 'right'}`);
      break;
    }
    case 'bottle': p.push(BOTTLE_KINDS[d.kind] || ''); break;
    case 'pump': {
      if (d.left) p.push(`L ${volOut(d.left)}`);
      if (d.right) p.push(`R ${volOut(d.right)}`);
      p.push(`total ${volOut((d.left || 0) + (d.right || 0))}`);
      if (e.end) p.push(fmtDur(e.end - e.start));
      break;
    }
    case 'diaper': if (d.color) p.push(`${POOP_COLORS[d.color] || d.color} poop`); break;
    case 'sleep': p.push(`${fmtDur(e.end - e.start)} · until ${fmtTime(e.end)}`); break;
    case 'med': if (d.dose) p.push(d.dose); break;
    case 'growth':
      if (d.weight) p.push(weightOut(d.weight));
      if (d.length) p.push(`length ${lenOut(d.length)}`);
      if (d.head) p.push(`head ${lenOut(d.head)}`);
      break;
  }
  if (e.note) p.push(`“${e.note}”`);
  return p.filter(Boolean).join(' · ');
}

// =====================================================================
// Baby age & guidelines
// =====================================================================
const ageDays = () => (S.settings.birth ? (Date.now() - S.settings.birth) / DAY : null);
function ageText() {
  const b = S.settings.birth;
  if (!b) return 'Tap to set birth date';
  const ms = Date.now() - b;
  if (ms < 0) return 'Birth date is in the future';
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR);
  if (d < 14) return `Day ${d + 1} of life · ${d ? `${d}d ` : ''}${h}h old`;
  if (d < 98) return `${Math.floor(d / 7)} wk ${d % 7} d old`;
  const mo = Math.floor(d / 30.44);
  return `${mo} months old`;
}
// Typical newborn output by day of life (common lactation guidance).
function diaperGoals() {
  const a = ageDays();
  if (a == null || a > 42) return null;
  const dol = Math.floor(a) + 1;
  return { wet: Math.min(dol, 6), dirty: Math.min(dol, 3), dol };
}
const feedGoal = () => { const a = ageDays(); return a != null && a < 56 ? [8, 12] : null; };

// Wake windows in minutes by age (days): [upToDays, min, max]
const WAKE = [[28, 35, 60], [56, 60, 90], [84, 75, 105], [120, 90, 120], [180, 105, 150], [270, 150, 180], [365, 180, 240], [Infinity, 240, 330]];
function ageWindow() {
  const a = ageDays();
  if (a == null) return [35, 60];
  for (const [lim, lo, hi] of WAKE) if (a < lim) return [lo, hi];
}

// =====================================================================
// Predictions
// =====================================================================
const finishedSleeps = () => S.entries.filter(e => e.type === 'sleep' && e.end).sort((a, b) => a.start - b.start);

function predictNap(now) {
  const [lo, hi] = ageWindow();
  if (S.timers.sleep) return { asleep: true, since: S.timers.sleep.start, lo, hi };
  const sl = finishedSleeps();
  const last = sl[sl.length - 1];
  if (!last) return { none: true, lo, hi };
  if (now - last.end > 8 * HOUR) return { stale: true, lastEnd: last.end, lo, hi };
  // Personalize from recent daytime wake windows (last 3 days)
  const gaps = [];
  for (let i = 1; i < sl.length; i++) {
    if (sl[i].start < now - 3 * DAY) continue;
    const g = (sl[i].start - sl[i - 1].end) / MIN, h = new Date(sl[i - 1].end).getHours();
    if (h >= 7 && h < 19 && g >= 15 && g <= 300) gaps.push(g);
  }
  let center = (lo + hi) / 2, personalized = false;
  const half = (hi - lo) / 2;
  if (gaps.length >= 4) {
    center = clamp(0.5 * center + 0.5 * median(gaps), lo * 0.8, hi * 1.25);
    personalized = true;
  }
  return { lastEnd: last.end, start: last.end + (center - half) * MIN, end: last.end + (center + half) * MIN, personalized, lo, hi, n: gaps.length };
}

function predictBedtime(now) {
  const a = ageDays() ?? 0;
  const minLen = a < 56 ? 2 * HOUR : 4 * HOUR;
  const byEvening = {};
  for (const s of finishedSleeps()) {
    if (s.start < now - 8 * DAY || s.end - s.start < minLen) continue;
    const h = new Date(s.start).getHours();
    if (!(h >= 18 || h < 2)) continue;
    const k = dayKey(s.start - 6 * HOUR);
    if (!byEvening[k] || s.start < byEvening[k].start) byEvening[k] = s;
  }
  const mins = Object.values(byEvening).map(s => { const d = new Date(s.start); let m = d.getHours() * 60 + d.getMinutes(); if (m < 360) m += 1440; return m; });
  let lo, hi, basis;
  if (mins.length >= 3) { const m = median(mins); lo = m - 30; hi = m + 30; basis = `Based on ${mins.length} recent nights`; }
  else if (a < 56) { lo = 21 * 60; hi = 23 * 60; basis = 'Newborns don’t have a set bedtime yet; the longest stretch usually starts late evening'; }
  else if (a < 120) { lo = 19.5 * 60; hi = 21 * 60; basis = 'Typical for this age'; }
  else { lo = 18.5 * 60; hi = 20 * 60; basis = 'Typical for this age'; }
  let base = startOfDay(now);
  // If tonight's window already passed (and it's after the window), show tomorrow
  if (now > base + hi * MIN && new Date(now).getHours() >= 6) base += DAY;
  if (new Date(now).getHours() < 6) base -= DAY; // after midnight, still "tonight"
  return { start: base + lo * MIN, end: base + hi * MIN, basis, personalized: mins.length >= 3 };
}

function predictFeed(now) {
  const feeds = S.entries.filter(e => isFeed(e) && e.start > now - 2 * DAY).sort((a, b) => a.start - b.start);
  const last = S.entries.find(isFeed);
  if (!last) return null;
  const ints = [];
  for (let i = 1; i < feeds.length; i++) { const d = feeds[i].start - feeds[i - 1].start; if (d >= 30 * MIN && d <= 6 * HOUR) ints.push(d); }
  const a = ageDays();
  let interval = a != null && a > 60 ? 3 * HOUR : 2.5 * HOUR, personalized = false;
  if (ints.length >= 3) { interval = median(ints.slice(-10)); personalized = true; }
  return { last, next: last.start + interval, interval, personalized };
}

function suggestSide() {
  const n = S.entries.find(e => e.type === 'nurse');
  if (!n) return null;
  const last = n.data.last || (n.data.right ? 'R' : 'L');
  return last === 'L' ? 'R' : 'L';
}

// =====================================================================
// Timers
// =====================================================================
function nurseMs(side, now = Date.now()) {
  const n = S.timers.nurse; if (!n) return 0;
  let acc = side === 'L' ? n.left : n.right;
  if (n.side === side && n.since) acc += now - n.since;
  return acc;
}
function nurseFreeze(n, now) {
  if (n.since) { if (n.side === 'L') n.left += now - n.since; else n.right += now - n.since; n.since = null; }
}
async function nurseTap(side) {
  const now = Date.now(); let n = S.timers.nurse;
  if (!n) { S.timers.nurse = { startedAt: now, left: 0, right: 0, side, since: now }; }
  else if (n.side === side && n.since) nurseFreeze(n, now); // tap active side = pause
  else { nurseFreeze(n, now); n.side = side; n.since = now; }
  vibrate(); await saveTimers(); render();
}
async function nursePause() {
  const n = S.timers.nurse; if (!n) return;
  const now = Date.now();
  if (n.since) nurseFreeze(n, now); else n.since = now;
  await saveTimers(); render();
}
async function nurseSave(endAt) {
  const n = S.timers.nurse; if (!n) return;
  let now = Date.now(); nurseFreeze(n, now);
  if (endAt != null && endAt < now) {
    // Trim the time after the chosen end, starting with the side that was active last
    let extra = now - endAt; const sides = n.side === 'L' ? ['left', 'right'] : ['right', 'left'];
    for (const k of sides) { const cut = Math.min(extra, n[k]); n[k] -= cut; extra -= cut; }
    now = endAt;
  }
  const left = Math.round(n.left / 1000), right = Math.round(n.right / 1000);
  S.timers.nurse = null; await saveTimers();
  if (left + right < 5) { toast('Timer under 5 seconds — not saved'); render(); return; }
  const e = await addEntry({ type: 'nurse', start: n.startedAt, end: now, data: { left, right, last: n.side }, note: '' });
  vibrate(25); render(); toastLogged(e, `Nursing saved · ${fmtSecs(left + right)}`);
}
async function sleepStart() {
  S.timers.sleep = { start: Date.now() }; vibrate(); await saveTimers(); render();
  toast('Sleep timer started 😴');
}
async function sleepSave(endAt) {
  const t = S.timers.sleep; if (!t) return;
  const now = endAt ?? Date.now(); S.timers.sleep = null; await saveTimers();
  if (now - t.start < 30 * 1000) { toast('Sleep under 30 seconds — not saved'); render(); return; }
  const e = await addEntry({ type: 'sleep', start: t.start, end: now, data: {}, note: '' });
  vibrate(25); render(); toastLogged(e, `Sleep saved · ${fmtDur(now - t.start)}`);
}
async function timerDiscard(which) {
  if (!confirm(`Discard this ${which === 'nurse' ? 'nursing' : 'sleep'} timer without saving?`)) return;
  S.timers[which] = null; await saveTimers(); render();
}
function timerAdjust(which) {
  const cur = which === 'nurse' ? S.timers.nurse.startedAt : S.timers.sleep.start;
  openSheet(`
    <h3 class="sheet-title">Adjust times</h3>
    <form id="adjForm">
      ${timeField('start', cur, which === 'nurse' ? 'Nursing started at' : 'Fell asleep at')}
      <p class="muted small">${which === 'nurse' ? 'Extra time is added to the side currently selected.' : ''}</p>
      ${timeField('end', null, which === 'nurse' ? 'Nursing ended at (optional)' : 'Woke up at (optional)', true)}
      <p class="muted small">Set an end time to stop the timer and save it as of that time.</p>
      <div class="sheet-actions"><button type="button" class="btn" data-action="sheet-close">Cancel</button><button class="btn primary">Update</button></div>
    </form>`);
  $('#adjForm').onsubmit = async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const t = fromLocalInput(fd.get('start')), end = fromLocalInput(fd.get('end'));
    if (!isFinite(t) || t > Date.now()) { toast('Pick a time in the past'); return; }
    if (isFinite(end) && end <= t) { toast('End time must be after start time'); return; }
    if (isFinite(end) && end > Date.now() + MIN) { toast('End time is in the future'); return; }
    if (which === 'nurse') {
      const n = S.timers.nurse; if (!n) return closeSheet();
      const diff = n.startedAt - t, k = n.side === 'L' ? 'left' : 'right';
      n[k] = Math.max(0, n[k] + diff); n.startedAt = t;
    } else if (S.timers.sleep) S.timers.sleep.start = t;
    await saveTimers(); closeSheet();
    if (isFinite(end)) { const at = Math.min(end, Date.now()); await (which === 'nurse' ? nurseSave(at) : sleepSave(at)); }
    else render();
  };
}

// =====================================================================
// Summaries
// =====================================================================
function summarize(from, to) {
  const out = { feeds: 0, nurseSec: 0, bottleMl: 0, pumpMl: 0, wet: 0, dirty: 0, sleepMs: 0, meds: 0 };
  for (const e of S.entries) {
    if (e.type === 'sleep') {
      const ov = Math.min(e.end, to) - Math.max(e.start, from);
      if (ov > 0) out.sleepMs += ov;
      continue;
    }
    if (e.start < from || e.start >= to) continue;
    if (isFeed(e)) out.feeds++;
    if (e.type === 'nurse') out.nurseSec += (e.data.left || 0) + (e.data.right || 0);
    if (e.type === 'bottle') out.bottleMl += e.data.amount || 0;
    if (e.type === 'pump') out.pumpMl += (e.data.left || 0) + (e.data.right || 0);
    if (isWet(e)) out.wet++;
    if (isDirty(e)) out.dirty++;
    if (e.type === 'med') out.meds++;
  }
  if (S.timers.sleep) { const ov = Math.min(Date.now(), to) - Math.max(S.timers.sleep.start, from); if (ov > 0) out.sleepMs += ov; }
  return out;
}

// =====================================================================
// Rendering
// =====================================================================
const view = () => $('#view');
function render() {
  $('#babyName').textContent = S.settings.babyName || 'Baby';
  $('#babyAge').textContent = ageText();
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
  applyTheme();
  const html = { home: renderHome, log: renderLog, stats: renderStats, settings: renderSettings }[S.tab]();
  view().innerHTML = html;
  if (S.tab === 'settings') bindSettings();
}

function renderHome() {
  const now = Date.now();
  const lastFeed = S.entries.find(isFeed), lastDiaper = S.entries.find(e => e.type === 'diaper');
  const side = suggestSide(), n = S.timers.nurse;
  const today = summarize(startOfDay(now), now + 1);
  const lastBottle = S.entries.find(e => e.type === 'bottle'), lastMed = S.entries.find(e => e.type === 'med');
  const lastSleep = S.entries.find(e => e.type === 'sleep');

  const nurseBtn = s => {
    const on = n && n.side === s, running = on && n.since;
    const badge = !n && side === s ? '<span class="badge">Next</span>' : '';
    const sub = n ? (running ? 'Running — tap to pause' : on ? 'Paused — tap to resume' : 'Tap to switch') : (side === s ? 'Suggested side' : 'Start timer');
    return `<button class="act nurse" data-action="nurse-tap" data-side="${s}">${badge}${on ? '<span class="ring"></span>' : ''}
      <span class="ico">🤱</span><span class="t">Nurse ${s}</span><span class="s">${sub}</span></button>`;
  };

  return `
    ${renderBanners()}
    ${renderTimers()}
    <div class="status-strip">
      <div class="stat"><div class="lbl">Last feed</div><div class="val">${lastFeed ? ago(lastFeed.start) : '—'}</div>
        <div class="sub">${lastFeed ? `${fmtTime(lastFeed.start)} · ${lastFeed.type === 'nurse' ? (side ? `next: ${side === 'L' ? 'Left' : 'Right'}` : 'nursing') : volOut(lastFeed.data.amount)}` : 'No feeds yet'}</div></div>
      <div class="stat"><div class="lbl">Last diaper</div><div class="val">${lastDiaper ? ago(lastDiaper.start) : '—'}</div>
        <div class="sub">${lastDiaper ? `${fmtTime(lastDiaper.start)} · ${DIAPER[lastDiaper.data.kind].label}` : 'No diapers yet'}</div></div>
    </div>

    <div class="grid three">
      ${nurseBtn('L')}
      ${nurseBtn('R')}
      <button class="act bottle" data-action="open" data-type="bottle"><span class="ico">🍼</span><span class="t">Bottle</span><span class="s">${lastBottle ? volOut(lastBottle.data.amount) + ' last' : 'Log amount'}</span></button>
      <button class="act wet" data-action="diaper" data-kind="wet"><span class="ico">💧</span><span class="t">Wet</span><span class="s">${today.wet} today</span></button>
      <button class="act dirty" data-action="diaper" data-kind="dirty"><span class="ico">💩</span><span class="t">Dirty</span><span class="s">${today.dirty} today</span></button>
      <button class="act dirty" data-action="diaper" data-kind="mixed"><span class="ico">💧💩</span><span class="t">Both</span><span class="s">wet + dirty</span></button>
      ${S.timers.sleep
        ? `<button class="act sleep" data-action="sleep-save"><span class="ring"></span><span class="ico">🌤️</span><span class="t">Woke up</span><span class="s">stop sleep</span></button>`
        : `<button class="act sleep" data-action="sleep-start"><span class="ico">😴</span><span class="t">Sleep</span><span class="s">${lastSleep ? 'awake ' + fmtDur(now - lastSleep.end) : 'Start timer'}</span></button>`}
      <button class="act pump" data-action="open" data-type="pump"><span class="ico">🥛</span><span class="t">Pump</span><span class="s">Log session</span></button>
      <button class="act med" data-action="open" data-type="med"><span class="ico">💊</span><span class="t">Meds</span><span class="s">${lastMed ? ago(lastMed.start) : 'Log dose'}</span></button>
      <button class="act growth" data-action="open" data-type="growth"><span class="ico">📏</span><span class="t">Growth</span><span class="s">Weight · length</span></button>
      <button class="act wet" data-action="open" data-type="diaper"><span class="ico">🧷</span><span class="t">Diaper…</span><span class="s">dry · color · note</span></button>
      <button class="act" data-action="pick-past"><span class="ico">🕘</span><span class="t">Past entry</span><span class="s">forgot to log?</span></button>
    </div>

    ${renderSummary()}
    ${renderPredictions()}
  `;
}

function renderBanners() {
  let out = '';
  const standalone = matchMedia('(display-mode: standalone)').matches;
  if (S.installPrompt && !standalone && !S.settings.installDismissed) {
    out += `<div class="banner">📲 <span>Install to your home screen for offline use.</span><button data-action="install">Install</button><button data-action="dismiss-install" aria-label="Dismiss">✕</button></div>`;
  }
  const n = S.entries.length, lb = S.settings.lastBackup;
  if (n >= 30 && (!lb || Date.now() - lb > 7 * DAY)) {
    out += `<div class="banner">💾 <span>${lb ? `Last backup ${Math.floor((Date.now() - lb) / DAY)} days ago.` : 'You haven’t backed up yet.'} Save a copy of your log.</span><button data-action="export-json">Back up</button></div>`;
  }
  return out;
}

function renderTimers() {
  let out = '';
  const n = S.timers.nurse, now = Date.now();
  if (n) {
    const side = s => `<button class="side ${n.side === s && n.since ? 'on' : ''}" data-action="nurse-tap" data-side="${s}">
        <div class="nm">${s === 'L' ? 'LEFT' : 'RIGHT'}</div><div class="tm" data-live="nurse${s}">${fmtClock(nurseMs(s, now))}</div>
        <div class="hint">${n.side === s ? (n.since ? 'running · tap to pause' : 'paused · tap to resume') : 'tap to switch'}</div></button>`;
    out += `<div class="card timer nurse">
      <div class="timer-head"><span>🤱 Nursing · started ${fmtTime(n.startedAt)}</span><button data-action="timer-adjust" data-which="nurse">adjust</button></div>
      <div class="sides">${side('L')}${side('R')}</div>
      <div class="big-clock" style="font-size:22px">Total <span data-live="nurseT">${fmtClock(nurseMs('L', now) + nurseMs('R', now))}</span></div>
      <div class="btnrow">
        <button class="btn danger" data-action="timer-discard" data-which="nurse" style="flex:0 0 auto">✕</button>
        <button class="btn" data-action="nurse-pause">${n.since ? '⏸ Pause' : '▶ Resume'}</button>
        <button class="btn primary" data-action="nurse-save">✓ Done</button>
      </div></div>`;
  }
  const s = S.timers.sleep;
  if (s) {
    out += `<div class="card timer sleep">
      <div class="timer-head"><span>😴 Sleeping since ${fmtTime(s.start)}</span><button data-action="timer-adjust" data-which="sleep">adjust</button></div>
      <div class="big-clock" data-live="sleep">${fmtClock(now - s.start)}</div>
      <div class="btnrow">
        <button class="btn danger" data-action="timer-discard" data-which="sleep" style="flex:0 0 auto">✕</button>
        <button class="btn primary" data-action="sleep-save">🌤️ Woke up</button>
      </div></div>`;
  }
  return out;
}

function renderSummary() {
  const now = Date.now(), mode = S.settings.sumMode;
  const from = mode === 'today' ? startOfDay(now) : now - DAY;
  const s = summarize(from, now + 1), g = diaperGoals(), fg = feedGoal();
  const goal = (v, target, label) => {
    if (target == null) return '';
    const met = v >= target;
    return `<div class="goal ${met ? 'met' : 'low'}">${met ? '✓' : '○'} goal ${label}</div>`;
  };
  const cell = (ico, lbl, val, extra = '') => `<div class="sum"><div class="lbl">${ico} ${lbl}</div><div class="val">${val}</div>${extra}</div>`;
  return `
    <h2>Summary</h2>
    <div class="card">
      <div class="card-title"><span>${mode === 'today' ? 'Today (since midnight)' : 'Last 24 hours'}</span>
        <div class="mini-seg"><button data-action="sum-mode" data-mode="24h" class="${mode === '24h' ? 'on' : ''}">24h</button><button data-action="sum-mode" data-mode="today" class="${mode === 'today' ? 'on' : ''}">Today</button></div></div>
      <div class="sum-grid">
        ${cell('💧', 'Wet diapers', s.wet, g ? goal(s.wet, g.wet, `${g.wet}+`) : '')}
        ${cell('💩', 'Dirty diapers', s.dirty, g ? goal(s.dirty, g.dirty, `${g.dirty}+`) : '')}
        ${cell('🍼', 'Feeds', s.feeds, fg ? goal(s.feeds, fg[0], `${fg[0]}–${fg[1]}`) : '')}
        ${cell('🤱', 'Nursing time', s.nurseSec ? fmtSecs(s.nurseSec) : '0m')}
        ${s.bottleMl ? cell('🍼', 'Bottle total', volOut(s.bottleMl)) : ''}
        ${s.pumpMl ? cell('🥛', 'Pumped', volOut(s.pumpMl)) : ''}
        ${cell('😴', 'Sleep', fmtDur(s.sleepMs))}
      </div>
      ${g ? `<div class="note">Day ${g.dol} of life guideline: about ${g.wet}+ wet and ${g.dirty}+ dirty diapers per day. Always follow your care team’s advice.</div>` : (S.settings.birth ? '' : '<div class="note">Set the birth date in Settings to see day-of-life diaper goals.</div>')}
    </div>`;
}

function renderPredictions() {
  const now = Date.now(), p = predictNap(now), bed = predictBedtime(now), f = predictFeed(now);
  const row = (ico, title, big, why, extra = '') => `<div class="pred"><div class="ico">${ico}</div><div class="main"><div class="muted small">${title}</div><div class="big">${big}</div><div class="why">${why}</div>${extra}</div></div>`;
  let nap;
  if (p.asleep) nap = row('😴', 'Sleep', `Asleep ${fmtDur(now - p.since)}`, 'The next wake window is calculated when baby wakes up.');
  else if (p.none) nap = row('😴', 'Next sleep window', 'Log a sleep first', `Tap <b>Sleep</b> when baby falls asleep. At this age babies are usually awake about ${p.lo}–${p.hi} min between sleeps.`);
  else if (p.stale) nap = row('😴', 'Next sleep window', 'No recent sleep logged', `Last sleep ended ${ago(p.lastEnd)}. Log sleeps to keep predictions accurate. Typical wake window: ${p.lo}–${p.hi} min.`);
  else {
    let pill;
    if (now < p.start) pill = `<span class="pill">in ${fmtDur(p.start - now)}</span>`;
    else if (now <= p.end) pill = '<span class="pill now">window open</span>';
    else pill = `<span class="pill late">${fmtDur(now - p.end)} past</span>`;
    const span = p.end + 30 * MIN - p.lastEnd, pos = t => clamp(((t - p.lastEnd) / span) * 100, 0, 100);
    const bar = `<div class="bar"><div class="win" style="left:${pos(p.start)}%;width:${pos(p.end) - pos(p.start)}%"></div><div class="now" style="left:calc(${pos(now)}% - 1px)"></div></div>`;
    nap = row('😴', 'Next sleep window', `${fmtTime(p.start)} – ${fmtTime(p.end)}${pill}`,
      `Awake since ${fmtTime(p.lastEnd)} (${fmtDur(now - p.lastEnd)}). ${p.personalized ? `Tuned to baby’s recent wake windows (${p.n}) and age.` : `Typical wake window for age: ${p.lo}–${p.hi} min.`}`, bar);
  }
  const bedRow = row('🌙', 'Bedtime', `${fmtTime(bed.start)} – ${fmtTime(bed.end)}`, bed.basis + '.');
  let feedRow = '';
  if (f) {
    const due = f.next - now;
    const pill = due > 0 ? `<span class="pill">in ${fmtDur(due)}</span>` : `<span class="pill late">due</span>`;
    const long = (ageDays() ?? 0) < 28 && now - f.last.start > 3 * HOUR ? ' <b>It’s been over 3 hours</b> — newborns usually feed at least every 2–3 hours.' : '';
    feedRow = row('🍼', 'Next feed (estimate)', `~${fmtTime(f.next)}${pill}`, `${f.personalized ? `Feeding about every ${fmtDur(f.interval)} lately` : `Typical interval ~${fmtDur(f.interval)}`} · last ${ago(f.last.start)}.${long}`);
  }
  return `<h2>Predictions</h2><div class="card">${nap}${feedRow}${bedRow}
    <div class="note">Estimates from baby’s age and your logs. Newborn sleep is irregular, so treat these as a guide and follow baby’s cues.</div></div>`;
}

// ---------- Timeline ----------
const FILTERS = [['all', 'All'], ['feeds', '🍼 Feeds'], ['diaper', '🧷 Diapers'], ['sleep', '😴 Sleep'], ['pump', '🥛 Pump'], ['med', '💊 Meds'], ['growth', '📏 Growth']];
const matchFilter = (e, f) => f === 'all' || (f === 'feeds' ? isFeed(e) : e.type === f);
function rowHTML(e) {
  return `<button class="row" data-action="edit" data-id="${e.id}">
    <span class="rico" style="--t:var(--t-${entryCls(e)})">${entryIcon(e)}</span>
    <span class="rmain"><div class="rt">${esc(entryTitle(e))}</div><div class="rd">${esc(entryDetail(e)) || '&nbsp;'}</div></span>
    <span class="rtime">${fmtTime(e.start)}</span></button>`;
}
function renderLog() {
  const now = Date.now(), cutoff = startOfDay(now) - (S.days - 1) * DAY;
  const list = S.entries.filter(e => matchFilter(e, S.filter));
  const shown = list.filter(e => e.start >= cutoff);
  const groups = new Map();
  for (const e of shown) { const k = dayKey(e.start); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  let html = `<div class="chips" style="margin-top:6px">${FILTERS.map(([k, l]) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-action="filter" data-f="${k}">${l}</button>`).join('')}</div>`;
  if (!shown.length) html += `<div class="empty">${S.entries.length ? 'Nothing logged in this period.' : 'No entries yet.<br>Log something from the Home tab.'}</div>`;
  for (const [, items] of groups) {
    const d0 = startOfDay(items[0].start), s = summarize(d0, d0 + DAY);
    html += `<div class="day-head"><strong>${dayLabel(items[0].start)}</strong><span>${s.feeds} feed${s.feeds === 1 ? '' : 's'} · ${s.wet} wet · ${s.dirty} dirty · ${fmtDur(s.sleepMs)} sleep</span></div>
      <div class="rows">${items.map(rowHTML).join('')}</div>`;
  }
  if (list.some(e => e.start < cutoff)) html += `<button class="btn full" style="margin-top:14px" data-action="more-days">Show earlier days</button>`;
  return html;
}

// ---------- Trends ----------
function renderStats() {
  const today = startOfDay(Date.now());
  const days = Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY);
  const sums = days.map(d => summarize(d, d + DAY));
  const metrics = [
    { k: 'feeds', label: 'Feeds per day', c: '--c-nurse', v: s => s.feeds, f: v => `${v}`, always: true },
    { k: 'wet', label: 'Wet diapers per day', c: '--c-wet', v: s => s.wet, f: v => `${v}`, always: true },
    { k: 'dirty', label: 'Dirty diapers per day', c: '--c-dirty', v: s => s.dirty, f: v => `${v}`, always: true },
    { k: 'sleep', label: 'Sleep per day', c: '--c-sleep', v: s => s.sleepMs / HOUR, f: v => fmtDur(v * HOUR), always: true },
    { k: 'nurse', label: 'Nursing time per day', c: '--c-nurse', v: s => s.nurseSec / 60, f: v => fmtDur(v * MIN) },
    { k: 'bottle', label: 'Bottle volume per day', c: '--c-bottle', v: s => s.bottleMl, f: v => volOut(v) },
    { k: 'pump', label: 'Pumped per day', c: '--c-pump', v: s => s.pumpMl, f: v => volOut(v) },
  ];
  let html = '<h2>Last 7 days</h2>';
  for (const m of metrics) {
    const vals = sums.map(m.v);
    if (!m.always && !vals.some(v => v > 0)) continue;
    const max = Math.max(...vals, 0.0001);
    const nonZeroDays = vals.slice(0, 6).filter(v => v > 0);
    const avg = nonZeroDays.length ? nonZeroDays.reduce((a, b) => a + b, 0) / nonZeroDays.length : null;
    const sel = S.sel[m.k];
    html += `<div class="card chart-card">
      <div class="card-title"><span>${m.label}</span></div>
      <div class="headline">${m.f(vals[6])}<small>today</small>${avg != null ? `<small>· avg ${m.f(round(avg, 1))}/day</small>` : ''}</div>
      <div class="bars" style="--c:var(${m.c})">${vals.map((v, i) => `<button class="b ${v ? '' : 'zero'} ${sel === i ? 'sel' : ''}" data-action="bar" data-m="${m.k}" data-i="${i}" aria-label="${dayLabel(days[i])}: ${m.f(v)}"><i style="height:${v ? Math.max(3, (v / max) * 100) : 2}%"></i></button>`).join('')}</div>
      <div class="xlab">${days.map(d => `<span>${new Date(d).toLocaleDateString([], { weekday: 'narrow' })}</span>`).join('')}</div>
      <div class="readout">${sel != null ? `${dayLabel(days[sel])}: <b>${m.f(vals[sel])}</b>` : 'Tap a bar for details'}</div>
    </div>`;
  }
  html += renderGrowth();
  return html;
}

function renderGrowth() {
  const g = S.entries.filter(e => e.type === 'growth').sort((a, b) => a.start - b.start);
  let html = '<h2>Growth</h2>';
  if (!g.length) return html + `<div class="card empty">No measurements yet.<br><button class="btn primary" style="margin-top:12px" data-action="open" data-type="growth">📏 Add measurement</button></div>`;
  const w = g.filter(e => e.data.weight);
  html += '<div class="card chart-card">';
  if (w.length) {
    const first = w[0], last = w[w.length - 1];
    const pct = ((last.data.weight - first.data.weight) / first.data.weight) * 100;
    const isBirth = S.settings.birth && Math.abs(first.start - S.settings.birth) < 1.5 * DAY;
    html += `<div class="card-title"><span>Weight</span></div><div class="headline">${weightOut(last.data.weight)}<small>${fmtDate(last.start)}</small></div>`;
    if (w.length > 1) html += `<div class="why muted small">${pct >= 0 ? '+' : ''}${round(pct, 1)}% since ${isBirth ? 'birth weight' : 'first weigh-in'} (${weightOut(first.data.weight)})</div>`;
    if (w.length > 1) html += weightChart(w);
  }
  html += `<table class="table"><thead><tr><th>Date</th><th>Weight</th><th>Length</th><th>Head</th></tr></thead><tbody>
    ${[...g].reverse().map(e => `<tr data-action="edit" data-id="${e.id}"><td>${fmtDate(e.start)}</td><td>${e.data.weight ? weightOut(e.data.weight) : '—'}</td><td>${e.data.length ? lenOut(e.data.length) : '—'}</td><td>${e.data.head ? lenOut(e.data.head) : '—'}</td></tr>`).join('')}
    </tbody></table>
    <button class="btn full" style="margin-top:10px" data-action="open" data-type="growth">📏 Add measurement</button></div>`;
  return html;
}

function weightChart(w) {
  const W = 340, H = 150, L = 44, R = 12, T = 12, B = 24;
  const xs = w.map(e => e.start), ys = w.map(e => e.data.weight);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padY = Math.max((y1 - y0) * 0.15, 50); y0 -= padY; y1 += padY;
  const X = t => L + ((t - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const ticks = [y0 + (y1 - y0) * 0.15, (y0 + y1) / 2, y1 - (y1 - y0) * 0.15];
  const tickLbl = v => (isImp() ? `${round(v / G_PER_OZ / 16, 1)} lb` : `${round(v / 1000, 2)} kg`);
  const sel = S.sel.weight;
  return `<svg class="line-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over time">
    ${ticks.map(v => `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${tickLbl(v)}</text>`).join('')}
    <text x="${L}" y="${H - 6}">${fmtDate(x0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${fmtDate(x1)}</text>
    <polyline class="ln" points="${w.map(e => `${X(e.start)},${Y(e.data.weight)}`).join(' ')}"/>
    ${w.map((e, i) => `<circle class="pt" cx="${X(e.start)}" cy="${Y(e.data.weight)}" r="${sel === i ? 6 : 4.5}"/><circle cx="${X(e.start)}" cy="${Y(e.data.weight)}" r="16" fill="transparent" data-action="wpt" data-i="${i}"/>`).join('')}
  </svg><div class="readout">${sel != null && w[sel] ? `${fmtDate(w[sel].start)}: <b>${weightOut(w[sel].data.weight)}</b>` : 'Tap a point for details'}</div>`;
}

// ---------- Settings ----------
function renderSettings() {
  const st = S.settings;
  const seg = (key, opts) => `<div class="mini-seg">${opts.map(([v, l]) => `<button data-action="set" data-key="${key}" data-val="${v}" class="${st[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const standalone = matchMedia('(display-mode: standalone)').matches;
  return `
    <h2>Baby</h2>
    <div class="card">
      <label class="field"><span>Name</span><input id="setName" value="${esc(st.babyName)}" autocomplete="off"></label>
      <label class="field" style="margin-bottom:4px"><span>Birth date & time</span><input id="setBirth" type="datetime-local" value="${st.birth ? toLocalInput(st.birth) : ''}"></label>
      <div class="note" style="margin-top:4px">Used for day-of-life diaper goals and age-based sleep predictions.</div>
    </div>
    ${renderSyncCard()}
    <h2>Preferences</h2>
    <div class="card">
      <div class="set-row"><div><div class="k">Bottle & pump units</div></div>${seg('vol', [['ml', 'ml'], ['oz', 'oz']])}</div>
      <div class="set-row"><div><div class="k">Weight & length</div></div>${seg('measure', [['metric', 'kg/cm'], ['imperial', 'lb/in']])}</div>
      <div class="set-row"><div><div class="k">Theme</div></div>${seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>
    </div>
    <h2>Your data</h2>
    <div class="card">
      <div class="set-row"><div><div class="k">${S.entries.length} entries</div><div class="d">${Sync?.connected ? 'Saved on this phone and synced to your shared log.' : 'Stored only on this phone.'} ${S.persisted === true ? 'Protected from automatic cleanup ✓' : S.persisted === false ? 'Install the app to protect storage.' : ''}</div></div></div>
      <div class="set-row"><div><div class="k">Last backup</div><div class="d">${st.lastBackup ? fmtDateTime(st.lastBackup) : 'Never'}</div></div></div>
      <div class="stack" style="margin-top:6px">
        <button class="btn primary" data-action="export-json">💾 Back up (save / share file)</button>
        <button class="btn" data-action="import">📂 Restore from backup</button>
        <button class="btn" data-action="export-csv">📄 Export spreadsheet (CSV)</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
      <div class="note">Back up regularly (e.g. share the file to Google Drive or email it to yourself). Clearing Chrome’s site data or uninstalling the app deletes the log.</div>
    </div>
    ${!standalone ? `<h2>Install</h2><div class="card">
      ${S.installPrompt ? '<button class="btn primary full" data-action="install">📲 Install app</button>' : '<div class="small">In Chrome, tap <b>⋮</b> → <b>Add to Home screen</b> / <b>Install app</b>. It then opens full-screen and works offline.</div>'}
    </div>` : ''}
    <h2>Danger zone</h2>
    <div class="card"><button class="btn danger full" data-action="wipe">Delete all data</button></div>
    <p class="muted small" style="text-align:center;margin-top:18px">Sprout Baby Log · works offline · no subscription</p>`;
}
function renderSyncCard() {
  const head = '<h2>Shared log</h2>';
  if (!Sync) {
    const msg = { unconfigured: 'Log together with your partner on both phones. To turn this on, fill in <b>firebase-config.js</b> (see the README).', failed: 'Couldn’t load sharing. Check your connection and reopen the app.' }[S.syncState] || 'Loading…';
    return `${head}<div class="card"><div class="small">${msg}</div></div>`;
  }
  const i = Sync.info(), err = i.error ? `<div class="note" style="color:var(--danger)">Problem: ${esc(i.error)}</div>` : '';
  if (i.status === 'loading') return `${head}<div class="card"><div class="small">Connecting…</div>${err}</div>`;
  if (i.status === 'signedOut') return `${head}<div class="card">
      <div class="small" style="margin-bottom:10px">Sign in so you and your partner both see the same log, live, on your own phones.</div>
      <button class="btn primary full" data-action="sync-signin">Sign in with Google</button>${err}</div>`;
  const who = `<div class="set-row"><div><div class="k">Signed in</div><div class="d">${esc(i.user.email)}</div></div><button class="btn" data-action="sync-signout">Sign out</button></div>`;
  if (i.status === 'noFamily') {
    const inv = i.invites.map(f => {
      const owner = (f.memberInfo && f.memberInfo[f.owner]) || {};
      return `<button class="btn primary full" data-action="sync-join" data-id="${esc(f.id)}">Join ${esc(owner.name || owner.email || 'shared')}’s log</button>`;
    }).join('');
    return `${head}<div class="card">${who}
      <div class="stack" style="margin-top:8px">${inv}
        <button class="btn${inv ? '' : ' primary'} full" data-action="sync-create">Create a new shared log</button></div>
      <div class="note">${inv ? 'You’ve been invited. Join to see the same log.' : 'Partner already created one? Ask them to invite this email, then reopen Settings.'}</div>${err}</div>`;
  }
  const f = i.family, info = f.memberInfo || {};
  const members = (f.members || []).map(u => `<div class="set-row"><div><div class="k">${esc(info[u]?.name || info[u]?.email || 'Member')}</div><div class="d">${esc(info[u]?.email || '')}${u === i.user.uid ? ' · you' : ''}</div></div></div>`).join('');
  const pending = (f.invites || []).map(e => `<div class="set-row"><div><div class="k">${esc(e)}</div><div class="d">Invited · they need to sign in and tap Join</div></div><button class="btn" data-action="sync-uninvite" data-email="${esc(e)}">Cancel</button></div>`).join('');
  const status = !i.online ? 'Offline · changes will sync when you’re back online' : i.pending ? 'Syncing…' : 'Synced ✓';
  return `${head}<div class="card">
      <div class="set-row"><div><div class="k">Status</div><div class="d">${status}</div></div></div>
      ${members}${pending}
      <label class="field" style="margin-top:8px"><span>Invite by Google email</span><input id="inviteEmail" type="email" autocomplete="off" placeholder="partner@gmail.com"></label>
      <button class="btn full" data-action="sync-invite">Send invite</button>
      ${who}${err}</div>`;
}
function bindSettings() {
  $('#setName').onchange = async e => { S.settings.babyName = e.target.value.trim() || 'Baby'; await saveProfile(); render(); toast('Saved'); };
  $('#setBirth').onchange = async e => { const t = fromLocalInput(e.target.value); S.settings.birth = isFinite(t) ? t : null; await saveProfile(); render(); toast('Saved'); };
  $('#importFile').onchange = e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; };
}

// =====================================================================
// Sheets (bottom dialogs) & forms
// =====================================================================
const sheet = () => $('#sheet');
let sheetOpen = false;
function openSheet(html) {
  $('#toast').hidden = true;
  sheet().innerHTML = `<div class="grabber"></div>${html}`;
  sheet().hidden = false; $('#backdrop').hidden = false;
  sheet().scrollTop = 0;
  if (!sheetOpen) history.pushState({ sheet: 1 }, '');
  sheetOpen = true;
}
function closeSheet(fromPop = false) {
  if (!sheetOpen) return;
  sheetOpen = false;
  sheet().hidden = true; $('#backdrop').hidden = true; sheet().innerHTML = '';
  if (!fromPop && history.state && history.state.sheet) history.back();
}
window.addEventListener('popstate', () => { if (sheetOpen) closeSheet(true); });

function timeField(name, t, label = 'Time', optional = false) {
  const chips = [[0, 'Now'], [5, '5m ago'], [15, '15m ago'], [30, '30m ago'], [60, '1h ago']];
  return `<label class="field"><span>${label}</span><input type="datetime-local" name="${name}" value="${t == null ? '' : toLocalInput(t)}" ${optional ? '' : 'required'}></label>
    <div class="qchips">${chips.map(([m, l]) => `<button type="button" data-ago="${m}" data-for="${name}">${l}</button>`).join('')}</div>`;
}
function stepper(name, val, step, unit, dec = 0) {
  return `<div class="stepper" data-step="${step}" data-dec="${dec}">
    <button type="button" data-delta="-1" aria-label="Decrease">−</button>
    <input name="${name}" type="number" inputmode="decimal" step="any" min="0" value="${val ?? ''}" placeholder="0">
    ${unit ? `<span class="unit">${unit}</span>` : ''}
    <button type="button" data-delta="1" aria-label="Increase">+</button></div>`;
}
const segField = (name, opts, val) => `<div class="seg">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${v === val ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
const noteField = v => `<label class="field"><span>Note (optional)</span><textarea name="note" rows="2">${esc(v)}</textarea></label>`;
const label = t => `<span class="flabel">${t}</span>`;

function formHTML(type, e) {
  const d = e?.data || {}, now = Date.now(), t = e?.start ?? now, oz = isOz();
  switch (type) {
    case 'bottle': {
      const v = d.amount != null ? volIn(d.amount) : S.settings.bottleLast != null ? volIn(S.settings.bottleLast) : oz ? 2 : 60;
      const quick = oz ? [1, 2, 3, 4, 5] : [30, 45, 60, 90, 120];
      return timeField('start', t) + label('Amount') + stepper('amount', v, oz ? 0.25 : 5, volUnit(), oz ? 2 : 0)
        + `<div class="qchips">${quick.map(q => `<button type="button" data-set="amount" data-v="${q}">${q} ${volUnit()}</button>`).join('')}</div>`
        + label('Type') + segField('kind', Object.entries(BOTTLE_KINDS), d.kind || S.settings.bottleKind || 'breast') + noteField(e?.note);
    }
    case 'pump': {
      const sv = v => (v != null ? volIn(v) : '');
      return timeField('start', t, 'Started') + timeField('end', e?.end ?? null, 'Ended (optional)', true) + `<div class="two"><div>${label('Left')}${stepper('left', sv(d.left), oz ? 0.25 : 5, '', oz ? 2 : 0)}</div><div>${label('Right')}${stepper('right', sv(d.right), oz ? 0.25 : 5, '', oz ? 2 : 0)}</div></div>`
        + `<div class="muted small" style="margin:-6px 0 12px">Amounts in ${volUnit()}</div>` + noteField(e?.note);
    }
    case 'diaper':
      return timeField('start', t) + label('Type') + segField('kind', [['wet', '💧 Wet'], ['dirty', '💩 Dirty'], ['mixed', '💧💩 Both'], ['dry', '⚪ Dry']], d.kind || 'wet')
        + label('Poop color (optional)') + segField('color', [['', 'None'], ...Object.entries(POOP_COLORS)], d.color || '') + noteField(e?.note);
    case 'nurse': {
      const m = s => (s != null ? round(s / 60, 1) : '');
      return timeField('start', e?.start ?? now - 20 * MIN, 'Started')
        + timeField('end', e?.end ?? null, 'Ended (optional)', true)
        + `<div class="muted small" style="margin:-6px 0 12px">Leave blank to use start + left/right minutes</div>`
        + `<div class="two"><div>${label('Left (min)')}${stepper('left', m(d.left), 1, '')}</div><div>${label('Right (min)')}${stepper('right', m(d.right), 1, '')}</div></div>`
        + label('Ended on') + segField('last', [['L', 'Left'], ['R', 'Right']], d.last || 'L') + noteField(e?.note);
    }
    case 'sleep':
      return timeField('start', e?.start ?? now - HOUR, 'Fell asleep') + timeField('end', e?.end ?? now, 'Woke up') + noteField(e?.note);
    case 'med': {
      const recent = S.settings.recentMeds || [];
      return timeField('start', t) + `<label class="field"><span>Medicine</span><input name="name" list="medList" value="${esc(d.name || '')}" placeholder="e.g. Vitamin D drops" autocomplete="off" required></label>
        <datalist id="medList">${recent.map(r => `<option value="${esc(r.name)}">`).join('')}</datalist>
        ${recent.length ? `<div class="qchips">${recent.slice(0, 6).map(r => `<button type="button" data-med="${esc(r.name)}" data-dose="${esc(r.dose || '')}">${esc(r.name)}</button>`).join('')}</div>` : ''}
        <label class="field"><span>Dose (optional)</span><input name="dose" value="${esc(d.dose || '')}" placeholder="e.g. 1 drop, 2.5 ml" autocomplete="off"></label>` + noteField(e?.note);
    }
    case 'growth': {
      const prev = S.entries.find(x => x.type === 'growth' && x.id !== e?.id)?.data || {};
      const src = e ? d : {};
      let w;
      if (isImp()) {
        const g = src.weight, oz2 = g ? g / G_PER_OZ : null, lb = oz2 != null ? Math.floor(oz2 / 16) : '';
        w = `${label('Weight')}<div class="two"><div>${stepper('wlb', lb, 1, 'lb')}</div><div>${stepper('woz', oz2 != null ? round(oz2 - lb * 16, 1) : '', 0.5, 'oz', 1)}</div></div>`;
      } else w = label('Weight') + stepper('wkg', src.weight ? round(src.weight / 1000, 3) : '', 0.01, 'kg', 3);
      const l = v => (v ? (isImp() ? round(v / CM_PER_IN, 2) : round(v, 1)) : '');
      const lu = isImp() ? 'in' : 'cm', ls = isImp() ? 0.25 : 0.5, ld = isImp() ? 2 : 1;
      const hint = prev.weight && !e ? `<div class="muted small" style="margin:-6px 0 12px">Previous: ${[prev.weight && weightOut(prev.weight), prev.length && lenOut(prev.length), prev.head && `head ${lenOut(prev.head)}`].filter(Boolean).join(' · ')}</div>` : '';
      return timeField('start', t, 'Measured') + w + hint + label('Length') + stepper('length', l(src.length), ls, lu, ld) + label('Head circumference') + stepper('head', l(src.head), ls, lu, ld) + noteField(e?.note);
    }
  }
  return '';
}

function readForm(type, form, e) {
  const fd = new FormData(form);
  const num = k => { const v = parseFloat(fd.get(k)); return isFinite(v) && v >= 0 ? v : null; };
  const start = fromLocalInput(fd.get('start'));
  if (!isFinite(start)) throw new Error('Please set a time');
  if (start > Date.now() + 5 * MIN) throw new Error('That time is in the future');
  const out = { id: e?.id, created: e?.created, type, start, end: null, data: {}, note: (fd.get('note') || '').trim() };
  const optEnd = () => {
    const end = fromLocalInput(fd.get('end'));
    if (!isFinite(end)) return null;
    if (end <= start) throw new Error('End time must be after start time');
    if (end > Date.now() + 5 * MIN) throw new Error('End time is in the future');
    if (end - start > 12 * HOUR) throw new Error('That session is over 12 hours — check the times');
    return end;
  };
  const d = out.data;
  switch (type) {
    case 'bottle': {
      const a = num('amount'); if (!a) throw new Error('Enter an amount');
      d.amount = volToMl(a); d.kind = fd.get('kind') || 'breast'; break;
    }
    case 'pump': {
      const l = num('left'), r = num('right');
      if (!l && !r) throw new Error('Enter an amount for at least one side');
      d.left = l ? volToMl(l) : 0; d.right = r ? volToMl(r) : 0;
      out.end = optEnd(); break;
    }
    case 'diaper': d.kind = fd.get('kind') || 'wet'; if (fd.get('color')) d.color = fd.get('color'); break;
    case 'nurse': {
      const l = num('left') || 0, r = num('right') || 0;
      if (!l && !r) throw new Error('Enter minutes for at least one side');
      d.left = Math.round(l * 60); d.right = Math.round(r * 60); d.last = fd.get('last') || 'L';
      const end = optEnd();
      out.end = end ?? start + (d.left + d.right) * 1000; break;
    }
    case 'sleep': {
      const end = fromLocalInput(fd.get('end'));
      if (!isFinite(end) || end <= start) throw new Error('Wake time must be after sleep time');
      if (end - start > 20 * HOUR) throw new Error('That sleep is over 20 hours — check the times');
      out.end = end; break;
    }
    case 'med': {
      const name = (fd.get('name') || '').trim(); if (!name) throw new Error('Enter the medicine name');
      d.name = name; const dose = (fd.get('dose') || '').trim(); if (dose) d.dose = dose; break;
    }
    case 'growth': {
      let g = null;
      if (isImp()) { const lb = num('wlb') || 0, oz = num('woz') || 0; if (lb || oz) g = (lb * 16 + oz) * G_PER_OZ; }
      else { const kg = num('wkg'); if (kg) g = kg * 1000; }
      const toCm = v => (v ? (isImp() ? v * CM_PER_IN : v) : null);
      const len = toCm(num('length')), head = toCm(num('head'));
      if (!g && !len && !head) throw new Error('Enter at least one measurement');
      if (g) d.weight = Math.round(g); if (len) d.length = round(len, 2); if (head) d.head = round(head, 2); break;
    }
  }
  return out;
}

function openForm(type, e = null) {
  const T = TYPES[type];
  openSheet(`
    <h3 class="sheet-title">${e ? entryIcon(e) : T.icon} ${e ? 'Edit' : 'Log'} ${T.label.toLowerCase()}</h3>
    <form id="entryForm" novalidate>
      ${formHTML(type, e)}
      <div class="sheet-actions">
        ${e ? '<button type="button" class="btn danger" data-action="sheet-delete">🗑</button>' : ''}
        <button type="button" class="btn" data-action="sheet-close">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
  const form = $('#entryForm');
  if (type === 'nurse') syncNurseTimes(form);
  form.onsubmit = async ev => {
    ev.preventDefault();
    let entry;
    try { entry = readForm(type, form, e); } catch (err) { toast(err.message); vibrate(40); return; }
    if (type === 'med') {
      const rm = (S.settings.recentMeds || []).filter(r => r.name.toLowerCase() !== entry.data.name.toLowerCase());
      rm.unshift({ name: entry.data.name, dose: entry.data.dose || '' });
      S.settings.recentMeds = rm.slice(0, 10);
    }
    if (type === 'bottle') { S.settings.bottleLast = entry.data.amount; S.settings.bottleKind = entry.data.kind; }
    if (type === 'med' || type === 'bottle') await saveSettings();
    closeSheet();
    if (e) { await updateEntry(entry); render(); toast('Changes saved'); }
    else { const saved = await addEntry(entry); vibrate(25); render(); toastLogged(saved, `${entryTitle(saved)} logged · ${fmtTime(saved.start)}`); }
  };
  if (e) sheet().querySelector('[data-action="sheet-delete"]').onclick = async () => {
    if (!confirm('Delete this entry?')) return;
    const copy = { ...e }; closeSheet(); await deleteEntry(e.id); render();
    toast('Entry deleted', [{ label: 'Undo', fn: async () => { await addEntry(copy); render(); } }]);
  };
}

// Keep nursing start/end and left/right minutes consistent while editing.
// Changing start or end adds/removes the difference on the "Ended on" side
// (spilling over to the other side). Changing the minutes moves the end time
// to start + left + right.
function syncNurseTimes(form) {
  const el = n => form.elements[n];
  const mins = n => parseFloat(el(n).value) || 0;
  const setM = (n, v) => { el(n).value = v > 0.05 ? String(round(v, 1)) : ''; };
  const span = () => {
    const s = fromLocalInput(el('start').value), e = fromLocalInput(el('end').value);
    return isFinite(s) && isFinite(e) && e > s ? (e - s) / MIN : null;
  };
  const sides = () => (el('last').value === 'R' ? ['right', 'left'] : ['left', 'right']);
  let prev = span();
  const onTimes = () => {
    const sp = span();
    if (sp == null) { prev = null; return; }
    const [a, b] = sides(), total = mins(a) + mins(b);
    if (!total) setM(a, sp);
    else if (prev == null) {
      if (total > sp) { const k = sp / total; setM(a, mins(a) * k); setM(b, mins(b) * k); }
    } else {
      let delta = sp - prev;
      if (delta >= 0) setM(a, mins(a) + delta);
      else {
        let cut = -delta;
        for (const n of [a, b]) { const c = Math.min(cut, mins(n)); setM(n, mins(n) - c); cut -= c; }
      }
    }
    prev = sp;
  };
  const onMins = () => {
    const start = fromLocalInput(el('start').value), total = mins('left') + mins('right');
    if (!isFinite(start) || !el('end').value || !total) return;
    el('end').value = toLocalInput(start + Math.round(total) * MIN);
    prev = span();
  };
  const handle = ev => {
    const n = ev.target.name;
    if (n === 'start' || n === 'end') onTimes();
    else if (n === 'left' || n === 'right') onMins();
  };
  form.addEventListener('input', handle);
  form.addEventListener('change', handle); // some mobile date pickers only fire change
}

function pickPast() {
  const opts = [['nurse', '🤱 Nursing'], ['sleep', '😴 Sleep'], ['bottle', '🍼 Bottle'], ['diaper', '🧷 Diaper'], ['pump', '🥛 Pumping'], ['med', '💊 Medicine'], ['growth', '📏 Growth']];
  openSheet(`<h3 class="sheet-title">🕘 Add a past entry</h3>
    <div class="type-pick">${opts.map(([t, l]) => `<button class="btn" data-action="open" data-type="${t}">${l}</button>`).join('')}</div>
    <div class="sheet-actions"><button class="btn" data-action="sheet-close">Cancel</button></div>`);
}

// Sheet-internal controls: time chips, steppers, quick values, med chips
document.addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b || !sheet().contains(b)) return;
  if (b.dataset.ago != null) {
    const inp = sheet().querySelector(`input[name="${b.dataset.for}"]`);
    inp.value = toLocalInput(Date.now() - (+b.dataset.ago) * MIN);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  } else if (b.dataset.delta) {
    const w = b.closest('.stepper'), inp = w.querySelector('input');
    const step = +w.dataset.step, dec = +w.dataset.dec;
    const v = (parseFloat(inp.value) || 0) + step * +b.dataset.delta;
    inp.value = Math.max(0, round(v, Math.max(dec, 2))).toString();
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    vibrate(6);
  } else if (b.dataset.set) {
    sheet().querySelector(`input[name="${b.dataset.set}"]`).value = b.dataset.v;
  } else if (b.dataset.med != null) {
    sheet().querySelector('input[name="name"]').value = b.dataset.med;
    sheet().querySelector('input[name="dose"]').value = b.dataset.dose;
  }
});

// =====================================================================
// Toasts
// =====================================================================
let toastTimer;
function toast(msg, actions = [], ms = 4500) {
  const el = $('#toast');
  el.innerHTML = `<span class="msg">${esc(msg)}</span>${actions.map((a, i) => `<button data-i="${i}">${esc(a.label)}</button>`).join('')}`;
  el.hidden = false;
  el.querySelectorAll('button').forEach(btn => btn.onclick = () => { el.hidden = true; actions[+btn.dataset.i].fn(); });
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function toastLogged(e, msg) {
  toast(msg, [
    { label: 'Undo', fn: async () => { await deleteEntry(e.id); render(); toast('Removed'); } },
    { label: 'Edit', fn: () => { const cur = S.entries.find(x => x.id === e.id); if (cur) openForm(cur.type, cur); } },
  ], 6000);
}

// =====================================================================
// Backup / export
// =====================================================================
async function deliverFile(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  } catch (err) { if (err.name === 'AbortError') return false; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };
async function exportJSON() {
  const data = { app: 'sprout-baby-log', version: 1, exported: Date.now(), settings: S.settings, timers: S.timers, entries: S.entries };
  const ok = await deliverFile(`sprout-backup_${stamp()}.json`, JSON.stringify(data), 'application/json');
  if (ok) { S.settings.lastBackup = Date.now(); await saveSettings(); render(); toast('Backup created ✓'); }
}
async function exportCSV() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['type', 'start', 'end', 'duration_min', 'title', 'details', 'note']];
  for (const e of [...S.entries].reverse()) {
    rows.push([e.type, toLocalInput(e.start).replace('T', ' '), e.end ? toLocalInput(e.end).replace('T', ' ') : '', e.end ? round((e.end - e.start) / MIN, 1) : '', entryTitle(e), entryDetail(e).replace(/ · “.*”$/, ''), e.note || '']);
  }
  await deliverFile(`sprout-log_${stamp()}.csv`, rows.map(r => r.map(q).join(',')).join('\n'), 'text/csv');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.entries)) throw new Error('bad');
    const valid = data.entries.filter(e => e && e.id && TYPES[e.type] && isFinite(e.start) && e.data);
    if (!confirm(`Restore ${valid.length} entries from this backup?\nEntries you already have are kept; matching ones are updated.`)) return;
    valid.forEach(e => { e.updated = Date.now(); });
    await DB.putMany(valid); Sync?.pushMany(valid);
    const byId = new Map(S.entries.map(e => [e.id, e]));
    valid.forEach(e => byId.set(e.id, e));
    S.entries = [...byId.values()]; sortEntries();
    if (data.settings && (!S.settings.birth || S.settings.babyName === 'Baby')) {
      S.settings = { ...DEFAULTS, ...data.settings, theme: S.settings.theme };
      await saveProfile();
    }
    render(); toast(`Restored ${valid.length} entries ✓`);
  } catch (_) { toast('That file isn’t a valid Sprout backup'); }
}

// =====================================================================
// Theme
// =====================================================================
const effectiveDark = () => S.settings.theme === 'dark' || (S.settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme() {
  const t = S.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $('#themeBtn').textContent = effectiveDark() ? '☀️' : '🌙';
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  meta.forEach(m => m.setAttribute('content', effectiveDark() ? '#16141c' : '#f7f4fb'));
}

// =====================================================================
// Global actions
// =====================================================================
const ACTIONS = {
  tab: b => { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); },
  'toggle-theme': async () => { S.settings.theme = effectiveDark() ? 'light' : 'dark'; await saveSettings(); render(); },
  'nurse-tap': b => nurseTap(b.dataset.side),
  'nurse-pause': nursePause,
  'nurse-save': () => nurseSave(),
  'sleep-start': sleepStart,
  'sleep-save': () => sleepSave(),
  'timer-discard': b => timerDiscard(b.dataset.which),
  'timer-adjust': b => timerAdjust(b.dataset.which),
  diaper: async b => {
    const e = await addEntry({ type: 'diaper', start: Date.now(), data: { kind: b.dataset.kind }, note: '' });
    vibrate(25); render(); toastLogged(e, `${DIAPER[e.data.kind].icon} ${entryTitle(e)} logged · ${fmtTime(e.start)}`);
  },
  open: b => openForm(b.dataset.type),
  edit: b => { const e = S.entries.find(x => x.id === b.dataset.id); if (e) openForm(e.type, e); },
  'pick-past': pickPast,
  'sheet-close': () => closeSheet(),
  'sum-mode': async b => { S.settings.sumMode = b.dataset.mode; await saveSettings(); render(); },
  filter: b => { S.filter = b.dataset.f; render(); },
  'more-days': () => { S.days += 7; render(); },
  bar: b => { S.sel[b.dataset.m] = S.sel[b.dataset.m] === +b.dataset.i ? null : +b.dataset.i; render(); },
  wpt: b => { S.sel.weight = +b.dataset.i; render(); },
  set: async b => { S.settings[b.dataset.key] = b.dataset.val; await saveSettings(); render(); },
  'export-json': exportJSON,
  'export-csv': exportCSV,
  import: () => $('#importFile').click(),
  install: async () => { if (!S.installPrompt) return; S.installPrompt.prompt(); await S.installPrompt.userChoice; S.installPrompt = null; render(); },
  'dismiss-install': async () => { S.settings.installDismissed = true; await saveSettings(); render(); },
  wipe: async () => {
    const shared = Sync?.connected;
    if (!confirm(shared ? 'Delete ALL entries from the SHARED log? They will be deleted on every phone in your family. This cannot be undone.' : 'Delete ALL entries and settings? This cannot be undone.')) return;
    if (!confirm('Are you sure? Consider making a backup first.')) return;
    if (shared) { const now = Date.now(); Sync.pushMany(S.entries.map(e => ({ id: e.id, deleted: true, updated: now }))); }
    await DB.clear(); S.entries = []; S.timers = { sleep: null, nurse: null }; S.settings = { ...DEFAULTS };
    await saveProfile(); await saveTimers(); render(); toast('All data deleted');
  },
  'sync-signin': () => Sync?.signIn(),
  'sync-signout': async () => {
    if (!confirm('Stop sharing on this phone? Your log stays on this phone, but new entries won’t sync until you sign in again.')) return;
    await Sync.signOut(); toast('Signed out');
  },
  'sync-create': async b => {
    if (!confirm(`Create a shared log${S.entries.length ? ` with the ${S.entries.length} entries on this phone` : ''}? Your log will be stored in your Firebase project so your partner can see it.`)) return;
    b.disabled = true;
    try { await Sync.createFamily(); toast('Shared log created ✓ Now invite your partner.'); }
    catch (err) { b.disabled = false; toast(`Couldn’t create shared log (${err.code || err.message})`); }
  },
  'sync-join': async b => {
    if (S.entries.length && !confirm(`The ${S.entries.length} entries on this phone will be added to the shared log. Continue?`)) return;
    b.disabled = true;
    try { await Sync.joinFamily(b.dataset.id); toast('Joined shared log ✓'); }
    catch (err) { b.disabled = false; toast(`Couldn’t join (${err.code || err.message})`); }
  },
  'sync-invite': () => {
    const inp = $('#inviteEmail'), email = inp.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter the email they use for Google'); inp.focus(); return; }
    Sync.invite(email); inp.value = ''; inp.blur(); toast(`Invited ${email}`);
  },
  'sync-uninvite': b => Sync.uninvite(b.dataset.email),
};
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el); }
});
$('#backdrop').addEventListener('click', () => closeSheet());

// Live timer ticking + periodic refresh of "x min ago" text
function tick() {
  const now = Date.now();
  const set = (k, v) => { const el = document.querySelector(`[data-live="${k}"]`); if (el) el.textContent = v; };
  if (S.timers.nurse) { set('nurseL', fmtClock(nurseMs('L', now))); set('nurseR', fmtClock(nurseMs('R', now))); set('nurseT', fmtClock(nurseMs('L', now) + nurseMs('R', now))); }
  if (S.timers.sleep) set('sleep', fmtClock(now - S.timers.sleep.start));
}
setInterval(tick, 1000);
setInterval(() => { if (!sheetOpen && S.tab === 'home') render(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !sheetOpen) render(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installPrompt = e; if (!sheetOpen) render(); });
window.addEventListener('appinstalled', () => { S.installPrompt = null; render(); toast('Installed ✓'); });

// =====================================================================
// Boot
// =====================================================================
async function boot() {
  try {
    await DB.open();
    const [entries, settings, timers] = await Promise.all([DB.all(), DB.get('settings'), DB.get('timers')]);
    S.entries = entries || []; sortEntries();
    S.settings = { ...DEFAULTS, ...(settings || {}) };
    S.timers = { sleep: null, nurse: null, ...(timers || {}) };
  } catch (err) {
    view().innerHTML = `<div class="card">Could not open storage: ${esc(err && err.message)}</div>`;
    return;
  }
  render();
  if (navigator.storage && navigator.storage.persist) {
    try { S.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch (_) {}
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  startSync();
}
async function startSync() {
  try {
    const config = (await import('./firebase-config.js')).default;
    if (!config || !config.apiKey) { S.syncState = 'unconfigured'; return; }
    S.syncState = 'loading';
    Sync = await (await import('./sync.js')).start(config, syncBridge);
  } catch (err) {
    console.warn('Shared log unavailable', err);
    S.syncState = 'failed';
  }
  renderSoon();
}
boot();
})();
