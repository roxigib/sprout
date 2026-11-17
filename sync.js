// Shared family log: syncs this phone's log with Firebase (Firestore) so several
// people can log and see the same data. The app keeps working fully offline; the
// local IndexedDB copy stays the source the UI reads from, and Firestore keeps
// queued changes until the phone is back online.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, addDoc, setDoc, updateDoc,
  onSnapshot, query, where, getDocs, writeBatch, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

const lower = s => String(s || '').trim().toLowerCase();
const clean = o => JSON.parse(JSON.stringify(o)); // Firestore rejects `undefined`
const stamp = e => e.updated || e.created || 0;

export async function start(config, app) {
  const fb = initializeApp(config);
  const auth = getAuth(fb);
  const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

  const st = {
    status: 'loading', // loading | signedOut | noFamily | connected
    user: null, family: null, invites: [], online: false, pending: false, error: null,
  };
  let unsubs = [], famId = null;
  const changed = () => app.changed();
  const stopListening = () => { unsubs.forEach(u => u()); unsubs = []; famId = null; st.family = null; };
  const entriesCol = () => collection(db, 'families', famId, 'entries');
  const metaDoc = name => doc(db, 'families', famId, 'meta', name);

  // Writes go into Firestore's persistent queue right away. The promise only
  // settles once the server confirms, so we never wait on it (that would hang offline).
  const fire = p => p.catch(err => { console.warn('sync write failed', err); st.error = err.code || err.message; changed(); });

  async function pushMany(list) {
    if (!famId) return;
    for (let i = 0; i < list.length; i += 400) {
      const b = writeBatch(db);
      list.slice(i, i + 400).forEach(e => b.set(doc(entriesCol(), e.id), clean(e)));
      fire(b.commit());
    }
  }

  function connect(fam) {
    stopListening();
    famId = fam.id; st.family = fam; st.status = 'connected'; st.error = null;
    let reconciled = false;
    const metaListen = (name, localStamp, apply, push) => onSnapshot(metaDoc(name), snap => {
      if (!snap.exists()) { if (!snap.metadata.fromCache && localStamp()) push(); return; }
      const r = snap.data().updated || 0;
      if (r > localStamp()) apply(snap.data()); else if (r < localStamp()) push();
    });

    unsubs.push(onSnapshot(doc(db, 'families', famId), snap => {
      if (!snap.exists() || !(snap.data().members || []).includes(st.user.uid)) { stopListening(); st.status = 'noFamily'; findFamily(); return; }
      st.family = { id: snap.id, ...snap.data() }; changed();
    }));

    unsubs.push(onSnapshot(entriesCol(), { includeMetadataChanges: true }, async snap => {
      st.online = !snap.metadata.fromCache; st.pending = snap.metadata.hasPendingWrites;
      const docs = snap.docChanges().map(c => c.doc.data());
      if (docs.length) await app.applyEntries(docs);
      // First time we hear from the server: upload anything only this phone has
      // (entries logged before joining, or while signed out).
      if (!reconciled && !snap.metadata.fromCache) {
        reconciled = true;
        const remote = new Map(snap.docs.map(d => [d.id, d.data()]));
        const missing = app.state().entries.filter(e => !remote.has(e.id) || stamp(e) > stamp(remote.get(e.id)));
        if (missing.length) pushMany(missing);
      }
      changed();
    }));

    unsubs.push(metaListen('timers', () => app.state().timers.updated || 0, app.applyTimers, pushTimers));
    unsubs.push(metaListen('profile', () => app.state().settings.profileUpdated || 0, app.applyProfile, pushProfile));
    changed();
  }

  async function findFamily() {
    if (!st.user) return;
    try {
      const mine = await getDocs(query(collection(db, 'families'), where('members', 'array-contains', st.user.uid)));
      if (!mine.empty) { const d = mine.docs[0]; connect({ id: d.id, ...d.data() }); return; }
      st.status = 'noFamily';
      const email = lower(st.user.email);
      const inv = email ? await getDocs(query(collection(db, 'families'), where('invites', 'array-contains', email))) : { docs: [] };
      st.invites = inv.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      st.status = 'noFamily'; st.error = err.code || err.message;
    }
    changed();
  }

  function pushTimers() {
    if (!famId) return;
    const t = app.state().timers;
    fire(setDoc(metaDoc('timers'), clean({ sleep: t.sleep || null, nurse: t.nurse || null, updated: t.updated || Date.now() })));
  }
  function pushProfile() {
    if (!famId) return;
    const s = app.state().settings;
    fire(setDoc(metaDoc('profile'), clean({ babyName: s.babyName || 'Baby', birth: s.birth ?? null, updated: s.profileUpdated || Date.now() })));
  }
  const me = () => ({ email: lower(st.user.email), name: st.user.displayName || '' });

  onAuthStateChanged(auth, user => {
    st.user = user; st.invites = [];
    if (!user) { stopListening(); st.status = 'signedOut'; changed(); return; }
    st.status = 'loading'; changed();
    findFamily();
  });
  getRedirectResult(auth).catch(err => { st.error = err.code || err.message; changed(); });

  return {
    info: () => st,
    get connected() { return !!famId; },
    pushEntry: e => { if (famId) fire(setDoc(doc(entriesCol(), e.id), clean(e))); },
    pushDelete: (id, updated = Date.now()) => { if (famId) fire(setDoc(doc(entriesCol(), id), { id, deleted: true, updated })); },
    pushMany,
    pushTimers,
    pushProfile,
    async signIn() {
      st.error = null;
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try { await signInWithPopup(auth, provider); }
      catch (err) {
        if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') return signInWithRedirect(auth, provider);
        if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') { st.error = err.code || err.message; changed(); }
      }
    },
    async signOut() { stopListening(); await signOut(auth); },
    async createFamily() {
      const ref = await addDoc(collection(db, 'families'), {
        owner: st.user.uid, members: [st.user.uid], memberInfo: { [st.user.uid]: me() }, invites: [], created: Date.now(),
      });
      connect({ id: ref.id, owner: st.user.uid, members: [st.user.uid], memberInfo: { [st.user.uid]: me() }, invites: [] });
    },
    async joinFamily(id) {
      await updateDoc(doc(db, 'families', id), {
        members: arrayUnion(st.user.uid), invites: arrayRemove(lower(st.user.email)), [`memberInfo.${st.user.uid}`]: me(),
      });
      await findFamily();
    },
    invite: email => fire(updateDoc(doc(db, 'families', famId), { invites: arrayUnion(lower(email)) })),
    uninvite: email => fire(updateDoc(doc(db, 'families', famId), { invites: arrayRemove(lower(email)) })),
  };
}
