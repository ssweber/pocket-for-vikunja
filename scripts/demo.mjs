// The README's demo GIF and screenshots, made from the real app against the local Vikunja of `npm run dev`.
//
//   npm run dev          in another terminal; it keeps running
//   npm run demo         writes docs/screenshots/pocket-demo.gif, pocket-checklist.gif and the screenshots of Pocket and of Vikunja
//
// The story is a small café: Alex owns it, and Priya is the shift lead who opens up. They're two users of the demo's
// own, with made-up tasks; alex's tasks and projects are replaced on each run.
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
const frames = [];                               // {png, delay}, for the GIF being filmed

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
  await call('PATCH', '/user/settings/general', { name }, token);
  return { token, user: await call('GET', '/user', null, token) };
}

// ---------- the demo's tasks ----------
const alex = await account('alex', 'Alex Rivera'), priya = await account('priya', 'Priya Shah');
const A = (method, path, body) => call(method, path, body, alex.token);
// Back to an Inbox as the default project (the café is the default by the end of a run), then everything else goes.
const own = (await A('GET', '/projects')).items.filter(p => p.id > 0 && p.owner?.id === alex.user.id);
const inbox = own.find(p => p.title === 'Inbox') || await A('POST', '/projects', { title: 'Inbox' });
await A('PATCH', '/user/settings/general', { default_project_id: inbox.id });
for (const p of own) if (p.id !== inbox.id) await A('DELETE', '/projects/' + p.id);
for (let page = (await A('GET', '/tasks?per_page=100')).items; page.length; page = (await A('GET', '/tasks?per_page=100')).items)
  for (const t of page) await A('DELETE', '/tasks/' + t.id);
for (const l of (await A('GET', '/labels')).items) if (l.created_by?.id === alex.user.id) await A('DELETE', '/labels/' + l.id);
await A('PATCH', '/projects/' + inbox.id, { title: 'Inbox', hex_color: '' });

// The café, shared with Priya and used for checklists; the orders to suppliers, Alex's own; and home.
const proj = {};
for (const [title, hex_color] of [['Café', '1d6b52'], ['Orders', '2563eb'], ['Home', 'e07a1f']]) proj[title] = await A('POST', '/projects', { title, hex_color });
await A('PATCH', '/projects/' + proj['Café'].id, { description: '<p>The café: opening up, closing down, and the jobs in between.</p><p>pocket:checklists</p>' });
for (const p of ['Café', 'Orders']) await A('POST', `/projects/${proj[p].id}/users`, { username: 'priya', permission: 1 });
// The café is where Alex's tasks go unless another project is named.
await A('PATCH', '/user/settings/general', { default_project_id: proj['Café'].id });
const label = {};
for (const [title, hex_color] of [['suppliers', 'db2777'], ['calls', '7c3aed'], ['quick', '0891b2']]) label[title] = await A('POST', '/labels', { title, hex_color });

async function task(project, t, { labels = [], subtasks = [], comment, file, assign } = {}){
  const made = await A('POST', `/projects/${proj[project].id}/tasks`, t);
  for (const l of labels) await A('POST', `/tasks/${made.id}/labels`, { label_id: label[l].id });
  if (assign) await A('POST', `/tasks/${made.id}/assignees`, { user_id: assign.user.id });
  // Made last first: Vikunja's List view puts a new task at the top, and Pocket shows subtasks in that order.
  for (const [title, done] of [...subtasks].reverse()) {
    const s = await A('POST', `/projects/${proj[project].id}/tasks`, { title, done });
    await A('POST', `/tasks/${made.id}/relations`, { other_task_id: s.id, relation_kind: 'subtask' });
  }
  if (comment) await call('POST', `/tasks/${made.id}/comments`, { comment }, priya.token);
  if (file) { const f = new FormData(); f.append('files', new Blob([file.text, new Uint8Array(file.size)], { type: 'application/pdf' }), file.name); await A('POST', `/tasks/${made.id}/attachments`, f); }
  return made;
}
const oatMilk = await task('Orders', { title: 'Order oat milk from Riverside Dairy', due_date: at(-2, 9), priority: 4, percent_done: .4,
  description: '<p>Two cases a week from October: set it up as a standing order.</p>' }, {
  labels: ['suppliers'], comment: '<p>We’re on the last case. Riverside’s cut-off is 2pm for next-day delivery.</p>', file: { name: 'riverside-price-list.pdf', text: '%PDF-1.4 demo', size: 184000 },
  subtasks: [['Count what’s left in the fridge', true], ['Ask about the October price', false], ['Set up the standing order', false]] });
await task('Orders', { title: 'Pay the coffee roaster’s invoice', due_date: at(-1) });
await task('Café', { title: 'Post next week’s rota', due_date: at(0, 10, 30), priority: 3 });
await task('Café', { title: 'Call the plumber about the dishwasher', due_date: at(0) }, { labels: ['calls'], assign: priya });   // Priya's picture on its row
await task('Café', { title: 'Pick up change from the bank', due_date: at(0, 15, 30) }, { labels: ['quick'] });
await task('Café', { title: 'Try the autumn menu with Priya', due_date: at(1, 14) });
await task('Café', { title: 'Deep-clean the espresso machine', due_date: at(2), repeat_after: 604800 });
await task('Home', { title: 'Book the van in for a service', due_date: at(3) });
await task('Café', { title: 'Renew the food hygiene certificate', due_date: at(4), priority: 2, reminders: [{ reminder: at(3, 9) }] });

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
  await page.locator('.row .body:has-text("Order oat milk")').click();
  await page.waitForSelector('#d-comments .comment'); await page.waitForTimeout(500);
  await page.screenshot({ path: out('pocket-task.png') });
  await page.click('#btn-sheet-close'); await page.waitForSelector('#sheet', { state: 'hidden' });
  const box = async (text, then) => {
    await page.fill('#in-capture', ''); await page.fill('#in-capture', text); await page.waitForTimeout(300);
    await then?.(); await page.waitForTimeout(300);
    return crop(page, '#capture');
  };
  await page.screenshot({ path: out('pocket-capture.png'), clip: await box('Order 6 bags of house blend fri at 9 +orders !3') });
  // Handing it off: @priya, in the café, which Priya can see.
  await page.screenshot({ path: out('pocket-assign.png'), clip: await box('Clean the milk steamer tomorrow @priya', () => page.waitForTimeout(1500)) });
  await page.screenshot({ path: out('pocket-chip-undo.png'), clip: await box('Write the Sunday brunch menu', () => page.click('#cap-chips .chip[data-kind=due]')) });
  await page.screenshot({ path: out('pocket-paste-list.png'), clip: await box('Supplier order\n• oat milk\n• paper cups\n• napkins', () => page.click('#cap-nest')) });
  await page.screenshot({ path: out('pocket-new-project.png'), clip: await box('Get quotes for patio heaters friday +Patio') });
  // Offline: the banner, and a task waiting to be sent.
  await page.fill('#in-capture', '');
  await context.setOffline(true);
  await page.fill('#in-capture', 'Buy till receipt rolls today');
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
  await page.goto(BASE + '/tasks/' + oatMilk.id);
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(800);
  await page.screenshot({ path: out('vikunja-task.png') });
  await context.close();
}

// ---------- the GIFs ----------
let gif;                                         // the phone being filmed: {context, page, touch}
const snap = async (delay = 100) => frames.push({ png: await gif.page.screenshot(), delay });
const hold = ms => { frames[frames.length - 1].delay += ms; };
// Screenshots for a while, as fast as they come, each shown for as long as it took.
async function film(ms){
  for (const end = Date.now() + ms; Date.now() < end;) { const t = Date.now(); const png = await gif.page.screenshot(); frames.push({ png, delay: Date.now() - t }); }
}
async function tap(sel){
  await gif.page.locator(sel).first().scrollIntoViewIfNeeded();            // a finger can only tap what's on screen
  const [x, y] = await centre(gif.page, sel);
  await gif.touch('touchStart', x, y); await snap(160); await gif.touch('touchEnd');
}

gif = await phone({ scale: 1.5, height: 760 });
let { page, touch } = gif;

await snap(1800);                                                    // Today
// 1. Quick add: the words it reads are highlighted, and chips say what they'll save.
await tap('#in-capture');
for (const ch of 'Order 6 bags of house blend at 4 +orders !3') { await page.keyboard.type(ch); await snap(ch === ' ' ? 40 : 75); }
hold(1600);
await tap('#f-capture .go');
await page.waitForSelector('.row .title:has-text("Order 6 bags")');
await page.locator('#in-capture').blur();
await film(1500); hold(1000);                                      // the new row lights up, then fades
// 2. Progress: hold a task, then slide; it stops at 25% and 50%.
{
  await page.waitForTimeout(250); await snap(300);
  const row = await page.locator('.row:has-text("Post next week")').boundingBox();
  const x = row.x + 30, y = row.y + row.height / 2;        // so the finger ends at the edge of the fill
  await touch('touchStart', x, y); await snap(250);
  await page.waitForSelector('.row.setting'); await snap(350);
  const width = (await page.locator('.row:has-text("Post next week")').boundingBox()).width * .8;
  for (let step = 1; step <= 6; step++) { await touch('touchMove', x + width * step / 10, y); await snap(130); }
  hold(600);
  await touch('touchEnd');
  await film(400); hold(1200);
}
// 3. "+ me" says you'll do it, and your picture takes its place.
await tap('.row:has-text("Post next week") .claim');
await page.waitForSelector('.row:has-text("Post next week") .claim.mine'); await page.waitForTimeout(300);
await snap(1300);
// 4. Done: tick one off, and its row becomes a line with an Undo.
await tap('.row:has-text("Pick up change from the bank") .check');
await film(1000); hold(2200);
await gif.context.close();
await writeGif('pocket-demo.gif');

// ---------- the checklist GIF: opening up the café, its timed steps counting down ----------
// Templates made as Pocket makes them: labelled "template", their steps done, then themselves done.
const tplLabel = (await A('GET', '/labels')).items.find(l => l.title === 'template') || await A('POST', '/labels', { title: 'template' });
async function template(title, steps){
  const t = await A('POST', `/projects/${proj['Café'].id}/tasks`, { title });
  for (const step of steps) {
    const s = await A('POST', `/projects/${proj['Café'].id}/tasks`, { title: step });
    await A('POST', `/tasks/${t.id}/relations`, { other_task_id: s.id, relation_kind: 'subtask' });
    await A('PATCH', '/tasks/' + s.id, { done: true });
  }
  await A('POST', `/tasks/${t.id}/labels`, { label_id: tplLabel.id });
  await A('PATCH', '/tasks/' + t.id, { done: true });
}
// Four steps, so the start sheet's Start button shows on the GIF's screen.
await template('Opening up', ['Turn on the espresso machine {#machine}', 'Put the croissants in the oven {#croissants}',
  'Dial in the grinder T#20m:machine', 'Take the croissants out T#18m:croissants']);
await template('Closing down', ['Backflush the espresso machine', 'Count the till', 'Wipe down the tables', 'Lock up']);

gif = await phone({ scale: 1.5, height: 760 });
({ page } = gif);
await tap('nav.tabs a[data-tab=checklists]');
await page.waitForSelector('.cl-start'); await page.waitForTimeout(300); await snap(1400);
await tap('.cl-tpl:has-text("Opening up") .cl-start');
await page.waitForSelector('#start-go:not([disabled])'); await page.waitForTimeout(500);
await snap(2600);                                                    // the steps, with when each is due
await tap('#start-go');
await page.waitForSelector('#step-title'); await page.waitForTimeout(400);
await snap(1800);                                                    // a run just started says so, with an Undo
await tap('#step-done');
await page.waitForSelector('#step-title:text-is("Put the croissants in the oven")'); await page.waitForTimeout(300); await snap(1200);
await tap('#step-done');                                             // the grinder counts down, and the croissants above it
await page.waitForSelector('#step-title:text-is("Dial in the grinder")'); await page.waitForSelector('#run-timers'); await page.waitForTimeout(400);
await film(600); hold(3600);
await page.screenshot({ path: out('pocket-run.png') });             // a still of the run, for the README
await gif.context.close();
await writeGif('pocket-checklist.gif');
await browser.close();

// ---------- encode: one palette for all frames; each frame keeps only the pixels that changed ----------
async function writeGif(name){
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
  await writeFile(new URL(name, OUT), enc.bytes());
  const stem = name.replace(/\.gif$/, '');
  if (process.env.FRAMES) { await mkdir(process.env.FRAMES, { recursive: true }); for (const [i, f] of frames.entries()) await writeFile(`${process.env.FRAMES}/${stem}-${String(i).padStart(3, '0')}-${f.delay}ms.png`, f.png); }
  console.log(`${name}: ${frames.length} frames, ${(frames.reduce((s, f) => s + f.delay, 0) / 1000).toFixed(1)} s, ${(enc.bytes().length / 1048576).toFixed(2)} MB`);
  frames.length = 0;
}
