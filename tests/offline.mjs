// Offline: Pocket opening without a connection, and tasks added offline being sent later.
//
//   npm run test:local        (runs this against a local Vikunja with the plugin)
//   VIKUNJA_URL=... VIKUNJA_USER=... VIKUNJA_PASSWORD=... VIKUNJA_TOKEN=tk_... node tests/offline.mjs
//   (ASSIGNEE=<username> ASSIGNEE_PROJECT=<project shared with them> adds a lost reply for a task with @username)
//
// Opens Pocket online once so it is saved on the "phone", then goes offline with the browser's offline switch. Pocket
// must open with the last loaded list, queue new tasks and pasted lists, and send them all once it is back online.
// It also checks an easy mistake: a task that reaches Vikunja but whose reply is lost must not be added twice.
// Photos behave the same way. A photo added offline, or cut off mid-upload, waits on the phone and is uploaded once later.
// Every task the test creates has the test run's timestamp in its title and is deleted at the end.
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright'; // BROWSER=webkit uses Safari's engine, as an iPhone does
import { expect, hintSeen, placeLine, placeSays, signIn, steady, synced } from './helpers.mjs';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN,
  USER = process.env.VIKUNJA_USER,
  PASSWORD = process.env.VIKUNJA_PASSWORD;
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !TOKEN || !USER || !PASSWORD) {
  console.error('Set VIKUNJA_URL, VIKUNJA_TOKEN, VIKUNJA_USER and VIKUNJA_PASSWORD');
  process.exit(2);
}
const POCKET = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';
// Vikunja on SQLite sometimes answers 500 "database is locked" when a request arrives while it is still writing the
// previous request's changes. The test retries its own requests, as Pocket does.
const api = async (path, init = {}) => {
  for (let i = 0; ; i++) {
    const r = await fetch(SERVER + '/api/v2' + path, {
      ...init,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...init.headers },
    });
    if (r.status !== 500 || i >= 4) return r;
    await new Promise(res => setTimeout(res, 300 * (i + 1)));
  }
};
const byTitle = async title =>
  ((await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items || []).filter(t => t.title === title);

await mkdir(OUT, { recursive: true });
const stamp = Date.now();
const T = name => `Pocket offline ${name} ${stamp}`;
const LABEL = 'pocket-smoke'; // the label smoke.mjs also uses, so this test leaves no new label behind
const browser =
  process.env.BROWSER === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await hintSeen(context); // dismisses the one-time hint (see helpers.mjs)
const page = await context.newPage();
page.on('dialog', d => d.accept());
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
let failed = 0;
async function step(name, fn) {
  const start = Date.now(),
    secs = () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`; // shows each step's duration so slow steps stand out
  try {
    await fn();
    console.log('PASS', name + secs());
  } catch (e) {
    failed++;
    console.log(
      'FAIL',
      name + secs(),
      '-',
      e.message
        .split('\n')
        .slice(0, process.env.VERBOSE ? 8 : 1)
        .join(' · '),
    );
    await page.screenshot({ path: `${OUT}/offline-fail-${name}.png` }).catch(() => {});
  }
}
const capture = async text => {
  await page.fill('#in-capture', text);
  await page.click('#f-capture .go');
};
// A task added offline appears in the normal list with a tint until it is sent.
const pendingRow = title => `.row.pending:has(.title:has-text("${title}"))`;
const NO_DATE = 'div:has(> .sec:has-text("Added today, no date"))';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const photo = name => ({ name, mimeType: 'image/png', buffer: PNG });
// The file names of a task's attachments in Vikunja.
const attached = async n => {
  const [t] = await byTitle(T(n));
  return t ? ((await (await api('/tasks/' + t.id)).json()).attachments || []).map(a => a.file.name) : [];
};
const online = () => page.evaluate(() => window.dispatchEvent(new Event('online'))); // makes Pocket retry now
// What is waiting in the outbox, as IndexedDB holds it.
const outboxOf = p =>
  p.evaluate(
    () =>
      new Promise(ok => {
        const r = indexedDB.open('pocket');
        r.onsuccess = () => {
          const q = r.result.transaction('outbox').objectStore('outbox').getAll();
          q.onsuccess = () => {
            r.result.close();
            ok(q.result);
          };
        };
      }),
  );
const sameTime = (a, b) => Date.parse(a) === Date.parse(b);

try {
  // A task due tomorrow, so there is something for Pocket to save for offline use.
  const me = await (await api('/user')).json(),
    projects = (await (await api('/projects')).json()).items;
  const home = me.settings?.default_project_id || projects.find(p => p.id > 0)?.id;
  const seeded = await api(`/projects/${home}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title: T('seed'), due_date: new Date(Date.now() + 86400000).toISOString() }),
  });
  if (!seeded.ok) throw new Error('could not create the seed task: HTTP ' + seeded.status);

  await step('online-first-visit', async () => {
    await signIn(page, POCKET, USER, PASSWORD);
    await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
    await page.evaluate(() => navigator.serviceWorker.ready); // Pocket is now saved for offline use
    await page.reload(); // so the service worker serves this page
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
  });

  await step('reads-dates-offline-straight-after-install', async () => {
    // The first page load wasn't served by the service worker. The saved copy of chrono must still be found offline,
    // although Vikunja answers with "Vary: Origin" and the page requests chrono with an Origin header.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await hintSeen(ctx);
    const p = await ctx.newPage();
    try {
      await signIn(p, POCKET, USER, PASSWORD);
      await p.evaluate(() => navigator.serviceWorker.ready);
      await ctx.setOffline(true);
      await p.reload();
      await p.waitForSelector('#app:not([hidden])', { timeout: 15000 });
      await p.fill('#in-capture', 'Order milk fri at 9');
      await p.waitForSelector('#cap-chips .chip[data-kind=due]:has-text("9:00")', { timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });

  /* Opening Pocket again shows the saved page at once. The service worker fetches a fresh page in the background and
     saves it for the next opening (sw.js). The test marks the saved copy, so the next opening shows the mark and the
     opening after that doesn't. */
  await step('opens-from-the-saved-page-and-saves-the-new-one-behind-it', async () => {
    const savedPage = mark =>
      page.evaluate(async mark => {
        const cache = await caches.open((await caches.keys()).find(k => k.startsWith('pocket-')));
        const url = new URL('index.html', location.href).href,
          kept = await cache.match(url),
          html = await kept.text();
        if (mark)
          await cache.put(
            url,
            new Response(html.replace('<head>', '<head><meta name="saved-copy">'), {
              headers: { 'Content-Type': 'text/html', 'Last-Modified': kept.headers.get('Last-Modified') || '' },
            }),
          );
        return html.includes('<meta name="saved-copy">');
      }, mark);
    await savedPage(true);
    await page.reload();
    await expect(page.locator('meta[name="saved-copy"]')).toHaveCount(1);
    await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
    await expect.poll(() => savedPage(false)).toBe(false); // the fresh page was fetched in the background and saved
    await page.reload();
    await expect(page.locator('meta[name="saved-copy"]')).toHaveCount(0);
    await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
  });

  await step('opens-offline-with-last-list', async () => {
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
    const banner = await page.textContent('.offline');
    if (!banner.includes('Offline') || !banner.includes('showing tasks from')) throw new Error('banner: ' + banner);
  });

  await step('task-added-offline-waits', async () => {
    await capture(`${T('A')} tomorrow`);
    await page.waitForSelector(pendingRow(T('A'))); // in Next 7 days, where the task belongs
    if (await page.isVisible('#toast.show'))
      throw new Error('unexpected toast: ' + (await page.textContent('#toast-msg')));
  });

  await step('pasted-list-offline-waits', async () => {
    await page.fill('#in-capture', `${T('P')} tomorrow\n- ${T('P1')}\n- ${T('P2')}`);
    await page.click('#cap-nest');
    await page.click('#f-capture .go');
    await page.waitForSelector(pendingRow(T('P')));
    if (await page.isVisible(pendingRow(T('P1')))) throw new Error('a subtask is shown in Today'); // only the parent should show
  });

  await step('cancel-a-waiting-task', async () => {
    await capture(`${T('X')} tomorrow`);
    await page.waitForSelector(pendingRow(T('X')));
    await page.click(`${pendingRow(T('X'))} button[aria-label^="Cancel"]`);
    await page.waitForSelector(pendingRow(T('X')), { state: 'detached' });
    // The task's text returns to the add box so the user can change it or add it again, and a message tells them.
    if ((await page.inputValue('#in-capture')) !== `${T('X')} tomorrow`)
      throw new Error('the add box holds: ' + (await page.inputValue('#in-capture')));
    await placeSays(page, 'cap', `Cancelled. “${T('X')}” is back where you typed it.`);
    await page.fill('#in-capture', '');
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });
  });

  await step('the-header-says-what-is-waiting', async () => {
    // The Refresh button turns into a waiting indicator with a count. Tapping it lists the waiting tasks, and the user can delete one there.
    await page.waitForSelector('#btn-refresh.waits[aria-label$="waiting to send"] #outbox-count');
    await expect(page.locator('html')).toHaveAttribute('data-sync', 'waiting'); // the state synced() waits on
    await capture(`${T('Y')} tomorrow`);
    await page.waitForSelector(pendingRow(T('Y')));
    await page.click('#btn-refresh');
    await page.waitForSelector('#outbox-status:has-text("No connection")');
    for (const text of [
      `New task: ${T('A')}`,
      `New task: ${T('P')}`,
      `Subtask of “${T('P')}”: ${T('P1')}`,
      `New task: ${T('Y')}`,
    ])
      await page.waitForSelector(`#outbox-rows .ob-row:has-text("${text}")`);
    if ((await page.textContent('#outbox-count')) !== String(await page.locator('#outbox-rows .ob-row').count()))
      throw new Error('the outbox count differs from the number of rows');
    await page
      .locator(`#outbox-rows .ob-row:has-text("${T('Y')}")`)
      .getByRole('button', { name: 'Cancel' })
      .click();
    await page.waitForSelector(`#outbox-rows .ob-row:has-text("${T('Y')}")`, { state: 'detached' });
    await page.click('#btn-sheet-close');
    if ((await page.inputValue('#in-capture')) !== `${T('Y')} tomorrow`)
      throw new Error('the add box holds: ' + (await page.inputValue('#in-capture')));
    await page.fill('#in-capture', '');
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });
  });

  await step('undated-task-offline-shows-in-added-today', async () => {
    await capture(T('U'));
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('U'))}`);
    if (await page.isVisible('#toast.show'))
      throw new Error('unexpected toast: ' + (await page.textContent('#toast-msg')));
  });

  await step('photo-added-offline-waits', async () => {
    await page.setInputFiles('#in-photo', photo('offline.png'));
    await capture(T('F'));
    // On Today the row is a single line, so a screen reader announces the waiting attachment (labels and counts are hidden on Today)
    await page.waitForSelector(
      `${NO_DATE} ${pendingRow(T('F'))} .title .sr:has-text("Attachments, 1 waiting to upload")`,
      { state: 'attached' },
    );
    await placeSays(page, 'cap', 'Saved offline, with the photo. They go to Vikunja'); // the message appears by the add box
  });

  await step('still-waiting-after-reopening', async () => {
    await page.reload(); // as when the phone closes the app
    await page.waitForSelector(pendingRow(T('A')), { timeout: 15000 });
    await page.waitForSelector(pendingRow(T('P')));
    await page.waitForSelector(`${NO_DATE} ${pendingRow(T('U'))}`);
    await page.waitForSelector(`${pendingRow(T('F'))} .title .sr:has-text("waiting to upload")`, { state: 'attached' });
  });

  await step('back-online-sends-everything', async () => {
    await context.setOffline(false); // this fires the browser's "online" event
    await synced(page);
    await expect(page.locator('.row.pending')).toHaveCount(0);
    await page.waitForSelector(`.row:not(.pending):has(.title:has-text("${T('A')}"))`); // now a normal task
    await page.waitForSelector(`${NO_DATE} .row:not(.pending):has(.title:has-text("${T('U')}"))`); // in the "Added today, no date" section
    for (const n of ['A', 'P', 'P1', 'P2', 'U', 'F'])
      if ((await byTitle(T(n))).length !== 1) throw new Error(`${n}: ${(await byTitle(T(n))).length} copies`);
    if ((await byTitle(T('X'))).length || (await byTitle(T('Y'))).length) throw new Error('a cancelled task was added');
    const parent = (await byTitle(T('P')))[0];
    const full = await (await api('/tasks/' + parent.id)).json();
    if ((full.related_tasks?.subtask || []).length !== 2)
      throw new Error('subtasks: ' + (full.related_tasks?.subtask || []).length);
    if (await page.isVisible('.offline')) throw new Error('the offline banner is still shown');
    // The photo stayed on the phone across the reload and was then uploaded.
    if ((await attached('F')).join() !== 'offline.png')
      throw new Error('the photo added offline never reached the task');
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).not.toHaveClass(/waits/); // nothing is waiting
  });

  await step('lost-reply-is-not-added-twice', async () => {
    // The first request reaches Vikunja, but its reply never arrives.
    let cut = true;
    await page.route('**/v2/projects/*/tasks', async route => {
      if (cut && route.request().method() === 'POST') {
        cut = false;
        await route.fetch();
        return route.abort('internetdisconnected');
      }
      return route.fallback();
    });
    await capture(`${T('D')} tomorrow`);
    // Pocket retries as soon as a request gets through (here, the list reloading), so the waiting row may appear and
    // disappear before the test can see it.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForSelector(`.row:not(.pending):has(.title:has-text("${T('D')}"))`, { timeout: 20000 });
    if (await page.isVisible(pendingRow(T('D')))) throw new Error('the task is still shown as waiting');
    const copies = (await byTitle(T('D'))).length;
    if (copies !== 1) throw new Error(`${copies} copies`);
    await page.unroute('**/v2/projects/*/tasks');
  });

  await step('photo-upload-cut-off-keeps-the-task', async () => {
    // The browser is online, but the connection drops during the photo upload, and the list can't reload either.
    let cut = true;
    const cutOff = r => (cut ? r.abort('internetdisconnected') : r.fallback());
    const lists = url => url.pathname.endsWith('/api/v2/tasks');
    await page.route('**/v2/tasks/*/attachments', cutOff);
    await page.route(lists, cutOff);
    await page.setInputFiles('#in-photo', photo('glitch.png'));
    await capture(T('G'));
    await placeSays(page, 'cap', 'The photo goes to Vikunja when you');
    // The task is in Vikunja, so it is a normal row. Its photo is still waiting, and Today's single-line row announces that.
    await page.waitForSelector(
      `${NO_DATE} .row:not(.pending):has(.title:has-text("${T('G')}")) .title .sr:has-text("Attachments, 1 waiting to upload")`,
      { state: 'attached' },
    );
    await page.click(`.row .body:has-text("${T('G')}")`);
    await page.waitForSelector(
      '#d-attachments .att.uploading:has-text("glitch.png"):has-text("Waiting for a connection")',
    );
    cut = false;
    await online();
    await page.waitForSelector('#d-attachments button.att:has-text("glitch.png")');
    if ((await attached('G')).join() !== 'glitch.png') throw new Error('attachments: ' + (await attached('G')).join());
    await page.unroute('**/v2/tasks/*/attachments', cutOff);
    await page.unroute(lists, cutOff);
  });

  await step('photo-whose-reply-is-lost-is-not-attached-twice', async () => {
    // The upload is from the task's sheet, which is still open. The upload reaches Vikunja, but the reply never arrives.
    let cut = true;
    const lose = async r => {
      if (!cut) return r.fallback();
      cut = false;
      await r.fetch();
      return r.abort('internetdisconnected');
    };
    await page.route('**/v2/tasks/*/attachments', lose);
    await page.setInputFiles('#d-file', photo('once.png'));
    await page.waitForSelector('#d-attachments .att.uploading:has-text("once.png")');
    await online();
    await page.waitForSelector('#d-attachments button.att:has-text("once.png")');
    const names = await attached('G');
    if (names.filter(n => n === 'once.png').length !== 1) throw new Error('attachments: ' + names.join());
    await page.unroute('**/v2/tasks/*/attachments', lose);
  });

  await step('server-error-keeps-the-photo', async () => {
    // Vikunja answers 500 once. The photo waits, shows a message, and uploads on the next try.
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 }); // the toast from adding the task, which must go first
    let busy = true;
    const answer = r => {
      if (!busy) return r.fallback();
      busy = false;
      return r.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: '{"title":"Internal Server Error","status":500,"detail":"Internal Server Error"}',
      });
    };
    await page.route('**/v2/tasks/*/attachments', answer);
    await page.setInputFiles('#d-file', photo('busy.png'));
    await page.waitForSelector(
      '#d-attachments .att.uploading:has-text("busy.png"):has-text("Vikunja had a problem with it. Trying again.")',
    );
    if (await page.isVisible('#toast.show'))
      throw new Error('unexpected toast: ' + (await page.textContent('#toast-msg')));
    await online();
    await page.waitForSelector('#d-attachments button.att:has-text("busy.png")');
    await page.unroute('**/v2/tasks/*/attachments', answer);
  });

  await step('sheet-photos-wait-offline-and-can-be-cancelled', async () => {
    await context.setOffline(true);
    await page.setInputFiles('#d-file', [photo('keep.png'), photo('drop.png')]);
    await page.waitForSelector(
      '#d-attachments .att.uploading:has-text("keep.png"):has-text("Waiting for a connection")',
    );
    await page.click('#d-attachments .att.uploading:has-text("drop.png") button[aria-label^="Don"]');
    await page.waitForSelector('#d-attachments .att:has-text("drop.png")', { state: 'detached' });
    if (await page.isVisible('#toast.show'))
      throw new Error('unexpected toast: ' + (await page.textContent('#toast-msg')));
    await context.setOffline(false);
    await page.waitForSelector('#d-attachments button.att:has-text("keep.png")');
    const names = await attached('G');
    if (!names.includes('keep.png') || names.includes('drop.png')) throw new Error('attachments: ' + names.join());
    await page.click('#btn-sheet-close');
  });

  await step('subtasks-added-offline-wait', async () => {
    // The sheet's subtask box also uses the outbox. Offline, a subtask waits in the sheet and is sent later.
    await page.click(`.row .body:has-text("${T('G')}")`);
    await page.waitForSelector('#d-subin');
    await context.setOffline(true);
    await page.fill('#d-subin', T('G1'));
    await page.press('#d-subin', 'Enter');
    await page.waitForSelector(`#d-subtasks .row.pending:has-text("${T('G1')}"):has-text("Waiting for a connection")`);
    if ((await page.evaluate(() => document.activeElement?.id)) !== 'd-subin')
      throw new Error('the box lost the focus');
    await context.setOffline(false);
    await online();
    await page.waitForSelector(`#d-subtasks .row:not(.pending) .title:text-is("${T('G1')}")`, { timeout: 20000 });
    const [g] = await byTitle(T('G'));
    const subs = (await (await api('/tasks/' + g.id)).json()).related_tasks?.subtask || [];
    if (subs.filter(s => s.title === T('G1')).length !== 1)
      throw new Error('subtasks: ' + subs.map(s => s.title).join(' | '));
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('comment-written-offline-waits', async () => {
    // Comments also use the outbox, and the offline banner names what needs a connection. On Today a task with a
    // subtask is shown as a card, and tapping the card's title opens the task.
    await page.click(
      `:is(.row .body:has-text("${T('G')}"), .day-card:has(.card-title:has-text("${T('G')}")) > .card-head)`,
    );
    await page.waitForSelector('#d-cin');
    await context.setOffline(true);
    await page.fill('#d-cin', T('comment'));
    await page.click('#d-cform button');
    await page.waitForSelector(
      `#d-comments .comment.waiting:has-text("${T('comment')}"):has-text("Waiting for a connection")`,
    );
    if (!(await page.textContent('.offline')).includes('. Changes wait in the Outbox.'))
      throw new Error('banner: ' + (await page.textContent('.offline')));
    await context.setOffline(false);
    await online();
    await page.waitForSelector(`#d-comments .comment:not(.waiting):has-text("${T('comment')}")`, { timeout: 20000 });
    const [g] = await byTitle(T('G'));
    const got = await (await api(`/tasks/${g.id}/comments`)).json(),
      list = Array.isArray(got) ? got : got.items || [];
    if (list.filter(c => c.comment.includes(T('comment'))).length !== 1) throw new Error('comments: ' + list.length);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('a-subtask-from-the-add-box-waits-offline', async () => {
    // On a project's list, "Add a subtask here" in the task's ⋯ menu points the add box at that task, so the box adds
    // subtasks to it. Offline, the new subtask waits on the task's card (a task with an open subtask is shown there as an
    // open, stacked card). The highlight follows the new subtask: its waiting row is the only highlighted row, and still
    // is once it has been sent.
    const [g] = await byTitle(T('G'));
    await page.evaluate(id => {
      location.hash = '#/project/' + id;
    }, g.project_id);
    const card = page.locator(`#view .day-card[data-id="${g.id}"]`);
    await card.evaluate(el => el.scrollIntoView({ block: 'center' }), null, { timeout: 15000 });
    await card.locator('> .card-head .card-open').click();
    await page.waitForSelector('#sheet .row.own');
    await page.click('#d-more');
    await page.click('#d-add-here');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(page.locator('#in-capture')).toHaveAttribute('aria-label', `New subtask of ${T('G')}`);
    await expect(page.locator('#cap-home')).toBeVisible(); // the add box is in the list, so its dashed placeholder shows at the bottom
    await expect(card).toHaveClass(/\baimed\b/);
    await context.setOffline(true);
    await page.fill('#in-capture', T('G2'));
    await page.press('#in-capture', 'Enter');
    // The waiting row goes first under the task, before the existing subtask, because the add box under a task adds
    // that task's first subtask. No message appears and the add box keeps focus.
    const waiting = card.locator(`.card-rows > .row.pending:has-text("${T('G2')}")`);
    await expect(waiting).toBeVisible();
    await expect(waiting).toHaveClass(/\baimed\b/);
    await expect(page.locator('#view .aimed')).toHaveCount(1); // only the waiting row is highlighted, not the card's header
    await expect(page.locator('#in-capture')).toHaveAttribute('aria-label', `New subtask of ${T('G')}`);
    const order = await page
      .locator('#view :is(.card-title, .row .title)')
      .evaluateAll(els => els.map(el => el.textContent || ''));
    const at = order.findIndex(t => t.includes(T('G')) && !t.includes(T('G1')) && !t.includes(T('G2')));
    if (!order[at + 1]?.includes(T('G2')) || !order[at + 2]?.includes(T('G1')))
      throw new Error('rows: ' + order.slice(at, at + 3).join(' | '));
    if ((await page.evaluate(() => document.activeElement?.id)) !== 'in-capture')
      throw new Error('the box lost the focus');
    await expect(page.locator('.place-line[data-place="cap"]')).toHaveCount(0);
    await context.setOffline(false);
    await online();
    await expect(page.locator(`#view .row:not(.pending):has-text("${T('G2')}")`)).toBeVisible({ timeout: 20000 });
    await expect(page.locator(`#view .row:not(.pending):has-text("${T('G2')}")`)).toHaveClass(/\baimed\b/);
    await expect(page.locator('#view .aimed')).toHaveCount(1);
    await expect(page.locator('#in-capture')).toHaveAttribute('aria-label', `New subtask of ${T('G')}`);
    await synced(page);
    const subs = (await (await api('/tasks/' + g.id)).json()).related_tasks?.subtask || [];
    if (subs.filter(s => s.title === T('G2')).length !== 1)
      throw new Error('subtasks: ' + subs.map(s => s.title).join(' | '));
    await page.evaluate(() => {
      location.hash = '#/today';
    });
    await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
  });

  await step('cut-off-label-is-still-added', async () => {
    // The task reaches Vikunja, then the request that sets its labels reaches Vikunja, but its reply is lost.
    let cut = true;
    const lose = async r => {
      if (!cut || r.request().method() !== 'PUT') return r.fallback();
      cut = false;
      await r.fetch();
      return r.abort('internetdisconnected');
    };
    await page.route('**/v2/tasks/*/labels/bulk', lose);
    await capture(`${T('L')} tomorrow *${LABEL}`);
    await page.waitForSelector(`.row:has(.title:has-text("${T('L')}"))`); // shown at once, because the task is already in Vikunja
    await online();
    await synced(page);
    if (cut) throw new Error('the labels were never sent');
    if (!(await byTitle(T('L')))[0]?.labels?.some(l => l.title === LABEL))
      throw new Error('the label never reached the task');
    if ((await byTitle(T('L'))).length !== 1) throw new Error((await byTitle(T('L'))).length + ' copies');
    await page.unroute('**/v2/tasks/*/labels/bulk', lose);
  });

  /* The relay makes the task, and its reply is lost on the way back. Once Pocket is back online it sends the request
     again with its key, the relay answers from what it kept, and the label and the person are added to that task. */
  if (process.env.ASSIGNEE)
    await step('a-task-whose-reply-is-lost-is-added-once-with-its-label-and-person', async () => {
      const who = process.env.ASSIGNEE,
        where = process.env.ASSIGNEE_PROJECT ? ` +"${process.env.ASSIGNEE_PROJECT}"` : '';
      const relay = '**/api/v1/plugins/pocket/v2/projects/*/tasks';
      let cut = true;
      const lose = async r => {
        if (!cut || r.request().method() !== 'POST') return r.fallback();
        cut = false;
        await r.fetch();
        return r.abort('internetdisconnected');
      };
      await page.route(relay, lose);
      await capture(`${T('B')} tomorrow @${who}${where} *${LABEL}`);
      await online();
      await synced(page);
      await page.unroute(relay, lose);
      if (cut) throw new Error('the task was never sent through the relay');
      await expect(page.locator('.row.pending')).toHaveCount(0);
      const made = await byTitle(T('B'));
      if (made.length !== 1) throw new Error(made.length + ' copies');
      if (!made[0].assignees?.some(u => u.username === who)) throw new Error('the task was never assigned');
      if (!made[0].labels?.some(l => l.title === LABEL)) throw new Error('the label never reached the task');
    });

  await step('no-room-on-the-phone-waits-while-open', async () => {
    // Pocket's storage is full, and the connection drops while the photo of a new task uploads. The photo waits in
    // memory, a message tells the user, and the photo uploads once the connection returns.
    await page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });
    await page.evaluate(() => {
      const put = (window.realPut = IDBObjectStore.prototype.put);
      IDBObjectStore.prototype.put = function (...a) {
        if (this.name === 'outbox') throw new DOMException('full', 'QuotaExceededError');
        return put.apply(this, a);
      };
    });
    let cut = true;
    const cutOff = r => (cut ? r.abort('internetdisconnected') : r.fallback());
    await page.route('**/v2/tasks/*/attachments', cutOff);
    await page.setInputFiles('#in-photo', photo('full.png'));
    await capture(T('S'));
    await placeSays(page, 'cap', "Pocket couldn't save this on the phone. Keep Pocket open");
    await page.waitForSelector(
      `.row:has(.title:has-text("${T('S')}")) .title .sr:has-text("Attachments, 1 waiting to upload")`,
      { state: 'attached' },
    );
    cut = false;
    await online();
    await synced(page);
    if ((await attached('S')).join() !== 'full.png') throw new Error('the photo never reached the task');
    if ((await byTitle(T('S'))).length !== 1) throw new Error((await byTitle(T('S'))).length + ' copies');
    await page.unroute('**/v2/tasks/*/attachments', cutOff);
    await page.evaluate(() => {
      IDBObjectStore.prototype.put = window.realPut;
    });
  });

  await step('same-title-twice-stays-two-tasks', async () => {
    // The second "Buy milk" never reaches Vikunja on its first try. The retry must not mistake the first task for it.
    await capture(T('M'));
    await page.waitForSelector(`.row:not(.pending):has(.title:has-text("${T('M')}"))`);
    const drop = r => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback());
    await page.route('**/v2/projects/*/tasks', drop);
    await capture(T('M'));
    await page.waitForSelector(pendingRow(T('M')));
    await page.unroute('**/v2/projects/*/tasks', drop);
    await online();
    await synced(page);
    if ((await byTitle(T('M'))).length !== 2) throw new Error((await byTitle(T('M'))).length + ' copies');
  });

  await step('same-title-made-elsewhere-is-not-taken', async () => {
    // A task is made on the web. Then a task with the same title is made in Pocket, and it never reaches Vikunja on its first try.
    const [me] = await byTitle(T('M')); // gives a project for the web task
    await api(`/projects/${me.project_id}/tasks`, { method: 'POST', body: JSON.stringify({ title: T('E') }) });
    await page.waitForTimeout(4000); // the Pocket task is made later, as a person would
    const drop = r => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback());
    await page.route('**/v2/projects/*/tasks', drop);
    await capture(T('E'));
    await page.waitForSelector(pendingRow(T('E')));
    await page.unroute('**/v2/projects/*/tasks', drop);
    await online();
    await synced(page);
    if ((await byTitle(T('E'))).length !== 2) throw new Error((await byTitle(T('E'))).length + ' copies');
  });

  await step('subtask-link-whose-reply-is-lost', async () => {
    // A pasted list whose first line is the parent. The subtask link reaches Vikunja but its reply doesn't. The retry sends it again with its key, and the relay answers from what it kept.
    let cut = true;
    const lose = async r => {
      if (!cut || r.request().method() !== 'POST') return r.fallback();
      cut = false;
      await r.fetch();
      return r.abort('internetdisconnected');
    };
    await page.route('**/v2/tasks/*/relations', lose);
    await page.fill('#in-capture', `${T('K')} tomorrow\n- ${T('K1')}\n- ${T('K2')}`);
    await page.click('#cap-nest');
    await page.click('#f-capture .go');
    await online();
    await synced(page);
    if ((await byTitle(T('K2'))).length !== 1) throw new Error('the list was never finished');
    const [parent] = await byTitle(T('K'));
    const full = await (await api('/tasks/' + parent.id)).json();
    if ((full.related_tasks?.subtask || []).length !== 2)
      throw new Error('subtasks: ' + (full.related_tasks?.subtask || []).length);
    if ((await page.textContent('#toast-msg')).includes("couldn't"))
      throw new Error('unexpected toast: ' + (await page.textContent('#toast-msg')));
    await page.unroute('**/v2/tasks/*/relations', lose);
  });

  await step('a-pasted-list-with-several-parents-waits-and-keeps-its-shape', async () => {
    // Two headings, each over its lines, and one line is already done. The list is added while Vikunja can't be
    // reached. Each parent waits on Today with its lines under it, not as separate rows. Once sent, each line is under
    // its original parent and the done line is done.
    const drop = r => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback());
    await page.route('**/v2/projects/*/tasks', drop);
    await page.fill(
      '#in-capture',
      `## ${T('H1')} tomorrow\n- ${T('H1a')}\n- [x] ${T('H1b')}\n## ${T('H2')} tomorrow\n- ${T('H2a')}`,
    );
    await page.click('#f-capture .go');
    await page.waitForSelector(pendingRow(T('H1')));
    await page.waitForSelector(pendingRow(T('H2')));
    if ((await page.isVisible(pendingRow(T('H1a')))) || (await page.isVisible(pendingRow(T('H2a')))))
      throw new Error('a subtask is shown in Today');
    // The first parent's request went out, so Vikunja may have it and its row has no Cancel. The second parent wasn't
    // sent. Its Cancel button has a label that says what happens to the line waiting under it.
    await expect(page.locator(`${pendingRow(T('H2'))} button[aria-label^="Cancel"]`)).toHaveAttribute(
      'aria-label',
      `Cancel ${T('H2')}. The line under it becomes its own task.`,
    );
    await expect(page.locator(`${pendingRow(T('H1'))} button[aria-label^="Cancel"]`)).toHaveCount(0);
    await page.unroute('**/v2/projects/*/tasks', drop);
    await online();
    await synced(page);
    const subs = async t =>
      ((await (await api('/tasks/' + (await byTitle(t))[0]?.id)).json()).related_tasks?.subtask || [])
        .map(s => [s.title, s.done])
        .sort();
    if (
      JSON.stringify(await subs(T('H1'))) !==
      JSON.stringify([
        [T('H1a'), false],
        [T('H1b'), true],
      ])
    )
      throw new Error('subtasks of the first heading: ' + JSON.stringify(await subs(T('H1'))));
    if (JSON.stringify(await subs(T('H2'))) !== JSON.stringify([[T('H2a'), false]]))
      throw new Error('subtasks of the second heading: ' + JSON.stringify(await subs(T('H2'))));
  });

  /* A pasted list of a parent and two subtasks, typed offline, waits as one add op per line, each line under the
     parent naming the parent's entry. Back online, the reply to the first subtask's request is lost, and the retry
     sends it again with its key. Vikunja has the parent with its two subtasks, each made once. */
  await step('a-pasted-list-typed-offline-arrives-as-one-parent-with-its-subtasks', async () => {
    await context.setOffline(true);
    await page.fill('#in-capture', `${T('Q')} tomorrow\n- ${T('Q1')}\n- ${T('Q2')}`);
    await page.click('#cap-nest');
    await page.click('#f-capture .go');
    await page.waitForSelector(pendingRow(T('Q')));
    const outbox = await page.evaluate(
      () =>
        new Promise(ok => {
          const r = indexedDB.open('pocket');
          r.onsuccess = () => {
            const q = r.result.transaction('outbox').objectStore('outbox').getAll();
            q.onsuccess = () => {
              r.result.close();
              ok(q.result);
            };
          };
        }),
    );
    const lines = outbox.filter(e => e.op === 'add' && [T('Q'), T('Q1'), T('Q2')].includes(e.p.title));
    const parent = lines.find(e => e.p.title === T('Q'));
    if (lines.length !== 3 || lines.filter(e => e.under === 'pending-' + parent?.id).length !== 2)
      throw new Error('waiting: ' + JSON.stringify(lines.map(e => [e.p.title, e.under])));
    let cut = true;
    const lose = async r => {
      if (!cut || r.request().method() !== 'POST' || r.request().postDataJSON()?.title !== T('Q1')) return r.fallback();
      cut = false;
      await r.fetch();
      return r.abort('internetdisconnected');
    };
    await page.route('**/v2/projects/*/tasks', lose);
    await context.setOffline(false);
    await online();
    await expect.poll(async () => (await byTitle(T('Q2'))).length, { timeout: 20000 }).toBe(1);
    await synced(page);
    await page.unroute('**/v2/projects/*/tasks', lose);
    if (cut) throw new Error("the first subtask's reply was never lost");
    for (const n of ['Q', 'Q1', 'Q2'])
      if ((await byTitle(T(n))).length !== 1) throw new Error(`${n}: ${(await byTitle(T(n))).length} copies`);
    const full = await (await api('/tasks/' + (await byTitle(T('Q')))[0].id)).json();
    const subs = (full.related_tasks?.subtask || []).map(s => s.title).sort();
    if (JSON.stringify(subs) !== JSON.stringify([T('Q1'), T('Q2')])) throw new Error('subtasks: ' + subs.join(' | '));
  });

  /* A checklist's screen is saved as its ids and Vikunja's copies of the checklist and its steps. Opened again offline,
     it shows the checklist and its steps from them. */
  await step('a-saved-checklist-screen-reopens-offline', async () => {
    const post = async (path, body) => (await api(path, { method: 'POST', body: JSON.stringify(body) })).json();
    const proj = await post('/projects', { title: T('saved checklists'), description: '<p>pocket:checklists</p>' });
    try {
      const run = await post(`/projects/${proj.id}/tasks`, { title: T('saved run'), description: '<p>pocket:run</p>' });
      for (const title of [T('saved step 1'), T('saved step 2')]) {
        const st = await post(`/projects/${proj.id}/tasks`, { title });
        await post(`/tasks/${run.id}/relations`, { other_task_id: st.id, relation_kind: 'subtask' });
      }
      await page.reload(); // so Pocket knows the project is for checklists
      await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
      await page.evaluate(id => {
        location.hash = '#/run/' + id;
      }, run.id);
      await page.waitForSelector(`#step-title:text-is("${T('saved step 1')}")`, { timeout: 15000 });
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator('#step-title')).toHaveText(T('saved step 1'), { timeout: 15000 });
      await expect(page.locator('#run-steps > .row .title')).toContainText([T('saved step 1'), T('saved step 2')]);
      await expect(page.locator('#run-own .title')).toContainText(T('saved run'));
      await context.setOffline(false);
      await online();
    } finally {
      await context.setOffline(false);
      await page.evaluate(() => {
        location.hash = '#/today';
      });
      await api('/projects/' + proj.id, { method: 'DELETE' });
    }
  });

  /* A comment and a tick on a checklist's step wait offline, across a reload, and reach Vikunja once. Every request
     goes through the plugin's relay with a key. The test reads the keys from the outbox, then sends two of the requests
     again with their keys. The relay answers from what it kept, and Vikunja changes nothing. */
  await step('a-checklist-step-ticked-offline-is-sent-once', async () => {
    const post = async (path, body) => (await api(path, { method: 'POST', body: JSON.stringify(body) })).json();
    const proj = await post('/projects', { title: T('checklists'), description: '<p>pocket:checklists</p>' });
    try {
      const run = await post(`/projects/${proj.id}/tasks`, { title: T('run'), description: '<p>pocket:run</p>' });
      const st = await post(`/projects/${proj.id}/tasks`, { title: T('step') });
      await post(`/tasks/${run.id}/relations`, { other_task_id: st.id, relation_kind: 'subtask' });
      await page.reload(); // so Pocket knows the project is for checklists
      await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
      await page.evaluate(id => {
        location.hash = '#/run/' + id;
      }, run.id);
      await page.waitForSelector(`#step-title:text-is("${T('step')}")`, { timeout: 15000 });
      await context.setOffline(true);
      await page.fill('#step-note', T('note'));
      await page.click('#step-note-form button');
      await page.click('#step-done');
      await page.waitForSelector('#finish-card'); // every step is done
      await page.reload();
      await page.waitForSelector('#finish-card', { timeout: 15000 }); // the tick still waits, after the reload
      const outbox = await page.evaluate(
        () =>
          new Promise(ok => {
            const r = indexedDB.open('pocket');
            r.onsuccess = () => {
              const q = r.result.transaction('outbox').objectStore('outbox').getAll();
              q.onsuccess = () => {
                r.result.close();
                ok(q.result);
              };
            };
          }),
      );
      const note = outbox.find(e => e.op === 'note' && e.task === st.id),
        tick = outbox.find(e => e.op === 'done' && e.task === st.id);
      if (!note || !tick) throw new Error('waiting: ' + outbox.map(e => e.op).join(', '));
      await context.setOffline(false);
      await online();
      await synced(page);
      const kept = async () => {
        const t = await (await api(`/tasks/${st.id}?expand=reactions`)).json(),
          got = await (await api(`/tasks/${st.id}/comments`)).json();
        return [
          t.done,
          (t.reactions?.['✅'] || []).length,
          (Array.isArray(got) ? got : got.items || []).filter(c => c.comment.includes(T('note'))).length,
        ];
      };
      await expect.poll(kept, { timeout: 20000 }).toEqual([true, 1, 1]);
      // The same requests again, each with the key Pocket sent it with: the comment, and the tick.
      const again = (a, method, path, body) =>
        fetch(SERVER + '/api/v1/plugins/pocket/v2' + path, {
          method,
          body: JSON.stringify(body),
          headers: {
            Authorization: 'Bearer ' + TOKEN,
            'Content-Type': 'application/json',
            'Idempotency-Key': `"${a.key || a.id}:0:0"`,
          },
        });
      for (const r of [
        await again(note, 'POST', `/tasks/${st.id}/comments`, { comment: note.html }),
        await again(tick, 'PATCH', '/tasks/' + st.id, { done: true }),
      ])
        if (r.headers.get('idempotent-replayed') !== 'true')
          throw new Error(`HTTP ${r.status}, not answered from what the relay kept: ${await r.text()}`);
      if (JSON.stringify(await kept()) !== '[true,1,1]')
        throw new Error('Vikunja changed: ' + JSON.stringify(await kept()));
    } finally {
      await page.evaluate(() => {
        location.hash = '#/today';
      });
      await api('/projects/' + proj.id, { method: 'DELETE' });
    }
  });

  /* While Pocket is offline it doesn't try a tick's first request, so the Outbox still offers Cancel.
     Tapping it unticks the step on the checklist's screen at once, and leaves it not done in Vikunja, also once Pocket
     is back online. */
  await step('a-tick-made-offline-can-be-dropped', async () => {
    const post = async (path, body) => (await api(path, { method: 'POST', body: JSON.stringify(body) })).json();
    const proj = await post('/projects', { title: T('dropped checklists'), description: '<p>pocket:checklists</p>' });
    try {
      const run = await post(`/projects/${proj.id}/tasks`, {
        title: T('dropped run'),
        description: '<p>pocket:run</p>',
      });
      const st = await post(`/projects/${proj.id}/tasks`, { title: T('not sent') });
      await post(`/tasks/${run.id}/relations`, { other_task_id: st.id, relation_kind: 'subtask' });
      await page.reload(); // so Pocket knows the project is for checklists
      await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
      await page.evaluate(id => {
        location.hash = '#/run/' + id;
      }, run.id);
      await page.waitForSelector(`#step-title:text-is("${T('not sent')}")`, { timeout: 15000 });
      await context.setOffline(true);
      await page.click('#step-done');
      await page.waitForSelector('#btn-refresh.waits');
      await page.click('#btn-refresh');
      const row = `#outbox-rows .ob-row:has-text("Done: ${T('not sent')}")`;
      await page.locator(row).getByRole('button', { name: 'Cancel' }).click();
      await page.waitForSelector(row, { state: 'detached' });
      await page.click('#btn-sheet-close');
      await expect(
        page.locator('#run-steps').getByRole('button', { name: 'Mark done: ' + T('not sent') }),
      ).toBeVisible();
      await expect(page.locator('#step-done')).toBeVisible();
      await context.setOffline(false);
      await online();
      await synced(page);
      const t = await (await api(`/tasks/${st.id}?expand=reactions`)).json();
      if (t.done || (t.reactions?.['✅'] || []).length)
        throw new Error('Vikunja has the tick: ' + JSON.stringify([t.done, t.reactions]));
    } finally {
      await page.evaluate(() => {
        location.hash = '#/today';
      });
      await api('/projects/' + proj.id, { method: 'DELETE' });
    }
  });

  /* A checklist's sheet lists its steps as their own rows. Two steps ticked there offline wait in the outbox. Back
     online, Vikunja refuses the first tick. The sheet and the checklist's ring show that step open again, while the
     second step is done. */
  await step('a-refused-tick-in-a-checklist-sheet-shows-that-step-open', async () => {
    const post = async (path, body) => (await api(path, { method: 'POST', body: JSON.stringify(body) })).json();
    const proj = await post('/projects', { title: T('refused checklists'), description: '<p>pocket:checklists</p>' });
    let refused = null;
    const refuse = r =>
      r.request().method() === 'PATCH'
        ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Forbidden' }) })
        : r.fallback();
    try {
      const run = await post(`/projects/${proj.id}/tasks`, {
        title: T('refused run'),
        description: '<p>pocket:run</p>',
      });
      const steps = [
        await post(`/projects/${proj.id}/tasks`, { title: T('refused one') }),
        await post(`/projects/${proj.id}/tasks`, { title: T('refused two') }),
      ];
      for (const st of steps)
        await post(`/tasks/${run.id}/relations`, { other_task_id: st.id, relation_kind: 'subtask' });
      await page.reload(); // so Pocket knows the project is for checklists
      await page.waitForSelector(`.row .title:has-text("${T('seed')}")`, { timeout: 15000 });
      await page.evaluate(id => Alpine.$data(document.body).openTask(id), run.id);
      const row = st => page.locator(`#d-subtasks .row[data-id="${st.id}"]`);
      for (const st of steps) await expect(row(st)).toBeVisible({ timeout: 15000 });
      await context.setOffline(true);
      for (const [st, name] of [
        [steps[0], 'refused one'],
        [steps[1], 'refused two'],
      ]) {
        await row(st)
          .getByRole('button', { name: 'Mark done: ' + T(name) })
          .click();
        await expect(row(st)).toHaveClass(/\bdone\b/);
      }
      refused = `**/api/v1/plugins/pocket/v2/tasks/${steps[0].id}`;
      await page.route(refused, refuse);
      await context.setOffline(false);
      await online();
      await expect
        .poll(async () => (await (await api('/tasks/' + steps[1].id)).json()).done, { timeout: 20000 })
        .toBe(true);
      await expect(row(steps[0])).not.toHaveClass(/\bdone\b/);
      await expect(row(steps[1])).toHaveClass(/\bdone\b/);
      await expect(
        page.locator('#sheet').getByRole('button', { name: `Finish “${T('refused run')}”, with 1 step not done` }),
      ).toBeVisible();
      if ((await (await api('/tasks/' + steps[0].id)).json()).done) throw new Error('Vikunja has the refused tick');
      await page.click('#btn-sheet-close');
      await page.click('#btn-refresh'); // Cancel, so nothing is left waiting
      await page
        .locator(`#outbox-rows .ob-row:has-text("Done: ${T('refused one')}")`)
        .getByRole('button', { name: 'Cancel' })
        .click();
      await page.waitForSelector('#outbox-rows .ob-row', { state: 'detached' });
      await page.click('#btn-sheet-close');
    } finally {
      if (refused) await page.unroute(refused, refuse);
      await page.evaluate(async () => {
        const a = Alpine.$data(document.body);
        for (const e of [...a.failed]) await a.dropAct(e.id);
      }); // so a failure here leaves the next steps nothing waiting
      await context.setOffline(false);
      await page.evaluate(() => {
        location.hash = '#/today';
      });
      await api('/projects/' + proj.id, { method: 'DELETE' });
    }
  });

  /* A screen is saved with Vikunja's copy of each task, never with what a waiting op shows on its row. The step's tick
     can't reach Vikunja, and Today loads and is saved while the tick waits. After a reload offline, Today shows the
     step ticked because the tick is in the outbox, while the saved Today still has the step not done. */
  await step('a-saved-screen-shows-a-waiting-tick-from-the-outbox', async () => {
    const post = async (path, body) => (await api(path, { method: 'POST', body: JSON.stringify(body) })).json();
    const proj = await post('/projects', { title: T('saved checklists'), description: '<p>pocket:checklists</p>' });
    const relay = '**/api/v1/plugins/pocket/v2/**',
      cut = r => r.abort('internetdisconnected');
    try {
      const run = await post(`/projects/${proj.id}/tasks`, { title: T('saved run'), description: '<p>pocket:run</p>' });
      // A step's line in its notes makes it a checklist's step on Today, ticked through the outbox.
      const stepOf = name =>
        post(`/projects/${proj.id}/tasks`, { title: T(name), description: `<p>pocket:step ${T(name)}</p>` });
      const steps = [await stepOf('saved one'), await stepOf('saved two')];
      for (const st of steps)
        await post(`/tasks/${run.id}/relations`, { other_task_id: st.id, relation_kind: 'subtask' });
      await page.reload(); // so Pocket knows the project is for checklists
      const tick = name => page.getByRole('button', { name: 'Mark done: ' + T(name) });
      await expect(tick('saved one')).toBeVisible({ timeout: 15000 });
      await page.route(relay, cut);
      await tick('saved one').click();
      const at = await page.evaluate(() => JSON.parse(localStorage.getItem('pocket.saved.today')).at);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // Today loads again, and is saved
      await expect
        .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pocket.saved.today')).at))
        .not.toBe(at);
      // A saved screen holds its tasks' ids, and each task's copy is kept under a key of its own.
      const kept = () =>
        page.evaluate(id => JSON.parse(localStorage.getItem('pocket.saved.task.' + id))?.done, steps[0].id);
      if ((await kept()) !== false) throw new Error('the saved Today has the step as ' + (await kept()));
      await context.setOffline(true);
      await page.reload();
      await expect(tick('saved two')).toBeVisible({ timeout: 15000 });
      await expect(tick('saved one')).toHaveCount(0); // ticked, from the outbox
      if ((await kept()) !== false) throw new Error('the saved Today has the step as ' + (await kept()));
      await page.unroute(relay, cut);
      await context.setOffline(false);
      await online();
      await synced(page);
      await expect
        .poll(async () => (await (await api('/tasks/' + steps[0].id)).json()).done, { timeout: 20000 })
        .toBe(true);
    } finally {
      await page.unroute(relay, cut).catch(() => {});
      await context.setOffline(false);
      await api('/projects/' + proj.id, { method: 'DELETE' });
    }
  });

  /* Move all to today made offline shows its message at once, and its moves wait in the outbox, also across a reload.
     Back online, each task is moved once. A move's request sent again with its key is answered from what the relay
     kept, and Vikunja changes nothing. */
  await step('move-all-made-offline-moves-each-task-once', async () => {
    const late = new Date();
    late.setDate(late.getDate() - 2);
    late.setHours(9, 0, 0, 0);
    const made = [];
    for (const n of ['late one', 'late two'])
      made.push(
        await (
          await api(`/projects/${home}/tasks`, {
            method: 'POST',
            body: JSON.stringify({ title: T(n), due_date: late.toISOString() }),
          })
        ).json(),
      );
    const patched = [],
      seen = r => {
        if (r.method() === 'PATCH' && /\/v2\/tasks\/\d+$/.test(r.url())) patched.push(+r.url().split('/').pop());
      };
    const row = (where, n) => page.locator(`.sec.${where} ~ .list .row:has(.title:has-text("${T(n)}"))`);
    page.on('request', seen);
    try {
      await context.setOffline(false);
      await page.reload();
      await expect(row('overdue', 'late two')).toBeVisible({ timeout: 15000 });
      await context.setOffline(true);
      await page.click('#btn-overdue-today');
      await expect(placeLine(page, 'overdue')).toContainText(/^Moved \d+ to today/);
      await expect(row('today', 'late one')).toBeVisible();
      await page.reload();
      await expect(row('today', 'late two')).toBeVisible({ timeout: 15000 }); // the moves still wait, after the reload
      const moves = (await outboxOf(page)).filter(e => e.op === 'due' && made.some(t => t.id === e.task));
      if (moves.length !== 2) throw new Error('waiting: ' + JSON.stringify(moves));
      await context.setOffline(false);
      await online();
      await synced(page);
      const today = new Date().toDateString();
      for (const t of made) {
        const due = (await (await api('/tasks/' + t.id)).json()).due_date;
        if (new Date(due).toDateString() !== today) throw new Error(`${t.title} is due ${due}`);
        if (patched.filter(id => id === t.id).length !== 1)
          throw new Error(`${patched.filter(id => id === t.id).length} requests moved ${t.title}`);
      }
      const a = moves[0],
        again = await fetch(SERVER + '/api/v1/plugins/pocket/v2/tasks/' + a.task, {
          method: 'PATCH',
          body: JSON.stringify({ due_date: a.due }),
          headers: {
            Authorization: 'Bearer ' + TOKEN,
            'Content-Type': 'application/json',
            'Idempotency-Key': `"${a.key || a.id}:0:0"`,
          },
        });
      if (again.headers.get('idempotent-replayed') !== 'true')
        throw new Error(`HTTP ${again.status}, not answered from what the relay kept: ${await again.text()}`);
    } finally {
      page.off('request', seen);
      await context.setOffline(false);
      for (const t of made) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* Cancel in the Outbox asks nothing, and its message has an Undo. A move made offline, cancelled, and put back with
     Undo is sent once when Pocket is back online. */
  await step('a-move-cancelled-in-the-outbox-then-undone-is-sent-once', async () => {
    const late = new Date();
    late.setDate(late.getDate() - 2);
    late.setHours(9, 0, 0, 0);
    const t = await (
      await api(`/projects/${home}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: T('cancelled move'), due_date: late.toISOString() }),
      })
    ).json();
    const patched = [],
      seen = r => {
        if (r.method() === 'PATCH' && r.url().endsWith('/v2/tasks/' + t.id)) patched.push(r.postData());
      };
    const asked = [],
      ask = d => asked.push(d.message());
    const row = where => page.locator(`.sec.${where} ~ .list .row:has(.title:has-text("${T('cancelled move')}"))`);
    const waiting = page.locator('#outbox-rows .ob-row', { hasText: T('cancelled move') });
    page.on('request', seen);
    page.on('dialog', ask);
    try {
      await context.setOffline(false);
      await page.reload();
      await expect(row('overdue')).toBeVisible({ timeout: 15000 });
      await context.setOffline(true);
      await page.click('#btn-overdue-today');
      await expect(row('today')).toBeVisible();
      await page.waitForSelector('#btn-refresh.waits');
      await page.click('#btn-refresh');
      await waiting.getByRole('button', { name: 'Cancel' }).click();
      await expect(waiting).toHaveCount(0);
      await expect(placeLine(page, 'sheet:top')).toContainText(`Cancelled. “${T('cancelled move')}” due date stays `);
      await placeLine(page, 'sheet:top').getByRole('button', { name: 'Undo' }).click();
      await expect(waiting).toHaveCount(1);
      await page.click('#btn-sheet-close');
      await context.setOffline(false);
      await online();
      await synced(page);
      if (asked.length) throw new Error('Cancel asked: ' + asked.join(' | '));
      const due = (await (await api('/tasks/' + t.id)).json()).due_date;
      if (new Date(due).toDateString() !== new Date().toDateString() || patched.length !== 1)
        throw new Error(`due ${due}, after ${patched.length} requests`);
    } finally {
      page.off('request', seen);
      page.off('dialog', ask);
      await context.setOffline(false);
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A date and a repeat set in a task's sheet offline show at once, and wait in the outbox as two ops, also across a
     reload. Back online, Vikunja gets each once. Each request sent again with its key is answered from what the relay
     kept. */
  await step('a-date-and-repeat-set-in-the-sheet-offline-are-each-sent-once', async () => {
    const was = new Date();
    was.setDate(was.getDate() + 3);
    was.setHours(9, 0, 0, 0);
    const to = new Date();
    to.setDate(to.getDate() + 2);
    to.setHours(10, 0, 0, 0);
    const p = n => String(n).padStart(2, '0'),
      local = `${to.getFullYear()}-${p(to.getMonth() + 1)}-${p(to.getDate())}T10:00`;
    const t = await (
      await api(`/projects/${home}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: T('sheet date'), due_date: was.toISOString() }),
      })
    ).json();
    const patched = [],
      seen = r => {
        if (r.method() === 'PATCH' && r.url().endsWith('/v2/tasks/' + t.id)) patched.push(r.postData());
      };
    const open = async () => {
      await page.click(`#view .row .body:has-text("${T('sheet date')}")`, { timeout: 15000 });
      await page.waitForSelector('#d-due');
    };
    page.on('request', seen);
    try {
      await context.setOffline(false);
      await page.reload();
      await open();
      await context.setOffline(true);
      await page.fill('#d-due', local);
      await page.selectOption('#d-repeat', 'week');
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      await page.reload();
      await open();
      await expect(page.locator('#d-due')).toHaveValue(local); // still shown after the reload
      await expect(page.locator('#d-repeat')).toHaveValue('week');
      await page.click('#btn-sheet-close');
      const ops = (await outboxOf(page)).filter(e => e.task === t.id);
      if (ops.map(e => e.op).join() !== 'due,repeat') throw new Error('waiting: ' + JSON.stringify(ops));
      await context.setOffline(false);
      await online();
      await synced(page);
      const now = await (await api('/tasks/' + t.id)).json();
      if (!sameTime(now.due_date, to.toISOString()) || now.repeat_after !== 604800 || patched.length !== 2)
        throw new Error(`due ${now.due_date}, repeats ${now.repeat_after}, after ${patched.length} requests`);
      for (const [e, body] of [
        [ops[0], { due_date: ops[0].due }],
        [ops[1], ops[1].set],
      ]) {
        const again = await fetch(SERVER + '/api/v1/plugins/pocket/v2/tasks/' + t.id, {
          method: 'PATCH',
          body: JSON.stringify(body),
          headers: {
            Authorization: 'Bearer ' + TOKEN,
            'Content-Type': 'application/json',
            'Idempotency-Key': `"${e.key || e.id}:0:0"`,
          },
        });
        if (again.headers.get('idempotent-replayed') !== 'true')
          throw new Error(
            `${e.op}: HTTP ${again.status}, not answered from what the relay kept: ${await again.text()}`,
          );
      }
    } finally {
      page.off('request', seen);
      await context.setOffline(false);
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A row thrown at two dates offline (app/throw.js) waits as one move, from its first date to the last. Back online,
     one request is sent, and Undo puts the first date back. The hold needs the page's clock, so this runs in a context
     of its own with Playwright's clock. */
  await step('a-row-thrown-at-two-dates-offline-sends-one-request', async () => {
    const due = new Date();
    due.setHours(23, 0, 0, 0);
    const t = await (
      await api(`/projects/${home}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: T('thrown'), due_date: due.toISOString() }),
      })
    ).json();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await hintSeen(ctx);
    await ctx.clock.install();
    const p = await ctx.newPage(),
      patched = [];
    p.on('pageerror', e => errors.push(String(e)));
    p.on('request', r => {
      if (r.method() === 'PATCH' && r.url().endsWith('/v2/tasks/' + t.id))
        patched.push(JSON.parse(r.postData()).due_date);
    });
    const later = async ms => {
      await p.clock.fastForward(ms);
      await p.clock.setSystemTime(Date.now());
    };
    const R = `#view .row:has(.title:has-text("${T('thrown')}"))`;
    // Hold the row until its date chips show, let go without moving, and tap the chip for date `id`.
    const throwAt = async id => {
      await p.locator(R).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const box = await steady(p.locator(R));
      await p.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 28));
      await p.mouse.down();
      await later(700);
      await expect(p.locator('.throw .throw-t[data-id]')).toHaveCount(4);
      await p.mouse.up();
      const chip = await p.locator(`.throw .throw-t[data-id="${id}"]`).boundingBox();
      await p.mouse.click(chip.x + chip.width / 2, chip.y + chip.height / 2);
      await expect(p.locator('.throw')).toHaveCount(0);
    };
    try {
      await signIn(p, POCKET, USER, PASSWORD);
      await expect(p.locator(R)).toBeVisible({ timeout: 15000 });
      await ctx.setOffline(true);
      await throwAt('tomorrow');
      await later(5100); // the message with its Undo folds, and the row is back
      await throwAt('none');
      const undo = p
        .locator('.row-line, .place-line[data-place="cap"]')
        .filter({ hasText: 'Removed its due date' })
        .getByRole('button', { name: 'Undo' });
      await expect(undo).toBeVisible();
      const moves = (await outboxOf(p)).filter(e => e.op === 'due' && e.task === t.id);
      if (moves.length !== 1 || !sameTime(moves[0].was, t.due_date) || !moves[0].due.startsWith('0001'))
        throw new Error('waiting: ' + JSON.stringify(moves));
      await ctx.setOffline(false);
      await p.evaluate(() => window.dispatchEvent(new Event('online')));
      await synced(p);
      if (patched.length !== 1 || !patched[0].startsWith('0001')) throw new Error('sent: ' + JSON.stringify(patched));
      await undo.click();
      await synced(p);
      const now = (await (await api('/tasks/' + t.id)).json()).due_date;
      if (!sameTime(now, t.due_date) || patched.length !== 2)
        throw new Error(`after Undo the task is due ${now}, with ${patched.length} requests`);
    } finally {
      await ctx.close();
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('two-tabs-send-it-once', async () => {
    // A task added offline in one tab also shows as waiting in the other tab. Back online, both tabs try to send it, and it is added once.
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
    await capture(`${T('Y')} tomorrow`); // a task is waiting at sign-out, so Pocket asks first
    await page.waitForSelector(pendingRow(T('Y')));
    // The browser goes back online for the sign-out, but the waiting task must not be sent meanwhile.
    await page.route('**/v2/projects/*/tasks', r =>
      r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback(),
    );
    await context.setOffline(false);
    await page.click('#btn-account');
    await page.click('#btn-signout');
    await page.waitForSelector('#login:not([hidden])');
    const left = await page.evaluate(() =>
      Object.keys(localStorage).filter(k => k.startsWith('pocket.saved.') || k === 'pocket.outbox'),
    );
    if (left.length) throw new Error('these are still stored: ' + left.join(', '));
    const count = name =>
      page.evaluate(
        n =>
          new Promise(ok => {
            const r = indexedDB.open('pocket');
            r.onsuccess = () => {
              const q = r.result.transaction(n).objectStore(n).count();
              q.onsuccess = () => {
                r.result.close();
                ok(q.result);
              };
            };
          }),
        name,
      );
    if (await count('files')) throw new Error(`${await count('files')} waiting photos still stored`);
    if (await count('outbox')) throw new Error(`${await count('outbox')} waiting tasks still stored`);
    await page.unroute('**/v2/projects/*/tasks');
    if ((await byTitle(T('Y'))).length) throw new Error('the dropped task was added');
  });
  if (errors.length) {
    failed++;
    console.log('FAIL page errors:', errors);
  }
} finally {
  await browser.close();
  const left = ((await (await api('/tasks?q=' + stamp)).json()).items || []).filter(t =>
    t.title.endsWith(String(stamp)),
  );
  // Retry a few times. Vikunja on SQLite (the local one with DB=sqlite) can answer 500 "database is locked" while busy.
  for (const t of left)
    for (let i = 0; i < 5 && !(await api('/tasks/' + t.id, { method: 'DELETE' })).ok; i++)
      await new Promise(ok => setTimeout(ok, 500));
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
