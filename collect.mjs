// Beit Al Watan Phase 11 collector.
// Runs on GitHub Actions. Reads public pages only (NUCA: Home, Cities, ViewCity,
// ViewProject, ViewZone; Madinty public API) and writes data/*.json for the page.
// It never submits reservations, never logs in, never opens Admin pages.
import { JSDOM } from 'jsdom';
import fs from 'node:fs/promises';

const NUCA = 'https://lands.nuca.gov.eg';
const API = 'https://madinty.test-domain-devunity.com/api/v1/';
const MY = 26733, PER_DAY = 300;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ONLY = (process.env.ONLY || '').toLowerCase(); // '', 'madinty', 'nuca'
const FORCE_SUMMARY = process.env.SUMMARY === '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jNow = () => new Date(Date.now() + 3 * 3600e3);              // Jeddah / Cairo (UTC+3)
const jDate = (off = 0) => new Date(jNow().getTime() + off * 864e5).toISOString().slice(0, 10);
const jTs = () => jNow().toISOString().slice(0, 16);              // YYYY-MM-DDTHH:MM
const NORM = s => String(s || '').normalize('NFC').replace(/ٔ/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[\s\-()_.]+/g, '');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } };
const writeJson = (p, v) => fs.writeFile(p, JSON.stringify(v));

// ---------- HTTP with retries and a per-host cookie jar ----------
const jars = {};
async function req(url, opt = {}, tries = 4) {
  const host = new URL(url).host, jar = jars[host] || (jars[host] = new Map());
  for (let i = 1; ; i++) {
    try {
      const h = { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', ...(opt.headers || {}) };
      if (jar.size) h.Cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
      const r = await fetch(url, { ...opt, headers: h, signal: AbortSignal.timeout(60000) });
      for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0], j = kv.indexOf('='); if (j > 0) jar.set(kv.slice(0, j).trim(), kv.slice(j + 1)) }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return r;
    } catch (e) { if (i >= tries) throw e; log('retry', i, String(e.message || e).slice(0, 120)); await sleep(3000 * i) }
  }
}
const parse = html => new JSDOM(html).window.document;

// ---------- Madinty ----------
const MH = { headers: { Accept: 'application/json', 'Accept-Language': 'ar', Origin: 'https://madintyegy.com', Referer: 'https://madintyegy.com/' } };
const api = async u => (await (await req(API + u, MH)).json()).data;

async function madinty(prev, prevPlots) {
  const TODAY = jDate(), WK = jDate(-13);
  const zl = await api('land-zones?per_page=200');
  log('madinty zones', zl.length);
  const agg = {}, days = {}; let page = 1, last = 1, stop = false, stats = null;
  do {
    const d = await api('land-plots/live-reserved?per_page=100&page=' + page);
    last = d.pagination?.last_page || 1; stats = d.stats || stats;
    for (const p of d.plots || []) {
      if (p.reserved_date < WK) { stop = true; break }
      days[p.reserved_date] = (days[p.reserved_date] || 0) + 1;
      if (p.reserved_date < jDate(-6)) continue;
      const k = NORM(p.location?.name) + '|' + NORM(p.zone?.name), o = agg[k] || (agg[k] = { t: 0, w: 0 });
      o.w++; if (p.reserved_date === TODAY) o.t++;
    }
    page++;
  } while (!stop && page <= last && page < 200);

  // free plots per zone, grouped by location, in the compact string format the page reads
  const meta = {}; (prevPlots || []).forEach(d => (d.zones || []).forEach(z => meta[z.id] = { c: d.c, z: z.z, base: z.base }));
  const docs = {}, q = [...zl];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (q.length) {
      const z = q.shift(); let arr = [];
      if (z.available_plots > 0) {
        const j = await (await req(API + 'land-zones/' + z.id + '/plots?per_page=5000', MH)).json();
        arr = (Array.isArray(j.data) ? j.data : Object.values(j.data || {})).filter(p => p.status === 'available');
      }
      const loc = z.location?.id ?? 0, m = meta[z.id] || {};
      const doc = docs[loc] || (docs[loc] = { loc, c: m.c || z.location?.name || '', date: TODAY, ts: jTs(), zones: [] });
      const groups = {};
      for (const p of arr) {
        const ex = [+p.distinction_corner || 0, +p.distinction_garden || 0, +p.distinction_sea || 0];
        let s = `${p.plot_number}:${+p.area}:${+p.price_per_meter_usd}`;
        if (ex.some(Boolean)) s += ':' + ex.join('/'); else if (p.is_service_zone) s += ':0/0/0';
        if (p.is_service_zone) s += ':x';
        (groups[p.district?.name || ''] ||= []).push(s);
      }
      doc.zones.push({ id: z.id, z: m.z || z.name, base: m.base ?? z.base_price_per_meter_usd, s: Object.entries(groups).map(([d, l]) => '#' + d + '#' + l.join(',')).join('') });
    }
  }));
  const mplots = Object.values(docs).sort((a, b) => a.loc - b.loc);
  mplots.forEach(d => d.zones.sort((a, b) => a.id - b.id));

  // zone summary, keeping fields from the previous doc (down payments etc.)
  const m2 = JSON.parse(JSON.stringify(prev || { zones: [], days: {}, totals: { offered: 0, sold: 0 } }));
  const byKey = {}; zl.forEach(z => byKey[NORM(z.location?.name) + '|' + NORM(z.name)] = z);
  m2.zones.forEach(z => {
    const k = NORM(z.c) + '|' + NORM(z.z), a = byKey[k];
    if (a) { z.av = a.available_plots; z.res = a.reserved_plots; z.tot = a.total_plots ?? z.tot; delete byKey[k] }
    const g = agg[k] || { t: 0, w: 0 }; z.today = g.t; z.wk = g.w;
  });
  Object.entries(byKey).forEach(([k, a]) => {
    if (!(a.total_plots > 0)) return; const g = agg[k] || { t: 0, w: 0 };
    m2.zones.push({ c: a.location?.name || '', z: a.name, ppm: a.base_price_per_meter_usd, tot: a.total_plots, av: a.available_plots, res: a.reserved_plots, amin: a.area_min, amax: a.area_max, br: a.building_ratio, fl: a.floors_description || '', today: g.t, wk: g.w });
  });
  m2.days = Object.assign(m2.days || {}, days);
  const off = zl.reduce((s, z) => s + (+z.total_plots || 0), 0); if (off) m2.totals.offered = off;
  m2.totals.reserved = stats?.total_reserved_count ?? zl.reduce((s, z) => s + (+z.reserved_plots || 0), 0);
  m2.totals.available = zl.reduce((s, z) => s + (+z.available_plots || 0), 0);
  m2.date = TODAY; m2.ts = jTs(); m2.source = 'madintyegy.com (GitHub collector)';
  return { mad: m2, mplots, today: stats?.reserved_today_count };
}

// ---------- NUCA (public pages only) ----------
async function nucaServed() {
  const d = parse(await (await req(NUCA + '/ar/Home.aspx')).text());
  const lines = d.body.textContent.split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => /مسلسل/.test(s));
  let servedTo = null, nextNote = '';
  for (const l of lines) { const m = l.match(/حتى\s*مسلسل\s*(\d[\d,]*)/); if (m) { const n = +m[1].replace(/,/g, ''); if (servedTo == null || n > servedTo) servedTo = n } }
  if (servedTo == null) throw new Error('servedTo not found on NUCA Home');
  nextNote = lines.find(l => /الاستكمال/.test(l) && new RegExp('مسلسل\\s*' + (servedTo + 1) + '\\b').test(l)) || '';
  const nx = nextNote.match(/الموافق\s*([\d/]+).*?مسلسل\s*(\d+)\s*حتى\s*مسلسل\s*(\d+)/);
  if (nx) nextNote = `Next session ${nx[1]}, 11 AM: serials ${(+nx[2]).toLocaleString('en')}–${(+nx[3]).toLocaleString('en')}`;
  return { servedTo, nextNote };
}

async function nucaCount() {
  const idOf = a => ((a?.getAttribute('href') || '').match(/ID=(\d+)/) || [])[1];
  const get = async (u, body) => parse(await (await req(NUCA + u, body ? { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {})).text());
  const grid = d => [...d.querySelectorAll('table')].find(t => /القطعة/.test(t.rows[0]?.textContent || ''));
  const rowsOf = t => t ? [...t.rows].slice(1).filter(r => r.cells.length > 5).length : 0;
  const pagerOf = d => { const t = grid(d); return t ? [...t.querySelectorAll('a')].map(a => (a.getAttribute('href') || '').match(/__doPostBack\('([^']+)','Page\$(\d+)'\)/)).filter(Boolean) : [] };
  async function countZone(id) {
    const url = '/ar/ViewZone.aspx?ID=' + id; let d = await get(url); if (!grid(d)) return 0;
    const pl = pagerOf(d); if (!pl.length) return rowsOf(grid(d));
    let n = Math.max(...pl.map(m => +m[2])), target = pl[0][1], last = 1;
    for (let g = 0; g < 40; g++) {
      const f = new URLSearchParams(); d.querySelectorAll('input[type=hidden]').forEach(i => f.set(i.name, i.value));
      const rd = d.querySelector('input[type=radio][value=rdShowAvailable]'); if (rd) f.set(rd.name, 'rdShowAvailable');
      f.set('__EVENTTARGET', target); f.set('__EVENTARGUMENT', 'Page$' + n);
      d = await get(url, f); last = n;
      const more = pagerOf(d).map(m => +m[2]).filter(x => x > n); if (!more.length) break; n = Math.max(...more);
    }
    return (last - 1) * 20 + rowsOf(grid(d));
  }
  const home = await get('/ar/Cities.aspx');
  let cities = [...home.querySelectorAll('area')].map(a => [idOf(a), (a.getAttribute('title') || '').trim()]).filter(x => x[0]);
  if (!cities.length) {
    const r = await req(NUCA + '/ar/Cities.aspx/GetSiteCities', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{}' });
    cities = JSON.parse((await r.json()).d).map(o => [String(o.ID || o.Id || o.id), o.Name]);
  }
  log('nuca cities', cities.length);
  const zones = [];
  for (const [cid, c] of cities) {
    const dc = await get('/ar/ViewCity.aspx?ID=' + cid);
    const projs = [...dc.querySelectorAll('.prj')].map(p => ({ id: idOf(p.querySelector('a[href*="ViewProject"]')), t: (p.querySelector('span')?.textContent || '').trim() })).filter(p => p.id && /الحادية عشر/.test(p.t));
    const key = NORM(c.replace(/^ال/, '').split(' ')[0]).replace(/^ال/, '');
    for (const pr of projs) {
      let segs = pr.t.split(' - ').map(s => s.trim()); if (/الحادية عشر/.test(segs[0])) segs.shift();
      if (segs.length > 1 && NORM(segs.at(-1)).includes(key)) segs.pop();
      const dp = await get('/ar/ViewProject.aspx?ID=' + pr.id);
      for (const a of dp.querySelectorAll('a[href*="ViewZone"]')) {
        const zid = idOf(a), r = (a.closest('.zone-cont')?.textContent || a.textContent).replace(/التفاصيل/g, '').replace(/\s+/g, ' ').trim();
        zones.push({ c, p: segs.join(' - '), r, n: await countZone(zid), zid: +zid, pid: +pr.id });
      }
    }
    log('nuca city done', c, zones.length);
  }
  if (!zones.length) throw new Error('NUCA count returned no zones');
  return { zones, total: zones.reduce((a, z) => a + z.n, 0) };
}

// ---------- Telegram (optional) ----------
async function telegram(text) {
  const tok = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { log('telegram not configured; message was:\n' + text); return }
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
    log('telegram', r.status);
  } catch (e) { log('telegram failed', e.message) }
}

// ---------- main ----------
const fmt = n => Math.round(n).toLocaleString('en');
async function main() {
  await fs.mkdir('data', { recursive: true });
  const state = await readJson('data/state.json', {});
  const snaps = await readJson('data/snapshots.json', []);
  let mad = await readJson('data/madinty.json', null);
  let mplots = await readJson('data/mplots.json', []);
  const watch = await readJson('config/watch.json', []);
  const picks = await readJson('config/picks.json', []);
  const errors = [], alerts = [];
  const prevFree = {}; mplots.forEach(d => d.zones.forEach(z => prevFree[z.id] = z.s));

  // Madinty
  if (ONLY !== 'nuca') {
    try { const r = await madinty(mad, mplots); mad = r.mad; mplots = r.mplots; await writeJson('data/madinty.json', mad); await writeJson('data/mplots.json', mplots); log('madinty ok', mad.totals) }
    catch (e) { errors.push('Madinty: ' + (e.message || e)); log('madinty failed', e) }
  }

  // NUCA
  let snap = null;
  if (ONLY !== 'madinty') {
    const last = snaps.at(-1) || {};
    snap = { date: jDate(), ts: jTs(), servedTo: last.servedTo, nextNote: last.nextNote || '', note: '', total: last.total, zts: last.zts || last.ts, zones: last.zones || [] };
    try { Object.assign(snap, await nucaServed()) } catch (e) { errors.push('NUCA serials: ' + (e.message || e)); snap.note += 'Serials not read this run. ' }
    try { const c = await nucaCount(); snap.zones = c.zones; snap.total = c.total; snap.zts = snap.ts; snap.note += 'Counted from NUCA public plot pages.' }
    catch (e) { errors.push('NUCA count: ' + (e.message || e)); snap.note += `Count failed (${String(e.message || e).slice(0, 80)}); zones carried over from ${snap.zts}.` }
    // one snapshot per day: replace today's entry
    if (snaps.length && snaps.at(-1).date === snap.date) snaps[snaps.length - 1] = snap; else snaps.push(snap);
    await writeJson('data/snapshots.json', snaps);
  }

  // Analysis
  const served = (snaps.at(-1) || {}).servedTo || 0;
  const ds = Object.entries(mad?.days || {}).filter(([, n]) => n >= 50).sort((a, b) => a[0].localeCompare(b[0])).slice(-6);
  const rate = ds.length ? ds.reduce((a, x) => a + x[1], 0) / (ds.length * PER_DAY) : 0.46;
  const ahead = Math.max(0, MY - served);
  const free = mad?.totals?.available ?? 0;
  const freeAtTurn = free - ahead * rate;
  const nDays = Math.ceil(ahead / PER_DAY); let d = new Date(jDate() + 'T12:00:00Z'), k = 0;
  while (k < nDays) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() <= 4) k++ }
  const turnDate = d.toISOString().slice(0, 10);

  const freeSet = {}; mplots.forEach(doc => doc.zones.forEach(z => freeSet[z.id] = new Set(String(z.s).split(/[#,]/).map(x => x.split(':')[0]))));
  for (const p of picks) {               // {zoneId, plot, label}
    const s = freeSet[p.zoneId]; if (s && !s.has(String(p.plot)) && !(state.booked || []).includes(p.zoneId + '|' + p.plot)) {
      alerts.push(`Pick booked: ${p.label || ''} plot ${p.plot} (zone ${p.zoneId})`); (state.booked ||= []).push(p.zoneId + '|' + p.plot);
    }
  }
  for (const w of watch) {               // {c, z, th}
    const z = (mad?.zones || []).find(x => NORM(x.c) === NORM(w.c) && NORM(x.z) === NORM(w.z)); if (!z) continue;
    const proj = z.av - (z.wk || 0) / 1800 * ahead;
    if (z.av <= (w.th ?? 0) || proj <= 0) alerts.push(`Watched zone ${w.c} – ${w.z}: ${z.av} free` + (proj <= 0 ? ', projected to run out before your turn' : ''));
  }
  if (served >= 25000) alerts.push(`NUCA has reached serial ${fmt(served)} — your serial ${fmt(MY)} is close.`);

  // NUCA vs Madinty per city (noise: ≤1% or ≤10 plots)
  const diffs = [];
  if (snap && snap.zts === snap.ts && mad) {
    const nc = {}, mc = {}; snap.zones.forEach(z => nc[NORM(z.c)] = (nc[NORM(z.c)] || 0) + z.n); mad.zones.forEach(z => mc[NORM(z.c)] = (mc[NORM(z.c)] || 0) + (z.av || 0));
    for (const c of new Set([...Object.keys(nc), ...Object.keys(mc)])) { const a = nc[c] || 0, b = mc[c] || 0; if (Math.abs(a - b) > 10 && Math.abs(a - b) > 0.01 * Math.max(a, b)) diffs.push(`${c}: NUCA ${a} vs Madinty ${b}`) }
  }

  const city = {}; (mad?.zones || []).forEach(z => { const c = city[z.c] || (city[z.c] = { t: 0, w: 0 }); c.t += z.today || 0; c.w += z.wk || 0 });
  const top = key => Object.entries(city).sort((a, b) => b[1][key] - a[1][key]).slice(0, 3).map(([c, v]) => `${c} ${v[key]}`).join(', ');
  const todayN = mad?.days?.[jDate()] || 0, weekN = Object.values(city).reduce((a, v) => a + v.w, 0);
  const status = { ts: jTs(), served, rate, free, freeAtTurn: Math.round(freeAtTurn), turnDate, todayN, weekN, nucaFresh: !!(snap && snap.zts === snap.ts), nucaTotal: snap?.total, errors, alerts, diffs };
  await writeJson('data/status.json', status);

  // Notifications
  const hr = jNow().getUTCHours(), evening = FORCE_SUMMARY || (hr >= 20 && state.summaryDate !== jDate());
  const lines = [];
  if (alerts.length) lines.push('⚠️ ' + alerts.join('\n⚠️ '));
  if (errors.length) lines.push('❌ Run problem: ' + errors.join(' | '));
  if (diffs.length) lines.push('NUCA vs Madinty differ: ' + diffs.slice(0, 5).join('; '));
  if (evening) {
    lines.push(`Booked today ${todayN}, this week ${weekN}. Top today: ${top('t')}.`,
      `Free now: ${fmt(free)} (Madinty)` + (snap ? `, NUCA ${fmt(snap.total || 0)} (${status.nucaFresh ? 'fresh' : 'carried over from ' + snap.zts})` : '') + '.',
      `Expected free at your serial ${fmt(MY)}: ~${fmt(freeAtTurn)} (rate ${(rate * 100).toFixed(0)}%).`,
      `Called up to ${fmt(served)}. ${snap?.nextNote || ''} Your turn ≈ ${turnDate}.`);
    state.summaryDate = jDate();
  }
  if (lines.length) await telegram('Beit Al Watan\n' + lines.join('\n') + (process.env.PAGE_URL ? '\n' + process.env.PAGE_URL : ''));
  await writeJson('data/state.json', state);
  log('done', JSON.stringify({ served, free, errors }));
  if (errors.length === (ONLY ? 1 : 3)) process.exitCode = 1;   // everything failed
}
main().catch(e => { console.error(e); process.exit(1) });
