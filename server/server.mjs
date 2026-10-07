// fgc-scout server: scouting store + FGC 2026 schedule poller + priority list.
// Zero dependencies (Node >= 22.5 for node:sqlite). Listens on 127.0.0.1; Caddy
// terminates TLS in front of it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { priorityList, mergeEntries, ourMatches, standing, projectedAlliance, matchesOfInterest, teamStats, opr, predictMatch, predictStandings, preEventProjection } from "./logic.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = process.env.SCOUT_DATA || path.join(ROOT, "data");
const WEB = path.join(ROOT, "web");
const PORT = Number(process.env.PORT || 3077);
const KEY = process.env.SCOUT_KEY || "";
const OUR = process.env.SCOUT_TEAM || "SRB";
const YEAR = process.env.SCOUT_YEAR || "2026";
const POLL_MS = Number(process.env.SCOUT_POLL_MS || 120_000);
const MAX_PHOTO = 8 * 1024 * 1024;

if (!KEY) {
  console.error("SCOUT_KEY is not set; refusing to start an open write API");
  process.exit(1);
}

fs.mkdirSync(path.join(DATA, "photos"), { recursive: true });
fs.mkdirSync(path.join(DATA, "tagimg"), { recursive: true });
const db = new DatabaseSync(path.join(DATA, "scout.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, code TEXT NOT NULL, scout TEXT, ts INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS photos  (id TEXT PRIMARY KEY, code TEXT NOT NULL, part TEXT NOT NULL, scout TEXT, ts INTEGER NOT NULL, bytes INTEGER);
  CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, code TEXT NOT NULL, matchKey TEXT, ts INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS matches (key TEXT PRIMARY KEY, fetched INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS investigations (id TEXT PRIMARY KEY, code TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, matchKey TEXT, ts INTEGER NOT NULL, priority REAL, body TEXT NOT NULL, answer TEXT, answeredBy TEXT, answeredTs INTEGER);
  CREATE INDEX IF NOT EXISTS entries_code ON entries(code);
  CREATE INDEX IF NOT EXISTS obs_code ON observations(code);
  CREATE INDEX IF NOT EXISTS photos_code ON photos(code);
`);

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
};
const history = readJson(path.join(DATA, "history.json"), { teams: {} });
// IOC code -> country name (REV's 2026 naming table), for teams in the official
// schedule that the first.global nations page doesn't list (ARG, THA in 2026).
const COUNTRY = (() => {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(ROOT, "research", "country-codes.tsv"), "utf8").trim().split("\n").map((l) => l.split("\t").reverse()));
  } catch { return {}; }
})();
const research = () => readJson(path.join(DATA, "research.json"), { teams: {} });
const LIVE = path.join(DATA, `live-${YEAR}.json`);
let live = readJson(LIVE, { fetchedAt: null, data: null, error: null });
const STATS = path.join(DATA, `stats-${YEAR}.json`);
let stats = readJson(STATS, { fetchedAt: null, teams: {} });
let polls = 0;

// Every 5th poll (~10 min) pull the full dump with per-match details, which is
// where the official per-robot end-game results live, and recompute stats.
async function pollDetails() {
  try {
    const r = await fetch(`https://api.first.global/v1?year=${YEAR}`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const model = opr(d.matches || []);
    stats = { fetchedAt: new Date().toISOString(), teams: teamStats(d.matches || []), model, standings: predictStandings(d.matches || [], model) };
    fs.writeFileSync(STATS + ".tmp", JSON.stringify(stats));
    fs.renameSync(STATS + ".tmp", STATS);
  } catch { /* keep last good stats */ }
}

async function poll() {
  try {
    const r = await fetch(`https://api.first.global/v1?excludeMatchDetails=true&year=${YEAR}`, {
      headers: { "User-Agent": "fgc-scout (team SRB scouting; contact via team)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    live = { fetchedAt: new Date().toISOString(), data, error: null };
    await archiveDetails(data);
    if (polls++ % 5 === 0) await pollDetails();
    fs.writeFileSync(LIVE + ".tmp", JSON.stringify(live));
    fs.renameSync(LIVE + ".tmp", LIVE);
  } catch (e) {
    // Keep the last good copy; the app shows how old it is.
    live = { ...live, error: `${new Date().toISOString()} ${e.message}` };
  }
}

// Keep every played match we care about, with its per-match scoring details,
// in our own store: results stay available even if the official API changes
// or goes down. One small request per newly played match, not a full dump.
async function archiveDetails(data) {
  const have = new Set(db.prepare("SELECT key FROM matches").all().map((r) => r.key));
  const ours = new Set(interestNow(data).map((m) => m.key));
  for (const m of data.matches || []) {
    const key = `${m.tournamentKey}-${m.id}`;
    if (!m.played || have.has(key) || !ours.has(key)) continue;
    try {
      const q = new URLSearchParams({ year: YEAR, tournamentKey: m.tournamentKey, id: String(m.id) });
      const r = await fetch(`https://api.first.global/v1/matches?${q}`, { signal: AbortSignal.timeout(15_000) });
      const full = r.ok ? await r.json() : null;
      const one = Array.isArray(full) ? full[0] : full;
      db.prepare("INSERT OR REPLACE INTO matches (key, fetched, body) VALUES (?, ?, ?)").run(key, Date.now(), JSON.stringify(one || m));
    } catch { /* retried next poll */ }
  }
}

function interestNow(data) {
  const d = data || { matches: [], rankings: [] };
  const schedule = ourMatches(d.matches || [], OUR);
  const alliance = projectedAlliance(d.rankings || [], OUR, d.alliances_round_robin || []);
  const investigated = db.prepare("SELECT DISTINCT code FROM investigations WHERE status != 'failed'").all().map((r) => r.code);
  return matchesOfInterest({ matches: d.matches || [], schedule, alliance, finalsAlliances: d.alliances_finals || [], our: OUR, investigated });
}

function state() {
  const rows = db.prepare("SELECT id, code, scout, ts, body FROM entries ORDER BY ts").all();
  const photos = db.prepare("SELECT id, code, part, scout, ts FROM photos ORDER BY ts").all();
  const byCode = {};
  for (const r of rows) (byCode[r.code] ??= []).push({ ...r, body: JSON.parse(r.body) });
  const photosBy = {};
  for (const p of photos) (photosBy[p.code] ??= []).push(p);
  const res = research().teams || {};
  const obsBy = {};
  for (const o of db.prepare("SELECT code, body FROM observations ORDER BY ts DESC").all()) (obsBy[o.code] ??= []).push(JSON.parse(o.body));
  const invBy = {};
  for (const r of db.prepare("SELECT code, body FROM investigations ORDER BY ts").all()) invBy[r.code] = JSON.parse(r.body);
  const openTags = db.prepare("SELECT COUNT(*) AS n FROM tags WHERE answer IS NULL").get().n;
  const archived = Object.fromEntries(db.prepare("SELECT key, body FROM matches").all().map((r) => [r.key, JSON.parse(r.body)]));
  const teams = {};
  for (const [code, h] of Object.entries(history.teams)) {
    teams[code] = {
      code, name: h.name, page: h.page,
      history: { pastScore: h.pastScore, predictedRank: h.predictedRank, predictedOf: h.predictedOf, seasons: h.seasons },
      research: res[code] || null,
      scouted: mergeEntries(byCode[code] || []),
      entries: (byCode[code] || []).length,
      photos: photosBy[code] || [],
      observations: obsBy[code] || [],
      stats: stats.teams[code] || null,
      investigation: invBy[code] || null,
    };
  }
  // Every team in the official schedule exists in the app, listed or not.
  const liveTeams = {};
  for (const m of (live.data?.matches || [])) for (const pp of m.participants || []) if (pp.country) liveTeams[pp.country] = (pp.countryCode || "").toLowerCase();
  for (const [code, cc2] of Object.entries(liveTeams)) {
    if (teams[code]) { if (!teams[code].cc2) teams[code].cc2 = cc2; continue; }
    teams[code] = { code, name: COUNTRY[code] || code, page: null, cc2, history: { pastScore: null, predictedRank: null, predictedOf: null, seasons: [] },
      research: res[code] || null, scouted: mergeEntries(byCode[code] || []), entries: (byCode[code] || []).length,
      photos: photosBy[code] || [], observations: obsBy[code] || [], stats: stats.teams[code] || null, investigation: invBy[code] || null, notListed: true };
  }
  // Teams we hold data on but that are missing from history.json (a late
  // entry, or a code the nations list spells differently) must still show up.
  for (const code of new Set([...Object.keys(byCode), ...Object.keys(obsBy), ...Object.keys(photosBy)])) {
    if (teams[code]) continue;
    teams[code] = { code, name: code, page: null, history: { pastScore: null, predictedRank: null, predictedOf: null, seasons: [] },
      research: res[code] || null, scouted: mergeEntries(byCode[code] || []), entries: (byCode[code] || []).length,
      photos: photosBy[code] || [], observations: obsBy[code] || [], stats: stats.teams[code] || null };
  }
  const liveData = live.data || { matches: [], rankings: [] };
  const schedule = ourMatches(liveData.matches || [], OUR);
  const ranks = {};
  for (const r of liveData.rankings || []) if (r.team) ranks[r.team.country] = r;
  const model = stats.model;
  for (const m of schedule) {
    const a = archived[`${m.tournamentKey}-${m.id}`];
    if (a?.details) m.details = a.details;
    if (!m.played && model?.n) m.prediction = predictMatch({ ourCode: OUR, partners: m.partners, opponents: m.opponents }, model);
  }
  if (model?.n) for (const [code, t] of Object.entries(teams)) {
    if (model.total[code] == null) continue;
    t.opr = { total: model.total[code], parts: Object.fromEntries(Object.entries(model.components).map(([k, v]) => [k, v[code]]).filter(([, v]) => v != null)) };
  }
  return {
    teams, schedule, ranks, prio: priorityList(teams, schedule, ranks, OUR),
    standing: standing(liveData.rankings || [], liveData.matches || [], OUR),
    alliance: projectedAlliance(liveData.rankings || [], OUR, liveData.alliances_round_robin || []),
    openTags,
    preEvent: preEventProjection(liveData.matches || [], history.teams, OUR),
    prediction: model?.n ? { matchesUsed: model.matches, sigma: Math.round(model.sigma), trend: model.trend,
      ours: (stats.standings || []).find((x) => x.code === OUR) || null, line24: (stats.standings || [])[23]?.predicted ?? null, line8: (stats.standings || [])[7]?.predicted ?? null,
      top: (stats.standings || []).slice(0, 30) } : null,
  };
}

const send = (res, code, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": isBuf ? "application/octet-stream" : typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
};

const cookieKey = (req) => {
  const m = /(?:^|;\s*)scout_key=([^;]+)/.exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
};
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authed = (req) => {
  const k = req.headers["x-scout-key"] || cookieKey(req);
  return typeof k === "string" && safeEq(k, KEY);
};

function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const CODE = /^[A-Z]{3}$/;
const PART = /^(robot|shooter|intake|climb|partnerClimb|hooks|other)$/;
const shellFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))
  .flatMap((e) => (e.isDirectory() ? shellFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const SHELL_VERSION = (() => {
  const h = crypto.createHash("sha256");
  for (const f of shellFiles(WEB)) h.update(f.slice(WEB.length)).update(fs.readFileSync(f));
  return h.digest("hex").slice(0, 12);
})();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/api/login" && req.method === "POST") {
    const { key } = JSON.parse((await body(req, 4096)).toString() || "{}");
    if (typeof key !== "string" || !safeEq(key, KEY)) return send(res, 401, { error: "wrong key" });
    return send(res, 200, { ok: true }, {
      "Set-Cookie": `scout_key=${encodeURIComponent(KEY)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`,
    });
  }
  if (p === "/api/health") return send(res, 200, { ok: true, version: SHELL_VERSION, liveFetchedAt: live.fetchedAt, liveError: live.error });

  if (p.startsWith("/api/") || p.startsWith("/photos/")) {
    if (!authed(req)) return send(res, 401, { error: "key required" });

    if (p === "/api/state" && req.method === "GET") {
      const s = state();
      return send(res, 200, { ...s, our: OUR, live: { fetchedAt: live.fetchedAt, error: live.error }, statsFetchedAt: stats.fetchedAt, backtest: history.backtest || null });
    }
    if (p === "/api/interest" && req.method === "GET") {
      return send(res, 200, { matches: interestNow(live.data) });
    }
    if (p === "/api/observation" && req.method === "POST") {
      const o = JSON.parse((await body(req, 64 * 1024)).toString());
      if (!ID.test(o.id || "") || !CODE.test(o.code || "") || typeof o.summary !== "string") return send(res, 400, { error: "bad id, code or summary" });
      o.transcript = String(o.transcript || "").slice(0, 4000);
      db.prepare("INSERT OR REPLACE INTO observations (id, code, matchKey, ts, body) VALUES (?, ?, ?, ?, ?)")
        .run(o.id, o.code, String(o.matchKey || ""), Number(o.ts) || Date.now(), JSON.stringify(o));
      return send(res, 200, { ok: true });
    }
    // --- deeper investigation of one team: queued by the app, run by a worker on archserver
    if (p === "/api/investigate" && req.method === "POST") {
      const b = JSON.parse((await body(req, 8 * 1024)).toString());
      if (!CODE.test(b.code || "")) return send(res, 400, { error: "bad code" });
      const open = db.prepare("SELECT body FROM investigations WHERE code = ? AND status IN ('queued','running')").get(b.code);
      if (open) return send(res, 200, JSON.parse(open.body));
      const inv = { id: crypto.randomUUID().replace(/-/g, ""), code: b.code, note: String(b.note || "").slice(0, 500), requestedBy: String(b.scout || "").slice(0, 60), ts: Date.now(), status: "queued" };
      db.prepare("INSERT INTO investigations (id, code, ts, status, body) VALUES (?, ?, ?, ?, ?)").run(inv.id, inv.code, inv.ts, inv.status, JSON.stringify(inv));
      return send(res, 200, inv);
    }
    if (p === "/api/investigations" && req.method === "GET") {
      const st = url.searchParams.get("status");
      const rows = st ? db.prepare("SELECT body FROM investigations WHERE status = ? ORDER BY ts").all(st) : db.prepare("SELECT body FROM investigations ORDER BY ts DESC LIMIT 200").all();
      return send(res, 200, { investigations: rows.map((r) => JSON.parse(r.body)) });
    }
    const invM = /^\/api\/investigation\/([a-f0-9]{32})$/.exec(p);
    if (invM && req.method === "POST") {
      const row = db.prepare("SELECT body FROM investigations WHERE id = ?").get(invM[1]);
      if (!row) return send(res, 404, { error: "no such investigation" });
      const u = JSON.parse((await body(req, 256 * 1024)).toString());
      if (!["running", "done", "failed"].includes(u.status)) return send(res, 400, { error: "bad status" });
      const inv = { ...JSON.parse(row.body), status: u.status, updated: Date.now(), ...(u.report ? { report: u.report } : {}), ...(u.error ? { error: String(u.error).slice(0, 2000) } : {}) };
      db.prepare("UPDATE investigations SET status = ?, body = ? WHERE id = ?").run(inv.status, JSON.stringify(inv), inv.id);
      return send(res, 200, { ok: true });
    }

    // --- human-in-the-loop robot identity: fgc-vision asks, scouts answer in the app
    if (p === "/api/tag-image" && req.method === "POST") {
      const id = url.searchParams.get("id") || "";
      if (!ID.test(id)) return send(res, 400, { error: "bad id" });
      const buf = await body(req, MAX_PHOTO);
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: "jpeg only" });
      fs.writeFileSync(path.join(DATA, "tagimg", `${id}.jpg`), buf);
      return send(res, 200, { ok: true });
    }
    const tiM = /^\/api\/tag-image\/([A-Za-z0-9_-]{8,64})\.jpg$/.exec(p);
    if (tiM && req.method === "GET") {
      const f = path.join(DATA, "tagimg", `${tiM[1]}.jpg`);
      if (!fs.existsSync(f)) return send(res, 404, { error: "no image" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === "/api/tag-request" && req.method === "POST") {
      const r = JSON.parse((await body(req, 32 * 1024)).toString());
      if (!ID.test(r.id || "") || !Array.isArray(r.candidates) || !r.candidates.every((c) => CODE.test(c))) return send(res, 400, { error: "bad id or candidates" });
      db.prepare("INSERT OR IGNORE INTO tags (id, matchKey, ts, priority, body) VALUES (?, ?, ?, ?, ?)")
        .run(r.id, String(r.matchKey || ""), Date.now(), Number(r.priority) || 0, JSON.stringify(r));
      return send(res, 200, { ok: true });
    }
    if (p === "/api/tags" && req.method === "GET") {
      const open = url.searchParams.get("open") === "1";
      const mk = url.searchParams.get("matchKey");
      let rows;
      if (open) rows = db.prepare("SELECT * FROM tags WHERE answer IS NULL ORDER BY priority DESC, ts LIMIT 50").all();
      else if (mk) rows = db.prepare("SELECT * FROM tags WHERE matchKey = ? ORDER BY ts").all(mk);
      else rows = db.prepare("SELECT * FROM tags WHERE answer IS NOT NULL ORDER BY answeredTs DESC LIMIT 500").all();
      return send(res, 200, { tags: rows.map((r) => ({ ...JSON.parse(r.body), answer: r.answer, answeredBy: r.answeredBy, answeredTs: r.answeredTs })) });
    }
    if (p === "/api/tag-answer" && req.method === "POST") {
      const a = JSON.parse((await body(req, 4096)).toString());
      if (!ID.test(a.id || "") || !(CODE.test(a.answer || "") || ["none", "unsure"].includes(a.answer))) return send(res, 400, { error: "bad id or answer" });
      // First answer wins; "unsure" leaves it open for someone else.
      if (a.answer === "unsure") return send(res, 200, { ok: true, kept: "open" });
      const r = db.prepare("UPDATE tags SET answer = ?, answeredBy = ?, answeredTs = ? WHERE id = ? AND answer IS NULL").run(a.answer, String(a.scout || "").slice(0, 60), Date.now(), a.id);
      return send(res, 200, { ok: true, recorded: r.changes === 1 });
    }

    if (p === "/api/entry" && req.method === "POST") {
      const e = JSON.parse((await body(req, 64 * 1024)).toString());
      if (!ID.test(e.id || "") || !CODE.test(e.code || "")) return send(res, 400, { error: "bad id or code" });
      const ts = Number.isFinite(e.ts) ? Math.min(e.ts, Date.now()) : Date.now();
      // Idempotent: the phone replays its outbox until it sees a 200.
      db.prepare("INSERT OR IGNORE INTO entries (id, code, scout, ts, body) VALUES (?, ?, ?, ?, ?)")
        .run(e.id, e.code, String(e.scout || "").slice(0, 60), ts, JSON.stringify(e.data || {}));
      return send(res, 200, { ok: true });
    }
    if (p === "/api/photo" && req.method === "POST") {
      const id = url.searchParams.get("id") || "", code = url.searchParams.get("code") || "", part = url.searchParams.get("part") || "";
      if (!ID.test(id) || !CODE.test(code) || !PART.test(part)) return send(res, 400, { error: "bad id, code or part" });
      const buf = await body(req, MAX_PHOTO);
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: "jpeg only" });
      const f = path.join(DATA, "photos", `${id}.jpg`);
      if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
      db.prepare("INSERT OR IGNORE INTO photos (id, code, part, scout, ts, bytes) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, code, part, String(url.searchParams.get("scout") || "").slice(0, 60), Date.now(), buf.length);
      return send(res, 200, { ok: true });
    }
    const m = /^\/photos\/([A-Za-z0-9_-]{8,64})\.jpg$/.exec(p);
    if (m && req.method === "GET") {
      const f = path.join(DATA, "photos", `${m[1]}.jpg`);
      if (!fs.existsSync(f)) return send(res, 404, { error: "no photo" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" });
      return fs.createReadStream(f).pipe(res);
    }
    return send(res, 404, { error: "not found" });
  }

  // Static app shell. sw.js gets a hash of the shell files stamped in, so any
// change to the app makes browsers install a new service worker, which is what
// triggers the "update ready" banner on phones.
  if (p === "/sw.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
    return res.end(fs.readFileSync(path.join(WEB, "sw.js"), "utf8").replace("__VERSION__", SHELL_VERSION));
  }
  let f = path.normalize(path.join(WEB, p === "/" ? "index.html" : p));
  // A folder with its own index.html is its own page (e.g. /guide/); anything
  // else unknown gets the app shell, whose router handles #/ routes.
  if (f.startsWith(WEB) && fs.existsSync(f) && fs.statSync(f).isDirectory()) {
    if (!p.endsWith("/")) { res.writeHead(301, { Location: `${p}/` }); return res.end(); }
    f = path.join(f, "index.html");
  }
  if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(WEB, "index.html");
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(f)] || "application/octet-stream",
    // The service worker owns caching; the browser must always revalidate it.
    "Cache-Control": path.basename(f) === "sw.js" ? "no-cache" : "public, max-age=60",
  });
  fs.createReadStream(f).pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "server error" });
    if (!e.status) console.error(e);
  });
});

if (process.env.SCOUT_NO_POLL !== "1") {
  poll();
  setInterval(poll, POLL_MS);
}
server.listen(PORT, process.env.HOST || "127.0.0.1", () => console.log(`fgc-scout on :${PORT}, team ${OUR}, year ${YEAR}`));
