// Times Pocket in a browser against the benchmark Vikunja (up.mjs), through proxy.mjs, the way a phone would reach it.
//   npm run perf -- [--profile fast] [--runs 3] [--label name]
// Profiles: fast (no slowing), phone (CPU 4 times slower, 100 ms round trips, 5 Mbps, behind nginx, so gzip, and the
// plugin's compressed page is passed on), phone-raw (the same without compression), weak (CPU 4x slower, 300 ms,
// 1 Mbps). Each run times four steps: opening Pocket on Today with its saved copy, opening Today without it, going
// from Today to Big, and opening Big's Done section. Times are milliseconds from the start of each step, and the
// result is the median of the runs. "rows" is when the screen's first row is in the page. "fresh" is when the screen
// has loaded from Vikunja and every row is drawn (no Loading text, not busy). Results go to
// test-results/perf/results/<label>.json, with every run.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { arg, HERE, OUT, PROFILES, signIn } from './lib.mjs';

const NAME = arg('profile', 'fast'),
  PROFILE = PROFILES[NAME],
  RUNS = +arg('runs', 3);
if (!PROFILE) throw new Error('--profile ' + Object.keys(PROFILES).join(', '));
const state = JSON.parse(readFileSync(join(OUT, 'state.json'), 'utf8'));
const PX = 'http://127.0.0.1:3471',
  APP = PX + '/api/v1/plugins/pocket/';
const LABEL = arg('label', `${state.scale}-${NAME}`);

const proxy = spawn(process.execPath, [join(HERE, 'proxy.mjs'), '--port', '3471', ...PROFILE.proxy], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise(ok => proxy.stdout.once('data', ok));
const stats = async () => (await fetch(PX + '/__stats')).json();
const reset = () => fetch(PX + '/__reset');

const dir = join(OUT, 'profile-' + NAME);
rmSync(dir, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(dir, {
  channel: process.env.BROWSER_CHANNEL || 'chrome',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await ctx.addInitScript(() => {
  const P = (window.__perf = { t0: 0, sel: '.row', firstRow: null, fresh: null, long: 0 });
  P.start = (sel = '.row') => {
    P.t0 = performance.now();
    P.sel = sel;
    P.firstRow = P.fresh = null;
    P.long = 0;
  };
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) if (e.startTime >= P.t0) P.long += e.duration;
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  const check = () => {
    const v = document.getElementById('view');
    if (!v) return;
    const now = performance.now() - P.t0;
    if (P.firstRow == null && v.querySelector(P.sel)) P.firstRow = now;
    // Check aria-busy first. It is one attribute, while searching for .loading scans the whole page on every change as a screen is drawn a batch at a time.
    if (P.firstRow != null && P.fresh == null && v.getAttribute('aria-busy') !== 'true' && !v.querySelector('.loading'))
      P.fresh = now;
  };
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-busy', 'class'],
  });
});

async function slowPage() {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpu });
  return page;
}
async function settle(page, timeout = 900000) {
  await page.waitForFunction(() => window.__perf?.fresh != null, null, { timeout, polling: 50 });
  return page.evaluate(() => ({
    rows: Math.round(window.__perf.firstRow),
    fresh: Math.round(window.__perf.fresh),
    long: Math.round(window.__perf.long),
    shown: document.querySelectorAll('#view .row').length,
    nodes: document.getElementsByTagName('*').length,
  }));
}
const quiet = ms => new Promise(r => setTimeout(r, ms));

// Sign in once and open Big once, so Pocket saves and preloads it, then let the background loads finish.
let page = await slowPage();
await page.goto(APP);
await page.locator('#auth-step').waitFor();
await signIn(page);
await page.locator('#app').waitFor();
await page.evaluate(() => window.__perf.start());
await settle(page);
await page.evaluate(id => {
  location.hash = '#/project/' + id;
}, state.projects.big);
await page.evaluate(() => window.__perf.start('#view:has(#sec-done) .row'));
await settle(page);
await page.evaluate(() => {
  location.hash = '#/today';
});
await quiet(8000); // views.js starts its preload 2 s after a screen loads

const out = {};
const add = (k, v) => (out[k] ||= []).push(v);
for (let r = 0; r < RUNS; r++) {
  // 1. Open Pocket as on a phone after some time away: the service worker is installed, copies are saved, the user is signed in.
  await page.close();
  await reset();
  page = await slowPage();
  await page.goto(APP + '#/today', { waitUntil: 'commit' });
  const open = await settle(page);
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return { dcl: Math.round(n.domContentLoadedEventEnd), page: Math.round(n.responseEnd) };
  });
  add('open Today (kept copy)', {
    ...open,
    ...nav,
    ...(({ api, apiBytes }) => ({ api, apiKB: Math.round(apiBytes / 1024) }))(await stats()),
  });
  await quiet(6000);

  // 2. Open it again without the saved copy of Today. This is the wait on a first open, or on a phone where the copy didn't fit.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('pocket.saved.today')) localStorage.removeItem(k);
  });
  await page.close();
  await reset();
  page = await slowPage();
  await page.goto(APP + '#/today', { waitUntil: 'commit' });
  add('open Today (no copy)', {
    ...(await settle(page)),
    ...(({ api, apiBytes }) => ({ api, apiKB: Math.round(apiBytes / 1024) }))(await stats()),
  });
  await quiet(6000);

  // 3. Go from Today to Big inside the app. Big shows its saved copy first, then loads.
  await reset();
  await page.evaluate(id => {
    window.__perf.start('#view:has(#sec-done) .row');
    location.hash = '#/project/' + id;
  }, state.projects.big);
  add('Today → Big', {
    ...(await settle(page)),
    ...(({ api, apiBytes }) => ({ api, apiKB: Math.round(apiBytes / 1024) }))(await stats()),
  });

  // 4. Open Big's Done section, then close it again. Pocket remembers an open section and would load it with the project.
  await reset();
  await page.evaluate(() => {
    window.__perf.start('.done-sec ~ .list .row');
    document.getElementById('sec-done').click();
  });
  add('open Done', {
    ...(await settle(page)),
    ...(({ api, apiBytes }) => ({ api, apiKB: Math.round(apiBytes / 1024) }))(await stats()),
  });
  await page.evaluate(() => document.getElementById('sec-done').click());
  await page.evaluate(() => {
    location.hash = '#/today';
  });
  await quiet(4000);
}
await ctx.close();
proxy.kill();

const median = a => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const summary = Object.fromEntries(
  Object.entries(out).map(([k, runs]) => [
    k,
    Object.fromEntries(Object.keys(runs[0]).map(f => [f, median(runs.map(x => x[f]))])),
  ]),
);
mkdirSync(join(OUT, 'results'), { recursive: true });
writeFileSync(
  join(OUT, 'results', LABEL + '.json'),
  JSON.stringify({ label: LABEL, profile: NAME, scale: state.scale, summary, runs: out }, null, 2),
);
console.log(`\n${LABEL}  (median of ${RUNS}; ms from the start of each step)`);
console.table(summary);
