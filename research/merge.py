"""Merge the two research passes (GPT-6 Luna and Sonnet, same chunks) into data/research.json.

A capability is kept only when no pass contradicts it: agreement keeps it,
one pass finding it while the other found nothing keeps it (flagged
"one source"), a true/false conflict drops it to unknown and is listed so a
scout can settle it in the pits.

People's names (mostly minors) and email addresses are not scouting data:
notes that are rosters, or that carry an email, are dropped.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
CAPS = ["shooter", "intake", "climb", "partnerClimb"]
ROSTER = re.compile(r"\b(roster|students?|members?|mentors?|captain|coach(es)?|led by|named)\b\s*[:(]", re.I)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
ROLE_NAME = re.compile(r"\b(captain|mentors?|lead|members?|students?|coach|programmer|driver|engineer|founder|director|vice-captain)\b[^.;]{0,40}?\b[A-Z][a-z]{2,}", re.I)
PAIR = re.compile(r"\b([A-Z][a-z]{2,}) and ([A-Z][a-z]{2,})\b")
# Country names of the "X and Y" shape are not people.
COUNTRY_PAIRS = {("Antigua", "Barbuda"), ("Trinidad", "Tobago"), ("Bosnia", "Herzegovina"), ("Kitts", "Nevis"), ("Vincent", "Grenadines"), ("Tome", "Principe")}


def array_in(text: str):
    m = re.search(r"\[\s*\{.*\}\s*\]", text, flags=re.S)
    return json.loads(m.group(0)) if m else None


def sonnet_answers(paths: list[Path]) -> dict[int, list]:
    """Each Sonnet transcript is JSONL; its answer is the last assistant text block."""
    out = {}
    for p in paths:
        last = None
        chunk = None
        for line in p.read_text().splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = rec.get("message") or {}
            content = msg.get("content")
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            for c in content or []:
                if c.get("type") == "text":
                    if msg.get("role") == "user" and chunk is None:
                        m = re.search(r"chunks/(\d+)\.json", c["text"])
                        if m:
                            chunk = int(m.group(1))
                    if msg.get("role") == "assistant":
                        last = c["text"]
        if chunk is not None and last:
            arr = array_in(last)
            if arr is not None:
                out[chunk] = arr
    return out


def clean_notes(notes):
    keep = []
    for n in notes or []:
        if EMAIL.search(n) or ROSTER.search(n):
            continue
        if any(p not in COUNTRY_PAIRS for p in PAIR.findall(n)):
            continue
        if ROLE_NAME.search(n) and re.search(r"\b[A-Z][a-z]+ [A-Z][a-z]+\b|\b(Mr|Ms|Dr)\.? [A-Z]", n):
            continue
        # "A, B, C, D" lists of capitalised words are rosters even without a label.
        if n.count(",") >= 3 and len(re.findall(r"\b[A-ZČĆŠŽĐ][a-zčćšžđ]+ [A-ZČĆŠŽĐ][a-zčćšžđ]+", n)) >= 3:
            continue
        keep.append(n)
    return keep


def merge_team(a: dict | None, b: dict | None):
    """a = Luna, b = Sonnet."""
    passes = [x for x in (a, b) if x]
    robot, notes_flag = {}, []
    for k in CAPS:
        va = (a or {}).get("robot", {}).get(k)
        vb = (b or {}).get("robot", {}).get(k)
        if va is not None and vb is not None and va != vb:
            robot[k] = None
            notes_flag.append(f"{k}: sources disagree, check in the pits")
        else:
            robot[k] = va if va is not None else vb
    zone = (b or {}).get("robot", {}).get("climbZone") or (a or {}).get("robot", {}).get("climbZone")
    drive = (b or {}).get("robot", {}).get("drivetrain") or (a or {}).get("robot", {}).get("drivetrain")
    found = {name: any((x or {}).get("robot", {}).get(k) is not None for k in CAPS) for name, x in (("Luna", a), ("Sonnet", b))}
    if notes_flag:
        agreement = "conflict"
    elif found["Luna"] and found["Sonnet"]:
        agreement = "Luna and Sonnet agree"
    elif found["Luna"] or found["Sonnet"]:
        agreement = f"one source ({'Luna' if found['Luna'] else 'Sonnet'})"
    else:
        agreement = "no robot details found"
    notes, seen = [], set()
    for x in passes:
        for n in clean_notes(x.get("notes")):
            key = re.sub(r"\W+", "", n.lower())[:60]
            if key not in seen:
                seen.add(key)
                notes.append(n)
    sources, urls = [], set()
    for x in passes:
        for s in x.get("sources") or []:
            if s.get("url") and s["url"] not in urls:
                urls.add(s["url"])
                sources.append({"url": s["url"], "what": EMAIL.sub("[email]", s.get("what", "")), "label": s.get("label", "REPORTED")})
    exp = next((x.get("experience") for x in (b, a) if x and x.get("experience")), None)
    order = ["none", "low", "medium", "high"]
    conf = max((x.get("confidence") or "none" for x in passes), key=lambda c: order.index(c) if c in order else 0)
    return {
        "robot": {**robot, "climbZone": zone, "drivetrain": drive},
        "notes": notes_flag + notes[:8],
        "experience": EMAIL.sub("[email]", exp) if exp else None,
        "sources": sources,
        "confidence": conf,
        "agreement": agreement,
    }


def main(argv: list[str]) -> int:
    luna = {}
    for i in range(10):
        f = OUT / f"luna-{i}.txt"
        if f.exists():
            arr = array_in(f.read_text())
            if arr is not None:
                luna[i] = arr
    sonnet = sonnet_answers([Path(p) for p in argv[1:]])
    teams = {}
    stats = {"agree": 0, "one source": 0, "conflict": 0, "none": 0}
    for i in range(10):
        chunk = json.loads((ROOT / "chunks" / f"{i}.json").read_text())
        la = {x["code"]: x for x in luna.get(i, [])}
        sb = {x["code"]: x for x in sonnet.get(i, [])}
        for t in chunk:
            m = merge_team(la.get(t["code"]), sb.get(t["code"]))
            teams[t["code"]] = m
            a = m["agreement"]
            stats["agree" if "agree" in a else "one source" if a.startswith("one") else "conflict" if a == "conflict" else "none"] += 1
    overrides = json.loads((ROOT / "overrides.json").read_text())
    for code, o in overrides.items():
        if code.startswith("_") or code not in teams:
            continue
        teams[code]["robot"].update(o.get("robot", {}))
        if o.get("checked"):
            teams[code]["checked"] = o["checked"]
    (ROOT.parent / "data" / "research.json").write_text(json.dumps({"teams": teams}, indent=1, ensure_ascii=False))
    print(json.dumps({"luna_chunks": sorted(luna), "sonnet_chunks": sorted(sonnet), "teams": len(teams), **stats}), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
