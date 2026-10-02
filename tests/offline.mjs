// Offline: Pocket opening without a connection, and tasks added offline being sent later.
//
//   npm run test:local        (runs this against a local Vikunja with the plugin)
//   VIKUNJA_URL=... VIKUNJA_TOKEN=tk_... node tests/offline.mjs
//
// Opens Pocket online once (so it's saved on the "phone"), then cuts the connection with the browser's offline switch:
// Pocket must open with the last-loaded list, queue new tasks and pasted lists, and add them all once back online.
// Also checks the case that's easy to get wrong: a task that reaches Vikunja but whose reply is lost must not be added
// twice. Photos go the same way: added offline, or cut off mid-upload, they wait on the phone and upload later, once.
// Every task it creates has the run's stamp in its title and is deleted at the end.
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';   // BROWSER=webkit runs it on Safari's engine, as on an iPhone

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN;
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !TOKEN) { console.error('Set VIKUNJA_URL and VIKUNJA_TOKEN'); process.exit(2); }
const POCKET = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';
const api = (path, init = {}) => fetch(SERVER + '/api/v1' + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...init.headers } });
const byTitle = async title => ((await (await api('/tasks?s=' + encodeURIComponent(title))).json()) || []).filter(t => t.title === title);

await mkdir(OUT, { recursive: true });
const stamp = Date.now();
const T = name => `Pocket offline ${name} ${stamp}`;
const browser = process.env.BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.on('dialog', d => d.accept());
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
let failed = 0;
async function step(name, fn){
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/offline-fail-${name}.png` }).catch(() => {}); }
}
const capture = async text => { await page.fill('#in-capture', text); await page.click('#f-capture .go'); };
// A task added offline sits in the normal list, tinted, until it's sent.
const pendingRow = title => `.row.pending:has(.title:has-text("${title}"))`;
const NO_DATE = 'div:has(> .sec:has-text("Added today, no date"))';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const photo = name => ({ name, mimeType: 'image/png', buffer: PNG });
// The names of the files on a task in Vikunja.
const attached = async n => { const [t] = await byTitle(T(n)); return t ? ((await (await api('/tasks/' + t.id)).json()).attachments || []).map(a => a.file.name) : []; };
async function until(what, fn, ms = 20000){
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 300))) { if (await fn()) return; if (Date.now() > end) throw new Error(what); }
}
const online = () => page.evaluate(() => window.dispatchEvent(new Event('online')));   // try again now

try {
  // A task due tomorrow, so the Today list has something to remember.
  const me = await (await api('/user')).json(), projects = await (await api('/projects')).json();
  const home = me.settings?.default_project_id || projects.find(p => p.id > 0)?.id;
  const seeded = await api(`/projects/${home}/tasks`, { method: 'PUT', body: JSON.stringify({ title: T('seed'), due_date: new Date(Date.now() + 86400000).toISOString() }) });
  if (!seeded.ok) throw new Error('could not create the seed task: HTTP ' + seeded.status);

  await step('online-first-visit', async () => {
    await page.goto(POCKET);
    await page.waitForSelector('#auth-step:not([hidden])');
    if (await page.isVisible('.seg button[data-mode=token]')) await page.click('.seg button[data-mode=token]');
    await page.fill('#in-token', TOKEN);
    await page.click('#f-token button[type=submit]');
    await page.waitForSelector(`.row .title:has-text("${T("seed")}")`, { timeout: 15000 });
    await page.evaluate(() => navigator.serviceWorker.ready);                // Pocket is now saved for offline use
    await page.reload();                                                     // and this page is served by the service worker
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    await page.waitForSelector(`.row .title:has-text("${T("seed")}")`, { timeout: 15000 });
  });

  await step('opens-offline-with-last-list', async () => {
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector(`.row .title:has-text("${T("seed")}")`, { timeout: 15000 });
    const banner = await page.textContent('.offline');
    if (!banner.includes('Offline') || !banner.includes('showing tasks from')) throw new Error('banner: ' + banner);
  });

  await step('task-added-offline-waits', async () => {
    await capture(`${T('A')} tomorrow`);
    await page.waitForSelector(pendingRow(T('A')));                           // in Next 7 days, where it belongs
    if (await page.isVisible('#toast.show')) throw new Error('toast: ' + await page.textContent('#toast-msg'));
  });

  await step('pasted-list-offline-waits', async () => {
    await page.fill('#in-capture', `${T('P')} tomorrow\n- ${T('P1')}\n- ${T('P2')}`);
    await page.click('#cap-nest');
    await page.click('#f-capture .go');
    await page.waitForSelector(pendingRow(T('P')));
    if (await page.isVisible(pendingRow(T('P1')))) throw new Error('a subtask is shown in Today');     // only the parent is
  });

  await step('cancel-a-waiting-task', async () => {
    await capture(`${T('X')} tomorrow`);
    await page.waitForSelector(pendingRow(T('X')));
    await page.click(`${pendingRow(T('X'))} button[aria-label^="Cancel"]`);
    await page.waitForSelector(pendingRow(T('X')), { state: 'detached' });
  });

  await step('undated-task-offline-shows-in-added-today', async () => {
    await capture(T('U'));
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('U'))}`);
    if (await page.isVisible('#toast.show')) throw new Error('toast: ' + await page.textContent('#toast-msg'));
  });

  await step('photo-added-offline-waits', async () => {
    await page.setInputFiles('#in-photo', photo('offline.png'));
    await capture(T('F'));
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('F'))} [aria-label="Attachments, 1 waiting to upload"]`);
    await page.waitForSelector('#toast-msg:has-text("Saved offline, with the photo. Both go to Vikunja")');
  });

  await step('still-waiting-after-reopening', async () => {
    await page.reload();                                                     // e.g. the phone closed the app
    await page.waitForSelector(pendingRow(T('A')), { timeout: 15000 });
    await page.waitForSelector(pendingRow(T('P')));
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('U'))}`);
    await page.waitForSelector(`${pendingRow(T('F'))} [aria-label^="Attachments"]`);
  });

  await step('back-online-sends-everything', async () => {
    await context.setOffline(false);                                         // fires the browser's "online" event
    await page.waitForSelector('.row.pending', { state: 'detached', timeout: 20000 });
    await page.waitForSelector(`.row:not(.pending):has(.title:has-text("${T('A')}"))`);   // now a normal task
    await page.waitForSelector(`${NO_DATE} .row:not(.pending):has(.title:has-text("${T('U')}"))`);   // added today, no date
    for (const n of ['A', 'P', 'P1', 'P2', 'U', 'F']) if ((await byTitle(T(n))).length !== 1) throw new Error(`${n}: ${(await byTitle(T(n))).length} copies`);
    if ((await byTitle(T('X'))).length) throw new Error('the cancelled task was added');
    const parent = (await byTitle(T('P')))[0];
    const full = await (await api('/tasks/' + parent.id)).json();
    if ((full.related_tasks?.subtask || []).length !== 2) throw new Error('subtasks: ' + (full.related_tasks?.subtask || []).length);
    if (await page.isVisible('.offline')) throw new Error('still says offline');
    // Kept on the phone across the reload, then uploaded.
    await until('the photo added offline never reached the task', async () => (await attached('F')).join() === 'offline.png');
  });

  await step('lost-reply-is-not-added-twice', async () => {
    // The first try reaches Vikunja, but the reply never arrives.
    let cut = true;
    await page.route('**/api/v1/projects/*/tasks', async route => {
      if (cut && route.request().method() === 'PUT') { cut = false; await route.fetch(); return route.abort('internetdisconnected'); }
      return route.fallback();
    });
    await capture(`${T('D')} tomorrow`);
    // Pocket tries again as soon as a request gets through (here, the list reloading), so the waiting row may come
    // and go before it can be seen.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForSelector(`.row:not(.pending):has(.title:has-text("${T('D')}"))`, { timeout: 20000 });
    if (await page.isVisible(pendingRow(T('D')))) throw new Error('still shown as waiting');
    const copies = (await byTitle(T('D'))).length;
    if (copies !== 1) throw new Error(`${copies} copies`);
    await page.unroute('**/api/v1/projects/*/tasks');
  });

  await step('photo-upload-cut-off-keeps-the-task', async () => {
    // Online, but the connection drops as the photo uploads, and the list can't reload either.
    let cut = true;
    const cutOff = r => cut ? r.abort('internetdisconnected') : r.fallback();
    const lists = url => url.pathname.endsWith('/api/v1/tasks');
    await page.route('**/api/v1/tasks/*/attachments', cutOff);
    await page.route(lists, cutOff);
    await page.setInputFiles('#in-photo', photo('glitch.png'));
    await capture(T('G'));
    await page.waitForSelector('#toast-msg:has-text("The photo uploads when the connection")');
    // The task is in Vikunja, so it's a normal row, with its photo counted.
    await page.waitForSelector(`${NO_DATE} .row:not(.pending):has(.title:has-text("${T('G')}")) [aria-label="Attachments, 1 waiting to upload"]`);
    await page.click(`.row .body:has-text("${T('G')}")`);
    await page.waitForSelector('#d-attachments .att.uploading:has-text("glitch.png"):has-text("Waiting for a connection")');
    cut = false;
    await online();
    await page.waitForSelector('#d-attachments button.att:has-text("glitch.png")');
    if ((await attached('G')).join() !== 'glitch.png') throw new Error('attachments: ' + (await attached('G')).join());
    await page.unroute('**/api/v1/tasks/*/attachments', cutOff);
    await page.unroute(lists, cutOff);
  });

  await step('photo-whose-reply-is-lost-is-not-attached-twice', async () => {
    // From the task's sheet, still open. The upload reaches Vikunja, but the reply never arrives.
    let cut = true;
    const lose = async r => { if (!cut) return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v1/tasks/*/attachments', lose);
    await page.setInputFiles('#d-file', photo('once.png'));
    await page.waitForSelector('#d-attachments .att.uploading:has-text("once.png")');
    await online();
    await page.waitForSelector('#d-attachments button.att:has-text("once.png")');
    const names = await attached('G');
    if (names.filter(n => n === 'once.png').length !== 1) throw new Error('attachments: ' + names.join());
    await page.unroute('**/api/v1/tasks/*/attachments', lose);
  });

  await step('sheet-photos-wait-offline-and-can-be-cancelled', async () => {
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });   // the add's toast, from before
    await context.setOffline(true);
    await page.setInputFiles('#d-file', [photo('keep.png'), photo('drop.png')]);
    await page.waitForSelector('#d-attachments .att.uploading:has-text("keep.png"):has-text("Waiting for a connection")');
    await page.click('#d-attachments .att.uploading:has-text("drop.png") button[aria-label^="Don"]');
    await page.waitForSelector('#d-attachments .att:has-text("drop.png")', { state: 'detached' });
    if (await page.isVisible('#toast.show')) throw new Error('toast: ' + await page.textContent('#toast-msg'));
    await context.setOffline(false);
    await page.waitForSelector('#d-attachments button.att:has-text("keep.png")');
    const names = await attached('G');
    if (!names.includes('keep.png') || names.includes('drop.png')) throw new Error('attachments: ' + names.join());
    await page.click('#btn-sheet-close');
  });

  await step('sign-out-clears-saved-data', async () => {
    await context.setOffline(true);
    await page.setInputFiles('#in-photo', photo('dropped.png'));
    await capture(`${T('Y')} tomorrow`);                                    // waiting when signing out: Pocket asks first
    await page.waitForSelector(pendingRow(T('Y')));
    // Back online for the sign-out itself, but keep this task from being sent in the meantime.
    await page.route('**/api/v1/projects/*/tasks', r => r.request().method() === 'PUT' ? r.abort('internetdisconnected') : r.fallback());
    await context.setOffline(false);
    await page.click('#btn-account');
    await page.click('#btn-signout');
    await page.waitForSelector('#login:not([hidden])');
    const left = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('pocket.saved.') || k === 'pocket.outbox'));
    if (left.length) throw new Error('still stored: ' + left.join(', '));
    const files = await page.evaluate(() => new Promise(ok => { const r = indexedDB.open('pocket'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').count(); q.onsuccess = () => ok(q.result); }; }));
    if (files) throw new Error(`${files} waiting photos still stored`);
    await page.unroute('**/api/v1/projects/*/tasks');
    if ((await byTitle(T('Y'))).length) throw new Error('the dropped task was added');
  });
  if (errors.length) { failed++; console.log('FAIL page errors:', errors); }
} finally {
  await browser.close();
  const left = ((await (await api('/tasks?s=' + stamp)).json()) || []).filter(t => t.title.endsWith(String(stamp)));
  for (const t of left) await api('/tasks/' + t.id, { method: 'DELETE' });
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
