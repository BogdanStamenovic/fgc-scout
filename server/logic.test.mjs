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
