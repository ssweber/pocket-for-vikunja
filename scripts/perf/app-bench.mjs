// Times Pocket in a browser against the measuring Vikunja (up.mjs), through proxy.mjs as a phone would reach it.
//   npm run perf -- [--profile fast] [--runs 3] [--label name]
// Profiles: fast (no slowing), phone (CPU 4 times slower, 100 ms round trips, 5 Mbps, behind nginx: gzip, and the
// plugin's compressed page passed on), phone-raw (the same without compression), weak (CPU 4x, 300 ms, 1 Mbps). Each
// run times four steps: opening Pocket on Today with its kept copy, and without it; Today -> Big; and Big's Done
// opened. Times are from the start of each step, in ms, the median of the runs: "rows" when the screen's first row is
// in the page, "fresh" when it's loaded from Vikunja and every row is drawn (no Loading, not busy). Results go to
// test-results/perf/results/<label>.json, with every run.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(HERE, '..', '..', 'test-results', 'perf');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PROFILES = {
  fast: { cpu: 1, proxy: [] },
  phone: { cpu: 4, proxy: ['--gzip', '--pass-encoding', '--rtt', '100', '--kbps', '5000'] },
  'phone-raw': { cpu: 4, proxy: ['--rtt', '100', '--kbps', '5000'] },
  weak: { cpu: 4, proxy: ['--gzip', '--pass-encoding', '--rtt', '300', '--kbps', '1000'] },
};
const NAME = arg('profile', 'fast'), PROFILE = PROFILES[NAME], RUNS = +arg('runs', 3);
if (!PROFILE) throw new Error('--profile ' + Object.keys(PROFILES).join(', '));
const state = JSON.parse(readFileSync(join(OUT, 'state.json'), 'utf8'));
const PX = 'http://127.0.0.1:3471', APP = PX + '/api/v1/plugins/pocket/';
const LABEL = arg('label', `${state.scale}-${NAME}`);

const proxy = spawn(process.execPath, [join(HERE, 'proxy.mjs'), '--port', '3471', ...PROFILE.proxy], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(ok => proxy.stdout.once('data', ok));
const stats = async () => (await fetch(PX + '/__stats')).json();
const reset = () => fetch(PX + '/__reset');

const dir = join(OUT, 'profile-' + NAME);
rmSync(dir, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(dir, { channel: process.env.BROWSER_CHANNEL || 'chrome', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => {
  const P = window.__perf = { t0: 0, sel: '.row', firstRow: null, fresh: null, long: 0 };
  P.start = (sel = '.row') => { P.t0 = performance.now(); P.sel = sel; P.firstRow = P.fresh = null; P.long = 0; };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.startTime >= P.t0) P.long += e.duration; }).observe({ type: 'longtask', buffered: true }); } catch {}
  const check = () => {
    const v = document.getElementById('view'); if (!v) return;
    const now = performance.now() - P.t0;
    if (P.firstRow == null && v.querySelector(P.sel)) P.firstRow = now;
    // (busy first: it's one attribute, where looking for .loading goes through the whole page, at each change while a screen is drawn a batch at a time)
    if (P.firstRow != null && P.fresh == null && v.getAttribute('aria-busy') !== 'true' && !v.querySelector('.loading')) P.fresh = now;
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy', 'class'] });
});

async function slowPage(){
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpu });
  return page;
}
async function settle(page, timeout = 900000){
  await page.waitForFunction(() => window.__perf?.fresh != null, null, { timeout, polling: 50 });
  return page.evaluate(() => ({ rows: Math.round(window.__perf.firstRow), fresh: Math.round(window.__perf.fresh), long: Math.round(window.__perf.long),
    shown: document.querySelectorAll('#view .row').length, nodes: document.getElementsByTagName('*').length }));
}
const quiet = ms => new Promise(r => setTimeout(r, ms));

// Sign in once, open Big once (so it's the project kept and preloaded), and let the background loads finish.
let page = await slowPage();
await page.goto(APP);
const tab = page.getByRole('button', { name: 'API token', exact: true });
await page.locator('#auth-step').waitFor();
if (await tab.isVisible()) await tab.click();
await page.getByLabel('API token').fill(state.token);
await page.getByRole('button', { name: 'Connect' }).click();
await page.locator('#app').waitFor();
await page.evaluate(() => window.__perf.start());
await settle(page);
await page.evaluate(id => { location.hash = '#/project/' + id; }, state.projects.big);
await page.evaluate(() => window.__perf.start('#view:has(#sec-done) .row'));
await settle(page);
await page.evaluate(() => { location.hash = '#/today'; });
await quiet(8000);                                              // preload (views.js) runs 2 s after a screen loads

const out = {};
const add = (k, v) => (out[k] ||= []).push(v);
for (let r = 0; r < RUNS; r++) {
  // 1. Opening Pocket, as on a phone after a while: service worker, kept copies, signed in.
  await page.close(); await reset();
  page = await slowPage();
  await page.goto(APP + '#/today', { waitUntil: 'commit' });
  const open = await settle(page);
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: Math.round(n.domContentLoadedEventEnd), page: Math.round(n.responseEnd) }; });
  add('open Today (kept copy)', { ...open, ...nav, ...(({ api, apiBytes }) => ({ api, apiKB: Math.round(apiBytes / 1024) }))(await stats()) });
  await quiet(6000);

  // 2. The same without the kept copy of Today: what a first open, or a phone whose copy didn't fit, waits for.
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pocket.saved.today')) localStorage.removeItem(k); });
  await page.close(); await reset();
  page = await slowPage();
  await page.goto(APP + '#/today', { waitUntil: 'commit' });
  add('open Today (no copy)', { ...await settle(page), ...(({ api, apiBytes }) => ({ api, apiKB: Math.round(apiBytes / 1024) }))(await stats()) });
  await quiet(6000);

  // 3. Today → Big, in the app (its kept copy first, then loaded).
  await reset();
  await page.evaluate(id => { window.__perf.start('#view:has(#sec-done) .row'); location.hash = '#/project/' + id; }, state.projects.big);
  add('Today → Big', { ...await settle(page), ...(({ api, apiBytes }) => ({ api, apiKB: Math.round(apiBytes / 1024) }))(await stats()) });

  // 4. Its Done section opened, then closed again (it stays as left, and would load with the project).
  await reset();
  await page.evaluate(() => { window.__perf.start('.done-sec ~ .list .row'); document.getElementById('sec-done').click(); });
  add('open Done', { ...await settle(page), ...(({ api, apiBytes }) => ({ api, apiKB: Math.round(apiBytes / 1024) }))(await stats()) });
  await page.evaluate(() => document.getElementById('sec-done').click());
  await page.evaluate(() => { location.hash = '#/today'; });
  await quiet(4000);
}
await ctx.close(); proxy.kill();

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const summary = Object.fromEntries(Object.entries(out).map(([k, runs]) => [k, Object.fromEntries(Object.keys(runs[0]).map(f => [f, median(runs.map(x => x[f]))]))]));
mkdirSync(join(OUT, 'results'), { recursive: true });
writeFileSync(join(OUT, 'results', LABEL + '.json'), JSON.stringify({ label: LABEL, profile: NAME, scale: state.scale, summary, runs: out }, null, 2));
console.log(`\n${LABEL}  (median of ${RUNS}; ms from the start of each step)`);
console.table(summary);
