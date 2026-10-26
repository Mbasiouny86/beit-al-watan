# Beit Al Watan Plot Watch

Live dashboard for Beit Al Watan Phase 11 (serial 26,733).

* `index.html` – the dashboard (GitHub Pages). It loads `data/*.json` and also reads Madinty live from your browser.
* `collect.mjs` – the collector. GitHub Actions runs it every hour on booking days (Sun–Thu, 11:17–21:17 Jeddah time).
  It reads public pages only (NUCA Home/Cities/ViewCity/ViewProject/ViewZone and the Madinty public API). It never reserves, never logs in.
* `config/watch.json` – watched zones, e.g. `[{"c":"العبور الجديدة","z":"الحى 24 -منطقة TJ","th":50}]`
* `config/picks.json` – your picks, e.g. `[{"zoneId":47,"plot":"185","label":"Obour TJ"}]`
* Telegram alerts (optional): add repository secrets `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID`.

Run it by hand: Actions → "Collect plot data" → Run workflow.
