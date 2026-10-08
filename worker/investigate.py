#!/usr/bin/env python3
"""Run queued "investigate this team" requests from the scout app.

Polls the scout server, claims each queued investigation, has Opus (keyless,
`claude -p`) research the team with web search over everything we already
hold, and posts a sourced report back. Runs on archserver from a systemd user
timer; stdlib only.

  investigate.py            process the queue once
  investigate.py --dry-run  show what is queued, change nothing

Exit: 0 ok (including an empty queue), 1 failure, 130 interrupted.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

PROMPT = """You are researching one team for team Serbia's scouting at the FIRST Global Challenge 2026 (Incheon, 7-10 Oct 2026).
Game: robots collect 100 mm orange balls (WILDFIRE) and score them into a 201 cm SUPPRESSION UNIT, push balls into the FIRE SHIELD port for the human player, and at the end climb a sloped 6.4 m steel pipe (BRACE) in zones 1-3; partner climbs are 25 points each. No autonomous period. Robot rules: 50 cm start cube, at most 50 cm horizontal extension in one direction, no weight limit, REV kit only.

Team: {name} ({code}). Requested focus: {note}

What we already hold (official results, our scouts' entries, earlier research, commentary observations from matches):
{known}

Do fresh web research: the team's 2026 posts, videos and news, plus their 2026 match results if any are online. Use only sources you actually opened. Then answer with ONLY this JSON:
{{"summary":"3-5 sentences: what this robot can do, how good the team likely is, what matters for us as partner or opponent",
 "sections":[{{"title":"Robot capabilities","text":"..."}},{{"title":"Track record","text":"..."}},{{"title":"Strategy and driving","text":"..."}},{{"title":"As our partner / opponent","text":"concrete advice for team Serbia"}},{{"title":"Open questions for our scouts","text":"what to measure or ask in the pits"}}],
 "kurac":{{"score":1-10,"reasons":["why"],"helpNeeded":["concrete things team Serbia may have to fix or help with on this robot"]}},
 "sources":[{{"url":"https://...","what":"which claim this supports"}}]}}
The "kurac" field holds the HELP SCORE. Never use the field's name in your text; call it the help score. It answers: on a scale of 1 to 10, how much of team Serbia's time will it take to help fix or get this robot working if they are our alliance partner? 1 = self-sufficient veteran team with a working robot, 10 = robot likely broken, missing or needing major work. Base it on evidence (reported problems, missing systems, experience, past results, official 2026 match results if any); say "estimate" in the reasons when evidence is thin.
Rules: never invent. Say "unknown" where nothing was found. Every factual claim must come from the material above or a listed source. Do not include people's names; this is about the robot and the team.
"""


def call(base, key, path, data=None, method=None):
    req = urllib.request.Request(base + path, method=method or ("POST" if data is not None else "GET"),
                                 data=None if data is None else json.dumps(data).encode(),
                                 headers={"X-Scout-Key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def known_for(team):
    keep = {
        "history": team.get("history"),
        "officialStats2026": team.get("stats"),
        "research": team.get("research"),
        "scouted": team.get("scouted", {}).get("fields"),
        "scoutComments": [c["text"] for c in team.get("scouted", {}).get("comments", [])][:40],
        "commentary": [{"match": o.get("matchKey"), "summary": o.get("summary"), "facts": o.get("facts")} for o in team.get("observations", [])][:30],
    }
    return json.dumps(keep, ensure_ascii=False)[:24000]


def parse_report(text):
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        raise ValueError("no JSON in model output")
    rep = json.loads(m.group(0))
    if not isinstance(rep.get("summary"), str) or not isinstance(rep.get("sections"), list):
        raise ValueError("report missing summary or sections")
    k = rep.get("kurac") or {}
    try:
        k["score"] = max(1, min(10, int(round(float(k.get("score"))))))
        rep["kurac"] = {"score": k["score"], "reasons": [str(x) for x in k.get("reasons", [])][:6], "helpNeeded": [str(x) for x in k.get("helpNeeded", [])][:8]}
    except (TypeError, ValueError):
        rep.pop("kurac", None)
    rep["sources"] = [s for s in rep.get("sources", []) if isinstance(s, dict) and str(s.get("url", "")).startswith("http")]
    return rep


def run_one(base, key, inv, team, timeout):
    prompt = PROMPT.format(name=team.get("name", inv["code"]), code=inv["code"], note=inv.get("note") or "general", known=known_for(team))
    last_err = None
    for attempt in range(2):  # one retry on unusable output
        p = subprocess.run(["claude", "-p", "--model", "opus", "--allowedTools", "WebSearch", "WebFetch", "--output-format", "text"],
                           input=prompt, capture_output=True, text=True, timeout=timeout)
        if p.returncode != 0:
            last_err = f"claude exited {p.returncode}: {p.stderr[-500:]}"
            continue
        try:
            return parse_report(p.stdout)
        except (ValueError, json.JSONDecodeError) as e:
            last_err = f"attempt {attempt + 1}: {e}"
    raise RuntimeError(last_err or "unknown failure")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="list the queue, change nothing")
    ap.add_argument("--timeout", type=int, default=1500, help="seconds per investigation (default 1500)")
    ap.add_argument("--parallel", type=int, default=3, help="investigations at once (default 3)")
    a = ap.parse_args(argv)
    base, key = os.environ.get("SCOUT_URL", "").rstrip("/"), os.environ.get("SCOUT_KEY", "")
    if not base or not key:
        print("SCOUT_URL and SCOUT_KEY must be set", file=sys.stderr)
        return 1
    try:
        queued = call(base, key, "/api/investigations?status=queued")["investigations"]
        if a.dry_run:
            for inv in queued:
                print(f"{inv['code']}  queued by {inv.get('requestedBy') or '?'}  focus: {inv.get('note') or '-'}")
            print(f"{len(queued)} queued")
            return 0
        if not queued:
            return 0
        teams = call(base, key, "/api/state")["teams"]

        def one(inv):
            call(base, key, f"/api/investigation/{inv['id']}", {"status": "running"})
            try:
                rep = run_one(base, key, inv, teams.get(inv["code"], {"code": inv["code"]}), a.timeout)
                call(base, key, f"/api/investigation/{inv['id']}", {"status": "done", "report": rep})
                print(f"{inv['code']}: done, {len(rep['sources'])} sources", flush=True)
                return True
            except Exception as e:  # report the failure to the app, keep going
                call(base, key, f"/api/investigation/{inv['id']}", {"status": "failed", "error": str(e)})
                print(f"{inv['code']}: failed: {e}", file=sys.stderr, flush=True)
                return False

        # A deep dive takes a few minutes of mostly waiting on the model and the
        # web, so a few at once cut a 50-team queue from ~3 h to ~1 h.
        with ThreadPoolExecutor(max_workers=a.parallel) as pool:
            ok = list(pool.map(one, queued))
        return 0 if all(ok) else 1
    except KeyboardInterrupt:
        return 130
    except Exception as e:
        print(f"investigate: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
