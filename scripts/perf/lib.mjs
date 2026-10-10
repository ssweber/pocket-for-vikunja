// What the measuring scripts share: the profiles, the proxy, a browser signed in to the measuring Vikunja (up.mjs),
// what a page is asked while it's measured, and a trace of its main thread. Not a script itself.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..', '..'), OUT = join(ROOT, 'test-results', 'perf');
export const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
// fast: the computer as it is. phone: CPU 4 times slower, 100 ms round trips, 5 Mbps, behind nginx (gzip, and the
// plugin's compressed page passed on). phone-raw: the same without compression. weak: CPU 4x, 300 ms, 1 Mbps.
export const PROFILES = {
  fast: { cpu: 1, proxy: [] },
  phone: { cpu: 4, proxy: ['--gzip', '--pass-encoding', '--rtt', '100', '--kbps', '5000'] },
  'phone-raw': { cpu: 4, proxy: ['--rtt', '100', '--kbps', '5000'] },
  weak: { cpu: 4, proxy: ['--gzip', '--pass-encoding', '--rtt', '300', '--kbps', '1000'] },
};
export const readState = () => JSON.parse(readFileSync(join(OUT, 'state.json'), 'utf8'));
export const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const sorted = a => [...a].sort((x, y) => x - y);
export const median = a => { const s = sorted(a.filter(x => x != null)); return s.length ? s[Math.floor(s.length / 2)] : null; };
// "12 (10–15)": the median of the runs, and the least and the most.
export const spread = (a, digits = 0) => {
  const s = sorted(a.filter(x => x != null)), f = x => x.toFixed(digits);
  return !s.length ? '' : s.length === 1 ? f(s[0]) : `${f(median(s))} (${f(s[0])}–${f(s.at(-1))})`;
};

const PX = 'http://127.0.0.1:3471';
export const APP = PX + '/api/v1/plugins/pocket/';
// proxy.mjs between the browser and Vikunja, as a profile's network.
export async function proxyUp(profile){
  const proxy = spawn(process.execPath, [join(HERE, 'proxy.mjs'), '--port', '3471', ...profile.proxy], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(ok => proxy.stdout.once('data', ok));
  return { stop: () => proxy.kill(), stats: async () => (await fetch(PX + '/__stats')).json(), reset: () => fetch(PX + '/__reset') };
}
// Vikunja asked straight, as user perf: to put back what a measurement changed.
export async function vikunja(method, path, body){
  const state = readState();
  const r = await fetch(state.base + '/api/v2' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: body && JSON.stringify(body) });
  if (!r.ok && r.status !== 304) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 || r.status === 304 ? null : r.json();
}

/* What a measured page has from its start, as window.__pf: nothing here changes what Pocket does, and nothing runs
   until it's asked, so a page left alone is as idle as Pocket is.
     app(), raw(): the component as Alpine watches it, and as it is (to count what's read off it: counted()).
     painted(): resolves once what's in the page now has been drawn (the next frame, and the turn after it).
     when(test, root, opts): resolves {at, drawn} when test() first holds, looked at as `root` changes: when it held,
       and when that was drawn.
     ev: every pointer, touch and key event's time as the page got it ({t: the event's own time, now: when its
       listener ran}), by type, since clear().
     record(sel): the element watched frame by frame, [time, how far aside it is, whether its gap is drawn], until the
       function it returns is called, which gives the frames.
     long: each task of the main thread's that took 50 ms or more, [{at, ms}], as the browser reports them.
     counted(names): each method or getter of the component named, counted from now: {name: {n, ms}} from the function
       it returns (ms: the time inside it, others it calls included, to the browser's 0.1 ms).
     ticks: when a run's screen's clock last moved, each second, with what count() says then (clock(count)). */
export function inPage(){
  const P = window.__pf = { ev: {}, ticks: [] };
  P.app = () => window.Alpine.$data(document.body);
  P.raw = () => window.Alpine.raw(document.body._x_dataStack[0]);
  P.painted = () => new Promise(ok => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => ok(performance.now()); c.port2.postMessage(0); }));
  P.when = (test, root = document.body, opts = { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }) => new Promise(ok => {
    const look = () => { if (!test()) return false; const at = performance.now(); mo.disconnect(); P.painted().then(drawn => ok({ at, drawn })); return true; };
    const mo = new MutationObserver(look);
    if (!look()) mo.observe(root, opts);
  });
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'keydown', 'click', 'scroll'])
    addEventListener(type, e => { (P.ev[type] ||= []).push({ t: e.timeStamp, now: performance.now() }); }, { capture: true, passive: true });
  P.clear = () => { P.ev = {}; };
  P.long = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.long.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask' }); } catch {}
  P.record = sel => {
    const el = document.querySelector(sel), F = []; let on = true;
    (function look(){
      if (!on) return;
      const gap = el.querySelector(':scope > .del-gap');
      F.push([performance.now(), el.isConnected ? new DOMMatrix(getComputedStyle(el).transform).m41 : null, gap && getComputedStyle(gap).display !== 'none' ? 1 : 0, scrollY]);
      requestAnimationFrame(look);
    })();
    return () => { on = false; return F; };
  };
  P.counted = names => {
    const raw = P.raw(), was = {}, C = {};
    for (const k of names) {
      const d = Object.getOwnPropertyDescriptor(raw, k); if (!d) continue;
      was[k] = d; C[k] = { n: 0, ms: 0 };
      const wrap = fn => function(...a){ C[k].n++; const t = performance.now(); try { return fn.apply(this, a); } finally { C[k].ms += performance.now() - t; } };
      Object.defineProperty(raw, k, d.get ? { ...d, get: wrap(d.get) } : { ...d, value: wrap(d.value) });
    }
    const stop = () => { for (const k in was) Object.defineProperty(raw, k, was[k]); return C; };
    stop.now = C;                                      // the counts so far
    return stop;
  };
  P.clock = count => window.Alpine.effect(() => { void P.app().clock; P.ticks.push({ t: performance.now(), n: count ? count() : 0 }); });
}

/* Alpine as Pocket's own copy of it (src/vendor/, as at the commit being served), with one line more: each time a
   binding is worked out, window.__fx(el, 'its attribute') is told. For counting only (rows-bench.mjs counts): the file
   is the readable one, not the minified one Pocket ships, so nothing is timed with it. */
export function countingAlpine(file, sha){
  const path = 'src/vendor/' + file.replace(/-pocket\.\d+\.min\.js$/, '.js');
  const src = sha ? spawnSync('git', ['-C', ROOT, 'show', `${sha}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout : readFileSync(join(ROOT, path), 'utf8');
  // Where a directive is handed what it works with (getDirectiveHandler): the one place every binding's effect is made.
  const at = /(let handler4 = directiveHandlers\[directive2\.type\] \|\| noop;\s*let \[utilities, cleanup\] = getElementBoundUtilities\(el\);)/;
  if (!src || src.split(at).length !== 3) throw new Error('Alpine has changed: no one place to count from in ' + path);
  return src.replace(at, '$1 if (window.__fx) { const fx0 = utilities.effect; utilities.effect = (cb, o) => fx0(() => { window.__fx(el, directive2.original); return cb(); }, o); }');
}
/* What counts them, in the page: __fx.read() gives, since __fx.reset(), how many bindings were worked out (`runs`), on
   how many rows (`rows`: a row, or a card's header, by its task's id), the most on one row (`most`), how many rows
   had their own class worked out and how often at most (`cls`, `clsMost`), and the count by attribute (`by`). */
export function inPageCounts(){
  let all = 0, rows = new Map(), cls = new Map(), by = {};
  const fx = window.__fx = (el, name) => {
    all++; by[name] = (by[name] || 0) + 1;
    const row = el.closest?.('.row, .day-card');
    if (!row) return;
    const id = (row.matches('.row') ? 'r' : 'c') + row.dataset.id;
    rows.set(id, (rows.get(id) || 0) + 1);
    if (el === row && name === ':class') cls.set(id, (cls.get(id) || 0) + 1);
  };
  fx.reset = () => { all = 0; rows = new Map(); cls = new Map(); by = {}; };
  fx.read = () => ({ runs: all, rows: rows.size, most: Math.max(0, ...rows.values()), inRows: [...rows.values()].reduce((a, b) => a + b, 0), cls: cls.size, clsMost: Math.max(0, ...cls.values()),
    clsRuns: [...cls.values()].reduce((a, b) => a + b, 0), by: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8)) });
}

/* A browser as a phone, signed in as perf through the proxy. page(hash) opens Pocket there in a new page, the CPU
   slowed as the profile says: {page, cdp}. Its service worker is off, so each page is the one Vikunja serves now.
   `counting`: with countingAlpine in the place of Pocket's own. */
export async function phone(profile, { counting = false } = {}){
  const state = readState();
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.addInitScript(inPage);
  if (counting) {
    await ctx.addInitScript(inPageCounts);
    await ctx.route(/\/alpine-[^/]*\.min\.js$/, (route, req) => route.fulfill({ contentType: 'text/javascript', body: countingAlpine(req.url().split('/').pop(), state.pocket) }));
  }
  let first = true;
  async function page(hash){
    const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
    await page.goto(APP + hash);
    if (first) {
      first = false;
      await page.locator('#auth-step').waitFor();
      const tab = page.getByRole('button', { name: 'API token', exact: true });
      if (await tab.isVisible()) await tab.click();
      await page.getByLabel('API token').fill(state.token);
      await page.getByRole('button', { name: 'Connect' }).click();
    }
    await page.locator('#app').waitFor();
    return { page, cdp };
  }
  return { browser, ctx, page, state, close: () => browser.close() };
}
// Until the screen is loaded from Vikunja and every row is drawn, asked a few times a second (so not while timing).
export const loaded = (page, timeout = 900000) => page.waitForFunction(() => { const v = document.getElementById('view'); return v && v.getAttribute('aria-busy') !== 'true' && !v.querySelector('.loading'); }, null, { timeout, polling: 200 });

/* The page's main thread while fn() runs: {out: what fn gave, tasks: [{at, ms}] (each thing the main thread did, when
   it started, in the page's own time, performance.now(), and how long it took), sum(a, b) and longest(a, b) of those
   that started between two of the page's times, events: the whole trace, at(ts): a trace time as the page's}.
   `more`: other things to trace; `timeline` false leaves the main thread's tasks out (tasks is then empty), for a
   trace kept going while a long list draws, which would be too big. */
export async function traced(browser, page, fn, more = [], timeline = true){
  await browser.startTracing(page, { categories: [...timeline ? ['disabled-by-default-devtools.timeline', 'devtools.timeline'] : [], 'blink.user_timing', ...more] });
  let out, events, ref;
  try {
    ref = await page.evaluate(() => performance.mark('pf:ref').startTime);
    out = await fn();
  } finally { events = JSON.parse((await browser.stopTracing()).toString()).traceEvents; }
  const m = events.find(e => e.name === 'pf:ref');
  if (!m) throw new Error('the trace has no mark from the page');
  const at = ts => (ts - m.ts) / 1000 + ref;
  const main = events.filter(e => e.pid === m.pid && e.tid === m.tid && e.ph === 'X');
  const tasks = main.filter(e => e.name === 'RunTask').map(e => ({ at: at(e.ts), ms: e.dur / 1000 })).sort((a, b) => a.at - b.at);
  const within = (a, b) => tasks.filter(t => t.at >= a && t.at < b);
  // Working out styles and laying the page out, of that: the rest is mostly script.
  const layout = (a, b) => main.filter(e => (e.name === 'UpdateLayoutTree' || e.name === 'Layout') && at(e.ts) >= a && at(e.ts) < b).reduce((s, e) => s + e.dur / 1000, 0);
  return { out, tasks, events, at, layout, sum: (a, b) => within(a, b).reduce((s, t) => s + t.ms, 0), longest: (a, b) => Math.max(0, ...within(a, b).map(t => t.ms)) };
}
