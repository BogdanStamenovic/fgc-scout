"""Past performance of every 2026 team, from the official results API.

Input:  research/results/<year>.json  (api.first.global/v1?excludeMatchDetails=true&year=Y)
        research/nations-2026.txt     (slugs from first.global/2026-nations/)
        research/country-codes.tsv    (name -> IOC code, REV 2026 naming page)
Output: data/history.json, and a backtest of the placement estimate on stdout.

The estimate is a recency-weighted mean of each year's rank percentile, shrunk
toward the middle for teams with little history. It is a screen, not a
forecast: the backtest below prints how well it would have predicted 2025.
"""
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
YEARS = [2017, 2018, 2019, 2022, 2023, 2024, 2025]
# Recency weights. Compared on three holdout seasons (predict 2023, 2024, 2025
# from the seasons before each) against flat and milder schemes:
#   recency  mean rho 0.232, predicted top-24 that finished top-24: 7.7 of 24
#   flat     mean rho 0.229, 7.0 of 24
#   mild     mean rho 0.227, 7.3 of 24
# All within noise; random picking would score about 3.2 of 24. History is a
# weak predictor (rho 0.03 for 2023, after the 2020-21 gap, to 0.38 for 2025).
WEIGHT = {2025: 1.0, 2024: 0.8, 2023: 0.6, 2022: 0.45, 2019: 0.25, 2018: 0.18, 2017: 0.12}
# Pseudo-weight of an "average team" prior, so a single lucky season does not
# put a newcomer at the top.
PRIOR_WEIGHT = 0.6
SKIPPED: dict[int, int] = {}  # ranking rows the API returned without a team


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"^team\s+", "", s)
    return re.sub(r"[^a-z]+", "", s)


# Slug spellings on first.global that differ from the REV naming table.
ALIASES = {"cookisland": "COK", "hongkong": "HKG", "laos": "LAO", "micronesia": "FSM",
           "moldova": "MDA", "syria": "SYR", "tanzania": "TAN"}


def load_codes() -> dict[str, str]:
    codes = dict(ALIASES)
    for line in (ROOT / "country-codes.tsv").read_text().splitlines():
        name, code = line.split("\t")
        codes[norm(name)] = code
    return codes


def season(year: int) -> dict[str, dict]:
    d = json.loads((ROOT / "results" / f"{year}.json").read_text())
    n = len(d["rankings"])
    out: dict[str, dict] = {}
    for r in d["rankings"]:
        if not r.get("team"):
            SKIPPED[year] = SKIPPED.get(year, 0) + 1
            continue
        code = r["team"]["country"]
        if not code.isalpha():  # continental / combined teams ("14" = Team Europe)
            continue
        out[code] = {
            "year": year,
            "rank": r["rank"],
            "of": n,
            "pct": round(1 - (r["rank"] - 1) / (n - 1), 4),
            "rankingScore": r["rankingScore"],
            "highestScore": r["highestScore"],
            "name": r["team"]["name"],
            "cc2": (r["team"].get("countryCode") or "").lower(),
            "playoffs": False,
            "finals": False,
            "awards": [],
        }
    for key, flag in (("round_robin", "playoffs"), ("finals", "finals")):
        for r in d.get(key, []):
            c = (r.get("team") or {}).get("country")
            if c in out:
                out[c][flag] = True
    by_cc2 = {v["cc2"]: k for k, v in out.items() if v["cc2"]}
    by_name = {norm(v["name"]): k for k, v in out.items()}
    for a in d.get("awards", []):
        winners = []
        for cls in ("gold", "silver", "bronze"):
            if a.get(cls):
                winners.append((a[cls], cls))
        winners += [(o, o.get("class", "")) for o in a.get("other") or []]
        for w, cls in winners:
            k = by_cc2.get((w.get("countryCode") or "").lower()) or by_name.get(norm(w.get("country") or ""))
            if k:
                out[k]["awards"].append(f"{a['name']}" + (f" ({cls})" if cls and cls not in a["name"].lower() else ""))
    return out


def estimate(rows: list[dict], upto: int | None = None) -> tuple[float, int]:
    used = [r for r in rows if upto is None or r["year"] < upto]
    w = sum(WEIGHT[r["year"]] for r in used)
    s = sum(WEIGHT[r["year"]] * (r["pct"] + (0.05 if r["playoffs"] else 0) + (0.05 if r["finals"] else 0)) for r in used)
    return (s + PRIOR_WEIGHT * 0.5) / (w + PRIOR_WEIGHT), len(used)


def spearman(a: list[float], b: list[float]) -> float:
    def ranks(x):
        order = sorted(range(len(x)), key=lambda i: x[i])
        r = [0.0] * len(x)
        for pos, i in enumerate(order):
            r[i] = pos
        return r
    ra, rb = ranks(a), ranks(b)
    n = len(a)
    ma, mb = sum(ra) / n, sum(rb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    return cov / math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))


def main() -> int:
    codes = load_codes()
    seasons = {y: season(y) for y in YEARS}
    teams = {}
    unmatched = []
    for slug in (ROOT / "nations-2026.txt").read_text().split():
        name = re.sub(r"-?2026$", "", slug).replace("-", " ")
        code = codes.get(norm(name))
        if not code:
            unmatched.append(slug)
            code = slug.upper()
        rows = [seasons[y][code] for y in YEARS if code in seasons[y]]
        est, n = estimate(rows)
        teams[code] = {
            "code": code,
            "name": (rows[-1]["name"] if rows else name.title()).replace("`", "’"),
            "page": f"https://first.global/2026-nations/{slug}/",
            "seasons": rows,
            "pastScore": round(est * 100, 1),
            "seasonsPlayed": n,
        }
    ordered = sorted(teams.values(), key=lambda t: -t["pastScore"])
    for i, t in enumerate(ordered, 1):
        t["predictedRank"] = i
        t["predictedOf"] = len(ordered)

    # Backtest: estimate 2025 from earlier seasons only, among teams that played 2025.
    played = [c for c in seasons[2025]]
    pred, actual, newcomers = [], [], 0
    for c in played:
        rows = [seasons[y][c] for y in YEARS if c in seasons[y]]
        e, n = estimate(rows, upto=2025)
        newcomers += n == 0
        pred.append(e)
        actual.append(seasons[2025][c]["pct"])
    rho = spearman(pred, actual)
    top = sorted(range(len(played)), key=lambda i: -pred[i])[:24]
    hit = sum(1 for i in top if actual[i] >= 1 - 23 / (len(played) - 1))
    backtest = {
        "predicting": 2025,
        "teams": len(played),
        "newcomers_without_history": newcomers,
        "spearman_rho": round(rho, 3),
        "predicted_top24_that_finished_top24": hit,
    }

    out = {"source": "https://api.first.global/v1?excludeMatchDetails=true&year=<Y>",
           "years": YEARS, "rows_without_team": SKIPPED, "backtest": backtest, "unmatched": unmatched,
           "teams": {t["code"]: t for t in ordered}}
    dest = ROOT.parent / "data" / "history.json"
    dest.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(json.dumps(backtest), file=sys.stderr)
    print(f"{len(teams)} teams, unmatched slugs: {unmatched}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
