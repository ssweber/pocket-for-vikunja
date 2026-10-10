// Offline: Pocket opening without a connection, and tasks added offline being sent later.
//
//   npm run test:local        (runs this against a local Vikunja with the plugin)
//   VIKUNJA_URL=... VIKUNJA_TOKEN=tk_... node tests/offline.mjs
//   (ASSIGNEE=<username> ASSIGNEE_PROJECT=<project shared with them> adds a lost reply for a task with @username)
//
// Opens Pocket online once (so it's saved on the "phone"), then cuts the connection with the browser's offline switch:
// Pocket must open with the last-loaded list, queue new tasks and pasted lists, and add them all once back online.
// Also checks the case that's easy to get wrong: a task that reaches Vikunja but whose reply is lost must not be added
// twice. Photos go the same way: added offline, or cut off mid-upload, they wait on the phone and upload later, once.
// Every task it creates has the run's stamp in its title and is deleted at the end.
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';   // BROWSER=webkit runs it on Safari's engine, as on an iPhone
import { expect, hintSeen, placeSays, signIn, synced } from './helpers.mjs';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN;
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !TOKEN) { console.error('Set VIKUNJA_URL and VIKUNJA_TOKEN'); process.exit(2); }
const POCKET = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';
// Vikunja on SQLite answers 500 "database is locked" now and then, when a request comes while it's still writing what
// the one before changed: the test's own requests try again, as Pocket's do.
const api = async (path, init = {}) => {
  for (let i = 0; ; i++) {
    const r = await fetch(SERVER + '/api/v2' + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...init.headers } });
    if (r.status !== 500 || i >= 4) return r;
    await new Promise(res => setTimeout(res, 300 * (i + 1)));
  }
};
const byTitle = async title => ((await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items || []).filter(t => t.title === title);

await mkdir(OUT, { recursive: true });
const stamp = Date.now();
const T = name => `Pocket offline ${name} ${stamp}`;
const LABEL = 'pocket-smoke';                    // the label the end-to-end test uses too, so no new one is left behind
const browser = process.env.BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await hintSeen(context);                         // the one-time hint: smoke.mjs
const page = await context.newPage();
page.on('dialog', d => d.accept());
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
let failed = 0;
async function step(name, fn){
  const start = Date.now(), secs = () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`;   // each step's time, so a slow one is seen
  try { await fn(); console.log('PASS', name + secs()); }
  catch (e) { failed++; console.log('FAIL', name + secs(), '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/offline-fail-${name}.png` }).catch(() => {}); }
}
const capture = async text => { await page.fill('#in-capture', text); await page.click('#f-capture .go'); };
// A task added offline sits in the normal list, tinted, until it's sent.
const pendingRow = title => `.row.pending:has(.title:has-text("${title}"))`;
const NO_DATE = 'div:has(> .sec:has-text("Added today, no date"))';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const photo = name => ({ name, mimeType: 'image/png', buffer: PNG });
// The names of the files on a task in Vikunja.
const attached = async n => { const [t] = await byTitle(T(n)); return t ? ((await (await api('/tasks/' + t.id)).json()).attachments || []).map(a => a.file.name) : []; };
const online = () => page.evaluate(() => window.dispatchEvent(new Event('online')));   // try again now

try {
  // A task due tomorrow, so the Today list has something to remember.
  const me = await (await api('/user')).json(), projects = (await (await api('/projects')).json()).items;
  const home = me.settings?.default_project_id || projects.find(p => p.id > 0)?.id;
  const seeded = await api(`/projects/${home}/tasks`, { method: 'POST', body: JSON.stringify({ title: T('seed'), due_date: new Date(Date.now() + 86400000).toISOString() }) });
  if (!seeded.ok) throw new Error('could not create the seed task: HTTP ' + seeded.status);

  await step('online-first-visit', async () => {
    await signIn(page, POCKET, TOKEN);
    await page.waitForSelector(`.row .title:has-text("${T("seed")}")`, { timeout: 15000 });
    await page.evaluate(() => navigator.serviceWorker.ready);                // Pocket is now saved for offline use
    await page.reload();                                                     // and this page is served by the service worker
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    await page.waitForSelector(`.row .title:has-text("${T("seed")}")`, { timeout: 15000 });
  });

  await step('reads-dates-offline-straight-after-install', async () => {
    // The first page wasn't the service worker's: its saved copy of chrono must still be found offline, though Vikunja
    // answers "Vary: Origin" and the page asks for it with an Origin.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await hintSeen(ctx);
    const p = await ctx.newPage();
    try {
      await signIn(p, POCKET, TOKEN);
      await p.evaluate(() => navigator.serviceWorker.ready);
      await ctx.setOffline(true);
      await p.reload();
      await p.waitForSelector('#app:not([hidden])', { timeout: 15000 });
      await p.fill('#in-capture', 'Order milk fri at 9');
      await p.waitForSelector('#cap-chips .chip[data-kind=due]:has-text("9:00")', { timeout: 5000 });
    } finally { await ctx.close(); }
  });

  /* Opening Pocket again is answered from the page it saved, at once, and the page is fetched behind it and saved for
     the next opening (sw.js). The saved copy is given a mark: the next opening shows it, the one after doesn't. */
  await step('opens-from-the-saved-page-and-saves-the-new-one-behind-it', async () => {
    const savedPage = mark => page.evaluate(async mark => {
      const cache = await caches.open((await caches.keys()).find(k => k.startsWith('pocket-')));
      const url = new URL('index.html', location.href).href, kept = await cache.match(url), html = await kept.text();
      if (mark) await cache.put(url, new Response(html.replace('<head>', '<head><meta name="saved-copy">'), { headers: { 'Content-Type': 'text/html', 'Last-Modified': kept.headers.get('Last-Modified') || '' } }));
      return html.includes('<meta name="saved-copy">');
    }, mark);
    await savedPage(true);
    await page.reload();
    await expect(page.locator('meta[name="saved-copy"]')).toHaveCount(1);
    await page.waitForSelector(`.row .title:has-text("${T("seed")}")`, { timeout: 15000 });
    await expect.poll(() => savedPage(false)).toBe(false);                  // the page fetched behind it, saved
    await page.reload();
    await expect(page.locator('meta[name="saved-copy"]')).toHaveCount(0);
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
    // Its words are back in the box, to change or add again, and the box says so.
    if (await page.inputValue('#in-capture') !== `${T('X')} tomorrow`) throw new Error('box: ' + await page.inputValue('#in-capture'));
    await placeSays(page, 'cap', 'Cancelled. It\'s back in the box.');
    await page.fill('#in-capture', '');
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });
  });

  await step('the-header-says-what-is-waiting', async () => {
    // Refresh becomes what's waiting, with how many; tapping it lists them, and one can be dropped from there.
    await page.waitForSelector('#btn-refresh.waits[aria-label$="waiting to send"] #outbox-count');
    await expect(page.locator('html')).toHaveAttribute('data-sync', 'waiting');   // what the tests' synced() waits on
    await capture(`${T('Y')} tomorrow`);
    await page.waitForSelector(pendingRow(T('Y')));
    await page.click('#btn-refresh');
    await page.waitForSelector('#outbox-status:has-text("No connection")');
    for (const text of [`New task: ${T('A')}`, `New task: ${T('P')}`, `Subtask of “${T('P')}”: ${T('P1')}`, `New task: ${T('Y')}`])
      await page.waitForSelector(`#outbox-rows .ob-row:has-text("${text}")`);
    if (await page.textContent('#outbox-count') !== String(await page.locator('#outbox-rows .ob-row').count())) throw new Error('the count isn\'t the rows');
    await page.click(`#outbox-rows .ob-row:has-text("${T('Y')}") .ob-drop`);
    await page.waitForSelector(`#outbox-rows .ob-row:has-text("${T('Y')}")`, { state: 'detached' });
    await page.click('#btn-sheet-close');
    if (await page.inputValue('#in-capture') !== `${T('Y')} tomorrow`) throw new Error('box: ' + await page.inputValue('#in-capture'));
    await page.fill('#in-capture', '');
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });
  });

  await step('undated-task-offline-shows-in-added-today', async () => {
    await capture(T('U'));
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('U'))}`);
    if (await page.isVisible('#toast.show')) throw new Error('toast: ' + await page.textContent('#toast-msg'));
  });

  await step('photo-added-offline-waits', async () => {
    await page.setInputFiles('#in-photo', photo('offline.png'));
    await capture(T('F'));
    // On Today, on one line, a screen reader hears it (labels and counts are off Today)
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('F'))} .title .sr:has-text("Attachments, 1 waiting to upload")`, { state: 'attached' });
    await placeSays(page, 'cap', 'Saved offline, with the photo. Both go to Vikunja');                // by the add box
  });

  await step('still-waiting-after-reopening', async () => {
    await page.reload();                                                     // e.g. the phone closed the app
    await page.waitForSelector(pendingRow(T('A')), { timeout: 15000 });
    await page.waitForSelector(pendingRow(T('P')));
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('U'))}`);
    await page.waitForSelector(`${pendingRow(T('F'))} .title .sr:has-text("waiting to upload")`, { state: 'attached' });
  });

  await step('back-online-sends-everything', async () => {
    await context.setOffline(false);                                         // fires the browser's "online" event
    await synced(page);
    await expect(page.locator('.row.pending')).toHaveCount(0);
    await page.waitForSelector(`.row:not(.pending):has(.title:has-text("${T('A')}"))`);   // now a normal task
    await page.waitForSelector(`${NO_DATE} .row:not(.pending):has(.title:has-text("${T('U')}"))`);   // added today, no date
    for (const n of ['A', 'P', 'P1', 'P2', 'U', 'F']) if ((await byTitle(T(n))).length !== 1) throw new Error(`${n}: ${(await byTitle(T(n))).length} copies`);
    if ((await byTitle(T('X'))).length || (await byTitle(T('Y'))).length) throw new Error('a cancelled task was added');
    const parent = (await byTitle(T('P')))[0];
    const full = await (await api('/tasks/' + parent.id)).json();
    if ((full.related_tasks?.subtask || []).length !== 2) throw new Error('subtasks: ' + (full.related_tasks?.subtask || []).length);
    if (await page.isVisible('.offline')) throw new Error('still says offline');
    // Kept on the phone across the reload, then uploaded.
    if ((await attached('F')).join() !== 'offline.png') throw new Error('the photo added offline never reached the task');
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).not.toHaveClass(/waits/);   // nothing waiting
  });

  await step('lost-reply-is-not-added-twice', async () => {
    // The first try reaches Vikunja, but the reply never arrives.
    let cut = true;
    await page.route('**/api/v2/projects/*/tasks', async route => {
      if (cut && route.request().method() === 'POST') { cut = false; await route.fetch(); return route.abort('internetdisconnected'); }
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
    await page.unroute('**/api/v2/projects/*/tasks');
  });

  await step('photo-upload-cut-off-keeps-the-task', async () => {
    // Online, but the connection drops as the photo uploads, and the list can't reload either.
    let cut = true;
    const cutOff = r => cut ? r.abort('internetdisconnected') : r.fallback();
    const lists = url => url.pathname.endsWith('/api/v2/tasks');
    await page.route('**/api/v2/tasks/*/attachments', cutOff);
    await page.route(lists, cutOff);
    await page.setInputFiles('#in-photo', photo('glitch.png'));
    await capture(T('G'));
    await placeSays(page, 'cap', 'The photo uploads when the connection');
    // The task is in Vikunja, so it's a normal row, with its photo waiting (said, on Today's one line).
    await page.waitForSelector(`${NO_DATE} .row:not(.pending):has(.title:has-text("${T('G')}")) .title .sr:has-text("Attachments, 1 waiting to upload")`, { state: 'attached' });
    await page.click(`.row .body:has-text("${T('G')}")`);
    await page.waitForSelector('#d-attachments .att.uploading:has-text("glitch.png"):has-text("Waiting for a connection")');
    cut = false;
    await online();
    await page.waitForSelector('#d-attachments button.att:has-text("glitch.png")');
    if ((await attached('G')).join() !== 'glitch.png') throw new Error('attachments: ' + (await attached('G')).join());
    await page.unroute('**/api/v2/tasks/*/attachments', cutOff);
    await page.unroute(lists, cutOff);
  });

  await step('photo-whose-reply-is-lost-is-not-attached-twice', async () => {
    // From the task's sheet, still open. The upload reaches Vikunja, but the reply never arrives.
    let cut = true;
    const lose = async r => { if (!cut) return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/tasks/*/attachments', lose);
    await page.setInputFiles('#d-file', photo('once.png'));
    await page.waitForSelector('#d-attachments .att.uploading:has-text("once.png")');
    await online();
    await page.waitForSelector('#d-attachments button.att:has-text("once.png")');
    const names = await attached('G');
    if (names.filter(n => n === 'once.png').length !== 1) throw new Error('attachments: ' + names.join());
    await page.unroute('**/api/v2/tasks/*/attachments', lose);
  });

  await step('server-error-keeps-the-photo', async () => {
    // Vikunja answers 500 once: the photo waits, says so, and goes up on the next try.
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });   // the add's toast, from before
    let busy = true;
    const answer = r => { if (!busy) return r.fallback(); busy = false; return r.fulfill({ status: 500, contentType: 'application/problem+json', body: '{"title":"Internal Server Error","status":500,"detail":"Internal Server Error"}' }); };
    await page.route('**/api/v2/tasks/*/attachments', answer);
    await page.setInputFiles('#d-file', photo('busy.png'));
    await page.waitForSelector('#d-attachments .att.uploading:has-text("busy.png"):has-text("Vikunja had a problem with it. Trying again.")');
    if (await page.isVisible('#toast.show')) throw new Error('toast: ' + await page.textContent('#toast-msg'));
    await online();
    await page.waitForSelector('#d-attachments button.att:has-text("busy.png")');
    await page.unroute('**/api/v2/tasks/*/attachments', answer);
  });

  await step('sheet-photos-wait-offline-and-can-be-cancelled', async () => {
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

  await step('subtasks-added-offline-wait', async () => {
    // The sheet's subtask box goes through the outbox too: offline, a subtask waits in the sheet, then is sent.
    await page.click(`.row .body:has-text("${T('G')}")`);
    await page.waitForSelector('#d-subin');
    await context.setOffline(true);
    await page.fill('#d-subin', T('G1'));
    await page.press('#d-subin', 'Enter');
    await page.waitForSelector(`#d-subtasks .row.pending:has-text("${T('G1')}"):has-text("Waiting for a connection")`);
    if (await page.evaluate(() => document.activeElement?.id) !== 'd-subin') throw new Error('the box lost the focus');
    await context.setOffline(false);
    await online();
    await page.waitForSelector(`#d-subtasks .row:not(.pending) .title:text-is("${T('G1')}")`, { timeout: 20000 });
    const [g] = await byTitle(T('G'));
    const subs = (await (await api('/tasks/' + g.id)).json()).related_tasks?.subtask || [];
    if (subs.filter(s => s.title === T('G1')).length !== 1) throw new Error('subtasks: ' + subs.map(s => s.title).join(' | '));
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('comment-written-offline-waits', async () => {
    // A comment goes through the outbox too; the banner says what needs a connection. (On Today, with its subtask, it's a
    // card now: its title opens it.)
    await page.click(`:is(.row .body:has-text("${T('G')}"), .day-card:has(.card-title:has-text("${T('G')}")) > .card-head)`);
    await page.waitForSelector('#d-cin');
    await context.setOffline(true);
    await page.fill('#d-cin', T('comment'));
    await page.click('#d-cform button');
    await page.waitForSelector(`#d-comments .comment.waiting:has-text("${T('comment')}"):has-text("Waiting for a connection")`);
    if (!(await page.textContent('.offline')).includes('Ticking off or changing tasks needs a connection, except on a run')) throw new Error('banner: ' + await page.textContent('.offline'));
    await context.setOffline(false);
    await online();
    await page.waitForSelector(`#d-comments .comment:not(.waiting):has-text("${T('comment')}")`, { timeout: 20000 });
    const [g] = await byTitle(T('G'));
    const got = await (await api(`/tasks/${g.id}/comments`)).json(), list = Array.isArray(got) ? got : got.items || [];
    if (list.filter(c => c.comment.includes(T('comment'))).length !== 1) throw new Error('comments: ' + list.length);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('a-subtask-from-the-add-box-waits-offline', async () => {
    // On its project's list, the add box adds subtasks to the task whose sheet was opened: offline, one waits under it,
    // on its card (a task with an open subtask is a stacked card there, open). The light follows it: its waiting row
    // is the one row lit, named by the line over the box, and still is once it's sent.
    const [g] = await byTitle(T('G'));
    await page.evaluate(id => { location.hash = '#/project/' + id; }, g.project_id);
    const card = page.locator(`#view .day-card[data-id="${g.id}"]`);
    await card.evaluate(el => el.scrollIntoView({ block: 'center' }), null, { timeout: 15000 });
    await card.locator('> .card-head .card-open').click();
    await page.waitForSelector('#sheet .row.own');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(page.locator('#cap-target')).toHaveText(`Add a subtask to ${T('G')}`);
    await expect(card).toHaveClass(/\baimed\b/);
    await context.setOffline(true);
    await page.fill('#in-capture', T('G2'));
    await page.press('#in-capture', 'Enter');
    // Waiting, under it, after its other subtask; nothing said, and the box keeps the focus.
    const waiting = card.locator(`.card-rows > .row.pending:has-text("${T('G2')}")`);
    await expect(waiting).toBeVisible();
    await expect(waiting).toHaveClass(/\baimed\b/);
    await expect(page.locator('#view .aimed')).toHaveCount(1);                 // the card's own header is dark
    await expect(page.locator('#cap-target')).toHaveText(`Add a subtask to ${T('G')}, after ${T('G2')}`);
    const order = await page.locator('#view :is(.card-title, .row .title)').evaluateAll(els => els.map(el => el.textContent || ''));
    const at = order.findIndex(t => t.includes(T('G')) && !t.includes(T('G1')) && !t.includes(T('G2')));
    if (!order[at + 1]?.includes(T('G1')) || !order[at + 2]?.includes(T('G2'))) throw new Error('rows: ' + order.slice(at, at + 3).join(' | '));
    if (await page.evaluate(() => document.activeElement?.id) !== 'in-capture') throw new Error('the box lost the focus');
    await expect(page.locator('.place-line[data-place="cap"]')).toHaveCount(0);
    await context.setOffline(false);
    await online();
    await expect(page.locator(`#view .row:not(.pending):has-text("${T('G2')}")`)).toBeVisible({ timeout: 20000 });
    await expect(page.locator(`#view .row:not(.pending):has-text("${T('G2')}")`)).toHaveClass(/\baimed\b/);
    await expect(page.locator('#view .aimed')).toHaveCount(1);
    await expect(page.locator('#cap-target')).toHaveText(`Add a subtask to ${T('G')}, after ${T('G2')}`);
    await synced(page);
    const subs = (await (await api('/tasks/' + g.id)).json()).related_tasks?.subtask || [];
    if (subs.filter(s => s.title === T('G2')).length !== 1) throw new Error('subtasks: ' + subs.map(s => s.title).join(' | '));
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
  });

  await step('cut-off-label-is-still-added', async () => {
    // The task reaches Vikunja, then the connection drops before its label is on it.
    let cut = true;
    const drop = r => { if (!cut || r.request().method() !== 'POST') return r.fallback(); cut = false; return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/tasks/*/labels', drop);
    await capture(`${T('L')} tomorrow *${LABEL}`);
    await page.waitForSelector(`.row:has(.title:has-text("${T('L')}"))`);     // shown straight away, as it's in Vikunja
    await online();
    await synced(page);
    if (!(await byTitle(T('L')))[0]?.labels?.some(l => l.title === LABEL)) throw new Error('the label never reached the task');
    if ((await byTitle(T('L'))).length !== 1) throw new Error((await byTitle(T('L'))).length + ' copies');
    await page.unroute('**/api/v2/tasks/*/labels', drop);
  });

  if (process.env.ASSIGNEE) await step('assigned-task-whose-reply-is-lost-is-added-once', async () => {
    // The @username leaves the title, so the retry must look for the title as it was sent.
    const who = process.env.ASSIGNEE, where = process.env.ASSIGNEE_PROJECT ? ` +"${process.env.ASSIGNEE_PROJECT}"` : '';
    let cut = true;
    const lose = async r => { if (!cut || r.request().method() !== 'POST') return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/projects/*/tasks', lose);
    await capture(`${T('B')} tomorrow @${who}${where}`);
    await online();
    await synced(page);
    if (!(await byTitle(T('B')))[0]?.assignees?.some(u => u.username === who)) throw new Error('the task was never assigned');
    await expect(page.locator('.row.pending')).toHaveCount(0);
    if ((await byTitle(T('B'))).length !== 1) throw new Error((await byTitle(T('B'))).length + ' copies');
    await page.unroute('**/api/v2/projects/*/tasks', lose);
  });

  await step('no-room-on-the-phone-waits-while-open', async () => {
    // Pocket's storage is full, and the connection drops as the photo of a new task uploads: the photo waits in memory,
    // with a message saying so, and goes up once the connection's back.
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });
    await page.evaluate(() => {
      const put = window.realPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...a){ if (this.name === 'outbox') throw new DOMException('full', 'QuotaExceededError'); return put.apply(this, a); };
    });
    let cut = true;
    const cutOff = r => cut ? r.abort('internetdisconnected') : r.fallback();
    await page.route('**/api/v2/tasks/*/attachments', cutOff);
    await page.setInputFiles('#in-photo', photo('full.png'));
    await capture(T('S'));
    await placeSays(page, 'cap', 'no room left on this phone to keep this until there\'s a connection. Keep Pocket open');
    await page.waitForSelector(`.row:has(.title:has-text("${T('S')}")) .title .sr:has-text("Attachments, 1 waiting to upload")`, { state: 'attached' });
    cut = false;
    await online();
    await synced(page);
    if ((await attached('S')).join() !== 'full.png') throw new Error('the photo never reached the task');
    if ((await byTitle(T('S'))).length !== 1) throw new Error((await byTitle(T('S'))).length + ' copies');
    await page.unroute('**/api/v2/tasks/*/attachments', cutOff);
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.realPut; });
  });

  await step('same-title-twice-stays-two-tasks', async () => {
    // The second "Buy milk" never reaches Vikunja on its first try; the retry mustn't take the first one for it.
    await capture(T('M'));
    await page.waitForSelector(`.row:not(.pending):has(.title:has-text("${T('M')}"))`);
    const drop = r => r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback();
    await page.route('**/api/v2/projects/*/tasks', drop);
    await capture(T('M'));
    await page.waitForSelector(pendingRow(T('M')));
    await page.unroute('**/api/v2/projects/*/tasks', drop);
    await online();
    await synced(page);
    if ((await byTitle(T('M'))).length !== 2) throw new Error((await byTitle(T('M'))).length + ' copies');
  });

  await step('same-title-made-elsewhere-is-not-taken', async () => {
    // A task made on the web, then one with the same title in Pocket that never reaches Vikunja on its first try.
    const [me] = await byTitle(T('M'));                                      // a project to put it in
    await api(`/projects/${me.project_id}/tasks`, { method: 'POST', body: JSON.stringify({ title: T('E') }) });
    await page.waitForTimeout(4000);                                         // a little later, as a person would
    const drop = r => r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback();
    await page.route('**/api/v2/projects/*/tasks', drop);
    await capture(T('E'));
    await page.waitForSelector(pendingRow(T('E')));
    await page.unroute('**/api/v2/projects/*/tasks', drop);
    await online();
    await synced(page);
    if ((await byTitle(T('E'))).length !== 2) throw new Error((await byTitle(T('E'))).length + ' copies');
  });

  await step('subtask-link-whose-reply-is-lost', async () => {
    // A pasted list under its first line: the link reaches Vikunja but its reply doesn't. The retry finds it made.
    let cut = true;
    const lose = async r => { if (!cut || r.request().method() !== 'POST') return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/tasks/*/relations', lose);
    await page.fill('#in-capture', `${T('K')} tomorrow\n- ${T('K1')}\n- ${T('K2')}`);
    await page.click('#cap-nest');
    await page.click('#f-capture .go');
    await online();
    await synced(page);
    if ((await byTitle(T('K2'))).length !== 1) throw new Error('the list was never finished');
    const [parent] = await byTitle(T('K'));
    const full = await (await api('/tasks/' + parent.id)).json();
    if ((full.related_tasks?.subtask || []).length !== 2) throw new Error('subtasks: ' + (full.related_tasks?.subtask || []).length);
    if ((await page.textContent('#toast-msg')).includes("couldn't")) throw new Error('toast: ' + await page.textContent('#toast-msg'));
    await page.unroute('**/api/v2/tasks/*/relations', lose);
  });

  await step('a-pasted-list-with-several-parents-waits-and-keeps-its-shape', async () => {
    // Two headings, each over its lines, one line done already. Added while Vikunja can't be reached, each parent waits
    // on Today with its lines under it, not rows of their own; sent, each line is under the one it was under, and the
    // done one is done.
    const drop = r => r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback();
    await page.route('**/api/v2/projects/*/tasks', drop);
    await page.fill('#in-capture', `## ${T('H1')} tomorrow\n- ${T('H1a')}\n- [x] ${T('H1b')}\n## ${T('H2')} tomorrow\n- ${T('H2a')}`);
    await page.click('#f-capture .go');
    await page.waitForSelector(pendingRow(T('H1')));
    await page.waitForSelector(pendingRow(T('H2')));
    if (await page.isVisible(pendingRow(T('H1a'))) || await page.isVisible(pendingRow(T('H2a')))) throw new Error('a subtask is shown in Today');
    // Each parent's Cancel says what becomes of the lines waiting under it, the second's too.
    await expect(page.locator(`${pendingRow(T('H1'))} button[aria-label^="Cancel"]`)).toHaveAttribute('aria-label', `Cancel ${T('H1')}: the lines under it become tasks of their own`);
    await expect(page.locator(`${pendingRow(T('H2'))} button[aria-label^="Cancel"]`)).toHaveAttribute('aria-label', `Cancel ${T('H2')}: the line under it becomes a task of its own`);
    await page.unroute('**/api/v2/projects/*/tasks', drop);
    await online();
    await synced(page);
    const subs = async t => ((await (await api('/tasks/' + (await byTitle(t))[0]?.id)).json()).related_tasks?.subtask || []).map(s => [s.title, s.done]).sort();
    if (JSON.stringify(await subs(T('H1'))) !== JSON.stringify([[T('H1a'), false], [T('H1b'), true]])) throw new Error('under the first heading: ' + JSON.stringify(await subs(T('H1'))));
    if (JSON.stringify(await subs(T('H2'))) !== JSON.stringify([[T('H2a'), false]])) throw new Error('under the second: ' + JSON.stringify(await subs(T('H2'))));
  });

  await step('waiting-work-from-an-older-pocket-moves-over', async () => {
    // An older Pocket kept its outbox in localStorage. Opening this one moves it to the database, and sends it.
    await context.setOffline(true);
    await page.evaluate(([title, pid]) => {
      const user = JSON.parse(localStorage.getItem('pocket.saved.user')).id;
      const p = { title, due: null, priority: 0, repeat: null, labels: [], assignees: [], project: null };
      localStorage.setItem('pocket.outbox', JSON.stringify([{ id: 'old1', user, at: new Date().toISOString(), nest: false, pid,
        items: [{ raw: title, p, taskId: null, tried: false, linked: false }], files: [] }]));
    }, [T('O'), home]);
    await page.reload();
    await page.waitForSelector(pendingRow(T('O')), { timeout: 15000 });
    if (await page.evaluate(() => localStorage.getItem('pocket.outbox'))) throw new Error('still in localStorage');
    await context.setOffline(false);
    await page.waitForSelector(pendingRow(T('O')), { state: 'detached', timeout: 20000 });
    if ((await byTitle(T('O'))).length !== 1) throw new Error((await byTitle(T('O'))).length + ' copies');
  });

  await step('two-tabs-send-it-once', async () => {
    // Added offline in one tab, the task shows as waiting in the other too; back online, both try, and it's added once.
    const other = await context.newPage();
    other.on('pageerror', e => errors.push(String(e)));
    await other.goto(POCKET);
    await other.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
    await context.setOffline(true);
    await capture(`${T('W')} tomorrow`);
    await page.waitForSelector(pendingRow(T('W')));
    await other.waitForSelector(pendingRow(T('W')), { timeout: 10000 });
    await context.setOffline(false);
    await page.waitForSelector(pendingRow(T('W')), { state: 'detached', timeout: 20000 });
    await other.waitForSelector(pendingRow(T('W')), { state: 'detached', timeout: 20000 });
    if ((await byTitle(T('W'))).length !== 1) throw new Error((await byTitle(T('W'))).length + ' copies');
    await other.close();
  });

  await step('sign-out-clears-saved-data', async () => {
    await context.setOffline(true);
    await page.setInputFiles('#in-photo', photo('dropped.png'));
    await capture(`${T('Y')} tomorrow`);                                    // waiting when signing out: Pocket asks first
    await page.waitForSelector(pendingRow(T('Y')));
    // Back online for the sign-out itself, but keep this task from being sent in the meantime.
    await page.route('**/api/v2/projects/*/tasks', r => r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback());
    await context.setOffline(false);
    await page.click('#btn-account');
    await page.click('#btn-signout');
    await page.waitForSelector('#login:not([hidden])');
    const left = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('pocket.saved.') || k === 'pocket.outbox'));
    if (left.length) throw new Error('still stored: ' + left.join(', '));
    const count = name => page.evaluate(n => new Promise(ok => { const r = indexedDB.open('pocket'); r.onsuccess = () => { const q = r.result.transaction(n).objectStore(n).count(); q.onsuccess = () => { r.result.close(); ok(q.result); }; }; }), name);
    if (await count('files')) throw new Error(`${await count('files')} waiting photos still stored`);
    if (await count('outbox')) throw new Error(`${await count('outbox')} waiting tasks still stored`);
    await page.unroute('**/api/v2/projects/*/tasks');
    if ((await byTitle(T('Y'))).length) throw new Error('the dropped task was added');
  });
  if (errors.length) { failed++; console.log('FAIL page errors:', errors); }
} finally {
  await browser.close();
  const left = ((await (await api('/tasks?q=' + stamp)).json()).items || []).filter(t => t.title.endsWith(String(stamp)));
  // A few tries: a Vikunja on SQLite (the local one with DB=sqlite) can answer 500 "database is locked" while busy.
  for (const t of left) for (let i = 0; i < 5 && !(await api('/tasks/' + t.id, { method: 'DELETE' })).ok; i++) await new Promise(ok => setTimeout(ok, 500));
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
