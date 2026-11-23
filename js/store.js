// 資料層：有 Firebase 設定時使用 Firestore＋匿名身分（辨識這支手機），否則使用本機 DEMO 資料
// 球友不需任何個資，成績以「名字」跨場次累積（名字先登記先贏）
// 場主綁定手機：號碼只在手機上做 SHA-256 加密，資料庫只存加密後的亂碼，且設定為任何人都讀不到
import { firebaseConfig } from './config.js?v=20261205';

const DEMO = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('YOUR');
export const PHONE_RE = /^09\d{8}$/;
export async function phoneHash(phone) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pickleball-pairing:' + phone));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const store = DEMO ? demoStore() : await firebaseStore();

async function firebaseStore() {
  const base = 'https://www.gstatic.com/firebasejs/10.12.2';
  const [{ initializeApp }, F, A] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-auth.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const db = F.getFirestore(app);
  const auth = A.getAuth(app);
  // 每支手機／瀏覽器自動取得一個匿名身分：用來辨識「誰是場主」「誰能輸入這一局的比分」
  await auth.authStateReady();
  if (!auth.currentUser) await A.signInAnonymously(auth);
  const uid = auth.currentUser.uid;

  const docs = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const withSid = snap => snap.docs.map(d => ({ id: d.id, sid: d.ref.parent.parent.id, ...d.data() }));
  const S = sid => F.doc(db, 'sessions', sid);
  const col = (sid, name) => F.collection(db, 'sessions', sid, name);

  return {
    demo: false,
    uid,
    // 開場次：先把這支手機綁到場主手機（加密後），再建立場次與只有規則讀得到的場主金鑰
    async createSession(data, hash) {
      await F.setDoc(F.doc(db, 'hostKeys', uid), { phoneHash: hash });
      const r = F.doc(F.collection(db, 'sessions'));
      await F.setDoc(r, { ...data, hostUids: [uid], createdAt: Date.now() });
      await F.setDoc(F.doc(db, 'sessions', r.id, 'private', 'host'), { phoneHash: hash });
      return r.id;
    },
    // 場主換手機：輸入同一支手機號碼，規則比對加密值相符才會把這支手機加入場主
    async reclaimHost(sid, hash) {
      await F.setDoc(F.doc(db, 'hostKeys', uid), { phoneHash: hash });
      await F.updateDoc(S(sid), { hostUids: F.arrayUnion(uid) });
    },
    // 名字登記：回傳 undefined = 沒人用過；null = 場主代報名用過、還沒人認領；其他 = 使用者身分
    async nameOwner(name) { const s = await F.getDoc(F.doc(db, 'names', name)); return s.exists() ? s.data().owner : undefined; },
    claimName: (name, owner) => F.setDoc(F.doc(db, 'names', name), { owner, at: Date.now() }),
    watchSessions: (cb, err) => F.onSnapshot(F.query(F.collection(db, 'sessions'), F.orderBy('date', 'desc'), F.limit(60)), s => cb(docs(s)), err),
    allSessions: async () => docs(await F.getDocs(F.collection(db, 'sessions'))),
    getSessions: async ids => (await Promise.all(ids.map(id => F.getDoc(S(id))))).filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() })),
    watchSession: (sid, cb, err) => F.onSnapshot(S(sid), s => cb(s.exists() ? { id: s.id, ...s.data() } : null), err),
    updateSession: (sid, patch) => F.updateDoc(S(sid), patch),

    watchPlayers: (sid, cb, err) => F.onSnapshot(col(sid, 'players'), s => cb(docs(s)), err),
    allPlayers: async () => withSid(await F.getDocs(F.collectionGroup(db, 'players'))),
    newId: () => F.doc(F.collection(db, 'sessions')).id,
    setPlayer: (sid, pid, data) => F.setDoc(F.doc(col(sid, 'players'), pid), data, { merge: true }),
    removePlayer: (sid, pid) => F.deleteDoc(F.doc(col(sid, 'players'), pid)),
    watchMatches: (sid, cb, err) => F.onSnapshot(col(sid, 'matches'), s => cb(docs(s)), err),
    // 需要 matches.names（集合群組、陣列包含）索引，見 README
    matchesByName: async name => withSid(await F.getDocs(F.query(F.collectionGroup(db, 'matches'), F.where('names', 'array-contains', name)))),
    async saveMatches(sid, upserts, delIds) {
      const b = F.writeBatch(db);
      for (const { id, ...m } of upserts) b.set(F.doc(col(sid, 'matches'), id), m);
      for (const id of delIds) b.delete(F.doc(col(sid, 'matches'), id));
      await b.commit();
    },
    setScore: (sid, mid, a, b) =>
      F.updateDoc(F.doc(col(sid, 'matches'), mid), { scoreA: a, scoreB: b, by: uid, at: Date.now() }),

    watchVenues: (cb, err) => F.onSnapshot(F.collection(db, 'venues'), s => cb(docs(s)), err),
    addVenue: name => F.addDoc(F.collection(db, 'venues'), { name, by: uid, createdAt: Date.now() }),
  };
}

// ---- DEMO：資料存在 localStorage，可切換「手機」模擬不同球友 ----
function demoStore() {
  const KEY = 'pp-demo4', UKEY = 'pp-demo4-uid';
  const rid = () => Math.random().toString(36).slice(2, 10);
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let data;
  const init = () => { data = load(); for (const k of ['sessions', 'players', 'matches', 'venues', 'names', 'hostKeys', 'private']) data[k] ||= {}; };
  init();
  let uid = localStorage.getItem(UKEY) || rid();
  localStorage.setItem(UKEY, uid);
  const subs = new Set();
  const emit = () => subs.forEach(f => f());
  const save = () => { localStorage.setItem(KEY, JSON.stringify(data)); emit(); };
  addEventListener('storage', e => { if (e.key === KEY) { init(); emit(); } });
  const watch = fn => { subs.add(fn); setTimeout(fn); return () => subs.delete(fn); };
  const list = obj => Object.entries(obj || {}).map(([id, v]) => ({ id, ...v }));
  const deny = () => Promise.reject(Object.assign(new Error('permission-denied'), { code: 'permission-denied' }));
  const isHost = sid => (data.sessions[sid]?.hostUids || []).includes(uid);
  const flat = name => Object.entries(data[name]).flatMap(([sid, o]) => list(o).map(x => ({ ...x, sid })));

  return {
    demo: true,
    get uid() { return uid; },
    setUid(id) { uid = id; localStorage.setItem(UKEY, id); emit(); },
    async createSession(d, hash) {
      const id = rid();
      data.hostKeys[uid] = hash; data.private[id] = hash;
      data.sessions[id] = { ...d, hostUids: [uid], createdAt: Date.now() }; save(); return id;
    },
    async reclaimHost(sid, hash) {
      data.hostKeys[uid] = hash;
      if (data.private[sid] !== hash) return deny();
      const s = data.sessions[sid]; if (!s.hostUids.includes(uid)) s.hostUids.push(uid); save();
    },
    async nameOwner(name) { return name in data.names ? data.names[name].owner : undefined; },
    async claimName(name, owner) {
      const cur = data.names[name];
      if (cur && cur.owner && cur.owner !== uid) return deny();
      if (owner !== uid && owner !== null) return deny();
      if (cur && owner === null) return; // 已存在就不必再登記
      data.names[name] = { owner, at: Date.now() }; save();
    },
    watchSessions: cb => watch(() => cb(list(data.sessions).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60))),
    allSessions: async () => list(data.sessions),
    getSessions: async ids => ids.filter(id => data.sessions[id]).map(id => ({ id, ...data.sessions[id] })),
    watchSession: (sid, cb) => watch(() => cb(data.sessions[sid] ? { id: sid, ...data.sessions[sid] } : null)),
    async updateSession(sid, patch) { if (!isHost(sid) || data.sessions[sid].closed) return deny(); Object.assign(data.sessions[sid], patch); save(); },

    watchPlayers: (sid, cb) => watch(() => cb(list(data.players[sid]))),
    allPlayers: async () => flat('players'),
    newId: rid,
    async setPlayer(sid, pid, d) {
      if (pid !== uid && !isHost(sid)) return deny();
      if (!isHost(sid) && data.names[d.name]?.owner !== uid) return deny(); // 自己報名須是自己登記的名字
      (data.players[sid] ||= {})[pid] = { ...(data.players[sid][pid] || {}), ...d }; save();
    },
    async removePlayer(sid, pid) {
      if (pid !== uid && !isHost(sid)) return deny();
      delete data.players[sid]?.[pid]; save();
    },
    watchMatches: (sid, cb) => watch(() => cb(list(data.matches[sid]))),
    matchesByName: async name => flat('matches').filter(m => (m.names || []).includes(name)),
    async saveMatches(sid, upserts, delIds) {
      if (!isHost(sid)) return deny();
      const m = (data.matches[sid] ||= {});
      for (const { id, ...v } of upserts) m[id] = v;
      for (const id of delIds) delete m[id];
      save();
    },
    async setScore(sid, mid, a, b) {
      const m = data.matches[sid]?.[mid];
      const s = data.sessions[sid];
      const ends = s.endsAt ?? (new Date(`${s.date}T${s.start}`).getTime() + s.duration * 60000);
      // 同正式版規則：該局四位球員或場主（補登）、場主沒按結束、且在結束後 15 分鐘內
      if (!m || !(m.players.includes(uid) || isHost(sid)) || s.closed || Date.now() > ends + 15 * 60000) return deny();
      Object.assign(m, { scoreA: a, scoreB: b, by: uid, at: Date.now() }); save();
    },

    watchVenues: cb => watch(() => cb(list(data.venues))),
    async addVenue(name) { data.venues[rid()] = { name, by: uid, createdAt: Date.now() }; save(); },
  };
}
