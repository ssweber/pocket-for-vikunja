// A CPU profile of one step in Pocket against the measuring Vikunja (up.mjs), with its time by function (agg.mjs).
//   node scripts/perf/prof.mjs [big|done|today] [--cpu 4] [--mine]
// big: Today -> Big; done: Big's Done opened; today: Pocket opened again on Today. Writes
// test-results/perf/prof-<step>.cpuprofile, which Chrome's developer tools open (Performance, Load profile). Pocket's
// page is minified: for names worth reading, run Vikunja on an unminified build (scripts/perf/README.md).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { report } from './agg.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(HERE, '..', '..', 'test-results', 'perf');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const STEP = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'big';
const state = JSON.parse(readFileSync(join(OUT, 'state.json'), 'utf8'));
const proxy = spawn(process.execPath, [join(HERE, 'proxy.mjs'), '--port', '3471'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(ok => proxy.stdout.once('data', ok));
const APP = 'http://127.0.0.1:3471/api/v1/plugins/pocket/';

const ctx = await chromium.launchPersistentContext(join(OUT, 'profile-prof'), { channel: process.env.BROWSER_CHANNEL || 'chrome', viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: +arg('cpu', 1) });
const fresh = () => page.waitForFunction(() => document.querySelector('#view .row') && !document.querySelector('#view .loading') && !document.querySelector('#view[aria-busy="true"]'), null, { timeout: 900000, polling: 200 });
// Signed in (once: the browser's profile keeps it), with the page Vikunja serves now rather than one saved before.
await page.goto(APP + '#/today');
await page.evaluate(async () => { for (const k of await caches.keys()) await caches.delete(k); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); });
await page.reload();
await Promise.race([page.locator('#auth-step').waitFor(), page.locator('#app').waitFor()]);
if (await page.locator('#auth-step').isVisible()) {
  const tab = page.getByRole('button', { name: 'API token', exact: true });
  if (await tab.isVisible()) await tab.click();
  await page.getByLabel('API token').fill(state.token);
  await page.getByRole('button', { name: 'Connect' }).click();
}
await page.waitForTimeout(500); await fresh(); await page.waitForTimeout(3000);
if (STEP === 'done') {
  await page.evaluate(id => { location.hash = '#/project/' + id; }, state.projects.big);
  await page.waitForTimeout(300); await fresh(); await page.waitForTimeout(3000);
  if (await page.getAttribute('#sec-done', 'aria-expanded') === 'true') await page.click('#sec-done');   // left open last time
}
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start');
const t0 = Date.now();
if (STEP === 'big') await page.evaluate(id => { location.hash = '#/project/' + id; }, state.projects.big);
else if (STEP === 'done') await page.click('#sec-done');
else await page.reload();
await page.waitForTimeout(300); await fresh();
const ms = Date.now() - t0;
const { profile } = await cdp.send('Profiler.stop');
writeFileSync(join(OUT, `prof-${STEP}.cpuprofile`), JSON.stringify(profile));
console.log(`step ${STEP}: ${ms} ms\n${report(profile, 45, process.argv.includes('--mine'))}`);
if (STEP === 'done') await page.click('#sec-done');                         // closed again, as the next run expects
await ctx.close(); proxy.kill();
