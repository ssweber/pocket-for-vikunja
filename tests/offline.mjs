// Offline: Pocket opening without a connection, and tasks added offline being sent later.
//
//   npm run test:local        (runs this against a local Vikunja with the plugin)
//   VIKUNJA_URL=... VIKUNJA_TOKEN=tk_... node tests/offline.mjs
//
// Opens Pocket online once (so it's saved on the "phone"), then cuts the connection with the browser's offline switch:
// Pocket must open with the last-loaded list, queue new tasks and pasted lists, and add them all once back online.
// Also checks the case that's easy to get wrong: a task that reaches Vikunja but whose reply is lost must not be added
// twice. Every task it creates has the run's stamp in its title and is deleted at the end.
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

  await step('still-waiting-after-reopening', async () => {
    await page.reload();                                                     // e.g. the phone closed the app
    await page.waitForSelector(pendingRow(T('A')), { timeout: 15000 });
    await page.waitForSelector(pendingRow(T('P')));
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('U'))}`);
  });

  await step('back-online-sends-everything', async () => {
    await context.setOffline(false);                                         // fires the browser's "online" event
    await page.waitForSelector('.row.pending', { state: 'detached', timeout: 20000 });
    await page.waitForSelector(`.row:not(.pending):has(.title:has-text("${T('A')}"))`);   // now a normal task
    await page.waitForSelector(`${NO_DATE} .row:not(.pending):has(.title:has-text("${T('U')}"))`);   // added today, no date
    for (const n of ['A', 'P', 'P1', 'P2', 'U']) if ((await byTitle(T(n))).length !== 1) throw new Error(`${n}: ${(await byTitle(T(n))).length} copies`);
    if ((await byTitle(T('X'))).length) throw new Error('the cancelled task was added');
    const parent = (await byTitle(T('P')))[0];
    const full = await (await api('/tasks/' + parent.id)).json();
    if ((full.related_tasks?.subtask || []).length !== 2) throw new Error('subtasks: ' + (full.related_tasks?.subtask || []).length);
    if (await page.isVisible('.offline')) throw new Error('still says offline');
  });

  await step('lost-reply-is-not-added-twice', async () => {
    // The first try reaches Vikunja, but the reply never arrives.
    let cut = true;
    await page.route('**/api/v1/projects/*/tasks', async route => {
      if (cut && route.request().method() === 'PUT') { cut = false; await route.fetch(); return route.abort('internetdisconnected'); }
      return route.fallback();
    });
    await capture(`${T('D')} tomorrow`);
    await page.waitForSelector(pendingRow(T('D')));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));   // try again
    await page.waitForSelector(pendingRow(T('D')), { state: 'detached', timeout: 20000 });
    const copies = (await byTitle(T('D'))).length;
    if (copies !== 1) throw new Error(`${copies} copies`);
    await page.unroute('**/api/v1/projects/*/tasks');
  });

  await step('sign-out-clears-saved-data', async () => {
    await context.setOffline(true);
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
