# Beit Al Watan Plot Watch

Public dashboard: https://mbasiouny86.github.io/beit-al-watan/

- `index.html` — the dashboard. It reads `data/live.json`, then tops up from the Madinty API live in the visitor's browser every 10 minutes.
- `.github/workflows/refresh.yml` — runs every 2 hours (and on demand via *Actions → Refresh plot data → Run workflow*). It opens the public NUCA pages read-only (no sign-in, no forms), pulls Madinty + NUCA serial news + per-zone free counts, and commits `data/live.json`.
- `scripts/collect.mjs` (collector), `scripts/build.py` (turns raw data into `data/live.json`).
