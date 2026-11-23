import { store, PHONE_RE, phoneHash } from './store.js?v=20261205';
import { buildSchedule, scheduleStats } from './pairing.js?v=20261205';
import { DEFAULT_VENUES } from './config.js?v=20261205';

// ================= 小工具 =================
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const addMin = (hhmm, m) => { const [h, mm] = hhmm.split(':').map(Number); const t = h * 60 + mm + m; return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; };
const WEEK = '日一二三四五六';
const dObj = d => new Date(d + 'T00:00');
const fmtDate = d => { if (!d) return ''; const x = dObj(d); return `${x.getMonth() + 1}/${x.getDate()}（${WEEK[x.getDay()]}）`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// 場次名稱規則：「月/日_場地匹克球」
const makeTitle = (date, venue) => { if (!date || !venue) return ''; const x = dObj(date); return `${x.getMonth() + 1}/${x.getDate()}_${venue}匹克球`; };
// 名字整理：去頭尾與多餘空白；成績以名字累積，所以名字要一致
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ');
const nameProblem = n => !n ? '請輸入名字' : n.length > 12 ? '名字最多 12 個字' : /[\/]/.test(n) ? '名字不能有「/」' : '';

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
const fail = e => { console.error(e); toast(e?.code === 'permission-denied' ? '沒有權限執行這個動作' : '儲存失敗，請檢查網路後再試'); };

// 這支手機上次用的名字（只存在本機，方便下次自動帶入）
const NAME_KEY = 'pp-my-name';
const myName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
const rememberName = n => { try { localStorage.setItem(NAME_KEY, n); } catch { } };

const params = new URLSearchParams(location.search);
const sid = params.get('s');
const page = sid ? 'session' : (params.get('p') === 'me' ? 'me' : 'home');

const state = { session: undefined, players: [], matches: [], tab: 'mine', viewAs: null, venues: [] };
let drawDemo = () => { };
const hostsOf = s => s?.hostUids || [];

// ================= 場主手機（只在本機加密，任何人都看不到號碼） =================
// 這支手機記住的是「加密後的亂碼」，不是號碼本身
const HOST_KEY = 'pp-host-key';
const savedHostKey = () => { try { return localStorage.getItem(HOST_KEY) || ''; } catch { return ''; } };
const saveHostKey = h => { try { localStorage.setItem(HOST_KEY, h); } catch { } };
let phoneAction = null;
function askPhone({ title, desc, submit }, action) {
  $('phoneTitle').textContent = title;
  $('phoneDesc').textContent = desc;
  $('phoneSubmit').textContent = submit;
  $('phoneInput').value = ''; $('phoneErr').textContent = '';
  phoneAction = action;
  $('phoneDlg').showModal(); $('phoneInput').focus();
}
function initPhoneDialog() {
  $('phoneCancel').addEventListener('click', () => $('phoneDlg').close());
  $('phoneInput').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
  $('phoneForm').addEventListener('submit', async e => {
    e.preventDefault();
    const phone = $('phoneInput').value.trim();
    if (!PHONE_RE.test(phone)) return ($('phoneErr').textContent = '請輸入 09 開頭的 10 碼手機號碼');
    $('phoneErr').textContent = '';
    try {
      const h = await phoneHash(phone);
      $('phoneInput').value = ''; // 號碼用完立即清掉，不留在畫面上
      await phoneAction(h);
      saveHostKey(h);
      $('phoneDlg').close();
    } catch (err) { console.error(err); $('phoneErr').textContent = err?.message === 'mismatch' || err?.code === 'permission-denied' ? '手機號碼和開場次時綁定的不同' : '操作失敗，請檢查網路後再試'; }
  });
}

// ================= 名字登記（先登記先贏） =================
const TAKEN = '已經有人用了，請另取一個名字（例如加上姓氏或綽號）。如果你是本人但換了手機，請場主幫你代報名。';
async function claimMyName(name) {
  const owner = await store.nameOwner(name);
  if (owner && owner !== store.uid) { const e = new Error('taken'); e.taken = true; throw e; }
  if (owner !== store.uid) await store.claimName(name, store.uid);
}

// ================= 場地 =================
let venueTarget = null;
const venueNames = () => {
  const extra = state.venues.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(v => v.name);
  return [...new Set([...DEFAULT_VENUES, ...extra])];
};
function fillVenue(sel, keep) {
  const cur = keep ?? sel.value;
  const names = venueNames();
  if (cur && !names.includes(cur)) names.push(cur);
  sel.innerHTML = names.map(n => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function initVenues() {
  store.watchVenues(vs => {
    state.venues = vs;
    fillVenue($('cVenue'));
    if ($('sVenue').options.length) fillVenue($('sVenue'));
    updatePreviews();
  }, e => console.error(e));
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-add-venue]'); if (!b) return;
    venueTarget = b.dataset.addVenue + 'Venue';
    $('venueName').value = ''; $('venueErr').textContent = '';
    $('venueDlg').showModal(); $('venueName').focus();
  });
  $('venueCancel').addEventListener('click', () => $('venueDlg').close());
  $('venueForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = cleanName($('venueName').value).replace(/匹克球$/, '');
    if (!name) return ($('venueErr').textContent = '請輸入場地名稱');
    try {
      if (!venueNames().includes(name)) await store.addVenue(name);
      fillVenue($(venueTarget), name);
      updatePreviews();
      $('venueDlg').close(); toast(`已新增場地：${name}`);
    } catch (err) { console.error(err); $('venueErr').textContent = '新增失敗，請再試一次'; }
  });
  ['cDate', 'cVenue', 'sDate', 'sVenue'].forEach(id => $(id).addEventListener('input', updatePreviews));
}
function updatePreviews() {
  $('cTitlePreview').textContent = makeTitle($('cDate').value, $('cVenue').value) || '—';
  $('sTitlePreview').textContent = makeTitle($('sDate').value, $('sVenue').value) || '—';
}
function readForm(p) {
  const date = $(p + 'Date').value, venue = $(p + 'Venue').value;
  return {
    title: makeTitle(date, venue), date, venue,
    start: $(p + 'Start').value,
    duration: +$(p + 'Dur').value,
    gameMin: +$(p + 'Game').value,
    courts: +$(p + 'Courts').value,
    // 結束時間（沒按「結束賽事」時，比分在結束後 15 分鐘自動鎖定）
    endsAt: new Date(`${date}T${$(p + 'Start').value}`).getTime() + (+$(p + 'Dur').value) * 60000,
  };
}

// ================= 首頁：場次列表＋開場次 =================
function initHome() {
  $('homeView').hidden = false;
  $('hdr').innerHTML = '<h1>一起來打匹克球</h1><p class="sub">報名場次、看自己每一輪的搭檔，打完輸入比分，成績自動累積。</p>';
  $('cDate').value = today();
  $('openCreate').addEventListener('click', () => { $('createForm').hidden = false; $('openCreate').hidden = true; updatePreviews(); });
  $('createForm').addEventListener('submit', async e => {
    e.preventDefault();
    const data = readForm('c');
    const create = async h => { const id = await store.createSession(data, h); saveHostKey(h); location.search = '?s=' + id; };
    const h = savedHostKey();
    if (h) { try { await create(h); } catch (err) { fail(err); } return; }
    askPhone({
      title: '綁定場主手機',
      desc: '第一次開場次請輸入你的手機號碼。之後換手機時，用同一個號碼就能取回場主管理權。',
      submit: '綁定並建立場次',
    }, create);
  });
  store.watchSessions(renderSessionList, e => { console.error(e); $('sessionList').innerHTML = '<div class="empty"><p>讀取場次失敗</p><p class="hint">請檢查網路連線後重新整理。</p></div>'; });
}
function renderSessionList(list) {
  const t = today();
  const up = list.filter(s => s.date >= t).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const past = list.filter(s => s.date < t);
  const item = s => {
    const x = dObj(s.date);
    return `<a class="sess" href="?s=${esc(s.id)}">
      <div class="cal"><b>${x.getMonth() + 1}/${x.getDate()}</b><span>週${WEEK[x.getDay()]}</span></div>
      <div class="info"><b>${esc(s.title)}</b><span>${esc(s.start)}–${esc(addMin(s.start, s.duration))}・${s.courts} 面場</span></div>
      ${s.date === t ? '<span class="tag">今天</span>' : ''}${hostsOf(s).includes(store.uid) ? '<span class="tag host">我開的</span>' : ''}
    </a>`;
  };
  $('sessionList').innerHTML = `
    <h2 class="sec">即將開打</h2>
    ${up.length ? `<div class="sess-list">${up.map(item).join('')}</div>` : '<div class="empty"><p>目前沒有即將開打的場次</p><p class="hint">按上方「開場次」建立一場，把連結傳給球友。</p></div>'}
    ${past.length ? `<h2 class="sec">最近打過</h2><div class="sess-list past">${past.slice(0, 20).map(item).join('')}</div>` : ''}`;
}

// ================= 場次頁 =================
const isHost = () => hostsOf(state.session).includes(store.uid);
const roundsOf = s => Math.max(1, Math.floor(s.duration / s.gameMin));
const playerMap = () => Object.fromEntries(state.players.map(p => [p.id, p]));
const sortedPlayers = () => state.players.slice().sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
const nameOf = (id, map = playerMap()) => map[id]?.name || '（已退出）';
const scored = m => m.scoreA != null && m.scoreB != null;
// 比分規則：該局四位球員能輸入／修改，場主可以補登任何一局
// 截止：場主按「結束賽事」立即截止；沒按的話，時間到後再預留 15 分鐘自動截止
const GRACE_MIN = 15;
const endsAtOf = s => s.endsAt ?? (new Date(`${s.date}T${s.start}`).getTime() + s.duration * 60000);
const deadline = () => state.session.closed ? state.session.closedAt : endsAtOf(state.session) + GRACE_MIN * 60000;
const scoreOpen = () => !state.session.closed && Date.now() <= deadline();
const deadlineText = () => { const d = new Date(deadline()); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const closedReason = () => state.session.closed ? `場主已於 ${deadlineText()} 結束賽事` : `${deadlineText()} 已截止`;
// 可輸入比分的人：該局四位球員，或場主（補登）
const mayScore = m => m.players.includes(store.uid) || isHost();
const canScore = m => mayScore(m) && scoreOpen();

function initSession() {
  $('sessionView').hidden = false;
  const err = e => { console.error(e); showMsg('讀取失敗', '請確認網路連線，或連結是否正確。'); };
  store.watchSession(sid, s => { state.session = s; onSession(); }, err);
  store.watchPlayers(sid, ps => { state.players = ps; render(); }, err);
  store.watchMatches(sid, ms => { state.matches = ms; render(); }, err);
  crownsOnce().then(render); // 皇冠名單讀到後重畫一次
  // 每 30 秒重畫一次，時間到就自動把比分按鈕換成「已截止」
  setInterval(() => { if (!$('scoreDlg').open) render(); }, 30000);

  $('joinName').value = myName();
  $('joinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = cleanName($('joinName').value);
    const prob = nameProblem(name); if (prob) return toast(prob);
    $('joinErr').textContent = '';
    if (state.players.some(p => p.name === name && p.id !== store.uid)) return ($('joinErr').textContent = `這場已經有人叫「${name}」，請另取一個名字（例如加上姓氏或綽號）。`);
    try {
      await claimMyName(name);
      await store.setPlayer(sid, store.uid, { name, joinedAt: playerMap()[store.uid]?.joinedAt || Date.now() });
      rememberName(name); state.renaming = false; toast('報名成功！'); render();
    } catch (err) {
      if (err.taken) { $('joinErr').textContent = `「${name}」${TAKEN}`; $('joinName').select(); return; }
      fail(err);
    }
  });
  $('reclaimBtn').addEventListener('click', () => askPhone({
    title: '取回場主管理權',
    desc: '請輸入開這個場次時綁定的手機號碼。號碼相符，這支手機就會成為場主。',
    submit: '取回管理權',
  }, async h => { await store.reclaimHost(sid, h); settingsFilled = false; toast('已取回場主管理權'); }));
  $('joinedBox').addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rename') { state.renaming = true; $('joinName').value = playerMap()[store.uid]?.name || ''; render(); $('joinName').focus(); }
    if (act === 'leave') {
      if (state.matches.some(m => m.players.includes(store.uid)) && !confirm('配對已經排好了，確定要取消報名？請記得告訴場主。')) return;
      try { await store.removePlayer(sid, store.uid); toast('已取消報名'); } catch (err) { fail(err); }
    }
  });

  $('settingsForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await store.updateSession(sid, readForm('s')); toast('設定已儲存'); } catch (err) { fail(err); }
  });
  $('addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = cleanName($('addName').value);
    const prob = nameProblem(name); if (prob) return toast(prob);
    if (state.players.some(p => p.name === name)) return toast('名單上已經有這個名字');
    try {
      // 已登記的名字：場主確認是本人才代報名（例如本人換了手機）
      const owner = await store.nameOwner(name);
      if (owner && !confirm(`「${name}」是已登記的名字，確定是本人嗎？成績會累積到這個名字。`)) return;
      await addByHost(name, owner);
      $('addName').value = '';
    } catch (err) { fail(err); }
  });

  // 從參加過的球友勾選
  $('pickBtn').addEventListener('click', openPick);
  $('pickCancel').addEventListener('click', () => $('pickDlg').close());
  $('pickSearch').addEventListener('input', renderPick);
  $('pickList').addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
    cb.checked ? pick.sel.add(cb.value) : pick.sel.delete(cb.value);
    pickCount();
  });
  $('pickForm').addEventListener('submit', async e => {
    e.preventDefault();
    const names = [...pick.sel];
    $('pickAdd').disabled = true;
    let n = 0;
    try {
      for (const name of names) { if (await addByHost(name)) n++; }
      $('pickDlg').close();
      toast(`已加入 ${n} 位球友`);
    } catch (err) { fail(err); pickCount(); }
  });
  $('drawBtn').addEventListener('click', draw);
  $('endBtn').addEventListener('click', async () => {
    const empty = state.matches.filter(m => !scored(m)).length;
    if (!confirm(`確定結束賽事？比分會立即鎖定，任何人都不能再修改。${empty ? `\n還有 ${empty} 局沒有比分。` : ''}`)) return;
    try { await store.updateSession(sid, { closed: true, closedAt: Date.now() }); toast('賽事已結束，比分已鎖定'); } catch (err) { fail(err); }
  });
  $('copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('shareUrl').value); toast('已複製連結，貼到群組給大家報名'); }
    catch { $('shareUrl').select(); toast('請長按連結複製'); }
  });
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    state.tab = b.dataset.tab;
    $('tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    render();
  });
  $('view').addEventListener('click', onViewClick);
  $('view').addEventListener('change', e => { if (e.target.id === 'viewAs') { state.viewAs = e.target.value; render(); } });
  initScoreDialog();
}

// 場主代報名：名字若是某支手機登記的，就用那支手機的身分加入，本人仍能用自己的手機輸入比分
async function addByHost(name, owner) {
  if (state.players.some(p => p.name === name)) return false;
  if (owner === undefined) owner = await store.nameOwner(name);
  if (owner === undefined) await store.claimName(name, null);
  const pid = owner && !state.players.some(p => p.id === owner) ? owner : store.newId();
  await store.setPlayer(sid, pid, { name, joinedAt: Date.now(), byHost: true });
  // 連續加入多人時，先記在本機避免重複；資料庫若已即時回傳這筆就不要再加（否則同一人會出現兩次）
  if (!state.players.some(p => p.id === pid)) state.players.push({ id: pid, name });
  return true;
}

// 勾選清單：列出在其他場次參加過的名字，依參加次數排序
const pick = { list: null, sel: new Set() };
async function openPick() {
  pick.sel = new Set(); pick.list = null;
  $('pickSearch').value = '';
  $('pickList').innerHTML = '<p class="hint">讀取中…</p>';
  pickCount();
  $('pickDlg').showModal();
  try {
    const ps = await store.allPlayers();
    const cnt = {};
    for (const p of ps) {
      if (p.sid === sid || !p.name) continue;
      const c = (cnt[p.name] ||= new Set()); c.add(p.sid);
    }
    pick.list = Object.entries(cnt).map(([name, s]) => ({ name, n: s.size }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh-Hant'));
    renderPick();
  } catch (err) { console.error(err); $('pickList').innerHTML = '<p class="err">讀取失敗，請檢查網路後再試</p>'; }
}
function renderPick() {
  if (!pick.list) return;
  const q = cleanName($('pickSearch').value);
  const here = new Set(state.players.map(p => p.name));
  const list = pick.list.filter(x => !q || x.name.includes(q));
  $('pickList').innerHTML = !pick.list.length ? '<p class="hint">還沒有其他場次的參加紀錄。</p>'
    : !list.length ? `<p class="hint">找不到「${esc(q)}」</p>`
    : list.map(x => {
      const inHere = here.has(x.name);
      return `<label class="pick ${inHere ? 'in' : ''}"><input type="checkbox" value="${esc(x.name)}" ${inHere ? 'checked disabled' : pick.sel.has(x.name) ? 'checked' : ''}>
        <span>${cn(x.name)}</span><small>${inHere ? '已在名單' : `參加過 ${x.n} 場`}</small></label>`;
    }).join('');
}
function pickCount() {
  $('pickAdd').textContent = pick.sel.size ? `加入 ${pick.sel.size} 位` : '加入';
  $('pickAdd').disabled = !pick.sel.size;
}

let settingsFilled = false;
function onSession() {
  const s = state.session;
  if (s === null) return showMsg('找不到這個場次', '連結可能打錯了，或場次已被刪除。');
  if (!s) return;
  if (isHost() && !settingsFilled) {
    settingsFilled = true;
    $('sDate').value = s.date; fillVenue($('sVenue'), s.venue || ''); $('sStart').value = s.start;
    $('sDur').value = s.duration; $('sGame').value = s.gameMin; $('sCourts').value = s.courts;
    updatePreviews();
  }
  document.title = `${s.title}｜匹克球雙打配對`;
  render();
}

function showMsg(title, body) {
  document.querySelectorAll('main').forEach(m => (m.hidden = true));
  $('msgView').hidden = false;
  $('msgView').innerHTML = `<section class="card center"><h2>${esc(title)}</h2><p class="hint">${esc(body)}</p><a class="btn primary" href="./">回到場次列表</a></section>`;
}

function render() {
  const s = state.session;
  if (!s) return;
  const R = roundsOf(s);
  const map = playerMap();
  const me = map[store.uid];
  const drawn = state.matches.length > 0;

  $('hdr').innerHTML = `<h1>${esc(s.title)}</h1>
    <div class="meta">
      <span>${esc(fmtDate(s.date))}</span>
      <span>${esc(s.start)}–${esc(addMin(s.start, s.duration))}</span>
      ${s.venue ? `<span>${esc(s.venue)}</span>` : ''}
      <span>${s.courts} 面場</span>
      <span>${R} 輪 × ${s.gameMin} 分鐘</span>
      <span>${state.players.length} 人報名</span>
      <span class="${scoreOpen() ? '' : 'closed'}">${scoreOpen() ? `比分可改到 ${esc(deadlineText().split(' ')[1])}` : s.closed ? '賽事已結束' : '比分已截止'}</span>
    </div>`;

  $('share').hidden = !isHost();
  $('shareUrl').value = location.origin + location.pathname + '?s=' + sid;

  // 報名區：配對排好後就不能改名字（避免成績記到不同名字）
  const myInMatch = state.matches.some(m => m.players.includes(store.uid));
  $('joinForm').hidden = !!me && !state.renaming;
  $('joinedBox').hidden = !me || !!state.renaming;
  if (me) {
    $('joinedBox').innerHTML = `<div class="joined"><div><span class="tag">已報名</span><b>${cn(me.name)}</b></div>
      <div class="acts">${myInMatch ? '' : '<button class="link" data-act="rename" type="button">改名字</button>'}<button class="link danger" data-act="leave" type="button">取消報名</button></div></div>`;
  }

  $('hostPanel').hidden = !isHost();
  $('reclaimBox').hidden = isHost();
  if (isHost()) {
    const lockedTo = Math.max(0, ...state.matches.filter(scored).map(m => m.round));
    $('drawBtn').textContent = drawn ? (lockedTo ? `重排第 ${lockedTo + 1} 輪之後的配對` : '重新產生配對') : '產生配對';
    $('drawBtn').disabled = state.players.length < 4 || lockedTo >= R || !scoreOpen();
    $('endBtn').hidden = !scoreOpen();
    $('endHint').textContent = scoreOpen()
      ? `按下後比分立即鎖定、不能再修改；沒按的話，${deadlineText().split(' ')[1]}（結束後 ${GRACE_MIN} 分鐘）自動鎖定。`
      : `${closedReason()}，比分已鎖定。`;
    $('drawHint').textContent = !scoreOpen() ? '賽事已結束，不能再重排或修改設定'
      : state.players.length < 4 ? `至少要 4 人才能配對（目前 ${state.players.length} 人）`
      : lockedTo >= R ? '每一輪都已有比分，無法再重排'
      : drawn ? (lockedTo ? `第 1–${lockedTo} 輪已有比分會保留，之後的輪次依目前名單重排（有人晚到或先走時使用）` : '名單有變動時可以重排，所有人的賽程會一起更新')
      : `會排出 ${R} 輪；人數超過 ${s.courts * 4} 人時，大家輪流休息`;
  }

  const v = $('view');
  if (state.tab === 'mine') v.innerHTML = renderMine(R, map, drawn);
  if (state.tab === 'all') v.innerHTML = renderAll(R, map, drawn);
  if (state.tab === 'rank') v.innerHTML = renderRank(map);
  if (state.tab === 'list') v.innerHTML = renderList();
  drawDemo();
}

function roundTime(r) { const s = state.session; const st = addMin(s.start, (r - 1) * s.gameMin); return `${st}–${addMin(st, s.gameMin)}`; }
const notDrawn = () => `<div class="empty"><div class="ball big" aria-hidden="true"></div><p>場主還沒產生配對</p><p class="hint">報名截止後，場主按下「產生配對」，這裡就會出現你每一輪的搭檔與對手。</p></div>`;

// 記分板：每隊一列，分數放大靠右，贏的一隊加粗並標綠點
// mySide：正在看的人在哪一隊（'A'／'B'／''）；mineView：我的賽程（自己這隊放上面，標「我方／對手」）
function scoreboard(m, map, mySide, mineView, who) {
  const done = scored(m);
  const win = done ? (m.scoreA > m.scoreB ? 'A' : 'B') : '';
  const order = mineView && mySide === 'B' ? ['B', 'A'] : ['A', 'B'];
  const rows = order.map(sd => {
    const team = sd === 'A' ? m.a : m.b, sc = sd === 'A' ? m.scoreA : m.scoreB;
    const label = mineView ? (sd === mySide ? '我方' : '對手') : '';
    const names = team.map(id => id === who ? `<b>${cn(nameOf(id, map))}</b>` : cn(nameOf(id, map))).join('<i>・</i>');
    return `<div class="trow side-${sd} ${sd === win ? 'win' : done ? 'lose' : ''} ${sd === mySide ? 'mine' : ''}">
      ${label ? `<span class="tlabel">${label}</span>` : ''}<span class="tnames">${names}</span>
      <span class="tscore">${done ? sc : '–'}</span><span class="tdot" aria-label="${sd === win ? '勝' : ''}"></span>
    </div>`;
  });
  return `<div class="board">${rows.join('')}</div>${scoreAction(m)}`;
}
// 比分按鈕：只有該局四位球員、而且賽事還沒結束
function scoreAction(m) {
  // 比分是場主（不在這局）補登的，標示出來讓大家知道
  const note = scored(m) && m.by && !m.players.includes(m.by) ? '<span class="by-host">場主補登</span>' : '';
  if (!mayScore(m)) return note ? `<div class="score-act">${note}</div>` : '';
  if (!scoreOpen()) return `<p class="locked">${note}比分已鎖定（${esc(closedReason())}）</p>`;
  const self = m.players.includes(store.uid);
  const label = scored(m) ? '修改比分' : self ? '輸入比分' : '補登比分';
  return `<div class="score-act">${note}<button class="btn sm ${scored(m) ? '' : 'primary'}" data-score="${esc(m.id)}" type="button">${label}</button></div>`;
}

function renderMine(R, map, drawn) {
  if (!drawn) return notDrawn();
  const opts = sortedPlayers();
  const who = state.viewAs && map[state.viewAs] ? state.viewAs : (map[store.uid] ? store.uid : null);
  const picker = `<label class="picker">查看：<select id="viewAs">
      ${who ? '' : '<option value="">選擇球友</option>'}
      ${opts.map(p => `<option value="${esc(p.id)}" ${p.id === who ? 'selected' : ''}>${esc(cnText(p.name))}${p.id === store.uid ? '（我）' : ''}</option>`).join('')}
    </select></label>`;
  if (!who) return `<div class="bar">${picker}</div><div class="empty"><p>你沒有報名這一場</p><p class="hint">可以在上方選擇其他球友，查看他們的賽程。</p></div>`;

  const ms = state.matches.filter(m => m.players.includes(who));
  const partners = new Set(), opps = new Set();
  let w = 0, l = 0;
  const cards = [];
  for (let r = 1; r <= R; r++) {
    const m = ms.find(x => x.round === r);
    if (!m) { cards.push(`<article class="round rest"><div class="rhead"><b>第 ${r} 輪</b><span>${roundTime(r)}</span></div><div class="restline">休息一輪，補充水分</div></article>`); continue; }
    const side = m.a.includes(who) ? 'A' : 'B';
    const mine = side === 'A' ? m.a : m.b, them = side === 'A' ? m.b : m.a;
    const partner = mine.find(x => x !== who);
    partners.add(partner); them.forEach(x => opps.add(x));
    if (scored(m)) { const my = m['score' + side], ot = m['score' + (side === 'A' ? 'B' : 'A')]; my > ot ? w++ : l++; }
    const res = scored(m) ? (m['score' + side] > m['score' + (side === 'A' ? 'B' : 'A')] ? '<span class="res win">勝</span>' : '<span class="res lose">敗</span>') : '';
    cards.push(`<article class="round"><div class="rhead"><b>第 ${r} 輪</b><span>${roundTime(r)}</span>${res}<span class="court">${m.court} 號場</span></div>
      ${scoreboard(m, map, side, true, who)}</article>`);
  }
  return `<div class="bar">${picker}</div>
    <div class="stats">
      <div><b>${ms.length}</b><span>上場局數</span></div>
      <div><b>${partners.size}<small>/${state.players.length - 1}</small></b><span>搭檔過的人</span></div>
      <div><b>${opps.size}</b><span>交手過的人</span></div>
      <div><b>${w}<small>勝</small> ${l}<small>敗</small></b><span>目前戰績</span></div>
    </div>
    <div class="rounds">${cards.join('')}</div>`;
}

function renderAll(R, map, drawn) {
  if (!drawn) return notDrawn();
  const ids = state.players.map(p => p.id);
  let html = '';
  for (let r = 1; r <= R; r++) {
    const ms = state.matches.filter(m => m.round === r).sort((a, b) => a.court - b.court);
    if (!ms.length) continue;
    const playing = new Set(ms.flatMap(m => m.players));
    const rest = ids.filter(id => !playing.has(id));
    html += `<article class="round all"><div class="rhead"><b>第 ${r} 輪</b><span>${roundTime(r)}</span></div>
      ${ms.map(m => `<div class="cblock ${m.players.includes(store.uid) ? 'me' : ''}">
        <span class="court">${m.court} 號場</span>
        ${scoreboard(m, map, m.a.includes(store.uid) ? 'A' : m.b.includes(store.uid) ? 'B' : '', false, store.uid)}
      </div>`).join('')}
      ${rest.length ? `<div class="restline">休息：${rest.map(x => cn(nameOf(x, map))).join('、')}</div>` : ''}
    </article>`;
  }
  return renderQuality(R, ids) + `<div class="rounds">${html}</div>`;
}

// 賽程品質摘要：讓場主一眼看出這份賽程公不公平，不滿意可以重排
function renderQuality(R, ids) {
  const rounds = [];
  for (let r = 1; r <= R; r++) rounds.push({ matches: state.matches.filter(m => m.round === r) });
  const q = scheduleStats(ids, rounds.filter(rd => rd.matches.length));
  const item = (label, value, ok, note) => `<div class="q ${ok ? 'good' : 'warn'}"><span>${label}</span><b>${value}</b><small>${note}</small></div>`;
  return `<section class="quality" aria-label="賽程品質">
    <h3>賽程品質</h3>
    <div class="qgrid">
      ${item('每人上場', q.minGames === q.maxGames ? `${q.maxGames} 局` : `${q.minGames}–${q.maxGames} 局`, q.maxGames - q.minGames <= 1, '差距越小越公平')}
      ${item('最多連打', `${q.maxPlayStreak} 輪`, q.maxPlayStreak <= 4, '同一人連續上場')}
      ${item('最久等待', `${q.maxRestStreak} 輪`, q.maxRestStreak <= 2, '同一人連續休息')}
      ${item('搭檔重複', q.repeatPartners ? `${q.repeatPartners} 組` : '沒有', q.repeatPartners === 0, '同兩人再同隊')}
      ${item('同對手最多', `${q.maxOpp} 次`, q.maxOpp <= 3, '跟同一人交手')}
    </div>
    ${isHost() ? '<p class="hint">不滿意可以按上方「重新產生配對」再排一次（已有比分的輪次會保留）。</p>' : ''}
  </section>`;
}

// 依對戰紀錄統計勝敗與得失分；key(m, i) 取出第 i 位（0,1 = A 隊；2,3 = B 隊）的識別
function tally(matches, keyOf) {
  const t = {};
  for (const m of matches.filter(scored)) {
    [0, 1, 2, 3].forEach(i => {
      const k = keyOf(m, i); if (k == null) return;
      const my = i < 2 ? m.scoreA : m.scoreB, ot = i < 2 ? m.scoreB : m.scoreA;
      const r = (t[k] ||= { id: k, g: 0, w: 0, l: 0, pf: 0, pa: 0 });
      r.g++; r.pf += my; r.pa += ot; my > ot ? r.w++ : r.l++;
    });
  }
  return t;
}
const signed = n => (n > 0 ? '+' : '') + n;

function renderRank(map) {
  const rows = Object.values(tally(state.matches, (m, i) => m.players[i]))
    .sort((a, b) => b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf);
  if (!rows.length) return `<div class="empty"><p>還沒有比分</p><p class="hint">每局結束後，由該局的四位球員輸入比分，戰績會自動統計。</p></div>`;
  return `<div class="table-wrap"><table class="rank"><thead><tr><th>#</th><th>球友</th><th>局數</th><th>勝</th><th>敗</th><th>得分</th><th>失分</th><th>淨分</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="${r.id === store.uid ? 'me' : ''}"><td>${i + 1}</td><td>${cn(nameOf(r.id, map))}</td><td>${r.g}</td><td>${r.w}</td><td>${r.l}</td><td>${r.pf}</td><td>${r.pa}</td><td>${signed(r.pf - r.pa)}</td></tr>`).join('')}
  </tbody></table></div><p class="hint">排名依勝場數，再比淨分（得分 − 失分）。</p>`;
}

function renderList() {
  const ps = sortedPlayers();
  if (!ps.length) return `<div class="empty"><p>還沒有人報名</p><p class="hint">把報名連結傳到群組，大家輸入名字就完成報名。</p></div>`;
  return `<ol class="plist">${ps.map(p => `<li><span>${cn(p.name)}${p.id === store.uid ? ' <span class="tag">我</span>' : ''}${p.byHost ? ' <span class="tag dim">代報名</span>' : ''}${hostsOf(state.session).includes(p.id) ? ' <span class="tag host">場主</span>' : ''}</span>
    ${isHost() ? `<button class="link danger" data-remove="${esc(p.id)}" type="button">移除</button>` : ''}</li>`).join('')}</ol>${crown.set.size ? `<p class="hint">${CROWN_SVG} 常客：參加場次前三名的球友（至少 2 場）</p>` : ''}`;
}

async function onViewClick(e) {
  const sc = e.target.closest('[data-score]');
  if (sc) return openScore(sc.dataset.score);
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const name = nameOf(rm.dataset.remove);
    if (!confirm(`確定把「${name}」移出名單？已排好的配對不會自動改，請再按一次「重排」。`)) return;
    try { await store.removePlayer(sid, rm.dataset.remove); } catch (err) { fail(err); }
  }
}

async function draw() {
  const s = state.session, R = roundsOf(s);
  const ids = [...new Set(sortedPlayers().map(p => p.id))]; // 保險：同一人只算一次
  const map = playerMap();
  if (ids.length < 4) return toast('至少需要 4 人才能配對');
  const lockedTo = Math.max(0, ...state.matches.filter(scored).map(m => m.round));
  const L = lockedTo + 1;
  if (L > R) return toast('每一輪都已有比分，無法再重排');
  if (state.matches.length && !confirm(lockedTo ? `第 ${L} 輪之後的配對會重新排，確定嗎？` : '目前的配對會全部重新排，確定嗎？')) return;

  const prior = state.matches.filter(m => m.round < L);
  const rounds = buildSchedule(ids, s.courts, R - L + 1, prior);
  const upserts = rounds.flatMap((rd, i) => rd.matches.map(m => {
    const players = [...m.a, ...m.b];
    return {
      id: `r${pad(L + i)}c${pad(m.court)}`, round: L + i, court: m.court,
      a: m.a, b: m.b, players, names: players.map(p => map[p].name), // names：跨場次累積成績用
      scoreA: null, scoreB: null, by: null, at: null,
    };
  }));
  const keep = new Set(upserts.map(m => m.id));
  const del = state.matches.filter(m => m.round >= L && !keep.has(m.id)).map(m => m.id);
  try {
    await store.saveMatches(sid, upserts, del);
    await store.updateSession(sid, { drawnAt: Date.now() });
    toast('配對完成！大家打開連結就能看到自己的賽程');
    state.tab = 'all';
    $('tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.tab === 'all'));
    render();
  } catch (err) { fail(err); }
}

let scoring = null;
function initScoreDialog() {
  $('scoreCancel').addEventListener('click', () => $('scoreDlg').close());
  $('scoreForm').addEventListener('submit', async e => {
    e.preventDefault();
    const a = Number($('scoreA').value), b = Number($('scoreB').value);
    if ([a, b].some(x => $('scoreA').value === '' || $('scoreB').value === '' || !Number.isInteger(x) || x < 0 || x > 99)) return ($('scoreErr').textContent = '請輸入 0–99 的整數');
    if (a === b) return ($('scoreErr').textContent = '匹克球沒有平手，請再確認比分');
    try { await store.setScore(sid, scoring, a, b); $('scoreDlg').close(); toast('比分已儲存'); }
    catch (err) { $('scoreErr').textContent = err?.code === 'permission-denied' ? '只有這一局的球員或場主可以輸入比分，且賽事結束後就不能再改' : '儲存失敗，請再試一次'; }
  });
}
function openScore(mid) {
  const m = state.matches.find(x => x.id === mid);
  if (!m) return;
  if (!mayScore(m)) return toast('只有這一局的球員或場主可以輸入比分');
  if (!scoreOpen()) return toast(`比分已鎖定（${closedReason()}）`);
  scoring = mid;
  const map = playerMap();
  $('scoreTitle').textContent = `第 ${m.round} 輪・${m.court} 號場`;
  $('scoreNamesA').innerHTML = m.a.map(x => cn(nameOf(x, map))).join('<br>');
  $('scoreNamesB').innerHTML = m.b.map(x => cn(nameOf(x, map))).join('<br>');
  $('scoreA').value = m.scoreA ?? ''; $('scoreB').value = m.scoreB ?? '';
  $('scoreErr').textContent = '';
  $('scoreDlg').showModal();
  $('scoreA').focus();
}

// ================= 我的成績（輸入名字查詢） =================
function initMe() {
  const v = $('meView');
  v.hidden = false;
  $('hdr').innerHTML = '<h1>我的成績</h1><p class="sub">輸入你報名時用的名字，就能看到每一場的勝敗與最常一起打的搭檔。</p>';
  v.innerHTML = `<section class="card">
      <form id="lookupForm" class="row-form">
        <label for="lookupName" class="lbl">你是誰？</label>
        <div class="row"><input id="lookupName" maxlength="12" placeholder="報名時用的名字" value="${esc(params.get('n') || myName())}"><button class="btn primary" type="submit">查詢</button></div>
      </form>
    </section>
    <div id="meBody"></div>`;
  $('lookupForm').addEventListener('submit', e => { e.preventDefault(); lookup(cleanName($('lookupName').value)); });
  if ($('lookupName').value) lookup(cleanName($('lookupName').value));
  else $('meBody').innerHTML = '<div class="empty"><p>輸入名字查詢</p><p class="hint">每次報名都用同一個名字，成績就會累積在一起。</p></div>';
}
let meToken = 0;
async function lookup(name) {
  const body = $('meBody'), token = ++meToken;
  if (!name) return;
  body.className = 'empty'; body.innerHTML = '<p>查詢中…</p>';
  let ms;
  try { [ms] = await Promise.all([store.matchesByName(name), crownsOnce()]); }
  catch (err) {
    console.error(err);
    if (token === meToken) body.innerHTML = '<p>查詢失敗</p><p class="hint">如果是剛上線，請確認 Firestore 已建立 README 所列的索引。</p>';
    return;
  }
  if (token !== meToken) return;
  const sids = [...new Set(ms.map(m => m.sid))];
  const sessions = await store.getSessions(sids);
  if (token !== meToken) return;
  const sMap = Object.fromEntries(sessions.map(s => [s.id, s]));
  ms = ms.filter(m => sMap[m.sid]);
  if (!ms.length) {
    body.innerHTML = `<p>找不到「${esc(name)}」的比賽紀錄</p><p class="hint">請確認名字和報名時一模一樣；配對排好後才會有紀錄。</p>`;
    return;
  }
  const byName = (m, i) => (m.names[i] === name ? name : null);
  const all = tally(ms, byName)[name] || { g: 0, w: 0, l: 0, pf: 0, pa: 0 };
  const partnerCount = {};
  for (const m of ms) { const i = m.names.indexOf(name); const p = m.names[i ^ 1]; partnerCount[p] = (partnerCount[p] || 0) + 1; }
  const topPartners = Object.entries(partnerCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const perSession = sids.filter(id => sMap[id]).map(id => {
    const list = ms.filter(m => m.sid === id);
    return { s: sMap[id], n: list.length, r: tally(list, byName)[name] || { w: 0, l: 0, pf: 0, pa: 0 } };
  }).sort((a, b) => b.s.date.localeCompare(a.s.date));
  const rate = all.g ? Math.round(all.w / all.g * 100) : 0;

  body.className = 'me-body';
  body.innerHTML = `
    <h2 class="sec">${cn(name)} 的成績${crown.set.has(name) ? '<span class="crown-note">常客・已參加 ' + crown.count[name] + ' 場</span>' : ''}</h2>
    <div class="stats">
      <div><b>${perSession.length}</b><span>參加場次</span></div>
      <div><b>${all.g}</b><span>有比分的局數</span></div>
      <div><b>${all.w}<small>勝</small> ${all.l}<small>敗</small></b><span>勝率 ${rate}%</span></div>
      <div><b>${signed(all.pf - all.pa)}</b><span>累計淨分</span></div>
    </div>
    <section class="card"><h2>最常一起打的搭檔</h2><ol class="partners">${topPartners.map(([p, c]) => `<li><span>${cn(p)}</span><b>${c} 局</b></li>`).join('')}</ol></section>
    <h2 class="sec">每場紀錄</h2>
    <div class="sess-list">${perSession.map(({ s, r, n }) => `<a class="sess" href="?s=${esc(s.id)}">
      <div class="cal"><b>${dObj(s.date).getMonth() + 1}/${dObj(s.date).getDate()}</b><span>週${WEEK[dObj(s.date).getDay()]}</span></div>
      <div class="info"><b>${esc(s.title)}</b><span>上場 ${n} 局・${r.w} 勝 ${r.l} 敗・淨分 ${signed(r.pf - r.pa)}</span></div>
    </a>`).join('')}</div>`;
}

// ================= 皇冠：常來球敘的球友 =================
// 規則：只算已經打過的場次（日期在今天以前或今天），參加場次排前三名（同場數並列）、且至少 2 場，名字旁戴皇冠
const CROWN_TOP = 3, CROWN_MIN = 2;
const CROWN_SVG = '<svg class="crown" viewBox="0 0 24 24" role="img" aria-label="常客"><title>常客：參加場次前三名</title><path d="M3 8.5l4.6 3.8L12 5l4.4 7.3L21 8.5l-1.8 9.5H4.8L3 8.5z"/><rect x="4.8" y="19" width="14.4" height="2" rx="1"/></svg>';
const crown = { set: new Set(), count: {} };
let crownReady = null;
const crownsOnce = () => (crownReady ||= loadCrowns()); // 一個頁面只讀一次
// 名字（已處理特殊字元）＋皇冠；給 HTML 用
const cn = name => esc(name) + (crown.set.has(name) ? CROWN_SVG : '');
// 給 <option> 這種不能放圖的地方用
const cnText = name => name + (crown.set.has(name) ? ' 👑' : '');
async function loadCrowns() {
  try {
    const [ss, ps] = await Promise.all([store.allSessions(), store.allPlayers()]);
    const t = today();
    const date = Object.fromEntries(ss.map(s => [s.id, s.date]));
    const seen = {};
    for (const p of ps) {
      const d = date[p.sid];
      if (!d || d > t || !p.name) continue;
      (seen[p.name] ||= new Set()).add(p.sid);
    }
    crown.count = Object.fromEntries(Object.entries(seen).map(([n, s]) => [n, s.size]));
    // 第 3 名的場數就是門檻；跟第 3 名一樣多場的也一起戴（並列）
    const sorted = Object.values(crown.count).filter(n => n >= CROWN_MIN).sort((a, b) => b - a);
    const cut = sorted.length ? sorted[Math.min(CROWN_TOP, sorted.length) - 1] : Infinity;
    crown.set = new Set(Object.entries(crown.count).filter(([, n]) => n >= cut && n >= CROWN_MIN).map(([name]) => name));
  } catch (e) { console.error(e); }
}

// ================= DEMO：模擬不同手機 =================
function renderDemoBar() {
  const bar = $('demoBar'); bar.hidden = false;
  drawDemo = () => {
    if (!sid) { bar.innerHTML = '<b>DEMO 模式</b><span>資料只存在這個瀏覽器（尚未填入 Firebase 設定）</span>'; return; }
    const host = hostsOf(state.session)[0], map = playerMap();
    const ids = [...new Set([host, ...sortedPlayers().map(p => p.id), store.uid].filter(Boolean))];
    bar.innerHTML = `<b>DEMO 模式</b><span>資料只存在這個瀏覽器</span>
      <label>模擬手機<select id="demoWho">${ids.map(id => `<option value="${esc(id)}" ${id === store.uid ? 'selected' : ''}>${id === host ? '場主' : ''}${map[id] ? (id === host ? '・' : '') + esc(map[id].name) : (id === host ? '' : '新手機')}</option>`).join('')}</select></label>
      <button class="btn sm" id="demoNew" type="button">換一支新手機</button>`;
  };
  const switchTo = id => { state.renaming = false; state.viewAs = null; settingsFilled = false; store.setUid(id); };
  bar.addEventListener('change', e => { if (e.target.id === 'demoWho') switchTo(e.target.value); });
  bar.addEventListener('click', e => { if (e.target.id === 'demoNew') switchTo(Math.random().toString(36).slice(2, 10)); });
  drawDemo();
}

// ================= 啟動 =================
$('mainnav').querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.p === page));
if (store.demo) renderDemoBar();
initPhoneDialog();
initVenues();
if (page === 'session') initSession();
else if (page === 'me') initMe();
else initHome();
