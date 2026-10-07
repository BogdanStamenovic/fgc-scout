// Pure logic: merging scout entries, finding our matches, ranking what to measure.

export const SYSTEMS = ["shooter", "intake", "climb", "partnerClimb"];

// What "fully measured" means. Each missing item is one thing a scout can go and get.
export const REQUIRED = [
  ["shooter", (f) => f.shooter?.has != null],
  ["intake", (f) => f.intake?.has != null],
  ["climb", (f) => f.climb?.has != null],
  ["partner climb", (f) => f.partnerClimb?.has != null],
  ["weight", (f) => f.weightKg != null],
  ["size", (f) => f.size?.l != null && f.size?.w != null && f.size?.h != null],
  ["hook space", (f) => f.hookSpace?.has != null],
];
const PHOTO_REQUIRED = "robot photo";

const blank = (v) => v === undefined || v === null || v === "";

// Field-level last-write-wins over entries sorted oldest first: a later entry that
// only fills in the weight must not erase the shooter answer from an earlier one.
export function mergeEntries(entries) {
  const fields = {};
  const comments = [];
  const scouts = new Set();
  let lastTs = null;
  const set = (obj, key, v) => { if (!blank(v)) obj[key] = v; };
  for (const e of [...entries].sort((a, b) => a.ts - b.ts)) {
    const d = e.body || {};
    if (e.scout) scouts.add(e.scout);
    lastTs = e.ts;
    for (const s of SYSTEMS) {
      const src = d.systems?.[s];
      if (!src) continue;
      fields[s] ??= {};
      set(fields[s], "has", src.has);
      if (s === "climb") set(fields[s], "zone", src.zone);
      if (!blank(src.comment)) comments.push({ field: s, text: src.comment, scout: e.scout, ts: e.ts });
    }
    set(fields, "weightKg", num(d.weightKg));
    set(fields, "extensionCm", num(d.extensionCm));
    if (d.size) {
      fields.size ??= {};
      for (const k of ["l", "w", "h"]) set(fields.size, k, num(d.size[k]));
    }
    if (d.hookSpace) {
      fields.hookSpace ??= {};
      set(fields.hookSpace, "has", d.hookSpace.has);
      set(fields.hookSpace, "w", num(d.hookSpace.w));
      set(fields.hookSpace, "h", num(d.hookSpace.h));
      if (!blank(d.hookSpace.comment)) comments.push({ field: "hookSpace", text: d.hookSpace.comment, scout: e.scout, ts: e.ts });
    }
    if (!blank(d.notes)) comments.push({ field: "notes", text: d.notes, scout: e.scout, ts: e.ts });
  }
  return { fields, comments, scouts: [...scouts], lastTs };
}

function num(v) {
  if (blank(v)) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function missingFor(team) {
  const f = team.scouted?.fields || {};
  const miss = REQUIRED.filter(([, ok]) => !ok(f)).map(([name]) => name);
  if (!(team.photos || []).some((p) => p.part === "robot")) miss.push(PHOTO_REQUIRED);
  return miss;
}
export const REQUIRED_COUNT = REQUIRED.length + 1;

// Stations 11-14 are red, 21-24 blue (14/24 = the fourth playoff alliance member).
const side = (station) => (Math.floor(station / 10) === 1 ? "red" : "blue");

export function ourMatches(matches, our) {
  const out = [];
  for (const m of matches) {
    const me = (m.participants || []).find((p) => p.country === our);
    if (!me) continue;
    const mine = side(me.station);
    const others = (m.participants || []).filter((p) => p.country !== our);
    out.push({
      id: m.id, name: m.name, tournamentKey: m.tournamentKey, field: m.field ?? null,
      scheduledTime: m.scheduledTime, played: !!m.played, side: mine,
      partners: others.filter((p) => side(p.station) === mine).map((p) => p.country),
      opponents: others.filter((p) => side(p.station) !== mine).map((p) => p.country),
      redScore: m.redScore, blueScore: m.blueScore,
    });
  }
  return out.sort((a, b) => String(a.scheduledTime).localeCompare(String(b.scheduledTime)) || a.id - b.id);
}

// Strength in 0..1: live 2026 rank once a team has played, blended in over its
// first six matches; before that, the past-performance score (a weak predictor,
// see history.json backtest).
export function strengthOf(team, rank, rankedCount) {
  const past = (team.history?.pastScore ?? 50) / 100;
  if (!rank || !rank.played || rankedCount < 2) return { value: past, source: "past seasons" };
  const pct = 1 - (rank.rank - 1) / (rankedCount - 1);
  const w = Math.min(1, rank.played / 6);
  return { value: w * pct + (1 - w) * past, source: `2026 rank ${rank.rank} after ${rank.played}` };
}

// priority = share still unmeasured x importance.
// importance = 1 + 3*strength, plus 5 + 5*relation for any team in one of our
// upcoming matches, so every upcoming partner/opponent outranks every
// non-match team (max 4). Partners count fully, opponents at 0.7: a partner's
// weight and hook space decide whether we can do a partner climb with them.
// relation decays with how far ahead the match is: next match 1, then 1/2, 1/3...
export function priorityList(teams, schedule, ranks, our) {
  const upcoming = schedule.filter((m) => !m.played);
  const rel = {};
  upcoming.forEach((m, i) => {
    const w = 1 / (1 + i);
    for (const c of m.partners) {
      rel[c] ??= { partner: 0, opponent: 0, next: m.name };
      rel[c].partner = Math.max(rel[c].partner, w);
    }
    for (const c of m.opponents) {
      rel[c] ??= { partner: 0, opponent: 0, next: m.name };
      rel[c].opponent = Math.max(rel[c].opponent, w);
    }
  });
  const rankedCount = Object.keys(ranks).length;
  const list = [];
  for (const t of Object.values(teams)) {
    if (t.code === our) continue;
    const missing = missingFor(t);
    const gap = missing.length / REQUIRED_COUNT;
    const s = strengthOf(t, ranks[t.code], rankedCount);
    const r = rel[t.code] || null;
    const relation = r ? Math.max(r.partner, 0.7 * r.opponent) : 0;
    const importance = 1 + 3 * s.value + (relation > 0 ? 5 + 5 * relation : 0);
    list.push({
      code: t.code, name: t.name,
      priority: Math.round(gap * importance * 10) / 10,
      importance: Math.round(importance * 10) / 10,
      missing, strength: Math.round(s.value * 100), strengthSource: s.source,
      relation: r,
    });
  }
  return list.sort((a, b) => b.priority - a.priority || b.importance - a.importance);
}

// ---------- standing, playoff math, alliances, matches of interest ----------

const sideOf = (station) => (Math.floor(station / 10) === 1 ? "red" : "blue");

// Ranking score = average of a team's ranking-match scores with the single
// lowest dropped (rule M21 / 6.3). Checked on 2025 data: equals the official
// rankingScore exactly for 172 of 181 teams; the other 9 differ by up to ~3,
// presumably penalties or cards.
export function dropLowestAvg(scores) {
  if (!scores.length) return null;
  if (scores.length === 1) return scores[0];
  const s = [...scores].sort((a, b) => a - b).slice(1);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

export function ourRankingScores(matches, our) {
  const played = [], remaining = [];
  for (const m of matches) {
    if (m.tournamentKey !== "t2") continue; // ranking matches only
    const me = (m.participants || []).find((p) => p.country === our);
    if (!me) continue;
    if (m.played) played.push(sideOf(me.station) === "red" ? m.redScore : m.blueScore);
    else remaining.push(m);
  }
  return { played, remaining: remaining.length };
}

// Lowest per-match average over the remaining matches that lifts our ranking
// score to at least `target`, assuming every other team's score stays where it
// is now (they will move, so treat this as a floor, not a guarantee).
export function neededAverage(scores, remaining, target) {
  if (target == null) return null;
  if (!remaining) return { done: true, reached: (dropLowestAvg(scores) ?? 0) >= target };
  const ok = (x) => dropLowestAvg([...scores, ...Array(remaining).fill(x)]) >= target;
  if (ok(0)) return { need: 0 };
  let lo = 0, hi = 1;
  while (!ok(hi)) { hi *= 2; if (hi > 1e6) return { need: Infinity }; }
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
  return { need: Math.ceil(hi) };
}

export function standing(rankings, matches, our) {
  const rows = rankings.filter((r) => r.team).map((r) => ({ code: r.team.country, rank: r.rank, score: r.rankingScore, played: r.played, highest: r.highestScore }));
  const me = rows.find((r) => r.code === our) || null;
  const others = rows.filter((r) => r.code !== our).sort((a, b) => b.score - a.score);
  const { played, remaining } = ourRankingScores(matches, our);
  // To end in the top N we must beat the Nth best of the *other* teams.
  const line = (n) => (others.length >= n ? others[n - 1].score : null);
  const goals = [24, 8, 1].map((n) => ({ top: n, mustBeat: line(n), ...neededAverage(played, remaining, line(n) == null ? null : line(n) + 0.01) }));
  return { me, teams: rows.length, scores: played, remaining, current: dropLowestAvg(played), goals };
}

// Table 6-1: alliance a (1..8) = ranks a, a+8, 25-a, plus a random draw from rank >= 25.
export function allianceForRank(r) {
  if (!r || r > 24) return null;
  const a = r <= 8 ? r : r <= 16 ? r - 8 : 25 - r;
  return { alliance: a, ranks: [a, a + 8, 25 - a] };
}

export function projectedAlliance(rankings, our, official) {
  const theirs = (official || []).find((al) => ["captain", "pick1", "pick2", "pick3"].some((k) => al[k]?.team?.country === our));
  if (theirs) {
    return { official: true, name: theirs.name, members: ["captain", "pick1", "pick2", "pick3"].map((k) => theirs[k]?.team?.country).filter(Boolean) };
  }
  const byRank = Object.fromEntries(rankings.filter((r) => r.team).map((r) => [r.rank, r.team.country]));
  const me = rankings.find((r) => r.team?.country === our);
  const a = allianceForRank(me?.rank);
  if (!a) return { official: false, alliance: null, note: me ? `rank ${me.rank}: outside the top 24, so only the random draw from rank 25+ could put us in` : "no ranking yet" };
  return { official: false, alliance: a.alliance, members: a.ranks.map((r) => ({ rank: r, code: byRank[r] || null })), plusRandomDraw: true };
}

// Played matches worth watching on video, highest priority first.
export function matchesOfInterest({ matches, schedule, alliance, finalsAlliances, our, investigated = [] }) {
  const want = {}; // code -> [priority, reason]
  const add = (code, p, why) => { if (code && code !== our && (!want[code] || want[code][0] < p)) want[code] = [p, why]; };
  for (const c of investigated) add(c, 90, "investigation requested");
  for (const c of alliance?.members || []) add(typeof c === "string" ? c : c.code, 80, "alliance partner");
  for (const al of finalsAlliances || []) for (const k of ["captain", "pick1", "pick2", "pick3"]) add(al[k]?.team?.country, 70, "finalist");
  for (const m of schedule.filter((x) => !x.played)) {
    for (const c of m.partners) add(c, 60, `partner in ${m.name}`);
    for (const c of m.opponents) add(c, 50, `opponent in ${m.name}`);
  }
  const out = [];
  for (const m of matches) {
    if (!m.played) continue;
    const ps = m.participants || [];
    let priority = 0; const reasons = [];
    if (ps.some((p) => p.country === our)) { priority = 100; reasons.push("our match"); }
    for (const p of ps) {
      const w = want[p.country];
      if (w) { priority = Math.max(priority, w[0]); reasons.push(`${p.country}: ${w[1]}`); }
    }
    if (!priority) continue;
    out.push({ key: `${m.tournamentKey}-${m.id}`, tournamentKey: m.tournamentKey, id: m.id, name: m.name, scheduledTime: m.scheduledTime, field: m.field ?? null,
      participants: ps.map((p) => ({ country: p.country, station: p.station })), redScore: m.redScore, blueScore: m.blueScore, reasons, priority });
  }
  return out.sort((a, b) => b.priority - a.priority || String(b.scheduledTime).localeCompare(String(a.scheduledTime)));
}

// ---------- official per-team stats from per-match details ----------
// The official details carry per-robot fields named like redRobotOneParking
// (2025) — robot One/Two/Three = station x1/x2/x3. Verified on 2025: summing a
// team's per-robot end-game values over its ranking matches gives its official
// protectionPoints for 181/181 teams under this mapping, at most 11/181 under
// any other ordering. Field names change every season, so match them generically.
const ROBOT_FIELD = /^(red|blue)Robot(One|Two|Three)(.+)$/;
const IDX = { One: 1, Two: 2, Three: 3 };
// 2026 climb increments (manual table 3-4), if the season's per-robot field uses them.
const CLIMB_2026 = { 0: "none", 0.05: "contact", 0.1: "zone 1", 0.2: "zone 2", 0.3: "zone 3" };

export function teamStats(matches) {
  const T = {};
  for (const m of matches) {
    if (!m.played || !m.details || m.tournamentKey !== "t2") continue;
    const byStation = Object.fromEntries((m.participants || []).map((p) => [p.station, p.country]));
    for (const p of m.participants || []) {
      if (p.station % 10 > 3) continue;
      const t = (T[p.country] ??= { played: 0, allianceScores: [], robot: {} });
      t.played++;
      t.allianceScores.push(Math.floor(p.station / 10) === 1 ? m.redScore : m.blueScore);
    }
    for (const [k, v] of Object.entries(m.details)) {
      const r = ROBOT_FIELD.exec(k);
      if (!r || typeof v !== "number") continue;
      const code = byStation[(r[1] === "red" ? 10 : 20) + IDX[r[2]]];
      if (!code) continue;
      ((T[code] ??= { played: 0, allianceScores: [], robot: {} }).robot[r[3]] ??= []).push(v);
    }
  }
  const out = {};
  for (const [code, t] of Object.entries(T)) {
    const robot = {};
    for (const [field, vals] of Object.entries(t.robot)) {
      const dist = {};
      for (const v of vals) dist[v] = (dist[v] || 0) + 1;
      const allClimb = vals.every((v) => v in CLIMB_2026);
      robot[field] = {
        n: vals.length,
        mean: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000,
        nonzeroRate: Math.round((vals.filter((v) => v > 0).length / vals.length) * 100),
        distribution: dist,
        ...(allClimb ? { levels: Object.fromEntries(Object.entries(dist).map(([v, n]) => [CLIMB_2026[v], n])), offGroundRate: Math.round((vals.filter((v) => v >= 0.1).length / vals.length) * 100) } : {}),
      };
    }
    const s = t.allianceScores;
    out[code] = { played: t.played, avgAllianceScore: s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null, robot };
  }
  return out;
}

// ---------- predictions: OPR (offensive power rating) ----------
// Each ranking-match alliance score is modelled as the sum of its three teams'
// contributions. Solved by ridge least squares, shrunk toward the average
// contribution so teams with few matches don't get extreme values. The same
// fit runs per scoring part (any red*/blue* alliance field in the details).
function solve(M, v) {
  const n = v.length, A = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((r, i) => r[n] / (r[i] || 1e-12));
}

function rows(matches) {
  const out = [];
  for (const m of matches) {
    if (!m.played || m.tournamentKey !== "t2") continue;
    for (const [side, base] of [["red", 10], ["blue", 20]]) {
      const teams = (m.participants || []).filter((p) => Math.floor(p.station / 10) === base / 10 && p.station % 10 <= 3).map((p) => p.country);
      if (teams.length !== 3) continue;
      const comps = {};
      for (const [k, v] of Object.entries(m.details || {})) {
        if (typeof v !== "number" || ROBOT_FIELD.test(k) || !k.startsWith(side)) continue;
        comps[k.slice(side.length)] = v;
      }
      out.push({ teams, score: side === "red" ? m.redScore : m.blueScore, comps });
    }
  }
  return out;
}

// lambda 4 + trend picked on 2025 holdouts (fit on the first 25/50/75 % of
// ranking matches, predict the rest): winner right 58/68/67 %, score MAE
// 22.9/19.4/21.3 vs 23.2/21.2/21.8 for "everyone scores the recent average".
// Scores rise during an event as teams improve, hence the trend factor
// (mean of the last 30 matches / overall mean) on predicted scores.
export function opr(matches, lambda = 4) {
  const R = rows([...matches].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)));
  if (!R.length) return { n: 0, total: {}, components: {}, sigma: null };
  const codes = [...new Set(R.flatMap((r) => r.teams))].sort();
  const idx = Object.fromEntries(codes.map((c, i) => [c, i]));
  const n = codes.length;
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const r of R) for (const a of r.teams) for (const b of r.teams) AtA[idx[a]][idx[b]] += 1;
  for (let i = 0; i < n; i++) AtA[i][i] += lambda;
  const fit = (val) => {
    const ys = R.map(val);
    const prior = ys.reduce((a, b) => a + b, 0) / ys.length / 3;
    const Atb = new Array(n).fill(lambda * prior);
    R.forEach((r, j) => { for (const c of r.teams) Atb[idx[c]] += ys[j]; });
    const x = solve(AtA.map((row) => [...row]), Atb);
    const res = R.map((r, j) => ys[j] - r.teams.reduce((s, c) => s + x[idx[c]], 0));
    const sigma = Math.sqrt(res.reduce((s, e) => s + e * e, 0) / Math.max(1, res.length - 1));
    return { values: Object.fromEntries(codes.map((c, i) => [c, Math.round(x[i] * 100) / 100])), prior, sigma };
  };
  const total = fit((r) => r.score);
  const components = {};
  for (const k of [...new Set(R.flatMap((r) => Object.keys(r.comps)))]) components[k] = fit((r) => r.comps[k] ?? 0).values;
  const per = R.map((r) => r.score), mean = per.reduce((a, b) => a + b, 0) / per.length;
  const tail = per.slice(-60), recent = tail.reduce((a, b) => a + b, 0) / tail.length;
  const trend = mean > 0 ? recent / mean : 1;
  return { n: R.length, matches: R.length / 2, total: total.values, prior: total.prior, components, sigma: total.sigma, trend: Math.round(trend * 1000) / 1000 };
}

const phi = (z) => 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3))); // normal CDF, tanh approx

export function predictMatch(m, model) {
  if (!model?.n) return null;
  const val = (c) => (model.total[c] ?? model.prior) * (model.trend || 1);
  const ours = [m.ourCode, ...m.partners].map(val).reduce((a, b) => a + b, 0);
  const theirs = m.opponents.map(val).reduce((a, b) => a + b, 0);
  const sd = (model.sigma || 1) * Math.SQRT2;
  return { ours: Math.round(ours), theirs: Math.round(theirs), winChance: Math.round(phi((ours - theirs) / sd) * 100), sigma: Math.round(model.sigma) };
}

// Predicted final ranking: played scores plus predicted remaining ones, lowest dropped.
export function predictStandings(matches, model) {
  if (!model?.n) return null;
  const val = (c) => (model.total[c] ?? model.prior) * (model.trend || 1);
  const S = {};
  for (const m of matches) {
    if (m.tournamentKey !== "t2") continue;
    for (const [base, side] of [[1, "red"], [2, "blue"]]) {
      const teams = (m.participants || []).filter((p) => Math.floor(p.station / 10) === base && p.station % 10 <= 3).map((p) => p.country);
      const s = m.played ? (side === "red" ? m.redScore : m.blueScore) : teams.reduce((a, c) => a + val(c), 0);
      for (const c of teams) (S[c] ??= []).push(s);
    }
  }
  const list = Object.entries(S).map(([code, sc]) => ({ code, predicted: Math.round(dropLowestAvg(sc) * 10) / 10 }))
    .sort((a, b) => b.predicted - a.predicted);
  list.forEach((x, i) => (x.rank = i + 1));
  return list;
}

// Before any 2026 match is played: rank teams by the average past-performance
// strength of their scheduled alliances (own + partners). On 2025 this beat
// own past score alone (rank correlation 0.417 vs 0.382, same 10/24 top-24 hits).
export function preEventProjection(matches, history, our) {
  const est = (c) => (history[c]?.pastScore ?? 50) / 100;
  const A = {}, P = {};
  for (const m of matches) {
    if (m.tournamentKey !== "t2") continue;
    for (const base of [1, 2]) {
      const t = (m.participants || []).filter((p) => Math.floor(p.station / 10) === base && p.station % 10 <= 3).map((p) => p.country);
      const s = t.reduce((a, c) => a + est(c), 0);
      for (const c of t) { (A[c] ??= []).push(s); (P[c] ??= []).push(s - est(c)); }
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const codes = Object.keys(A);
  if (!codes.length || !A[our]) return null;
  const order = codes.sort((a, b) => mean(A[b]) - mean(A[a]));
  const partnerAvg = mean(codes.map((c) => mean(P[c])));
  const luck = [...codes].sort((a, b) => mean(P[b]) - mean(P[a]));
  const ownRank = [...codes].sort((a, b) => est(b) - est(a)).indexOf(our) + 1;
  const line24 = mean(A[order[23]]);
  return { teams: codes.length, rank: order.indexOf(our) + 1, ownRank, partnerStrength: Math.round(mean(P[our]) * 100) / 100,
    fieldPartnerStrength: Math.round(partnerAvg * 100) / 100, scheduleRank: luck.indexOf(our) + 1,
    neededOwn: Math.round((est(our) + (line24 - mean(A[our]))) * 100) };
}
