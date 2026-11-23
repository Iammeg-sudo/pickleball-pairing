// 雙打配對演算法
// 原則：1) 上場次數平均，不連續休息太多輪、也不連續打太多輪
//       2) 盡量和「還沒搭檔過」的人同隊  3) 盡量避免一直遇到同樣的對手
// 做法：每一輪試很多種組合取最好的；整份賽程也排很多版，用「賽程品質」挑最好的一版
const TRIALS = 250;      // 每一輪嘗試的分組次數
const CANDIDATES = 40;   // 整份賽程排幾版來比較
const STREAK_WEIGHT = 0.6; // 連打一輪約等於多打 0.6 局，決定誰該休息

const key = (x, y) => (x < y ? x + '|' + y : y + '|' + x);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newStats() {
  return { games: new Map(), rests: new Map(), playStreak: new Map(), restStreak: new Map(), partner: new Map(), opp: new Map() };
}
const get = (m, k, d = 0) => (m.has(k) ? m.get(k) : d);
const inc = (m, k) => m.set(k, get(m, k) + 1);

function applyRound(st, ids, matches) {
  const playing = new Set();
  for (const { a, b } of matches) {
    for (const p of [...a, ...b]) playing.add(p);
    inc(st.partner, key(a[0], a[1]));
    inc(st.partner, key(b[0], b[1]));
    for (const x of a) for (const y of b) inc(st.opp, key(x, y));
  }
  for (const p of ids) {
    if (playing.has(p)) { inc(st.games, p); inc(st.playStreak, p); st.restStreak.set(p, 0); }
    else { inc(st.rests, p); inc(st.restStreak, p); st.playStreak.set(p, 0); }
  }
}

// 一組四人的三種分隊方式，取成本最低者
function bestSplit(q, st) {
  const [p, r, s, t] = q;
  const options = [[[p, r], [s, t]], [[p, s], [r, t]], [[p, t], [r, s]]];
  let best = null, bestCost = Infinity;
  for (const [a, b] of options) {
    const pa = get(st.partner, key(a[0], a[1])), pb = get(st.partner, key(b[0], b[1]));
    let cost = 100 * (pa * pa + pa) + 100 * (pb * pb + pb);
    for (const x of a) for (const y of b) { const o = get(st.opp, key(x, y)); cost += 8 * o * o + 4 * o; }
    if (cost < bestCost) { bestCost = cost; best = { a, b }; }
  }
  return { ...best, cost: bestCost };
}

function makeRound(ids, courts, st) {
  const k = Math.min(courts, Math.floor(ids.length / 4));
  const restN = ids.length - 4 * k;
  // 休息人選（排越前面越該休息）：
  // 1. 已經連續休息越多輪的，越不該再休息（避免等太久）
  // 2. 「上場局數＋連打輪數」越高的先休息（局數平均，同時避免連打太多）
  // 3. 休息次數少的先休息
  const tired = p => get(st.games, p) + STREAK_WEIGHT * get(st.playStreak, p);
  const order = shuffle(ids.slice()).sort((x, y) =>
    (get(st.restStreak, x) - get(st.restStreak, y)) ||
    (tired(y) - tired(x)) ||
    (get(st.rests, x) - get(st.rests, y)));
  const rest = order.slice(0, restN);
  const active = order.slice(restN);

  let best = null, bestCost = Infinity;
  for (let t = 0; t < TRIALS && k > 0; t++) {
    shuffle(active);
    const matches = [];
    let cost = 0;
    for (let c = 0; c < k; c++) {
      const m = bestSplit(active.slice(c * 4, c * 4 + 4), st);
      cost += m.cost;
      matches.push({ court: c + 1, a: m.a, b: m.b });
    }
    if (cost < bestCost) { bestCost = cost; best = matches; if (cost === 0) break; }
  }
  return { matches: best || [], rest };
}

/**
 * 賽程品質：rounds = 依輪次排好的 [{matches:[{a,b}]}]，ids = 參加者
 * 回傳 平均／最少／最多上場局數、最多連打幾輪、最久連續休息幾輪、搭檔重複組數、同搭檔最多幾次、同對手最多交手幾次
 */
export function scheduleStats(ids, rounds) {
  const games = new Map(), partner = new Map(), opp = new Map();
  const cur = new Map(), curRest = new Map();
  let maxPlay = 0, maxRest = 0;
  for (const rd of rounds) {
    const playing = new Set();
    for (const { a, b } of rd.matches) {
      [...a, ...b].forEach(p => playing.add(p));
      inc(partner, key(a[0], a[1])); inc(partner, key(b[0], b[1]));
      for (const x of a) for (const y of b) inc(opp, key(x, y));
    }
    for (const p of ids) {
      if (playing.has(p)) { inc(games, p); inc(cur, p); curRest.set(p, 0); maxPlay = Math.max(maxPlay, cur.get(p)); }
      else { inc(curRest, p); cur.set(p, 0); maxRest = Math.max(maxRest, curRest.get(p)); }
    }
  }
  const g = ids.map(p => get(games, p));
  const pv = [...partner.values()];
  return {
    minGames: g.length ? Math.min(...g) : 0,
    maxGames: g.length ? Math.max(...g) : 0,
    maxPlayStreak: maxPlay,
    maxRestStreak: maxRest,
    repeatPartners: pv.filter(v => v > 1).length,
    maxPartner: pv.length ? Math.max(...pv) : 0,
    maxOpp: opp.size ? Math.max(...opp.values()) : 0,
  };
}

// 整份賽程的扣分（越低越好）：先求公平與搭檔不重複，再求不連打、不久等、少重複對手
function scheduleCost(s) {
  return (s.maxGames - s.minGames) * 1000 + Math.max(0, s.maxPartner - 1) * 500 + s.repeatPartners * 120
    + s.maxRestStreak * 80 + s.maxPlayStreak * 60 + s.maxOpp * 150;
}

/**
 * 產生賽程
 * @param {string[]} ids 參加者 id（依報名順序）
 * @param {number} courts 場地數
 * @param {number} count 要產生幾輪
 * @param {{round:number,a:string[],b:string[]}[]} prior 之前已打（保留）的對戰，用來延續搭檔與連打紀錄
 * @returns {{matches:{court:number,a:string[],b:string[]}[], rest:string[]}[]}
 */
export function buildSchedule(ids, courts, count, prior = []) {
  const priorRounds = [...new Set(prior.map(m => m.round))].sort((x, y) => x - y)
    .map(r => ({ matches: prior.filter(m => m.round === r) }));
  let best = null, bestCost = Infinity;
  for (let c = 0; c < CANDIDATES; c++) {
    const st = newStats();
    priorRounds.forEach(rd => applyRound(st, ids, rd.matches));
    const out = [];
    for (let i = 0; i < count; i++) {
      const rd = makeRound(ids, courts, st);
      applyRound(st, ids, rd.matches);
      out.push(rd);
    }
    const cost = scheduleCost(scheduleStats(ids, [...priorRounds, ...out]));
    if (cost < bestCost) { bestCost = cost; best = out; }
  }
  return best;
}
