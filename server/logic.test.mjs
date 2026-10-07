import test from "node:test";
import assert from "node:assert/strict";
import { mergeEntries, missingFor, ourMatches, priorityList, REQUIRED_COUNT } from "./logic.mjs";

const e = (ts, scout, body) => ({ ts, scout, body });

test("later entry fills in without erasing earlier answers", () => {
  const m = mergeEntries([
    e(1, "ana", { systems: { shooter: { has: true, comment: "flywheel" } }, size: { l: 48 } }),
    e(2, "marko", { weightKg: "14,5", systems: { shooter: { has: null } }, size: { w: 47, h: "" } }),
  ]);
  assert.equal(m.fields.shooter.has, true);
  assert.equal(m.fields.weightKg, 14.5);
  assert.deepEqual(m.fields.size, { l: 48, w: 47 });
  assert.deepEqual(m.scouts, ["ana", "marko"]);
  assert.equal(m.comments[0].text, "flywheel");
});

test("a later explicit 'no' overrides an earlier 'yes'", () => {
  const m = mergeEntries([e(1, "a", { systems: { climb: { has: true } } }), e(2, "b", { systems: { climb: { has: false } } })]);
  assert.equal(m.fields.climb.has, false);
});

test("entries are merged in time order whatever order they arrive in", () => {
  const m = mergeEntries([e(5, "b", { weightKg: 20 }), e(1, "a", { weightKg: 10 })]);
  assert.equal(m.fields.weightKg, 20);
});

test("missing lists every unanswered item including the robot photo", () => {
  const t = { scouted: mergeEntries([e(1, "a", { weightKg: 12 })]), photos: [{ part: "shooter" }] };
  const miss = missingFor(t);
  assert.ok(!miss.includes("weight"));
  assert.ok(miss.includes("robot photo"));
  assert.equal(miss.length, REQUIRED_COUNT - 1);
});

const P = (station, country) => ({ station, country });
const matches = [
  { id: 2, name: "Ranking Match 2", scheduledTime: "2026-10-08T11:10", played: false, participants: [P(11, "SRB"), P(12, "AAA"), P(13, "BBB"), P(21, "CCC"), P(22, "DDD"), P(23, "EEE")] },
  { id: 1, name: "Ranking Match 1", scheduledTime: "2026-10-08T11:00", played: true, participants: [P(21, "SRB"), P(22, "ZZZ"), P(23, "YYY"), P(11, "XXX"), P(12, "WWW"), P(13, "VVV")] },
  { id: 3, name: "Ranking Match 3", scheduledTime: "2026-10-08T11:20", played: false, participants: [P(11, "QQQ"), P(12, "RRR"), P(13, "SSS"), P(21, "TTT"), P(22, "UUU"), P(23, "OOO")] },
];

test("ourMatches finds our side, partners and opponents, in time order", () => {
  const s = ourMatches(matches, "SRB");
  assert.equal(s.length, 2);
  assert.equal(s[0].name, "Ranking Match 1");
  assert.equal(s[0].side, "blue");
  assert.deepEqual(s[0].partners, ["ZZZ", "YYY"]);
  assert.deepEqual(s[1].opponents, ["CCC", "DDD", "EEE"]);
});

const team = (code, pastScore) => ({ code, name: code, history: { pastScore }, scouted: mergeEntries([]), photos: [] });

test("upcoming partners outrank opponents, which outrank any non-match team", () => {
  const teams = Object.fromEntries(["SRB", "AAA", "CCC", "TOP", "ZZZ"].map((c) => [c, team(c, c === "TOP" ? 100 : 30)]));
  const list = priorityList(teams, ourMatches(matches, "SRB"), {}, "SRB");
  const order = list.map((x) => x.code);
  assert.ok(!order.includes("SRB"));
  assert.ok(order.indexOf("AAA") < order.indexOf("CCC"));
  assert.ok(order.indexOf("CCC") < order.indexOf("TOP"));
  // ZZZ was only in a match already played: no relation boost.
  assert.equal(list.find((x) => x.code === "ZZZ").relation, null);
});

test("a fully measured team drops to priority 0", () => {
  const full = team("AAA", 90);
  full.scouted = mergeEntries([e(1, "a", {
    systems: { shooter: { has: true }, intake: { has: true }, climb: { has: false }, partnerClimb: { has: false } },
    weightKg: 15, size: { l: 50, w: 50, h: 50 }, hookSpace: { has: true },
  })]);
  full.photos = [{ part: "robot" }];
  const list = priorityList({ AAA: full }, [], {}, "SRB");
  assert.equal(list[0].priority, 0);
  assert.deepEqual(list[0].missing, []);
});

test("live 2026 rank takes over from past seasons as matches are played", () => {
  const teams = { AAA: team("AAA", 90), BBB: team("BBB", 10) };
  const ranks = { AAA: { rank: 2, played: 6 }, BBB: { rank: 1, played: 6 } };
  const list = priorityList(teams, [], ranks, "SRB");
  assert.equal(list[0].code, "BBB");
  assert.match(list[0].strengthSource, /2026 rank 1/);
});

import { dropLowestAvg, neededAverage, standing, allianceForRank, projectedAlliance, matchesOfInterest } from "./logic.mjs";

test("drop-lowest average", () => {
  assert.equal(dropLowestAvg([10, 50, 30]), 40);
  assert.equal(dropLowestAvg([7]), 7);
  assert.equal(dropLowestAvg([]), null);
});

test("needed average is the smallest whole score that reaches the target", () => {
  // scores 40, 60 (dropped 40 -> 60). Two more matches; target 80: need x with avg(60,x,x)>=80 -> x=90
  assert.deepEqual(neededAverage([40, 60], 2, 80), { need: 90 });
  assert.deepEqual(neededAverage([90, 95], 1, 50), { need: 0 });
  assert.deepEqual(neededAverage([10], 0, 50), { done: true, reached: false });
});

test("table 6-1 alliance mapping", () => {
  assert.deepEqual(allianceForRank(1), { alliance: 1, ranks: [1, 9, 24] });
  assert.deepEqual(allianceForRank(9), { alliance: 1, ranks: [1, 9, 24] });
  assert.deepEqual(allianceForRank(24), { alliance: 1, ranks: [1, 9, 24] });
  assert.deepEqual(allianceForRank(13), { alliance: 5, ranks: [5, 13, 20] });
  assert.deepEqual(allianceForRank(17), { alliance: 8, ranks: [8, 16, 17] });
  assert.equal(allianceForRank(25), null);
  // every rank 1..24 appears in exactly one alliance
  const seen = new Set();
  for (let a = 1; a <= 8; a++) for (const r of allianceForRank(a).ranks) seen.add(r);
  assert.equal(seen.size, 24);
});

const rk = (code, rank, score) => ({ rank, rankingScore: score, played: 3, team: { country: code } });

test("projected alliance uses current ranks, official alliances win when present", () => {
  const rankings = Array.from({ length: 30 }, (_, i) => rk(i === 12 ? "SRB" : `T${String(i + 1).padStart(2, "0")}`, i + 1, 100 - i));
  const p = projectedAlliance(rankings, "SRB", []);
  assert.equal(p.alliance, 5);
  assert.deepEqual(p.members.map((m) => m.rank), [5, 13, 20]);
  const official = [{ name: "Alliance 3", captain: { team: { country: "AAA" } }, pick1: { team: { country: "SRB" } }, pick2: { team: { country: "BBB" } }, pick3: { team: { country: "CCC" } } }];
  assert.deepEqual(projectedAlliance(rankings, "SRB", official).members, ["AAA", "SRB", "BBB", "CCC"]);
});

test("standing: goals measured against the other teams", () => {
  const rankings = [rk("AAA", 1, 90), rk("SRB", 2, 70), rk("BBB", 3, 60)];
  const matches = [
    { tournamentKey: "t2", id: 1, played: true, redScore: 60, blueScore: 10, participants: [{ station: 11, country: "SRB" }] },
    { tournamentKey: "t2", id: 2, played: true, redScore: 5, blueScore: 80, participants: [{ station: 21, country: "SRB" }] },
    { tournamentKey: "t2", id: 3, played: false, participants: [{ station: 12, country: "SRB" }] },
  ];
  const s = standing(rankings, matches, "SRB");
  assert.deepEqual(s.scores, [60, 80]);
  assert.equal(s.remaining, 1);
  const top1 = s.goals.find((g) => g.top === 1);
  assert.equal(top1.mustBeat, 90);
  assert.equal(top1.need, 101); // avg(80, x) > 90 -> x >= 100.02 -> 101
});

test("matches of interest: our matches first, then partners' and opponents'", () => {
  const P = (c, s) => ({ country: c, station: s });
  const matches = [
    { tournamentKey: "t2", id: 1, played: true, scheduledTime: "a", participants: [P("SRB", 11), P("XXX", 21)] },
    { tournamentKey: "t2", id: 2, played: true, scheduledTime: "b", participants: [P("OPP", 11), P("ZZZ", 21)] },
    { tournamentKey: "t2", id: 3, played: true, scheduledTime: "c", participants: [P("QQQ", 11)] },
    { tournamentKey: "t2", id: 4, played: false, scheduledTime: "d", participants: [P("SRB", 11), P("OPP", 21)] },
  ];
  const schedule = [{ name: "Ranking Match 4", played: false, partners: [], opponents: ["OPP"] }];
  const list = matchesOfInterest({ matches, schedule, alliance: null, finalsAlliances: [], our: "SRB" });
  assert.deepEqual(list.map((m) => m.key), ["t2-1", "t2-2"]);
  assert.equal(list[1].priority, 50);
});

import { teamStats } from "./logic.mjs";

test("teamStats maps per-robot fields to the team at that station", () => {
  const P = (c, s) => ({ country: c, station: s });
  const mk = (id, r1, b2) => ({ tournamentKey: "t2", id, played: true, redScore: 50, blueScore: 30,
    participants: [P("AAA", 11), P("BBB", 12), P("CCC", 13), P("DDD", 21), P("EEE", 22), P("FFF", 23)],
    details: { redRobotOneClimb: r1, blueRobotTwoClimb: b2, redRobotTwoClimb: 0, notARobotField: 7 } });
  const s = teamStats([mk(1, 0.3, 0.05), mk(2, 0.1, 0)]);
  assert.equal(s.AAA.played, 2);
  assert.equal(s.AAA.avgAllianceScore, 50);
  assert.deepEqual(s.AAA.robot.Climb.levels, { "zone 3": 1, "zone 1": 1 });
  assert.equal(s.AAA.robot.Climb.offGroundRate, 100);
  assert.equal(s.EEE.robot.Climb.offGroundRate, 0);
  assert.equal(s.EEE.robot.Climb.nonzeroRate, 50);
  assert.equal(s.BBB.robot.Climb.mean, 0);
});

import { opr, predictMatch, predictStandings } from "./logic.mjs";

test("OPR recovers known team contributions from simulated alliance scores", () => {
  // 30 teams with true contributions 5..34, 400 random alliances, small noise
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const codes = Array.from({ length: 30 }, (_, i) => `T${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
  const truth = Object.fromEntries(codes.map((c, i) => [c, 5 + i]));
  const matches = [];
  for (let id = 1; id <= 200; id++) {
    const pick = [...codes].sort(() => rnd() - 0.5).slice(0, 6);
    const sc = (t) => t.reduce((s, c) => s + truth[c], 0) + (rnd() - 0.5) * 6;
    matches.push({ tournamentKey: "t2", id, played: true, redScore: sc(pick.slice(0, 3)), blueScore: sc(pick.slice(3)),
      participants: pick.map((c, i) => ({ country: c, station: (i < 3 ? 11 : 21) + (i % 3) })), details: { redBalls: 1, blueBalls: 2 } });
  }
  const m = opr(matches);
  const err = codes.map((c) => Math.abs(m.total[c] - truth[c]));
  assert.ok(Math.max(...err) < 2.5, `max error ${Math.max(...err)}`);
  assert.deepEqual(Object.keys(m.components), ["Balls"]);
  const p = predictMatch({ ourCode: codes[29], partners: [codes[28], codes[27]], opponents: [codes[0], codes[1], codes[2]] }, m);
  assert.ok(p.ours > p.theirs && p.winChance > 95);
  const st = predictStandings(matches, m);
  assert.equal(st[0].rank, 1);
});
