# fgc-scout

A phone app (PWA) and a small server for team Serbia's scouting at the FIRST Global Challenge 2026 in Incheon (7–10 Oct). Scouts record what each robot can do, its weight and size, whether there is room for our hooks, and photos. The server pulls the official match schedule, then ranks which teams to measure next: upcoming partners first, then opponents, then strong teams.

## How it works

| Part | What it does |
|---|---|
| `web/` | The app: plain JS, no build step. A service worker caches the shell. Every save goes to an IndexedDB outbox and is replayed until the server confirms, so scouting works with no Wi-Fi. |
| `server/server.mjs` | Node ≥ 22.5, zero dependencies, `node:sqlite`. Stores entries and photos. Polls `api.first.global` every 2 min for the 2026 schedule and rankings. One shared team key; the login sets an HttpOnly cookie. |
| `server/logic.mjs` | Field-level merge of entries (a later entry never erases an earlier answer with a blank), our match list, the priority score. |
| `research/history.py` | Past-performance score for every 2026 team from official results 2017–19 and 2022–25, with a backtest. |
| `research/merge.py` | Merges two independent research passes (GPT-6 Luna and Sonnet, same team chunks) into `data/research.json`, plus hand-checked overrides. |

**Priority** = share of fields still unmeasured × importance.
- Importance = 1 + 3·strength, plus 5 + 5·relation for any team in one of our upcoming matches.
- So every upcoming partner or opponent outranks every other team.
- Partners count fully and opponents at 0.7: a partner's weight and hook space decide whether a partner climb is possible.
- Relation decays as 1, 1/2, 1/3… over our upcoming matches.
- Strength is the past-performance score, blended into the live 2026 rank over a team's first six matches.

**Why a PWA and not a sideloaded app.** Android sideloading is easy; iOS is not. A native iOS install needs a $99/yr Apple developer account, or a Mac re-signing the app every 7 days for each phone. A PWA installs from Safari with "Add to Home Screen", runs offline, and uses the camera, at no cost. The same code can be wrapped with Capacitor if a store-style app is ever needed.

## Install

```bash
# on the server (Ubuntu, Node >= 22.5, Caddy)
sudo useradd --system --home /opt/fgc-scout fgcscout
sudo git clone https://github.com/BogdanStamenovic/fgc-scout /opt/fgc-scout/app
sudo mkdir -p /opt/fgc-scout/data && sudo chown fgcscout /opt/fgc-scout/data
python3 research/history.py   # locally; then copy data/history.json and data/research.json to /opt/fgc-scout/data
echo "SCOUT_KEY=$(openssl rand -hex 6)" | sudo tee /opt/fgc-scout/env && sudo chmod 600 /opt/fgc-scout/env
sudo cp deploy/fgc-scout.service /etc/systemd/system/ && sudo systemctl enable --now fgc-scout
sudo cp deploy/scout.caddy /etc/caddy/sites/ # and add `import sites/*.caddy` to the Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

## Usage

- Open the site, enter your name and the team key, then Add to Home Screen.
- **Measure next:** the ranked list, with what each team is still missing.
- **Teams:** every team, plus past seasons, research and everything scouted so far.
- **Our matches:** fills in by itself once FIRST Global publishes the schedule (after inspection, rule 6.3).
- Tests: `node --test server/logic.test.mjs`.

## Limitations

- **The placement estimate is weak.**
  - Backtested by predicting 2023, 2024 and 2025 from the seasons before each, it gives a mean Spearman ρ of 0.23 (0.03 for 2023, after the 2020–21 gap; 0.38 for 2025).
  - Of its predicted top 24, 7.7 on average actually finished top 24; random picking would hit about 3.2.
  - It is a screen for "probably strong", not a forecast.
- **Research is thin.** Before the event, public sources describe a robot for only 10 of 178 teams.
  - I checked those claims against the cited text: 7 held, 1 was only partial (Bangladesh's exhibition prototypes), 1 was refuted (Guam's "human shooter" is a person), and 1 source would not load.
  - GPT-6 Luna found none of the 10, so every robot fact in the app came from the Sonnet pass.
- **Red/blue** is read from station numbers (11–14 red, 21–24 blue). That is inferred from the 2025 data, not documented by FIRST Global.
- **The schedule** depends on `api.first.global` publishing 2026 matches, which it did in 2023–25. If it doesn't, "Our matches" stays empty and priority falls back to strength.
- **One shared key**, no per-person accounts. Anyone with the key can write, and entries are append-only (a mistake is fixed by entering the right value later).
- **Names are filtered out of research notes** (roster and email patterns), but the filter is pattern-based and can miss a name.
- **iOS** clears a PWA's storage if the app isn't opened for weeks. Irrelevant for a 4-day event; just don't leave unsynced entries on a phone afterwards.
