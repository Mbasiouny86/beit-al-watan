// Runs on GitHub Actions: opens the public NUCA site in headless Chromium (read-only, no sign-in),
// collects Madinty API + NUCA news + NUCA per-zone free counts, and writes raw.json for build.py.
import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-EG' });
let nucaOk = true;
try { await page.goto('https://lands.nuca.gov.eg/ar/Home.aspx', { waitUntil: 'domcontentloaded', timeout: 90000 }); }
catch (e) { nucaOk = false; console.log('NUCA unreachable:', String(e).slice(0, 200)); await page.goto('about:blank'); }

const out = await page.evaluate(async (nucaOk) => {
  const J = t => new Date(Date.parse(t) + 3 * 3600e3).toISOString().slice(0, 16);
  const now = J(new Date().toISOString()), cut = new Date(Date.now() + 3 * 3600e3 - 8 * 864e5).toISOString().slice(0, 10);
  // ---- NUCA per-zone free plots (public zone pages, paged via the grid's own postback) ----
  const NZ = {}, NB = {}, ZM = {}; let N0 = 0;
  if (nucaOk) try {
    const nq = [4813,3795,3586,3611,4812,4818,3798,3797,3791,4815,4810,3580,3783,3796,4814,3811,3799,4816,3585,3698,4809,3607,4823,3782,3612,3806,3613,4801,3583,3600,4822,3603,3699,3591,4811,3582,3780,3779,3805,3622,3802,4817,3800,3803,3804,3581,3584,3587,3588,3589,3590,3592,3593,3594,3596,3597,3598,3599,3604,3605,3606,3608,3609,3610,3614,3615,3621,3624,3625,3626,3627,3628,3629,3630,3631,3632,3633,3636,3637,3638,3640,3781,3789,3790,3792,3793,3801,3807,3808,3809,3810,3812,4796,4797,4798,4799,4800,4802,4803,4804,4805,4806,4807,4808,4819,4820,4821,4824];
    const P = new DOMParser(), get = async u => P.parseFromString(await (await fetch(u)).text(), 'text/html');
    const nScan = async id => {
      let doc = await get('/ar/ViewZone.aspx?ID=' + id); const M = new Map();
      const grab = d => { const t = d.querySelector('[id$=grdPlots]'); let nw = 0; if (!t) return 0;
        t.querySelectorAll('tr').forEach(tr => { const td = tr.querySelectorAll('td'); if (td.length >= 10) { const k = td[0].textContent.trim() + '|' + td[1].textContent.trim(); if (!M.has(k)) { M.set(k, /حجز/.test(td[td.length - 1].textContent) ? 1 : 0); nw++ } } }); return nw };
      grab(doc);
      for (let p = 2; p < 500; p++) {
        const fd = new URLSearchParams(); doc.querySelectorAll('input[type=hidden]').forEach(i => fd.append(i.name, i.value));
        fd.set('__EVENTTARGET', 'ctl00$MainContent$grdPlots'); fd.set('__EVENTARGUMENT', 'Page$' + p);
        fd.append('ctl00$MainContent$PlotType', 'rdShowAvailable'); fd.append('ctl00$MainContent$txtPlotNumber', '');
        const d2 = P.parseFromString(await (await fetch('/ar/ViewZone.aspx?ID=' + id, { method: 'POST', body: fd })).text(), 'text/html');
        if (!grab(d2)) break; doc = d2 }
      NZ[id] = M.size; NB[id] = [...M.values()].filter(x => x).length };
    try {
      const cities = [...new Map([...document.querySelectorAll('a[href*="ViewCity"]')].map(a => [a.href, a.textContent.trim()])).entries()];
      const projs = [];
      await Promise.all(cities.map(async ([u, c]) => { try { const d = await get(u); new Map([...d.querySelectorAll('a[href*="ViewProject"]')].map(a => [a.href, a.textContent.trim()])).forEach((t, h) => { const id = +new URL(h).searchParams.get('ID'); if (id >= 1230) projs.push([h, c, t]) }) } catch (e) {} }));
      await Promise.all(projs.map(async ([u, c, p]) => { try { const d = await get(u); d.querySelectorAll('a[href*="ViewZone"]').forEach(a => { const id = +new URL(a.getAttribute('href'), u).searchParams.get('ID'); if (id && !nq.includes(id)) { nq.push(id); ZM[id] = [c, p, a.textContent.trim()] } }) } catch (e) {} }));
    } catch (e) {}
    N0 = nq.length;
    await Promise.all(Array.from({ length: 6 }, async () => { while (nq.length) { const id = nq.shift(); try { await nScan(id) } catch (e) {} } }));
  } catch (e) {}
  // ---- Madinty public API ----
  const B = 'https://madinty.test-domain-devunity.com/api/v1/', H = { headers: { Accept: 'application/json', 'Accept-Language': 'ar' } };
  const g = async u => (await (await fetch(B + u, H)).json()).data;
  const zl = await g('land-zones?per_page=200');
  let page = 1, last = 1, stop = false, stats = null; const R = [];
  do { const d = await g('land-plots/live-reserved?per_page=100&page=' + page); last = d.pagination.last_page; stats = d.stats;
    for (const p of d.plots) { const jt = J(p.reserved_at); if (jt.slice(0, 10) < cut) { stop = true; break } R.push([jt, p.location?.name, p.zone?.name, p.zone?.id, String(p.plot_number), +p.area, +p.price_per_meter_usd]) } page++ } while (!stop && page <= last);
  const S = {}; const q = zl.filter(z => z.available_plots > 0);
  await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { const z = q.shift(); const d = await g('land-zones/' + z.id + '/plots?per_page=5000'); const A = Array.isArray(d) ? d : (d.plots || d.data || []);
    const by = {}; A.filter(p => p.status === 'available').forEach(p => { const k = p.district?.name || ''; (by[k] = by[k] || []).push(p.plot_number + ':' + (+p.area) + ':' + (+p.price_per_meter_usd) + ((p.distinction_corner || p.distinction_garden || p.distinction_sea) ? ':' + (+p.distinction_corner || 0) + '/' + (+p.distinction_garden || 0) + '/' + (+p.distinction_sea || 0) : (p.is_service_zone ? ':' : '')) + (p.is_service_zone ? ':x' : '')) });
    S[z.id] = Object.entries(by).map(([k, v]) => '#' + k + '#' + v.join(',')).join('') } }));
  // ---- NUCA news (serial schedule) ----
  let news = [];
  if (nucaOk) try { const h = await (await fetch('https://lands.nuca.gov.eg/ar/NewsList.aspx')).text(); const doc = new DOMParser().parseFromString(h, 'text/html'); doc.querySelectorAll('script,style').forEach(e => e.remove()); const t = doc.body.textContent.replace(/[ \t]+/g, ' '); const i = t.indexOf('قائمة الأخبار'); news = t.slice(i, i + 3000).split('\n').map(x => x.trim()).filter(Boolean).slice(0, 40) } catch (e) { news = [] }
  const Z = zl.map(z => [z.id, z.land_location_id, z.location?.name, z.name, +z.base_price_per_meter_usd, +z.total_plots, +z.available_plots, +z.reserved_plots, +z.area_min, +z.area_max, +z.min_down_payment_usd, +z.max_down_payment_usd, +z.building_ratio, z.floors_description || '']);
  const okNZ = N0 && Object.keys(NZ).length >= 0.9 * N0;
  return { now, stats, R, Z, S, news, nz: okNZ ? NZ : null, nb: okNZ ? NB : null, nzN: N0 || null, nzts: okNZ ? now : null, nzm: ZM };
}, nucaOk);

await browser.close();
fs.writeFileSync('raw.json', JSON.stringify(out));
console.log(JSON.stringify({ now: out.now, reserved: out.stats?.total_reserved_count, today: out.stats?.reserved_today_count, zones: out.Z.length, nucaReachable: nucaOk, nucaZones: out.nz ? Object.keys(out.nz).length : 0, news: out.news.length }));
