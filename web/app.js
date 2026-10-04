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
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
const yn = (v) => (v === true ? "yes" : v === false ? "no" : "?");
const ago = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const tags = (p) => {
  if (!p.relation) return "";
  const out = [];
  if (p.relation.partner) out.push(`<span class="tag partner">partner · ${esc(p.relation.next)}</span>`);
  if (p.relation.opponent) out.push(`<span class="tag opp">opponent · ${esc(p.relation.next)}</span>`);
  return out.join("");
};
function setTab(tab) {
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
}

// ---------- views ----------
function showLogin() {
  setTab("");
  view.innerHTML = `
    <h1>Team key</h1>
    <p class="muted">Ask Bogdan for the scouting key. You enter it once on this phone.</p>
    <label class="f">Your name (shown on what you scout)</label>
    <input id="scout" type="text" autocomplete="name" value="${esc(ls.get("scout", ""))}">
    <label class="f">Key</label>
    <input id="key" type="password" autocomplete="current-password">
    <p></p><button class="primary" id="go">Continue</button>
    <p class="small muted">To install: Safari → Share → Add to Home Screen. Chrome → ⋮ → Install app.</p>`;
  $("#go").onclick = async () => {
    ls.set("scout", $("#scout").value.trim());
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: $("#key").value }) });
    if (!r.ok) return toast("Wrong key");
    location.hash = "#/next";
    refresh();
  };
}

function renderNext() {
  setTab("next");
  const s = STATE;
  const list = s.prio.filter((p) => p.priority > 0).slice(0, 60);
  const sched = s.schedule.filter((m) => !m.played);
  view.innerHTML = `
    <h1>Measure next</h1>
    <p class="small muted">${sched.length ? `${sched.length} upcoming ${esc(s.our)} matches. Partners and opponents first.` : "Match schedule not published yet, so this is ranked by team strength and what is missing."}
    Schedule checked ${ago(s.live.fetchedAt)}.</p>
    <div class="list">${list.map((p) => `
      <a class="row" href="#/team/${p.code}">
        <span class="code">${p.code}</span>
        <span class="grow"><div class="title">${esc(p.name)}</div>
          <div class="sub">needs: ${esc(p.missing.join(", "))}</div>${tags(p)}</span>
        <span class="score">${p.priority}</span>
      </a>`).join("") || `<p class="muted">Everything is measured.</p>`}</div>`;
}

function renderTeams() {
  setTab("teams");
  const q = ls.get("q", "");
  view.innerHTML = `
    <input id="q" type="search" placeholder="Search country or code" value="${esc(q)}">
    <p></p><div class="list" id="tl"></div>`;
  const draw = () => {
    const t = $("#q").value.trim().toLowerCase();
    ls.set("q", t);
    const prio = Object.fromEntries(STATE.prio.map((p) => [p.code, p]));
    const rows = Object.values(STATE.teams)
      .filter((x) => !t || x.code.toLowerCase().includes(t) || x.name.toLowerCase().includes(t))
      .sort((a, b) => a.name.localeCompare(b.name));
    $("#tl").innerHTML = rows.map((x) => {
      const f = x.scouted.fields;
      const sys = SYSTEMS.map(([k, l]) => `${l.split(" ")[0]} ${yn(f[k]?.has)}`).join(" · ");
      return `<a class="row" href="#/team/${x.code}"><span class="code">${x.code}</span>
        <span class="grow"><div class="title">${esc(x.name)}</div><div class="sub">${x.entries ? sys : "not scouted yet"}</div></span>
        <span class="score" title="past-performance score">${x.history.pastScore ?? "–"}</span></a>`;
    }).join("");
    void prio;
  };
  $("#q").oninput = draw;
  draw();
}

function renderMatches() {
  setTab("matches");
  const s = STATE;
  if (!s.schedule.length) {
    view.innerHTML = `<h1>Our matches</h1><p class="muted">No ${esc(s.our)} matches published yet. FIRST Global generates the ranking schedule after robot inspection (rule 6.3); this page fills in by itself, checked every 2 minutes (last ${ago(s.live.fetchedAt)}${s.live.error ? `, last error: ${esc(s.live.error)}` : ""}).</p>`;
    return;
  }
  const name = (c) => esc(s.teams[c]?.name || c);
  view.innerHTML = `<h1>Our matches</h1><div class="list">${s.schedule.map((m) => `
    <div class="card"><div><b>${esc(m.name)}</b> <span class="tag ${m.side}">${m.side}</span>
      <span class="small muted">${esc(new Date(m.scheduledTime).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}${m.played ? ` · played ${m.redScore}–${m.blueScore}` : ""}</span></div>
      <div class="small">With: ${m.partners.map((c) => `<a href="#/team/${c}">${name(c)}</a>`).join(", ")}</div>
      <div class="small">Against: ${m.opponents.map((c) => `<a href="#/team/${c}">${name(c)}</a>`).join(", ")}</div></div>`).join("")}</div>`;
}

function renderTeam(code) {
  setTab("");
  const t = STATE.teams[code];
  if (!t) { view.innerHTML = `<p>No team ${esc(code)}.</p>`; return; }
  const f = t.scouted.fields;
  const p = STATE.prio.find((x) => x.code === code);
  const r = t.research;
  const draft = ls.get(`draft:${code}`, {});
  const val = (path, fallback = "") => path.split(".").reduce((o, k) => o?.[k], draft) ?? fallback;
  view.innerHTML = `
    <h1>${esc(t.name)} <span class="code">${code}</span></h1>
    ${p ? `<p class="small muted">Priority ${p.priority} · strength ${p.strength}/100 (${esc(p.strengthSource)}) ${tags(p)}${p.missing.length ? `<br>Still needed: <b>${esc(p.missing.join(", "))}</b>` : ""}</p>` : ""}

    <h2>Known so far</h2>
    <div class="card"><dl class="kv">
      ${SYSTEMS.map(([k, l]) => `<dt>${l}</dt><dd>${yn(f[k]?.has)}${k === "climb" && f.climb?.zone ? ` (zone ${esc(f.climb.zone)})` : ""}</dd>`).join("")}
      <dt>Weight</dt><dd>${f.weightKg != null ? `${f.weightKg} kg` : "?"}</dd>
      <dt>Start size</dt><dd>${f.size ? `${f.size.l ?? "?"} × ${f.size.w ?? "?"} × ${f.size.h ?? "?"} cm` : "?"}</dd>
      <dt>Max extension</dt><dd>${f.extensionCm != null ? `${f.extensionCm} cm` : "?"}</dd>
      <dt>Hook space</dt><dd>${yn(f.hookSpace?.has)}${f.hookSpace?.w ? ` · ${f.hookSpace.w} × ${f.hookSpace.h ?? "?"} cm` : ""}</dd>
    </dl>
    ${t.scouted.comments.map((c) => `<div class="comment"><b>${esc(c.field)}</b>: ${esc(c.text)} <span class="small muted">— ${esc(c.scout || "?")}</span></div>`).join("")}
    ${t.photos.length ? `<p></p><div class="photos">${t.photos.map((ph) => `<a href="/photos/${ph.id}.jpg" target="_blank"><img loading="lazy" src="/photos/${ph.id}.jpg" alt="${esc(ph.part)}"></a>`).join("")}</div>` : ""}
    </div>

    <h2>Scout this robot</h2>
    <form id="f" class="card">
      ${SYSTEMS.map(([k, l]) => `
        <div class="sys"><b>${l}</b><div class="yn" data-k="${k}">
          <button type="button" class="yes ${val(`systems.${k}.has`) === true ? "on" : ""}" data-v="true">Yes</button>
          <button type="button" class="no ${val(`systems.${k}.has`) === false ? "on" : ""}" data-v="false">No</button></div></div>
        ${k === "climb" ? `<label class="f">Highest zone reached (1/2/3)</label><input type="text" inputmode="numeric" name="climbZone" value="${esc(val("systems.climb.zone"))}">` : ""}
        <input type="text" name="c_${k}" placeholder="Comment on the ${l.toLowerCase()}" value="${esc(val(`systems.${k}.comment`))}">
        <p></p>`).join("")}
      <label class="f">Weight (kg)</label><input type="text" inputmode="decimal" name="weightKg" value="${esc(val("weightKg"))}">
      <label class="f">Starting size L × W × H (cm)</label>
      <div class="grid3"><input type="text" inputmode="decimal" name="l" placeholder="L" value="${esc(val("size.l"))}"><input type="text" inputmode="decimal" name="w" placeholder="W" value="${esc(val("size.w"))}"><input type="text" inputmode="decimal" name="h" placeholder="H" value="${esc(val("size.h"))}"></div>
      <label class="f">Max extension beyond start (cm)</label><input type="text" inputmode="decimal" name="extensionCm" value="${esc(val("extensionCm"))}">
      <p></p>
      <div class="sys"><b>Space for our hooks?</b><div class="yn" data-k="hookSpace">
        <button type="button" class="yes ${val("hookSpace.has") === true ? "on" : ""}" data-v="true">Yes</button>
        <button type="button" class="no ${val("hookSpace.has") === false ? "on" : ""}" data-v="false">No</button></div></div>
      <div class="grid2"><input type="text" inputmode="decimal" name="hw" placeholder="space W cm" value="${esc(val("hookSpace.w"))}"><input type="text" inputmode="decimal" name="hh" placeholder="space H cm" value="${esc(val("hookSpace.h"))}"></div>
      <input type="text" name="hc" placeholder="Where would hooks go?" value="${esc(val("hookSpace.comment"))}">
      <label class="f">Other notes</label><textarea name="notes">${esc(val("notes"))}</textarea>
      <label class="f">Photos</label>
      <div class="photo-add">${PARTS.map(([k, l]) => `<label>📷 ${l}<input type="file" accept="image/*" capture="environment" data-part="${k}"></label>`).join("")}</div>
      <p class="small muted" id="pc"></p>
      <button class="primary" type="submit">Save</button>
      <p class="small muted">Saved on this phone first, then synced. Only fill what you saw; blanks never erase what others entered.</p>
    </form>

    <h2>Past seasons</h2>
    <div class="card">
      <p class="small muted">Past-performance score ${t.history.pastScore ?? "–"}/100 → estimated rank ${t.history.predictedRank ?? "–"} of ${t.history.predictedOf ?? "–"}.
      ${STATE.backtest ? `This estimate is weak: tested on 2025 it had a rank correlation of ${STATE.backtest.spearman_rho} and got ${STATE.backtest.predicted_top24_that_finished_top24} of the top 24 right.` : ""}</p>
      ${t.history.seasons?.length ? `<table class="hist"><tr><th>Year</th><th>Rank</th><th>Playoffs</th><th>Awards</th></tr>
        ${[...t.history.seasons].reverse().map((s) => `<tr><td>${s.year}</td><td>${s.rank}/${s.of}</td><td>${s.finals ? "finals" : s.playoffs ? "yes" : ""}</td><td class="small">${esc(s.awards.join("; "))}</td></tr>`).join("")}</table>` : `<p class="muted">No past FGC results under this code.</p>`}
    </div>

    <h2>Research (public sources)</h2>
    <div class="card">${r ? `
      <p class="small muted">Confidence: ${esc(r.confidence)}${r.agreement ? ` · ${esc(r.agreement)}` : ""}</p>
      <dl class="kv">${SYSTEMS.map(([k, l]) => `<dt>${l}</dt><dd>${yn(r.robot?.[k])}</dd>`).join("")}</dl>
      ${r.experience ? `<p class="small">${esc(r.experience)}</p>` : ""}
      ${(r.notes || []).map((n) => `<div class="comment">${esc(n)}</div>`).join("")}
      ${(r.sources || []).map((s) => `<div class="small"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a> · ${esc(s.what)}</div>`).join("")}
      <p class="small"><a href="${esc(t.page)}" target="_blank" rel="noopener">Official team page</a></p>` : `<p class="muted">No research yet.</p>`}</div>`;

  const form = $("#f");
  const choice = { ...Object.fromEntries(SYSTEMS.map(([k]) => [k, val(`systems.${k}.has`, null)])), hookSpace: val("hookSpace.has", null) };
  form.querySelectorAll(".yn").forEach((g) => g.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    const v = b.dataset.v === "true";
    choice[g.dataset.k] = choice[g.dataset.k] === v ? null : v; // tap again to clear
    g.querySelectorAll("button").forEach((x) => x.classList.toggle("on", choice[g.dataset.k] === (x.dataset.v === "true")));
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
    $("#pc").textContent = `${pending} photo(s) queued`;
    inp.value = "";
    flush();
  }));

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = collect();
    await outboxPut({ id: uid(), kind: "entry", payload: { id: uid(), code, scout: ls.get("scout", ""), ts: Date.now(), data } });
    ls.set(`draft:${code}`, {});
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
  else if (h === "#/") renderTeams();
  else renderNext();
  syncBadge();
}
addEventListener("hashchange", refresh);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
flush().finally(refresh);
