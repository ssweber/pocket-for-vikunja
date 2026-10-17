// What the benchmark scripts share: the profiles, the proxy, a browser signed in to the benchmark Vikunja (up.mjs),
// the helpers injected into a page while it is measured, and a trace of the page's main thread. This file is a library,
// not a script.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const HERE = dirname(fileURLToPath(import.meta.url)),
  ROOT = join(HERE, '..', '..'),
  OUT = join(ROOT, 'test-results', 'perf');
export const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
// fast: this computer, unchanged. phone: CPU 4 times slower, 100 ms round trips, 5 Mbps, behind nginx (so gzip, and the
// plugin's compressed page is passed on). phone-raw: the same without compression. weak: CPU 4x slower, 300 ms, 1 Mbps.
export const PROFILES = {
  fast: { cpu: 1, proxy: [] },
  phone: { cpu: 4, proxy: ['--gzip', '--pass-encoding', '--rtt', '100', '--kbps', '5000'] },
  'phone-raw': { cpu: 4, proxy: ['--rtt', '100', '--kbps', '5000'] },
  weak: { cpu: 4, proxy: ['--gzip', '--pass-encoding', '--rtt', '300', '--kbps', '1000'] },
};
export const readState = () => JSON.parse(readFileSync(join(OUT, 'state.json'), 'utf8'));
export const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const sorted = a => [...a].sort((x, y) => x - y);
export const median = a => {
  const s = sorted(a.filter(x => x != null));
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
// Formats the runs as "12 (10–15)": the median, then the lowest and highest.
export const spread = (a, digits = 0) => {
  const s = sorted(a.filter(x => x != null)),
    f = x => x.toFixed(digits);
  return !s.length ? '' : s.length === 1 ? f(s[0]) : `${f(median(s))} (${f(s[0])}–${f(s.at(-1))})`;
};

const PX = 'http://127.0.0.1:3471';
export const APP = PX + '/api/v1/plugins/pocket/';
// Start proxy.mjs between the browser and Vikunja, set up as the profile's network.
export async function proxyUp(profile) {
  const proxy = spawn(process.execPath, [join(HERE, 'proxy.mjs'), '--port', '3471', ...profile.proxy], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise(ok => proxy.stdout.once('data', ok));
  return {
    stop: () => proxy.kill(),
    stats: async () => (await fetch(PX + '/__stats')).json(),
    reset: () => fetch(PX + '/__reset'),
  };
}
// Sign Pocket in as user perf, whom up.mjs creates.
export async function signIn(page) {
  await page.getByLabel('Username or email').fill('perf');
  await page.getByLabel('Password', { exact: true }).fill('perf-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
// Call Vikunja directly as user perf, to restore what a measurement changed.
export async function vikunja(method, path, body) {
  const state = readState();
  const r = await fetch(state.base + '/api/v2' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
    body: body && JSON.stringify(body),
  });
  if (!r.ok && r.status !== 304) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 || r.status === 304 ? null : r.json();
}

/* Helpers that every measured page has from its start, as window.__pf. They don't change what Pocket does, and they run
   only when called, so a page left alone is as idle as Pocket is.
     app(), raw(): the component as Alpine watches it, and the plain object underneath. Use raw() to count reads
       without Alpine's tracking (see counted()).
     painted(): resolves once what is in the page now has been drawn (after the next frame and the task after that).
     when(test, root, opts): watches `root` for changes and resolves {at, drawn} when test() first returns true. `at` is
       when it became true, and `drawn` is when that was drawn.
     ev: the time of every pointer, touch and key event, by type, since the last clear(). Each entry is {t: the event's
       own time, now: when the page's listener ran}.
     record(sel): watches the element frame by frame until the function it returns is called, which returns the frames.
       Each frame is [time, horizontal offset, whether its delete gap is displayed, scroll position].
     long: each main thread task that took 50 ms or more, as {at, ms}, as the browser reports them.
     counted(names): counts each named method or getter of the component from now on. The function it returns gives
       {name: {n, ms}}. n is the number of calls. ms is the time inside the call, including what it calls, to the
       browser's precision of 0.1 ms.
     ticks: {t, n} recorded each time the component's clock changes (every second), with n from count(). Set up by
       clock(count). */
export function inPage() {
  const P = (window.__pf = { ev: {}, ticks: [] });
  P.app = () => window.Alpine.$data(document.body);
  P.raw = () => window.Alpine.raw(document.body._x_dataStack[0]);
  P.painted = () =>
    new Promise(ok =>
      requestAnimationFrame(() => {
        const c = new MessageChannel();
        c.port1.onmessage = () => ok(performance.now());
        c.port2.postMessage(0);
      }),
    );
  P.when = (
    test,
    root = document.body,
    opts = { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] },
  ) =>
    new Promise(ok => {
      const look = () => {
        if (!test()) return false;
        const at = performance.now();
        mo.disconnect();
        P.painted().then(drawn => ok({ at, drawn }));
        return true;
      };
      const mo = new MutationObserver(look);
      if (!look()) mo.observe(root, opts);
    });
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'keydown', 'click', 'scroll'])
    addEventListener(
      type,
      e => {
        (P.ev[type] ||= []).push({ t: e.timeStamp, now: performance.now() });
      },
      { capture: true, passive: true },
    );
  P.clear = () => {
    P.ev = {};
  };
  P.long = [];
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) P.long.push({ at: e.startTime, ms: e.duration });
    }).observe({ type: 'longtask' });
  } catch {}
  P.record = sel => {
    const el = document.querySelector(sel),
      F = [];
    let on = true;
    (function look() {
      if (!on) return;
      const gap = el.querySelector(':scope > .del-gap');
      F.push([
        performance.now(),
        el.isConnected ? new DOMMatrix(getComputedStyle(el).transform).m41 : null,
        gap && getComputedStyle(gap).display !== 'none' ? 1 : 0,
        scrollY,
      ]);
      requestAnimationFrame(look);
    })();
    return () => {
      on = false;
      return F;
    };
  };
  P.counted = names => {
    const raw = P.raw(),
      was = {},
      C = {};
    for (const k of names) {
      const d = Object.getOwnPropertyDescriptor(raw, k);
      if (!d) continue;
      was[k] = d;
      C[k] = { n: 0, ms: 0 };
      const wrap = fn =>
        function (...a) {
          C[k].n++;
          const t = performance.now();
          try {
            return fn.apply(this, a);
          } finally {
            C[k].ms += performance.now() - t;
          }
        };
      Object.defineProperty(raw, k, d.get ? { ...d, get: wrap(d.get) } : { ...d, value: wrap(d.value) });
    }
    const stop = () => {
      for (const k in was) Object.defineProperty(raw, k, was[k]);
      return C;
    };
    stop.now = C; // the counts so far, readable before stop()
    return stop;
  };
  P.clock = count =>
    window.Alpine.effect(() => {
      void P.app().clock;
      P.ticks.push({ t: performance.now(), n: count ? count() : 0 });
    });
}

/* Returns Pocket's patched copy of Alpine from src/vendor/ (as of the commit being served, `sha`) with one line added.
   That line calls window.__fx(el, attribute) each time a binding is evaluated. It is only for counting (rows-bench.mjs
   counts). The file is the readable one, not the minified one Pocket ships, so don't time anything with it. */
export function countingAlpine(file, sha) {
  const path = 'src/vendor/' + file.replace(/-pocket\.\d+\.min\.js$/, '.js');
  const src = sha
    ? spawnSync('git', ['-C', ROOT, 'show', `${sha}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout
    : readFileSync(join(ROOT, path), 'utf8');
  // The place in getDirectiveHandler where a directive gets its utilities. Every binding's effect is created there, and nowhere else.
  const at =
    /(let handler4 = directiveHandlers\[directive2\.type\] \|\| noop;\s*let \[utilities, cleanup\] = getElementBoundUtilities\(el\);)/;
  if (!src || src.split(at).length !== 3) throw new Error('Alpine has changed: no one place to count from in ' + path);
  return src.replace(
    at,
    '$1 if (window.__fx) { const fx0 = utilities.effect; utilities.effect = (cb, o) => fx0(() => { window.__fx(el, directive2.original); return cb(); }, o); }',
  );
}
/* Counts bindings inside the page. Since the last __fx.reset(), __fx.read() returns: `runs`, how many bindings were
   evaluated. `rows`, how many rows they were on (a row, or a card's header, identified by its task id). `most`, the
   largest number on one row. `inRows`, the total on rows. `cls`, how many rows had their own class binding evaluated,
   `clsMost`, the most times for one row, and `clsRuns`, the total. `by`, the count per attribute (the top 8). */
export function inPageCounts() {
  let all = 0,
    rows = new Map(),
    cls = new Map(),
    by = {};
  const fx = (window.__fx = (el, name) => {
    all++;
    by[name] = (by[name] || 0) + 1;
    const row = el.closest?.('.row, .day-card');
    if (!row) return;
    const id = (row.matches('.row') ? 'r' : 'c') + row.dataset.id;
    rows.set(id, (rows.get(id) || 0) + 1);
    if (el === row && name === ':class') cls.set(id, (cls.get(id) || 0) + 1);
  });
  fx.reset = () => {
    all = 0;
    rows = new Map();
    cls = new Map();
    by = {};
  };
  fx.read = () => ({
    runs: all,
    rows: rows.size,
    most: Math.max(0, ...rows.values()),
    inRows: [...rows.values()].reduce((a, b) => a + b, 0),
    cls: cls.size,
    clsMost: Math.max(0, ...cls.values()),
    clsRuns: [...cls.values()].reduce((a, b) => a + b, 0),
    by: Object.fromEntries(
      Object.entries(by)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    ),
  });
}

/* Starts a browser that behaves as a phone, signed in as perf through the proxy. page(hash) opens Pocket at that hash
   in a new page, with the CPU slowed as the profile says, and returns {page, cdp}. The service worker is blocked, so
   each page is the one Vikunja serves now. `counting` replaces Pocket's Alpine with countingAlpine. */
export async function phone(profile, { counting = false } = {}) {
  const state = readState();
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  await ctx.addInitScript(inPage);
  if (counting) {
    await ctx.addInitScript(inPageCounts);
    await ctx.route(/\/alpine-[^/]*\.min\.js$/, (route, req) =>
      route.fulfill({ contentType: 'text/javascript', body: countingAlpine(req.url().split('/').pop(), state.pocket) }),
    );
  }
  let first = true;
  async function page(hash) {
    const page = await ctx.newPage(),
      cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
    await page.goto(APP + hash);
    if (first) {
      first = false;
      await page.locator('#auth-step').waitFor();
      await signIn(page);
    }
    await page.locator('#app').waitFor();
    return { page, cdp };
  }
  return { browser, ctx, page, state, close: () => browser.close() };
}
// Wait until the screen has loaded from Vikunja and every row is drawn. It polls a few times a second, so don't use it inside a timed section.
export const loaded = (page, timeout = 900000) =>
  page.waitForFunction(
    () => {
      const v = document.getElementById('view');
      return v && v.getAttribute('aria-busy') !== 'true' && !v.querySelector('.loading');
    },
    null,
    { timeout, polling: 200 },
  );

/* Traces the page's main thread while fn() runs. It returns:
     out: what fn returned.
     tasks: [{at, ms}], each task the main thread ran, with its start in the page's own time (performance.now()) and
       its duration.
     sum(a, b), longest(a, b): the total and longest duration of the tasks that started between two page times.
     sumOver(a, b), longestOver(a, b): the same for tasks that were running at any time between the two times.
     layout(a, b): the time spent on style calculation and layout between the two times.
     events: the whole trace.
     at(ts): converts a trace time to the page's time.
   `more` adds trace categories. `timeline` false leaves out the main thread's tasks (tasks is then empty). Use it for a
   trace kept running while a long list is drawn, which would otherwise be too big. */
export async function traced(browser, page, fn, more = [], timeline = true) {
  await browser.startTracing(page, {
    categories: [
      ...(timeline ? ['disabled-by-default-devtools.timeline', 'devtools.timeline'] : []),
      'blink.user_timing',
      ...more,
    ],
  });
  let out, events, ref;
  try {
    ref = await page.evaluate(() => performance.mark('pf:ref').startTime);
    out = await fn();
  } finally {
    events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  }
  const m = events.find(e => e.name === 'pf:ref');
  if (!m) throw new Error('the trace has no mark from the page');
  const at = ts => (ts - m.ts) / 1000 + ref;
  const main = events.filter(e => e.pid === m.pid && e.tid === m.tid && e.ph === 'X');
  const tasks = main
    .filter(e => e.name === 'RunTask')
    .map(e => ({ at: at(e.ts), ms: e.dur / 1000 }))
    .sort((a, b) => a.at - b.at);
  const within = (a, b) => tasks.filter(t => t.at >= a && t.at < b);
  // The part of the main thread's time spent on style calculation and layout. The rest is mostly script.
  const layout = (a, b) =>
    main
      .filter(e => (e.name === 'UpdateLayoutTree' || e.name === 'Layout') && at(e.ts) >= a && at(e.ts) < b)
      .reduce((s, e) => s + e.dur / 1000, 0);
  // Tasks running at any time between a and b. Use these for an event whose task may have started well before the event was seen.
  const over = (a, b) => tasks.filter(t => t.at < b && t.at + t.ms > a);
  return {
    out,
    tasks,
    events,
    at,
    layout,
    sum: (a, b) => within(a, b).reduce((s, t) => s + t.ms, 0),
    longest: (a, b) => Math.max(0, ...within(a, b).map(t => t.ms)),
    sumOver: (a, b) => over(a, b).reduce((s, t) => s + t.ms, 0),
    longestOver: (a, b) => Math.max(0, ...over(a, b).map(t => t.ms)),
  };
}
