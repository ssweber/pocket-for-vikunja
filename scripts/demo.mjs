// The README's demo GIF and screenshots, made from the real app against the local Vikunja of `npm run dev`.
//
//   npm run dev          in another terminal; it keeps running
//   npm run demo         writes docs/screenshots/pocket-demo.gif and the screenshots of Pocket and of Vikunja
//
// It uses two users of its own, alex and priya, with made-up tasks; alex's tasks and projects are replaced on each run.
// The page's clock is fixed at Wednesday 30 September 2026, 10:05, so "Today 10:30 AM" and "2 days ago" come out the
// same every time. BROWSER_CHANNEL=msedge|chrome as for the tests; FRAMES=<folder> also saves the GIF's frames there.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const BASE = (process.env.VIKUNJA_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '');
const APP = BASE + '/api/v1/plugins/pocket/';
const OUT = new URL('../docs/screenshots/', import.meta.url);
const out = name => fileURLToPath(new URL(name, OUT));
const NOW = new Date(2026, 8, 30, 10, 5);                    // Wednesday 30 September 2026, 10:05, local time
const at = (days, h = 0, m = 0) => { const d = new Date(NOW); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, path, body, token){
  const form = body instanceof FormData;
  const r = await fetch(BASE + '/api/v2' + path, { method, body: body && !form ? JSON.stringify(body) : body,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) } });
  if (!r.ok && r.status !== 304) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
  return r.status === 204 || r.status === 304 ? null : r.json();      // 304: a PATCH that changes nothing
}
// A user of the demo's own, created on the first run, with a display name.
async function account(username, name){
  await call('POST', '/register', { username, email: `${username}@example.com`, password: `${username}-password` }).catch(() => {});
  const { token } = await call('POST', '/login', { username, password: `${username}-password` });
  const user = await call('GET', '/user', null, token);
  await call('PATCH', '/user/settings/general', { name }, token);
  return { token, user: await call('GET', '/user', null, token) };
}

// ---------- the demo's tasks ----------
const alex = await account('alex', 'Alex Rivera'), priya = await account('priya', 'Priya Shah');
const A = (method, path, body) => call(method, path, body, alex.token);
for (const p of (await A('GET', '/projects')).items) if (p.id > 0 && p.id !== alex.user.settings.default_project_id && p.owner?.id === alex.user.id) await A('DELETE', '/projects/' + p.id);
for (let page = (await A('GET', '/tasks?per_page=100')).items; page.length; page = (await A('GET', '/tasks?per_page=100')).items)
  for (const t of page) await A('DELETE', '/tasks/' + t.id);
for (const l of (await A('GET', '/labels')).items) if (l.created_by?.id === alex.user.id) await A('DELETE', '/labels/' + l.id);
await A('PATCH', '/projects/' + alex.user.settings.default_project_id, { title: 'Inbox', hex_color: '' });

const proj = {};
for (const [title, hex_color] of [['Work', '1d6b52'], ['Home', 'e07a1f'], ['Errands', '2563eb']]) proj[title] = await A('POST', '/projects', { title, hex_color });
await A('POST', `/projects/${proj.Work.id}/users`, { username: 'priya', permission: 1 });
const label = {};
for (const [title, hex_color] of [['waiting', 'db2777'], ['calls', '7c3aed'], ['quick', '0891b2']]) label[title] = await A('POST', '/labels', { title, hex_color });

async function task(project, t, { labels = [], subtasks = [], comment, file } = {}){
  const made = await A('POST', `/projects/${proj[project].id}/tasks`, t);
  for (const l of labels) await A('POST', `/tasks/${made.id}/labels`, { label_id: label[l].id });
  for (const [title, done] of subtasks) {
    const s = await A('POST', `/projects/${proj[project].id}/tasks`, { title, done });
    await A('POST', `/tasks/${made.id}/relations`, { other_task_id: s.id, relation_kind: 'subtask' });
  }
  if (comment) await call('POST', `/tasks/${made.id}/comments`, { comment }, priya.token);
  if (file) { const f = new FormData(); f.append('files', new Blob([file.text, new Uint8Array(file.size)], { type: 'application/pdf' }), file.name); await A('POST', `/tasks/${made.id}/attachments`, f); }
  return made;
}
const invoice = await task('Work', { title: 'Send Q3 invoice to Brightline', due_date: at(-2, 9), priority: 4, percent_done: .4,
  description: '<p>Use the new rate from the September contract.</p>' }, {
  labels: ['waiting'], comment: '<p>Brightline asked for PO number 4471 on the invoice.</p>', file: { name: 'rates-2026.pdf', text: '%PDF-1.4 demo', size: 184000 },
  subtasks: [['Export hours from the time tracker', true], ['Attach expense receipts', false], ['CC accounts@brightline.example', false]] });
await task('Errands', { title: 'Renew car registration', due_date: at(-1) });
await task('Work', { title: 'Review Priya’s onboarding draft', due_date: at(0, 10, 30), priority: 3 });
await task('Home', { title: 'Call the dentist to reschedule', due_date: at(0) }, { labels: ['calls'] });
await task('Errands', { title: 'Pick up dry cleaning', due_date: at(0, 17, 30) }, { labels: ['quick'] });
await task('Work', { title: 'Team retro', due_date: at(1, 14) });
await task('Home', { title: 'Water the plants', due_date: at(2), repeat_after: 604800 });
await task('Work', { title: 'Book flights for the offsite', due_date: at(4), priority: 2, reminders: [{ reminder: at(3, 9) }] });

// ---------- the browser ----------
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
// A phone: touch, the fixed clock, and a dot that shows where the finger is.
async function phone({ scale = 2, height = 844 } = {}){
  const context = await browser.newContext({ viewport: { width: 390, height }, deviceScaleFactor: scale, hasTouch: true, isMobile: true });
  await context.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const dot = Object.assign(document.createElement('div'), { id: 'demo-finger' });
    dot.style.cssText = 'position:fixed;left:-99px;top:-99px;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;' +
      'background:rgba(23,32,28,.25);box-shadow:0 0 0 2px rgba(255,255,255,.75);pointer-events:none;z-index:9999;display:none';
    document.body.append(dot);
    const move = e => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; };
    addEventListener('pointerdown', e => { move(e); dot.style.display = 'block'; }, true);
    addEventListener('pointermove', move, true);
    for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => { dot.style.display = 'none'; }, true);
  }));
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.goto(APP);
  await page.waitForSelector('#auth-step:not([hidden])');
  if (await page.isVisible('.seg button[data-mode=token]')) await page.click('.seg button[data-mode=token]');
  await page.fill('#in-token', alex.token);
  await page.click('#f-token button[type=submit]');
  await page.waitForSelector('#view .loading', { state: 'detached' });
  await page.waitForTimeout(400);
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  return { context, page, touch };
}
const centre = async (page, sel) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const crop = async (page, sel, pad = 4) => { const b = await page.locator(sel).boundingBox(); return { x: 0, y: Math.max(0, b.y - pad), width: 390, height: b.height + pad * 2 }; };

// ---------- the screenshots ----------
{
  const { context, page } = await phone();
  await page.screenshot({ path: out('pocket-today.png') });
  await page.locator('.row .body:has-text("Send Q3 invoice")').click();
  await page.waitForSelector('#d-comments .comment'); await page.waitForTimeout(500);
  await page.screenshot({ path: out('pocket-task.png') });
  await page.click('#btn-sheet-close'); await page.waitForSelector('#sheet', { state: 'hidden' });
  const box = async (text, then) => {
    await page.fill('#in-capture', ''); await page.fill('#in-capture', text); await page.waitForTimeout(300);
    await then?.(); await page.waitForTimeout(300);
    return crop(page, '#capture');
  };
  await page.screenshot({ path: out('pocket-capture.png'), clip: await box('Call Ana Friday at 10 +work !3') });
  await page.screenshot({ path: out('pocket-chip-undo.png'), clip: await box('Watch Monday night football', () => page.click('#cap-chips .chip[data-kind=due]')) });
  await page.screenshot({ path: out('pocket-paste-list.png'), clip: await box('Groceries\n• milk\n• eggs\n• coffee', () => page.click('#cap-nest')) });
  await page.screenshot({ path: out('pocket-new-project.png'), clip: await box('Call contractor friday +Kitchen') });
  // Offline: the banner, and a task waiting to be sent.
  await page.fill('#in-capture', '');
  await context.setOffline(true);
  await page.fill('#in-capture', 'Call the plumber today');
  await page.click('#f-capture .go');
  await page.waitForSelector('.row.pending'); await page.waitForTimeout(400);
  const banner = await page.locator('.offline').boundingBox(), pending = await page.locator('.row.pending').boundingBox();
  await page.screenshot({ path: out('pocket-offline.png'), clip: { x: 0, y: banner.y - 12, width: 390, height: pending.y + pending.height - banner.y + 24 } });
  await context.close();
}

// ---------- Vikunja's own web app, for comparison: the same account and tasks, on the same screen ----------
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.goto(BASE + '/login');
  await page.fill('#username', 'alex');
  await page.fill('#password', 'alex-password');
  await page.keyboard.press('Enter');
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(800);
  // Vikunja suggests adding it to the home screen; close that, as someone would.
  await page.locator('text=Add this app to your home screen').locator('xpath=ancestor::*[.//button][1]').locator('button').last().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: out('vikunja-home.png') });
  await page.goto(BASE + '/tasks/' + invoice.id);
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(800);
  await page.screenshot({ path: out('vikunja-task.png') });
  await context.close();
}

// ---------- the GIF ----------
const frames = [];                               // {png, delay}
const gif = await phone({ scale: 1.5, height: 760 });
const { page, touch } = gif;
const snap = async (delay = 100) => frames.push({ png: await page.screenshot(), delay });
const hold = ms => { frames[frames.length - 1].delay += ms; };
// Screenshots for a while, as fast as they come, each shown for as long as it took.
async function film(ms){
  for (const end = Date.now() + ms; Date.now() < end;) { const t = Date.now(); const png = await page.screenshot(); frames.push({ png, delay: Date.now() - t }); }
}
async function tap(sel){
  const [x, y] = await centre(page, sel);
  await touch('touchStart', x, y); await snap(160); await touch('touchEnd');
}

await snap(1800);                                                    // Today
// 1. Quick add: the words it reads are highlighted, and chips say what they'll save.
await tap('#in-capture');
for (const ch of 'Call Ana at 4pm +work !3') { await page.keyboard.type(ch); await snap(ch === ' ' ? 40 : 75); }
hold(1600);
await tap('#f-capture .go');
await page.waitForSelector('.row .title:has-text("Call Ana")');
await page.locator('#in-capture').blur();
await film(1800); hold(1200);                                      // the new row lights up, then fades
// 2. Progress: hold a task, then slide.
{
  await page.evaluate(() => { app.toast.show = false; }); await page.waitForTimeout(250); await snap(300);
  const row = await page.locator('.row:has-text("Review Priya")').boundingBox();
  const x = row.x + 30, y = row.y + row.height / 2;        // so the finger ends at the edge of the fill
  await touch('touchStart', x, y); await snap(250);
  await page.waitForSelector('.row.setting'); await snap(350);
  const width = (await page.locator('.row:has-text("Review Priya")').boundingBox()).width * .8;
  for (let step = 1; step <= 6; step++) { await touch('touchMove', x + width * step / 10, y); await snap(130); }
  hold(600);
  await touch('touchEnd');
  await film(400); hold(1600);
}
// 3. Done: tick one off, and it slides away with an Undo.
await tap('.row:has-text("Pick up dry cleaning") .check');
await film(1300); hold(2000);
await gif.context.close();
await browser.close();

// ---------- encode: one palette for all frames; each frame keeps only the pixels that changed ----------
const images = frames.map(f => { const png = PNG.sync.read(f.png); return { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height, delay: f.delay }; });
const { width, height } = images[0];
const sample = new Uint8Array(images.length * width * 4 * Math.ceil(height / 8));
let o = 0;
for (const im of images) for (let row = 0; row < height; row += 8) { sample.set(im.data.subarray(row * width * 4, (row + 1) * width * 4), o); o += width * 4; }
const palette = quantize(sample.subarray(0, o), 255);
while (palette.length < 256) palette.push([0, 0, 0]);    // the last one is "unchanged"
const KEEP = 255;
const enc = GIFEncoder();
let prev = null;
for (const [i, im] of images.entries()) {
  const idx = applyPalette(im.data, palette.slice(0, 255));
  const out = idx.slice();
  if (prev) for (let p = 0; p < out.length; p++) if (idx[p] === prev[p]) out[p] = KEEP;
  enc.writeFrame(out, width, height, { palette: i === 0 ? palette : undefined, delay: im.delay, transparent: !!prev, transparentIndex: KEEP, dispose: 1 });
  prev = idx;
}
enc.finish();
await mkdir(OUT, { recursive: true });
await writeFile(new URL('pocket-demo.gif', OUT), enc.bytes());
if (process.env.FRAMES) { await mkdir(process.env.FRAMES, { recursive: true }); for (const [i, f] of frames.entries()) await writeFile(`${process.env.FRAMES}/${String(i).padStart(3, '0')}-${f.delay}ms.png`, f.png); }
console.log(`pocket-demo.gif: ${frames.length} frames, ${(frames.reduce((s, f) => s + f.delay, 0) / 1000).toFixed(1)} s, ${(enc.bytes().length / 1048576).toFixed(2)} MB`);
