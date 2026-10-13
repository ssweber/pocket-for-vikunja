// The README's two GIFs and the guide's screenshot, made from the real app against the local Vikunja of `npm run dev`.
//
//   npm run dev          in another terminal; it keeps running
//   npm run demo         writes docs/screenshots/pocket-demo.gif, pocket-checklist.gif and pocket-capture.png
//
// The story is a small café. Alex owns it, and Jamie is the shift lead who opens up. The demo creates both users and
// gives them made-up tasks. Each run replaces alex's tasks and projects.
// The page's clock is fixed at Wednesday 30 September 2026, 10:05, so "Today 10:30 AM" and "2 days ago" read the same
// every time. BROWSER_CHANNEL=msedge|chrome works as it does for the tests. FRAMES=<folder> also saves the GIF's frames
// there.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
import { hintSeen } from '../tests/helpers.mjs';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const BASE = (process.env.VIKUNJA_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '');
const APP = BASE + '/api/v1/plugins/pocket/';
const OUT = new URL('../docs/screenshots/', import.meta.url);
const out = name => fileURLToPath(new URL(name, OUT));
const NOW = new Date(2026, 8, 30, 10, 5);                    // Wednesday 30 September 2026, 10:05, local time
const at = (days, h = 0, m = 0) => { const d = new Date(NOW); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
const frames = [];                               // the frames of the GIF being filmed, as {png, delay}

async function call(method, path, body, token){
  const form = body instanceof FormData;
  const r = await fetch(BASE + '/api/v2' + path, { method, body: body && !form ? JSON.stringify(body) : body,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) } });
  if (!r.ok && r.status !== 304) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
  return r.status === 204 || r.status === 304 ? null : r.json();      // 304 means a PATCH changed nothing
}
// Create a demo user on the first run, with a display name.
async function account(username, name){
  await call('POST', '/register', { username, email: `${username}@example.com`, password: `${username}-password` }).catch(() => {});
  const { token } = await call('POST', '/login', { username, password: `${username}-password` });
  await call('PATCH', '/user/settings/general', { name }, token);
  return { token, user: await call('GET', '/user', null, token) };
}

// ---------- the demo's tasks ----------
const alex = await account('alex', 'Alex Rivera'), jamie = await account('jamie', 'Jamie Taylor');
const A = (method, path, body) => call(method, path, body, alex.token);
// Make Inbox the default project again, because a run ends with the café as the default. Then delete everything else.
const own = (await A('GET', '/projects')).items.filter(p => p.id > 0 && p.owner?.id === alex.user.id);
const inbox = own.find(p => p.title === 'Inbox') || await A('POST', '/projects', { title: 'Inbox' });
await A('PATCH', '/user/settings/general', { default_project_id: inbox.id });
for (const p of own) if (p.id !== inbox.id) await A('DELETE', '/projects/' + p.id);
for (let page = (await A('GET', '/tasks?per_page=100')).items; page.length; page = (await A('GET', '/tasks?per_page=100')).items)
  for (const t of page) await A('DELETE', '/tasks/' + t.id);
for (const l of (await A('GET', '/labels')).items) if (l.created_by?.id === alex.user.id) await A('DELETE', '/labels/' + l.id);
await A('PATCH', '/projects/' + inbox.id, { title: 'Inbox', hex_color: '' });

// Three projects. The café holds the checklists, Orders holds the supplier orders, and Home is personal. Below, the café
// and Orders are shared with Jamie.
const proj = {};
for (const [title, hex_color] of [['Café', '1d6b52'], ['Orders', '2563eb'], ['Home', 'e07a1f']]) proj[title] = await A('POST', '/projects', { title, hex_color });
await A('PATCH', '/projects/' + proj['Café'].id, { description: '<p>The café: opening up, closing down, and the jobs in between.</p><p>pocket:checklists</p>' });
for (const p of ['Café', 'Orders']) await A('POST', `/projects/${proj[p].id}/users`, { username: 'jamie', permission: 1 });
// A task Alex adds goes to the café unless he names another project.
await A('PATCH', '/user/settings/general', { default_project_id: proj['Café'].id });
const label = {};
for (const [title, hex_color] of [['suppliers', 'db2777'], ['calls', '7c3aed'], ['quick', '0891b2']]) label[title] = await A('POST', '/labels', { title, hex_color });

async function task(project, t, { labels = [], subtasks = [], comment, file, assign } = {}){
  const made = await A('POST', `/projects/${proj[project].id}/tasks`, t);
  for (const l of labels) await A('POST', `/tasks/${made.id}/labels`, { label_id: label[l].id });
  if (assign) await A('POST', `/tasks/${made.id}/assignees`, { user_id: assign.user.id });
  // Create the subtasks in reverse. Vikunja's List view puts a new task at the top, and Pocket shows subtasks in that order.
  for (const [title, done] of [...subtasks].reverse()) {
    const s = await A('POST', `/projects/${proj[project].id}/tasks`, { title, done });
    await A('POST', `/tasks/${made.id}/relations`, { other_task_id: s.id, relation_kind: 'subtask' });
  }
  if (comment) await call('POST', `/tasks/${made.id}/comments`, { comment }, jamie.token);
  if (file) { const f = new FormData(); f.append('files', new Blob([file.text, new Uint8Array(file.size)], { type: 'application/pdf' }), file.name); await A('POST', `/tasks/${made.id}/attachments`, f); }
  return made;
}
await task('Orders', { title: 'Order oat milk from Riverside Dairy', due_date: at(-2, 9), priority: 4, percent_done: .4,
  description: '<p>Two cases a week from October: set it up as a standing order.</p>' }, {
  labels: ['suppliers'], comment: '<p>We’re on the last case. Riverside’s cut-off is 2pm for next-day delivery.</p>', file: { name: 'riverside-price-list.pdf', text: '%PDF-1.4 demo', size: 184000 },
  subtasks: [['Count what’s left in the fridge', true], ['Ask about the October price', false], ['Set up the standing order', false]] });
await task('Orders', { title: 'Pay the coffee roaster’s invoice', due_date: at(1) });   // due tomorrow, so it isn't overdue and Today has space for one more task
await task('Café', { title: 'Post next week’s rota', due_date: at(0, 10, 30), priority: 3 });
await task('Café', { title: 'Call the plumber about the dishwasher', due_date: at(0) }, { labels: ['calls'], assign: jamie });   // shows Jamie's picture on the row
await task('Café', { title: 'Pick up change from the bank', due_date: at(0, 15, 30) }, { labels: ['quick'] });
await task('Café', { title: 'Try the autumn menu with Jamie', due_date: at(1, 14) });
await task('Café', { title: 'Deep-clean the espresso machine', due_date: at(2), repeat_after: 604800 });
await task('Home', { title: 'Book the van in for a service', due_date: at(3) });
await task('Café', { title: 'Renew the food hygiene certificate', due_date: at(4), priority: 2, reminders: [{ reminder: at(3, 9) }] });

// ---------- the browser ----------
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
// A phone-sized browser with touch, the fixed clock, and a dot that shows where the touch is.
async function phone({ scale = 2, height = 844 } = {}){
  const context = await browser.newContext({ viewport: { width: 390, height }, deviceScaleFactor: scale, hasTouch: true, isMobile: true });
  await hintSeen(context);                       // keeps the one-time hint out of the pictures
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

// ---------- the guide's screenshot: quick add, showing what it understood ----------
{
  const { context, page } = await phone();
  await page.fill('#in-capture', 'Order 6 bags of house blend fri at 9 +orders !3'); await page.waitForTimeout(600);
  await page.screenshot({ path: out('pocket-capture.png'), clip: await crop(page, '#capture') });
  await context.close();
}

// ---------- the GIFs ----------
let gif;                                         // the phone being filmed, as {context, page, touch}
const snap = async (delay = 100) => frames.push({ png: await gif.page.screenshot(), delay });
const hold = ms => { frames[frames.length - 1].delay += ms; };
// Take screenshots as fast as possible for `ms` milliseconds. Each frame is shown for as long as it took to capture, so
// the GIF plays in real time.
async function film(ms){
  for (const end = Date.now() + ms; Date.now() < end;) { const t = Date.now(); const png = await gif.page.screenshot(); frames.push({ png, delay: Date.now() - t }); }
}
async function tap(sel){
  await gif.page.locator(sel).first().scrollIntoViewIfNeeded();            // a touch can only tap what is on screen
  const [x, y] = await centre(gif.page, sel);
  await gif.touch('touchStart', x, y); await snap(160); await gif.touch('touchEnd');
}

gif = await phone({ scale: 1.5, height: 760 });
let { page, touch } = gif;

await snap(1800);                                                    // Today, with the oat milk order as a card folded down to its next step
// 1. Open a card. The tab under its top row lists every open subtask, and the rows below move down.
await tap('.day-card:has-text("Order oat milk") .card-more[aria-expanded=false]');
await page.waitForSelector('.day-card:has-text("Order oat milk") .card-more[aria-expanded=true]'); await page.waitForTimeout(250);
await snap(1500);
// 2. Quick add. The words it reads are highlighted, and chips show what will be saved.
await tap('#in-capture');
for (const ch of 'Order 6 bags of house blend at 4 +orders !3') { await page.keyboard.type(ch); await snap(ch === ' ' ? 40 : 75); }
hold(1500);
await tap('#f-capture .go');
await page.waitForSelector('.row .title:has-text("Order 6 bags")');
await page.locator('#in-capture').blur(); await page.waitForTimeout(150);   // the box's help disappears with the keyboard
await film(1500); hold(800);                                       // the new row is highlighted, then fades
// 3. Progress. Swipe right on a task nobody has claimed. The ring in the green space it uncovers fills to 25%, then
//    50%. On release the row springs back with its tick half filled, and "+ me" becomes Alex's initial A.
{
  await page.waitForTimeout(250); await snap(300);
  const row = await page.locator('.row:has-text("Post next week")').boundingBox();
  const x = row.x + 30, y = row.y + row.height / 2;
  // Move sideways straight away. A row on Today that is held still for half a second lifts instead, and date chips appear around the touch.
  await touch('touchStart', x, y); await touch('touchMove', x + 12, y);
  const width = row.width * .3;                            // 50% is reached at a quarter of the row's width, done at half
  for (let step = 1; step <= 6; step++) { await touch('touchMove', x + 12 + (width - 12) * step / 6, y); await snap(130); }
  hold(600);
  await touch('touchEnd');
  await page.waitForSelector('.row:has-text("Post next week") .claim.mine'); await page.waitForTimeout(300);
  await snap(1600);
}
// 4. Done. A ticked row stays in place, ticked, and leaves the list 3 seconds later. The rows below close up once, after it leaves.
await tap('.row:has-text("Pick up change from the bank") .check');
await page.waitForSelector('.row.done:has-text("Pick up change from the bank")'); await page.waitForTimeout(200);
await snap(); { const t = Date.now(); await page.waitForTimeout(2300); hold(Date.now() - t); }
await film(1200); hold(1800);
await gif.context.close();
await writeGif('pocket-demo.gif');

// ---------- the checklist GIF: opening up the café, with the checklist's row and ring, the square step boxes and the timed steps ----------
// Create templates the way Pocket does. Each has the label "template", its steps are marked done, then the template is marked done.
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
// Four steps, so the start sheet's Start button fits on the GIF's screen.
await template('Opening up', ['Turn on the espresso machine {#machine}', 'Put the croissants in the oven {#croissants}',
  'Dial in the grinder T#20m:machine', 'Take the croissants out T#18m:croissants']);
await template('Closing down', ['Backflush the espresso machine', 'Count the till', 'Wipe down the tables', 'Lock up']);

gif = await phone({ scale: 1.5, height: 760 });
({ page } = gif);
await tap('nav.tabs a[data-tab=checklists]');
await page.waitForSelector('.cl-start'); await page.waitForTimeout(300); await snap(1400);
await tap('.cl-tpl:has-text("Opening up") .cl-start');
await page.waitForSelector('#start-go:not([disabled])'); await page.waitForTimeout(500);
await snap(2600);                                                    // shows the steps and when each is due
await tap('#start-go');
await page.waitForSelector('#step-title'); await page.waitForTimeout(400);
await snap(1800);                                                    // a message says the checklist has started, with an Undo
await tap('#step-done');
await page.waitForSelector('#step-title:text-is("Put the croissants in the oven")'); await page.waitForTimeout(300); await snap(1200);
await tap('#step-done');                                             // the next step is the grinder, due in 20m, with the croissants step pinned above it
await page.waitForSelector('#step-title:text-is("Dial in the grinder")'); await page.waitForSelector('#run-timers'); await page.waitForTimeout(400);
await film(600); hold(3600);
await gif.context.close();
await writeGif('pocket-checklist.gif');
await browser.close();

// ---------- encode the GIF with one palette for all frames, where each frame keeps only the pixels that changed ----------
async function writeGif(name){
  const images = frames.map(f => { const png = PNG.sync.read(f.png); return { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height, delay: f.delay }; });
  const { width, height } = images[0];
  const sample = new Uint8Array(images.length * width * 4 * Math.ceil(height / 8));
  let o = 0;
  for (const im of images) for (let row = 0; row < height; row += 8) { sample.set(im.data.subarray(row * width * 4, (row + 1) * width * 4), o); o += width * 4; }
  const palette = quantize(sample.subarray(0, o), 255);
  while (palette.length < 256) palette.push([0, 0, 0]);    // the last entry marks an unchanged pixel
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
