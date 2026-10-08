// SRB Scout client. Offline first: every write goes to an IndexedDB outbox and
// is replayed until the server answers 200 (writes are idempotent by id), so a
// scout in a hall with no Wi-Fi loses nothing.
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, "");
const SYSTEMS = [["shooter", "Shooter"], ["intake", "Ball intake"], ["climb", "Climbing"], ["partnerClimb", "Partner climb"]];
const PARTS = [["robot", "Whole robot"], ["shooter", "Shooter"], ["intake", "Intake"], ["climb", "Climber"], ["hooks", "Hook space"]];

// ---------- storage ----------
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let dbp;
function idb() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("srb-scout", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("outbox", { keyPath: "id" }); r.result.createObjectStore("cache"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}
const outboxAll = () => tx("outbox", "readonly", (s) => s.getAll());
const outboxPut = (item) => tx("outbox", "readwrite", (s) => s.put(item));
const outboxDel = (id) => tx("outbox", "readwrite", (s) => s.delete(id));
const cacheGet = (k) => tx("cache", "readonly", (s) => s.get(k));
const cachePut = (k, v) => tx("cache", "readwrite", (s) => s.put(v, k));

// ---------- network ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (r.status === 401) { showLogin(); throw new Error("key required"); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

let STATE = null;
async function loadState() {
  try {
    STATE = await api("/api/state");
    await cachePut("state", STATE);
  } catch (e) {
    if (e.message === "key required") throw e;
    STATE = STATE || (await cacheGet("state")) || null;
  }
  return STATE;
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (const item of await outboxAll()) {
      try {
        if (item.kind === "entry") {
          await api("/api/entry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.payload) });
        } else if (item.kind === "photo") {
          const q = new URLSearchParams({ id: item.id, code: item.code, part: item.part, scout: item.scout || "" });
          await api(`/api/photo?${q}`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: item.blob });
        }
        await outboxDel(item.id);
      } catch (e) {
        if (e.message === "key required") break;
        break; // offline or server trouble: keep order, retry later
      }
    }
  } finally {
    flushing = false;
    await syncBadge();
  }
}
async function syncBadge() {
  const n = (await outboxAll()).length;
  const el = $("#sync");
  el.className = "sync " + (n ? "pending" : "ok");
  el.textContent = n ? `${n} waiting to sync` : navigator.onLine ? "synced" : "offline";
}
addEventListener("online", () => flush().then(refresh));
setInterval(() => flush(), 20_000);

// ---------- photos ----------
async function compress(file) {
  // Phone photos are 3-12 MB; 1600 px JPEG at q0.8 is ~300 KB and plenty for scouting.
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const max = 1600, s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b || file), "image/jpeg", 0.8));
}

// ---------- ui helpers ----------
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
const ago = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const ord = (n) => `${n}${[11, 12, 13].includes(n % 100) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th")}`;
const fmt = (x) => (x == null ? "–" : Math.round(x * 10) / 10);
const teamOf = (c) => STATE.teams[c] || { code: c, name: c, history: {} };

// Robots carry their country flag (rule M08), so the app uses it too: the
// two-letter code from the official results becomes a flag emoji.
function flag(code) {
  const tm = teamOf(code), seasons = tm.history?.seasons || [];
  const cc = tm.cc2 || (seasons.length ? seasons[seasons.length - 1].cc2 : "");
  if (!/^[a-z]{2}$/.test(cc || "")) return `<span class="flag flag-none" aria-hidden="true"></span>`;
  const f = String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
  return `<span class="flag" aria-hidden="true">${f}</span>`;
}
const teamLink = (c) => `<a class="tlink" href="#/team/${c}">${flag(c)}${esc(teamOf(c).name)}</a>`;

function setScreen(tab, title, sub = "") {
  document.querySelectorAll(".tabs a").forEach((a) => {
    const on = a.dataset.tab === tab;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("#title").textContent = title;
  $("#subtitle").textContent = sub;
  window.scrollTo(0, 0);
}

// What we know about one capability: our scouts first, public research as a weaker fallback.
function capState(t, k) {
  const scouted = k === "hookSpace" ? t.scouted.fields.hookSpace?.has : t.scouted.fields[k]?.has;
  if (scouted != null) return { v: scouted, from: "scouted" };
  const r = t.research?.robot?.[k];
  if (r != null) return { v: r, from: "research" };
  return { v: null, from: null };
}
function capChips(t) {
  return `<div class="caps">${SYSTEMS.map(([k, l]) => {
    const s = capState(t, k);
    const cls = s.v === true ? "yes" : s.v === false ? "no" : "unk";
    const mark = s.v === true ? "✓" : s.v === false ? "✕" : "?";
    const title = s.from === "research" ? `${l}: from public research, not yet seen by our scouts` : s.from ? `${l}: seen by our scouts` : `${l}: unknown`;
    return `<span class="cap ${cls} ${s.from === "research" ? "soft" : ""}" title="${esc(title)}"><b>${mark}</b>${l}</span>`;
  }).join("")}</div>`;
}

// Urgency shown the way a forest fire-danger board shows risk: five steps,
// relative to the most urgent team on the list right now.
function dangerBand(level) {
  return `<span class="band" role="img" aria-label="urgency ${level} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= level ? `on l${level}` : ""}"></i>`).join("")}</span>`;
}

function relationLine(p) {
  if (!p.relation) return "";
  const r = p.relation;
  if (r.partner) return `<span class="rel with">With us in ${esc(r.next)}</span>`;
  return `<span class="rel vs">Against us in ${esc(r.next)}</span>`;
}

// ---------- time ----------
function until(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < -10 * 60_000) return "played or in progress";
  if (ms < 60_000) return "starting now";
  const m = Math.round(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `in ${d} d ${h % 24} h`;
  return h ? `in ${h} h ${m % 60} min` : `in ${m} min`;
}
const clock = (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
// Countdowns tick without re-rendering the page.
setInterval(() => document.querySelectorAll("[data-until]").forEach((el) => (el.textContent = until(el.dataset.until))), 30_000);

// ---------- kurac score: how much of our time a partner's robot will take ----------
// Opus's judgement from its deep dive when there is one; until then an
// estimate from what we hold, each part 0..1, weighted, mapped to 1..10.
const TROUBLE = /\b(broke|broken|break|stuck|dead|disconnect|battery|fell|tipped|loose|not mov|no.?show|fail|repair|issue|problem|malfunction|jam|didn.t move|stopped)/i;
function kurac(t) {
  const k = t.investigation?.status === "done" ? t.investigation.report?.kurac : null;
  if (k?.score) return { score: k.score, source: "Opus deep dive", reasons: k.reasons || [], help: k.helpNeeded || [] };
  const parts = [], reasons = [];
  const add = (w, v, why) => { parts.push([w, v]); if (v >= 0.5) reasons.push(why); };
  const past = t.history?.pastScore;
  add(0.25, past == null ? 0.6 : 1 - past / 100, past == null ? "no FGC history found" : `past score ${past}/100`);
  const caps = ["shooter", "intake", "climb"].map((k2) => capState(t, k2).v);
  add(0.15, caps.reduce((s, v) => s + (v === false ? 1 : v == null ? 0.4 : 0), 0) / 3, "systems missing or unknown");
  const texts = [...t.scouted.comments.map((c) => c.text), ...(t.observations || []).flatMap((o) => [...(o.facts?.problems || []), ...(o.facts?.badAt || [])])];
  const hits = texts.filter((x) => TROUBLE.test(x || "")).length;
  add(0.35, Math.min(1, hits / 3), `${hits} problem report${hits === 1 ? "" : "s"} in notes and commentary`);
  add(0.1, (t.history?.seasons || []).length === 0 ? 1 : 0, "first FGC season");
  const og = Object.values(t.stats?.robot || {}).map((r) => r.offGroundRate).find((x) => x != null);
  if (og != null) add(0.15, 1 - og / 100, `climbs off the ground in only ${og}% of matches`);
  const w = parts.reduce((s, [a]) => s + a, 0), v = parts.reduce((s, [a, b]) => s + a * b, 0) / w;
  return { score: Math.max(1, Math.min(10, Math.round(1 + 9 * v))), source: "estimate", reasons, help: [] };
}
const kuracBadge = (t) => { const k = kurac(t); return `<span class="kurac k${Math.ceil(k.score / 2)}" title="${esc(k.source)}">Help ${k.score}</span>`; };
const partnerCodes = () => [...new Set(STATE.schedule.flatMap((m) => m.partners))];

// ---------- views ----------
function showLogin() {
  setScreen("", "Welcome", "");
  view.innerHTML = `
    <section class="login">
      <p class="lead">Scout robots for team Serbia. Enter your name and the team key once on this phone.</p>
      <label class="field"><span>Your name</span><input id="scout" type="text" autocomplete="name" value="${esc(ls.get("scout", ""))}"></label>
      <label class="field"><span>Team key</span><input id="key" type="password" autocomplete="current-password"></label>
      <button class="btn primary" id="go">Sign in</button>
      <p class="hint">Install it: in Safari tap Share, then Add to Home Screen. In Chrome open the menu, then Install app.</p>
    </section>`;
  $("#go").onclick = async () => {
    if (!$("#scout").value.trim()) { toast("Add your name, so we know who scouted what."); $("#scout").focus(); return; }
    ls.set("scout", $("#scout").value.trim());
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: $("#key").value }) });
    if (!r.ok) return toast("That key didn't work. Check it with Bogdan.");
    location.hash = "#/next";
    refresh();
  };
}

function nextMatchCard(s) {
  const m = s.schedule.find((x) => !x.played && new Date(x.scheduledTime).getTime() > Date.now() - 10 * 60_000);
  if (!m) return "";
  return `<a class="nextmatch ${m.side}" href="#/matches">
    <span class="nm-top"><b>${esc(m.name)}</b><span data-until="${esc(m.scheduledTime)}">${until(m.scheduledTime)}</span></span>
    <span class="nm-mid">${m.side === "red" ? "Red" : "Blue"}, ${clock(m.scheduledTime)}. With ${m.partners.map((c) => `${flag(c)}${esc(teamOf(c).name)}`).join(" and ")}</span>
    ${m.prediction ? `<span class="nm-pred">Predicted ${m.prediction.ours}–${m.prediction.theirs}, ${m.prediction.winChance}% chance to win</span>` : ""}
  </a>`;
}

function standingBlock(s) {
  const st = s.standing, me = st?.me;
  if (!me) {
    const pe = s.preEvent;
    return `<section class="standing empty"><p>Our live rank and the points we need for the playoffs show up here once ranking matches start.</p>
      ${pe ? `<p class="predline"><b>Before the event:</b> on our own record we're <b>${ord(pe.ownRank)}</b> of ${pe.teams}. Our draw of partners is the <b>${ord(pe.teams + 1 - pe.scheduleRank)} hardest</b> of ${pe.teams}: they average ${pe.partnerStrength} against ${pe.fieldPartnerStrength} for the field. With partners counted we project to <b>${ord(pe.rank)}</b>. To be projected into the top 24, our robot has to play like a team with a past score of about <b>${pe.neededOwn}</b> (ours is ${teamOf(s.our).history.pastScore}).${(() => { const last = (teamOf(s.our).history.seasons || []).slice(-1)[0]; return last ? ` In ${last.year} we finished ${ord(last.rank)} of ${last.of}.` : ""; })()}</p>
      <p class="note">History-based and weak: it got about 1 in 3 of the top 24 right in past seasons. Historically the #24 team averaged about 1.3 times the event's median score, so watch the median after the first matches.</p>` : ""}</section>`;
  }
  const goalRow = (g) => {
    if (g.mustBeat == null) return "";
    const label = g.top === 1 ? "Finish first" : g.top === 8 ? "Top 8, alliance captain" : "Top 24, playoffs";
    let v;
    if (g.done) v = g.reached ? `<span class="ok">Reached</span>` : `<span class="miss">Missed</span>`;
    else if (g.need === 0) v = `<span class="ok">Safe</span>`;
    else if (g.need === Infinity) v = `<span class="miss">Out of reach</span>`;
    else v = `Average <b>${g.need}</b> in ${st.remaining} left`;
    return `<li><span>${label}</span><span>${v}</span></li>`;
  };
  const al = s.alliance;
  let alHtml = "";
  if (al?.official) alHtml = `<p class="alliance"><span>${esc(al.name)}</span>${al.members.filter((c) => c !== s.our).map(teamLink).join("")}</p>`;
  else if (al?.alliance) alHtml = `<p class="alliance"><span>If rankings ended now: alliance ${al.alliance}</span>${al.members.filter((m) => m.code && m.code !== s.our).map((m) => teamLink(m.code)).join("")}<em>plus one random draw</em></p>`;
  return `<section class="standing">
    <div class="board">
      <div><b>${me.rank}</b><span>rank of ${st.teams}</span></div>
      <div><b>${fmt(me.score)}</b><span>ranking score</span></div>
      <div><b>${st.scores.length}</b><span>${st.remaining ? `played, ${st.remaining} left` : "played"}</span></div>
    </div>
    <ul class="goals">${st.goals.map(goalRow).join("")}</ul>
    ${s.prediction?.ours ? `<p class="predline">Predicted finish: <b>rank ${s.prediction.ours.rank}</b>, ranking score ${s.prediction.ours.predicted}. The top-24 line is predicted at ${s.prediction.line24 ?? "–"}, the top-8 line at ${s.prediction.line8 ?? "–"}.</p>` : ""}
    ${alHtml}
    <details class="fine"><summary>How this is worked out</summary><p>The ranking score is the average of our ranking matches with the lowest one dropped, which matches FIRST Global's official 2025 numbers. "Average needed" assumes every other team stays where it is now, so treat it as a minimum.</p></details>
  </section>`;
}

const SCORE_HELP = `<details class="fine"><summary>How teams are ordered</summary><p>
The bars show how urgently to measure a team, compared with the most urgent one on the list. A team rises when much about it is still unknown, when it is strong, and above all when it plays with or against us soon. Fully measured teams drop off.</p>
<p>The past score (0 to 100) on team pages is how good a team has been at FGC from 2017 to 2025. It is a weak forecast: on past seasons it picked about one in three of the top 24 correctly.</p></details>`;

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-show]");
  if (a && a.tagName === "A") ls.set("show", a.dataset.show);
});
function renderNext() {
  const s = STATE;
  const list = s.prio.filter((p) => p.priority > 0).slice(0, 60);
  const sched = s.schedule.filter((m) => !m.played);
  setScreen("next", "Measure next", sched.length ? `${sched.length} matches of ours to come` : "Schedule not out yet");
  const max = Math.max(...list.map((p) => p.priority), 0.0001);
  view.innerHTML = `
    ${ls.get("scout", "") ? "" : `<section class="namecard"><label class="field"><span>Add your name, so we know who scouted what</span><input id="myname" type="text" autocomplete="name"></label><button class="btn" id="savename">Save name</button></section>`}
    ${nextMatchCard(s)}
    ${standingBlock(s)}
    <p class="scoutsum"><a href="#/" data-show="scouted" id="seeScouted">${plural(Object.values(s.teams).filter(isScouted).length, "team")} scouted so far</a>, ${plural(Object.values(s.teams).reduce((n, t) => n + (t.photos || []).length, 0), "photo")}.</p>
    <h2 class="sect">Who to measure</h2>
    <p class="note">${sched.length ? "Teams in our upcoming matches come first." : "Once the match schedule is out, teams we play with and against move to the top."} Schedule checked ${ago(s.live.fetchedAt)}.</p>
    <ol class="rows">${list.map((p) => `
      <li><a class="row" href="#/team/${p.code}">
        ${flag(p.code)}
        <span class="main"><span class="name">${esc(p.name)}</span>
          <span class="meta">Needs ${p.missing.length}: ${esc(p.missing.slice(0, 3).join(", "))}${p.missing.length > 3 ? "…" : ""}</span>
          ${relationLine(p)}</span>
        ${dangerBand(Math.max(1, Math.ceil((5 * p.priority) / max)))}
      </a></li>`).join("") || `<li class="none">Every team is measured. Nice work.</li>`}</ol>
    ${SCORE_HELP}
    <p class="note"><a href="/guide/">Songdo trip guide</a> for the team: entry rules, the 3am arrival, free evenings, food. Anyone can open that link, no key needed.</p>`;
  wireNameCard();
}

function wireNameCard() {
  const b = $("#savename");
  if (!b) return;
  b.onclick = () => {
    const v = $("#myname").value.trim();
    if (!v) return toast("Type your name first.");
    ls.set("scout", v); toast(`Thanks, ${v}`); refresh();
  };
}
function progressDots(t) {
  const known = REQUIRED_KEYS.filter((k) => k(t)).length;
  return `<span class="dots" role="img" aria-label="${known} of ${REQUIRED_KEYS.length} measured">${REQUIRED_KEYS.map((k) => `<i class="${k(t) ? "on" : ""}"></i>`).join("")}</span>`;
}
const REQUIRED_KEYS = [
  (t) => t.scouted.fields.shooter?.has != null, (t) => t.scouted.fields.intake?.has != null,
  (t) => t.scouted.fields.climb?.has != null, (t) => t.scouted.fields.partnerClimb?.has != null,
  (t) => t.scouted.fields.weightKg != null, (t) => t.scouted.fields.size?.l != null,
  (t) => t.scouted.fields.hookSpace?.has != null, (t) => (t.photos || []).some((p) => p.part === "robot"),
];

const scoutedAt = (x) => Math.max(x.scouted.lastTs || 0, ...(x.photos || []).map((p) => p.ts || 0));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const isScouted = (x) => x.entries > 0 || (x.photos || []).length > 0;

function renderTeams() {
  const all = Object.values(STATE.teams);
  const done = all.filter(isScouted).length;
  setScreen("teams", "Teams", `${done} of ${all.length} scouted`);
  const q = ls.get("q", "");
  let show = ls.get("show", "all");
  const segs = [["all", `All ${all.length}`], ["scouted", `Scouted ${done}`], ["todo", `Not yet ${all.length - done}`]];
  view.innerHTML = `
    <div class="filterseg" role="tablist">${segs.map(([k, l]) => `<button role="tab" data-show="${k}" aria-selected="${k === show}">${l}</button>`).join("")}</div>
    <label class="search"><span class="sr">Search teams</span><input id="q" type="search" placeholder="Country or code" value="${esc(q)}"></label>
    <ol class="rows" id="tl"></ol>`;
  const draw = () => {
    const t = $("#q").value.trim().toLowerCase();
    ls.set("q", t);
    let rows = all.filter((x) => !t || x.code.toLowerCase().includes(t) || x.name.toLowerCase().includes(t));
    if (show === "scouted") rows = rows.filter(isScouted).sort((a, b) => scoutedAt(b) - scoutedAt(a));
    else if (show === "todo") rows = rows.filter((x) => !isScouted(x)).sort((a, b) => a.name.localeCompare(b.name));
    else rows = rows.sort((a, b) => a.name.localeCompare(b.name));
    $("#tl").innerHTML = rows.map((x) => {
      const meta = isScouted(x)
        ? `${ago(new Date(scoutedAt(x)).toISOString())}, ${x.photos.length} photo${x.photos.length === 1 ? "" : "s"}${x.scouted.scouts.length ? `, by ${esc(x.scouted.scouts.join(", "))}` : ""}`
        : x.code;
      return `<li><a class="row" href="#/team/${x.code}">${flag(x.code)}
      <span class="main"><span class="name">${esc(x.name)}</span><span class="meta">${meta}</span></span>
      ${progressDots(x)}<span class="num" title="past score">${x.history.pastScore ?? "–"}</span></a></li>`;
    }).join("") || `<li class="none">${show === "scouted" && !t ? "Nothing scouted yet." : `No team matches “${esc(t)}”.`}</li>`;
  };
  view.querySelectorAll(".filterseg button").forEach((b) => (b.onclick = () => {
    show = b.dataset.show; ls.set("show", show);
    view.querySelectorAll(".filterseg button").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.show === show)));
    draw();
  }));
  $("#q").oninput = draw;
  draw();
}

function renderMatches() {
  const s = STATE;
  setScreen("matches", "Our matches", s.schedule.length ? `${s.schedule.filter((m) => m.played).length} of ${s.schedule.length} played` : "");
  if (!s.schedule.length) {
    view.innerHTML = `<p class="empty-state">FIRST Global publishes the match schedule after robot inspection. This page fills in by itself; last checked ${ago(s.live.fetchedAt)}.${s.live.error ? ` The last check failed: ${esc(s.live.error)}.` : ""}</p>`;
    return;
  }
  const pc = partnerCodes().map((c) => ({ c, k: kurac(teamOf(c)), next: s.schedule.find((m) => !m.played && m.partners.includes(c)) })).sort((a, b) => b.k.score - a.k.score);
  const partnersHtml = `<h2 class="sect">Partners by help needed</h2>
    <p class="note">Help score: 1 means self-sufficient, 10 means expect to spend a lot of pit time on their robot. Scores marked "estimate" switch to Opus's judgement as each deep dive finishes.</p>
    <ol class="rows">${pc.map(({ c, k, next }) => `<li><a class="row" href="#/team/${c}">${flag(c)}<span class="main"><span class="name">${esc(teamOf(c).name)}</span><span class="meta">${next ? `${esc(next.name)}, ${clock(next.scheduledTime)}` : "played"}, ${esc(k.source)}</span></span><span class="kurac big k${Math.ceil(k.score / 2)}">${k.score}</span></a></li>`).join("")}</ol>
    ${s.prediction ? `<p class="note">Predictions come from ${Math.round(s.prediction.matchesUsed)} official matches so far. Tested on 2025, this way of predicting picked the winner 58–68% of the time; treat it as a lean, not a promise.</p>` : `<p class="note">Score predictions start once official 2026 matches have been played.</p>`}`;
  view.innerHTML = `<ol class="matches">${s.schedule.map((m) => {
    const us = m.side === "red" ? m.redScore : m.blueScore, them = m.side === "red" ? m.blueScore : m.redScore;
    const res = !m.played ? "" : us > them ? "won" : us < them ? "lost" : "tied";
    return `<li class="match ${m.side}">
      <div class="mhead"><span class="mname">${esc(m.name)}</span><span class="mtime">${clock(m.scheduledTime)}${m.played ? "" : `<br><b data-until="${esc(m.scheduledTime)}">${until(m.scheduledTime)}</b>`}</span></div>
      ${!m.played && m.prediction ? `<p class="mpred">Predicted <b>${m.prediction.ours}–${m.prediction.theirs}</b>, ${m.prediction.winChance}% chance to win <span class="note">(give or take ${m.prediction.sigma} points)</span></p>` : ""}
      ${m.played ? `<p class="result ${res}"><b>${us}</b><span>–</span><b>${them}</b><em>${res === "won" ? "Won" : res === "lost" ? "Lost" : "Tied"}</em></p>` : ""}
      <div class="sides"><div><span class="lab">With us</span>${m.partners.map((c) => `${teamLink(c)}${kuracBadge(teamOf(c))}`).join("")}</div><div><span class="lab">Against</span>${m.opponents.map(teamLink).join("")}</div></div>
      ${m.details ? `<details class="fine"><summary>Scoring breakdown</summary><table class="kvt">${Object.entries(m.details).filter(([, v]) => typeof v === "number" || typeof v === "boolean").map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></details>` : ""}
    </li>`;
  }).join("")}</ol>${partnersHtml}`;
}

function renderFind() {
  setScreen("find", "Find robots", "Search everything we know");
  const f = ls.get("find", {});
  const box = (name, label) => `<label class="field small"><span>${label}</span><input type="text" inputmode="decimal" name="${name}" value="${esc(f[name] || "")}"></label>`;
  view.innerHTML = `
    <label class="search"><span class="sr">Search notes</span><input type="search" name="text" placeholder="Words in notes and commentary" value="${esc(f.text || "")}"></label>
    <div class="chips" role="group" aria-label="Must have">${[["shooter", "Shooter"], ["intake", "Intake"], ["climb", "Climbs"], ["partnerClimb", "Partner climb"], ["hookSpace", "Room for hooks"]].map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${f[k] ? "true" : "false"}">${l}</button>`).join("")}</div>
    <details class="filters" ${["wmin", "wmax", "l", "w", "h", "hw", "og"].some((k) => f[k]) ? "open" : ""}><summary>Size and weight</summary>
      <div class="grid2">${box("wmin", "Weight from, kg")}${box("wmax", "Weight up to, kg")}${box("l", "Length up to, cm")}${box("w", "Width up to, cm")}${box("h", "Height up to, cm")}${box("hw", "Hook gap at least, cm")}${box("og", "Climbs off the ground, at least %")}</div>
    </details>
    <p class="note" id="cnt"></p><ol class="rows" id="res"></ol>`;
  const num = (v) => (v === "" || v == null ? null : Number(String(v).replace(",", ".")));
  const run = () => {
    const q = Object.fromEntries([...view.querySelectorAll("input")].map((i) => [i.name, i.value.trim()]));
    view.querySelectorAll(".chips button").forEach((b) => (q[b.dataset.k] = b.getAttribute("aria-pressed") === "true"));
    ls.set("find", q);
    const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = Object.values(STATE.teams).filter((t) => {
      const F = t.scouted.fields;
      for (const k of ["shooter", "intake", "climb", "partnerClimb", "hookSpace"]) if (q[k] && capState(t, k).v !== true) return false;
      const wt = F.weightKg;
      if (num(q.wmin) != null && !(wt >= num(q.wmin))) return false;
      if (num(q.wmax) != null && !(wt <= num(q.wmax))) return false;
      for (const d of ["l", "w", "h"]) if (num(q[d]) != null && !(F.size?.[d] <= num(q[d]))) return false;
      if (num(q.hw) != null && !(F.hookSpace?.w >= num(q.hw))) return false;
      if (num(q.og) != null) {
        const og = Object.values(t.stats?.robot || {}).map((r) => r.offGroundRate).find((x) => x != null);
        if (!(og >= num(q.og))) return false;
      }
      if (words.length) {
        const hay = [t.name, ...t.scouted.comments.map((c) => c.text), ...(t.research?.notes || []), t.investigation?.report?.summary, ...(t.observations || []).flatMap((o) => [o.summary, o.facts?.strategy, ...(o.facts?.goodAt || []), ...(o.facts?.badAt || []), ...(o.facts?.problems || []), ...(o.facts?.evidence || [])])].join(" ").toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    }).sort((a, b) => (b.history.pastScore ?? 0) - (a.history.pastScore ?? 0));
    $("#cnt").textContent = rows.length === 1 ? "1 team" : `${rows.length} teams`;
    $("#res").innerHTML = rows.slice(0, 80).map((t) => {
      const F = t.scouted.fields;
      const bits = [F.weightKg != null ? `${F.weightKg} kg` : null, F.size?.l != null ? `${F.size.l}×${F.size.w ?? "?"}×${F.size.h ?? "?"} cm` : null, t.observations?.length ? `${t.observations.length} match notes` : null].filter(Boolean);
      return `<li><a class="row" href="#/team/${t.code}">${flag(t.code)}<span class="main"><span class="name">${esc(t.name)}</span><span class="meta">${esc(bits.join(", ") || "Not measured yet")}</span></span><span class="num">${t.history.pastScore ?? "–"}</span></a></li>`;
    }).join("");
  };
  view.querySelectorAll("input").forEach((i) => (i.oninput = run));
  view.querySelectorAll(".chips button").forEach((b) => (b.onclick = () => { b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true"); run(); }));
  run();
}

async function renderTag() {
  setScreen("tag", "Tag robots", "Help the video tracker");
  let tags = [];
  try { tags = (await api("/api/tags?open=1")).tags; } catch { view.innerHTML = `<p class="empty-state">Tagging needs a connection. Try again when you have signal.</p>`; return; }
  if (!tags.length) { view.innerHTML = `<p class="empty-state">Nothing to tag right now. When the video tracker can't tell which robot is which, it asks here.</p>`; return; }
  const q = tags[0];
  $("#subtitle").textContent = tags.length === 1 ? "1 question waiting" : `${tags.length} questions waiting`;
  view.innerHTML = `<section class="tagq">
    <p class="ask">${esc(q.prompt || "Which team's robot is in the box?")}</p>
    ${q.imageId ? `<img src="/api/tag-image/${esc(q.imageId)}.jpg" alt="The robot to identify, marked with a box">` : ""}
    <p class="note">${esc(q.matchKey || "")}${q.t != null ? `, ${Math.round(q.t)} seconds in` : ""}${q.context ? `. ${esc(q.context)}` : ""}</p>
    <div class="answers" id="opts">${q.candidates.map((c) => `<button class="btn answer" data-a="${c}">${flag(c)}<span>${esc(teamOf(c).name)}</span></button>`).join("")}</div>
    <div class="answers minor"><button class="btn ghost" data-a="none">Not a robot</button><button class="btn ghost" data-a="unsure">Can't tell, skip</button></div>
  </section>`;
  view.querySelectorAll("[data-a]").forEach((b) => (b.onclick = async () => {
    try {
      await api("/api/tag-answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: q.id, answer: b.dataset.a, scout: ls.get("scout", "") }) });
    } catch { toast("Not sent. Check your connection."); return; }
    renderTag();
  }));
}

// ---------- team page ----------
const SEGMENTS = [["overview", "Overview"], ["scout", "Scout"], ["intel", "Intel"], ["history", "History"]];

function teamOverview(t, p) {
  const f = t.scouted.fields;
  const og = Object.values(t.stats?.robot || {}).map((r) => r.offGroundRate).find((x) => x != null);
  const facts = [
    ["Weight", f.weightKg != null ? `${f.weightKg} kg` : null],
    ["Start size", f.size?.l != null ? `${f.size.l} × ${f.size.w ?? "?"} × ${f.size.h ?? "?"} cm` : null],
    ["Extends", f.extensionCm != null ? `${f.extensionCm} cm` : null],
    ["Room for hooks", f.hookSpace?.has == null ? null : f.hookSpace.has ? (f.hookSpace.w ? `Yes, ${f.hookSpace.w} × ${f.hookSpace.h ?? "?"} cm` : "Yes") : "No"],
    ["Climb zone", f.climb?.zone ? `Zone ${f.climb.zone}` : null],
    ["Off the ground", og != null ? `${og}% of matches` : null],
  ];
  return `
    ${p?.missing.length ? `<p class="todo"><b>Still needed:</b> ${esc(p.missing.join(", "))}.</p>` : ""}
    ${facts.some(([, v]) => v) ? `<dl class="facts">${facts.filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>` : `<p class="note">Nothing measured yet. Open Scout to add what you see.</p>`}
    ${t.photos.length ? `<div class="photos">${t.photos.map((ph) => `<a href="/photos/${ph.id}.jpg" target="_blank" rel="noopener"><img loading="lazy" src="/photos/${ph.id}.jpg" alt="${esc(ph.part)} photo"></a>`).join("")}</div>` : `<p class="note">No photos yet. Add one under Scout.</p>`}
    ${t.scouted.comments.length ? `<h3>Scout notes</h3><ul class="notes">${t.scouted.comments.map((c) => `<li><span>${esc(c.text)}</span><small>${esc(c.field === "notes" ? "General" : (SYSTEMS.find(([k]) => k === c.field)?.[1] || "Hook space"))}, ${esc(c.scout || "unknown scout")}</small></li>`).join("")}</ul>` : ""}
    ${investigationBlock(t)}`;
}

function investigationBlock(t) {
  const inv = t.investigation;
  const ask = `<div class="invask"><label class="field"><span>What should it look into?</span><input type="text" id="invnote" placeholder="Optional, e.g. can they carry a partner"></label><button class="btn" id="invgo">Investigate ${esc(t.name)}</button></div>`;
  if (!inv) return `<h3>Deeper look</h3><p class="note">Researches this team on the web and runs all their matches through the commentary pipeline. The report lands under Intel.</p>${ask}`;
  if (inv.status === "queued" || inv.status === "running") return `<p class="status">Investigation ${inv.status === "queued" ? "queued" : "running"}, asked by ${esc(inv.requestedBy || "a scout")} ${ago(new Date(inv.ts).toISOString())}.</p>`;
  if (inv.status === "failed") return `<p class="status bad">The last investigation failed: ${esc(inv.error || "no reason given")}.</p>${ask}`;
  return `<p class="status">Investigation report ready under Intel.</p>`;
}

function teamIntel(t) {
  const inv = t.investigation, r = t.research;
  const k = partnerCodes().includes(t.code) ? kurac(t) : null;
  const kHtml = k ? `<h3>Help score ${k.score} of 10</h3><p class="note">${esc(k.source)}. How much of our pit time their robot is likely to need.</p>
    ${k.reasons.length ? `<ul class="plain">${k.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${k.help.length ? `<p><b>Help they'll likely need</b></p><ul class="plain">${k.help.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}` : "";
  const rep = inv?.status === "done" ? inv.report || {} : null;
  return `
    ${kHtml}
    ${rep ? `<article class="report"><h3>Investigation report</h3><p class="lead">${esc(rep.summary || "")}</p>
      ${(rep.sections || []).map((s) => `<details><summary>${esc(s.title)}</summary><p>${esc(s.text)}</p></details>`).join("")}
      ${(rep.sources || []).length ? `<p class="sources">${rep.sources.map((s, i) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.what || "")}">Source ${i + 1}</a>`).join("")}</p>` : ""}
      <p class="note">${ago(new Date(inv.updated || inv.ts).toISOString())}</p>${investigationAskOnly(t)}</article>` : ""}
    <h3>From match commentary</h3>
    ${(t.observations || []).length ? `<ul class="obs">${t.observations.map((o) => `<li>
      <p class="ohead"><span>${esc(o.matchKey || "")}</span>${o.source?.url ? `<a href="${esc(o.source.url)}" target="_blank" rel="noopener">Watch this moment</a>` : ""}</p>
      <p>${esc(o.summary)}</p>
      ${o.facts?.goodAt?.length ? `<p class="good">Good at ${esc(o.facts.goodAt.join("; "))}</p>` : ""}
      ${o.facts?.badAt?.length ? `<p class="bad">Weak at ${esc(o.facts.badAt.join("; "))}</p>` : ""}
      ${o.facts?.strategy ? `<p class="strat">Plays ${esc(o.facts.strategy)}</p>` : ""}
      ${o.facts?.problems?.length ? `<p class="bad">Problems: ${esc(o.facts.problems.join("; "))}</p>` : ""}
      ${o.facts?.evidence?.length ? `<details><summary>What the commentators said</summary>${o.facts.evidence.map((q) => `<blockquote>${esc(q)}</blockquote>`).join("")}</details>` : ""}
    </li>`).join("")}</ul>` : `<p class="note">Nothing yet. This fills in from the livestream commentary once they play a match we follow.</p>`}
    <h3>Public research</h3>
    ${r ? `${capChips({ ...t, scouted: { fields: {} } })}
      ${r.experience ? `<p>${esc(r.experience)}</p>` : ""}
      ${(r.notes || []).length ? `<ul class="plain">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <p class="sources">${(r.sources || []).map((s, i) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.what || "")}">${s.label === "VERIFIED" ? "Official" : "Report"} ${i + 1}</a>`).join("")}${t.page ? `<a href="${esc(t.page)}" target="_blank" rel="noopener">Team page</a>` : ""}</p>
      ${r.checked ? `<p class="note">Checked by us: ${esc(r.checked)}</p>` : ""}` : `<p class="note">No public research on this team.</p>`}`;
}
const investigationAskOnly = (t) => `<div class="invask"><label class="field"><span>Ask for a fresh look</span><input type="text" id="invnote" placeholder="Optional focus"></label><button class="btn" id="invgo">Investigate again</button></div>`;

function teamHistory(t) {
  const s = t.stats;
  return `
    <h3>This season, official</h3>
    ${s ? `<p>${s.played} ranking matches, alliance average ${s.avgAllianceScore ?? "–"} points.</p>
      ${Object.entries(s.robot).map(([field, r]) => r.levels
        ? `<div class="levels">${Object.entries(r.levels).map(([l, n]) => `<span><b>${n}</b>${esc(l)}</span>`).join("")}</div><p class="note">Off the ground in ${r.offGroundRate}% of matches.</p>`
        : `<p class="note">${esc(field)} per robot: ${Object.entries(r.distribution).map(([v, n]) => `${esc(v)} ×${n}`).join(", ")}</p>`).join("")}
      <p class="note">From FIRST Global's official per-robot results, updated ${ago(STATE.statsFetchedAt)}.</p>`
      : `<p class="note">No 2026 matches played yet.</p>`}
    ${t.opr ? `<h3>What they add per match</h3><p>About <b>${Math.round(t.opr.total)}</b> points to their alliance per match, fitted from official scores.</p>
      ${Object.keys(t.opr.parts).length ? `<table class="kvt">${Object.entries(t.opr.parts).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${Math.round(v * 10) / 10}</td></tr>`).join("")}</table>` : ""}` : ""}
    <h3>Past seasons</h3>
    <p>Past score <b>${t.history.pastScore ?? "–"}</b> of 100, which puts them around rank ${t.history.predictedRank ?? "–"} of ${t.history.predictedOf ?? "–"} this year.</p>
    <p class="note">A rough guide only: tested on past seasons it picked about one in three of the top 24.</p>
    ${t.history.seasons?.length ? `<table class="seasons"><thead><tr><th>Year</th><th>Rank</th><th>Reached</th></tr></thead><tbody>
      ${[...t.history.seasons].reverse().map((x) => `<tr><td>${x.year}</td><td>${x.rank} of ${x.of}</td><td>${x.finals ? "Finals" : x.playoffs ? "Playoffs" : ""}</td></tr>${x.awards.length ? `<tr class="aw"><td></td><td colspan="2">${esc(x.awards.join("; "))}</td></tr>` : ""}`).join("")}</tbody></table>` : `<p class="note">No past FGC results under this code.</p>`}`;
}

function teamScoutForm(code) {
  const draft = ls.get(`draft:${code}`, {});
  const val = (path, fallback = "") => path.split(".").reduce((o, k) => o?.[k], draft) ?? fallback;
  const toggle = (k, label) => `
    <div class="q"><span class="qlabel">${label}</span><div class="seg2" role="group" aria-label="${label}" data-k="${k}">
      <button type="button" data-v="true" aria-pressed="${val(k === "hookSpace" ? "hookSpace.has" : `systems.${k}.has`) === true}">Yes</button>
      <button type="button" data-v="false" aria-pressed="${val(k === "hookSpace" ? "hookSpace.has" : `systems.${k}.has`) === false}">No</button></div></div>`;
  const note = (name, label, value) => `<details class="addnote" ${value ? "open" : ""}><summary>Add a note</summary><input type="text" name="${name}" aria-label="${label}" value="${esc(value)}"></details>`;
  const num = (name, label, value, ph = "") => `<label class="field small"><span>${label}</span><input type="text" inputmode="decimal" name="${name}" placeholder="${ph}" value="${esc(value)}"></label>`;
  return `<form id="f" class="scout">
    <p class="note">Fill in only what you saw. Blanks never erase other scouts' answers, and everything saves on this phone first, so no signal is fine.</p>
    <fieldset><legend>What it has</legend>
      ${SYSTEMS.map(([k, l]) => `${toggle(k, l)}${k === "climb" ? `<div class="zone">${num("climbZone", "Highest zone it reaches", val("systems.climb.zone"), "1, 2 or 3")}</div>` : ""}${note(`c_${k}`, `${l} note`, val(`systems.${k}.comment`))}`).join("")}
    </fieldset>
    <fieldset><legend>Measurements</legend>
      <div class="grid3">${num("l", "Length, cm", val("size.l"))}${num("w", "Width, cm", val("size.w"))}${num("h", "Height, cm", val("size.h"))}</div>
      <div class="grid2">${num("weightKg", "Weight, kg", val("weightKg"))}${num("extensionCm", "Extends, cm", val("extensionCm"))}</div>
    </fieldset>
    <fieldset><legend>Our hooks</legend>
      ${toggle("hookSpace", "Room for our hooks")}
      <div class="grid2">${num("hw", "Gap width, cm", val("hookSpace.w"))}${num("hh", "Gap height, cm", val("hookSpace.h"))}</div>
      <label class="field"><span>Where would they go?</span><input type="text" name="hc" value="${esc(val("hookSpace.comment"))}"></label>
    </fieldset>
    <fieldset><legend>Photos</legend>
      <div class="shots">${PARTS.map(([k, l]) => `<label class="shot"><input type="file" accept="image/*" capture="environment" data-part="${k}"><span>${l}</span></label>`).join("")}</div>
      <p class="note" id="pc"></p>
    </fieldset>
    <label class="field"><span>Anything else</span><textarea name="notes">${esc(val("notes"))}</textarea></label>
    <div class="savebar"><button class="btn primary" type="submit">Save</button></div>
  </form>`;
}

function renderTeam(code) {
  const t = STATE.teams[code];
  if (!t) { setScreen("", "Not found"); view.innerHTML = `<p class="empty-state">There's no team with the code ${esc(code)}.</p>`; return; }
  const p = STATE.prio.find((x) => x.code === code);
  const seg = SEGMENTS.some(([k]) => k === ls.get("seg", "overview")) ? ls.get("seg", "overview") : "overview";
  setScreen("", t.name, code);
  view.innerHTML = `
    <header class="team">
      <div class="tid">${flag(code)}<div>${p?.relation ? relationLine(p) : ""}<p class="tmeta">Past score ${t.history.pastScore ?? "–"} of 100${t.opr ? `, adds about ${Math.round(t.opr.total)} points per match` : ""}</p></div>${partnerCodes().includes(code) ? kuracBadge(t) : ""}</div>
      ${capChips(t)}
    </header>
    <nav class="segs" role="tablist">${SEGMENTS.map(([k, l]) => `<button role="tab" data-seg="${k}" aria-selected="${k === seg}">${l}</button>`).join("")}</nav>
    <div id="segbody"></div>`;
  const show = (k) => {
    ls.set("seg", k);
    view.querySelectorAll(".segs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.seg === k)));
    const body = $("#segbody");
    body.innerHTML = k === "scout" ? teamScoutForm(code) : k === "intel" ? teamIntel(t) : k === "history" ? teamHistory(t) : teamOverview(t, p);
    wireTeam(code, t);
  };
  view.querySelectorAll(".segs button").forEach((b) => (b.onclick = () => show(b.dataset.seg)));
  show(seg);
}

function wireTeam(code, t) {
  const ig = $("#invgo");
  if (ig) ig.onclick = async () => {
    try {
      await api("/api/investigate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, note: $("#invnote")?.value || "", scout: ls.get("scout", "") }) });
      toast("Investigation queued");
      refresh();
    } catch { toast("Not sent. It needs a connection."); }
  };
  const form = $("#f");
  if (!form) return;
  const draft = ls.get(`draft:${code}`, {});
  const choice = { ...Object.fromEntries(SYSTEMS.map(([k]) => [k, draft.systems?.[k]?.has ?? null])), hookSpace: draft.hookSpace?.has ?? null };
  form.querySelectorAll(".seg2").forEach((g) => g.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    const v = b.dataset.v === "true";
    choice[g.dataset.k] = choice[g.dataset.k] === v ? null : v; // tap again to clear
    g.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(choice[g.dataset.k] === (x.dataset.v === "true"))));
    saveDraft();
  })));
  const collect = () => {
    const F = new FormData(form);
    const g = (n) => (F.get(n) || "").toString().trim();
    return {
      systems: Object.fromEntries(SYSTEMS.map(([k]) => [k, { has: choice[k], comment: g(`c_${k}`), ...(k === "climb" ? { zone: g("climbZone") } : {}) }])),
      weightKg: g("weightKg"), extensionCm: g("extensionCm"),
      size: { l: g("l"), w: g("w"), h: g("h") },
      hookSpace: { has: choice.hookSpace, w: g("hw"), h: g("hh"), comment: g("hc") },
      notes: g("notes"),
    };
  };
  const saveDraft = () => ls.set(`draft:${code}`, collect());
  form.oninput = saveDraft;
  let pending = 0;
  form.querySelectorAll("input[type=file]").forEach((inp) => (inp.onchange = async () => {
    for (const file of inp.files) {
      const blob = await compress(file);
      await outboxPut({ id: uid(), kind: "photo", code, part: inp.dataset.part, scout: ls.get("scout", ""), blob });
      pending++;
    }
    $("#pc").textContent = pending === 1 ? "1 photo saved, syncing" : `${pending} photos saved, syncing`;
    inp.closest(".shot")?.classList.add("done");
    inp.value = "";
    flush();
  }));
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = collect();
    await outboxPut({ id: uid(), kind: "entry", payload: { id: uid(), code, scout: ls.get("scout", ""), ts: Date.now(), data } });
    ls.set(`draft:${code}`, {});
    ls.set("seg", "overview");
    toast("Saved");
    await flush();
    await refresh();
  };
}

// ---------- router ----------
async function refresh() {
  try { await loadState(); } catch { return; }
  if (!STATE) { view.innerHTML = `<p class="muted">Offline and nothing cached yet. Open the app once with internet.</p>`; return; }
  const h = location.hash || "#/next";
  const m = /^#\/team\/([A-Z]{3})$/.exec(h);
  if (m) renderTeam(m[1]);
  else if (h === "#/matches") renderMatches();
  else if (h === "#/find") renderFind();
  else if (h === "#/tag") renderTag();
  else if (h === "#/") renderTeams();
  else renderNext();
  syncBadge();
  const tn = $("#tagn");
  if (tn) tn.textContent = STATE.openTags ? ` (${STATE.openTags})` : "";
}
addEventListener("hashchange", refresh);
// Updates: the server stamps sw.js with a hash of the app, so a deploy means a
// new service worker. When it takes control, offer a reload. Check on every
// return to the app too: iOS resumes a home-screen app instead of reopening it.
if ("serviceWorker" in navigator) {
  // The first controller change on a fresh install is not an update.
  let firstInstall = !navigator.serviceWorker.controller;
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
    setInterval(check, 5 * 60_000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (firstInstall) { firstInstall = false; return; }
    const b = $("#update");
    b.hidden = false;
    b.onclick = () => location.reload();
  });
}
flush().finally(refresh);
