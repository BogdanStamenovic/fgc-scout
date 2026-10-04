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
export function matchesOfInterest({ matches, schedule, alliance, finalsAlliances, our }) {
  const want = {}; // code -> [priority, reason]
  const add = (code, p, why) => { if (code && code !== our && (!want[code] || want[code][0] < p)) want[code] = [p, why]; };
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
