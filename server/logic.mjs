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
