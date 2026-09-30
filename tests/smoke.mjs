// End-to-end smoke test against a real Vikunja server.
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm test
//
// Serves the app on http://localhost:8000 (that origin must be in Vikunja's
// cors.origins), signs in with the token, then creates, edits, completes and
// deletes one throwaway task. The label it creates is removed at the end.
// Optional: BROWSER_CHANNEL=msedge|chrome (default: Playwright's Chromium),
// OUT=<dir> for screenshots.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN;
const PORT = +(process.env.PORT || 8000);
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !TOKEN) { console.error('Set VIKUNJA_URL and VIKUNJA_TOKEN'); process.exit(2); }

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const http = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([\\/])+/, '') || 'index.html';
  try { res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(await readFile(join(ROOT, path))); }
  catch { res.writeHead(404).end(); }
}).listen(PORT);
const APP = `http://localhost:${PORT}/`;

const api = (path, init = {}) => fetch(SERVER + '/api/v1' + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, ...init.headers } });

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());

let failed = 0;
async function step(name, fn){
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/fail-${name}.png` }); }
}

const stamp = Date.now();
const title = 'Pocket smoke test ' + stamp;
const label = 'pocket-smoke-' + stamp;

try {
  await page.goto(APP);
  await step('login-server', async () => {
    await page.fill('#in-server', SERVER);
    await page.click('#f-server button[type=submit]');
    await page.waitForSelector('#f-token:not([hidden])', { timeout: 10000 });
  });
  await step('login-token', async () => {
    await page.click('.seg button[data-mode=token]').catch(() => {});
    await page.fill('#in-token', TOKEN);
    await page.click('#f-token button[type=submit]');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#view .loading', { state: 'detached', timeout: 15000 });
  });
  await page.screenshot({ path: `${OUT}/today.png` });

  await step('quick-add', async () => {
    await page.fill('#in-capture', `${title} tomorrow at 5pm !3 *${label}`);
    const chips = await page.textContent('#cap-chips');
    if (!/Tomorrow/.test(chips) || !/Priority 3/.test(chips)) throw new Error('chips: ' + chips);
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row .title:has-text("${title}")`, { timeout: 15000 });
  });
  await step('open-task', async () => {
    await page.click(`.row .body:has-text("${title}")`);
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
    const labels = await page.textContent('.prop:has(.k:text("Labels"))');
    if (!labels.includes(label)) throw new Error('label missing: ' + labels);
  });
  await step('comment', async () => {
    await page.fill('#d-cin', 'smoke comment');
    await page.click('#d-cform button');
    await page.waitForSelector('.comment:has-text("smoke comment")', { timeout: 10000 });
  });
  await step('set-priority', async () => {
    await page.click('[data-prio="1"]');
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
  });
  await page.screenshot({ path: `${OUT}/sheet.png` });
  await step('mark-done', async () => {
    await page.click('#d-done');
    await page.waitForSelector('#d-done.on', { timeout: 10000 });
  });
  await step('delete', async () => {
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
  });
  await step('projects', async () => {
    await page.click('nav.tabs a[data-tab=projects]');
    await page.click('.tree .row .body');
    await page.waitForSelector('.toggle-done');
  });
  await page.screenshot({ path: `${OUT}/project.png` });
  await step('deep-link-add', async () => {
    await page.goto(APP + '#/add?text=Buy+milk+friday');
    await page.waitForFunction(() => document.querySelector('#in-capture').value === 'Buy milk friday');
  });
  if (errors.length) { failed++; console.log('FAIL console errors:', errors); }
} finally {
  await browser.close();
  http.close();
  // Clean up whatever this run left behind on the server.
  const labels = await (await api('/labels?s=' + encodeURIComponent(label))).json().catch(() => []);
  for (const l of labels || []) if (l.title === label) await api('/labels/' + l.id, { method: 'DELETE' });
  const tasks = await (await api('/tasks?s=' + encodeURIComponent(title))).json().catch(() => []);
  for (const t of tasks || []) if (t.title === title) await api('/tasks/' + t.id, { method: 'DELETE' });
}

console.log(failed ? `${failed} failed` : 'All passed');
process.exit(failed ? 1 : 0);
