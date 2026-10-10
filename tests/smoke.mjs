// End-to-end test of Pocket as served by the Vikunja plugin, against that Vikunja.
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... npm run test:smoke
//   npm run test:local        (starts a local Vikunja with the plugin and runs everything against it)
//
// Opens <VIKUNJA_URL>/api/v1/plugins/pocket/, signs in with the token, then creates, edits, completes and deletes
// throwaway tasks (including a pasted list with subtasks). It tags one with a "pocket-smoke" label, which it
// creates on the first run and reuses after that.
// Optional: POCKET_URL if Pocket lives somewhere else,
// ASSIGNEE=<username> to test @assignee (token needs Other -> Users), with
// ASSIGNEE_PROJECT=<name> of a project shared with that user,
// BROWSER_CHANNEL=msedge|chrome (default: Playwright's Chromium),
// OUT=<dir> for screenshots.
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { expect, finger, hintSeen, loaded, noToast, placeLine, placeSays, rowLine, signIn, steady, swipeRow, synced, toastGone as toastGoneOn } from './helpers.mjs';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const ASSIGNEE = process.env.ASSIGNEE;         // optional: a username to assign; the token needs Other -> Users
const ASSIGNEE_PROJECT = process.env.ASSIGNEE_PROJECT;   // a project shared with ASSIGNEE (default: your default project)
const TOKEN = process.env.VIKUNJA_TOKEN;
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !TOKEN) { console.error('Set VIKUNJA_URL and VIKUNJA_TOKEN'); process.exit(2); }
const APP = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';

// Vikunja on SQLite answers 500 "database is locked" now and then, when a request comes while it's still writing what
// the one before changed: the test's own requests try again, as Pocket's do.
const api = async (path, init = {}) => {
  for (let i = 0; ; i++) {
    const r = await fetch(SERVER + '/api/v2' + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, ...init.headers } });
    if (r.status !== 500 || i >= 4) return r;
    await new Promise(res => setTimeout(res, 300 * (i + 1)));
  }
};

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await hintSeen(context);                         // the one-time hint has a step of its own, on a phone of its own
// The page's clock is Playwright's: it keeps the real time, and later() moves it on instead of waiting.
await context.clock.install();
const page = await context.newPage();
const errors = [];
/* Time passing on the page only, `ms` of it at once: its timers due meanwhile run (a toast going, Today's minute), then
   its clock is put back on the real time, which Vikunja's dates are on. */
const later = async ms => { await page.clock.fastForward(Math.max(0, Math.round(ms))); await page.clock.setSystemTime(Date.now()); };
// A token without some permission gets 401s, which Pocket handles; the browser still logs them, so they're left out here,
// with the reply a test cuts off on purpose.
page.on('console', m => m.type() === 'error' && !/status of 401|ERR_CONNECTION_RESET/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());

let failed = 0;
async function step(name, fn){
  const start = Date.now(), secs = () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`;   // each step's time, so a slow one is seen
  try { await fn(); console.log('PASS', name + secs()); }
  catch (e) { failed++; console.log('FAIL', name + secs(), '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/fail-${name}.png` }); }
}

const stamp = Date.now();
const title = 'Pocket smoke test ' + stamp;
const label = 'pocket-smoke';
const createdProjects = [];
// A card on Today (a task with subtasks still open), by its title; and what opens a task on Today: its row's title, or
// its card's.
const cardOf = t => `.day-card:has(> .card-head .card-title:has-text("${t}"))`;
const opener = t => `:is(.row > .body:has(.title:has-text("${t}")), ${cardOf(t)} > .card-head)`;

try {
  await step('sign-in-with-a-token', () => signIn(page, APP, TOKEN));
  await page.screenshot({ path: `${OUT}/today.png` });

  await step('quick-add', async () => {
    await page.fill('#in-capture', `${title} tomorrow at 5pm !3 *${label}`);
    const chips = await page.textContent('#cap-chips');
    if (!/Tomorrow/.test(chips) || !/Priority 3/.test(chips)) throw new Error('chips: ' + chips);
    await page.click('#f-capture .go');
    // On its list at once, not sent yet; once it's in Vikunja, it lights up.
    await expect(page.locator(`.row.fresh:has(.title:has-text("${title}"))`), 'the new row isn\'t highlighted').toBeVisible({ timeout: 15000 });
  });
  const row = `.row:has(.title:has-text("${title}"))`;
  await step('refresh-keeps-rows', async () => {
    const before = await page.$(row);
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    if (!await before.evaluate(el => el.isConnected)) throw new Error('refresh rebuilt the list');
  });
  await step('refresh-loads-a-new-version', async () => {
    // A second tab whose copy of Pocket looks older than the server's.
    const old = await page.context().newPage();
    await old.addInitScript(() => Object.defineProperty(document, 'lastModified', { get: () => '01/01/2000 00:00:00' }));
    await old.goto(APP);
    await old.waitForSelector(row, { timeout: 15000 });
    await old.evaluate(() => window.marker = 1);
    // Something typed holds the reload off: the list refreshes in place.
    await old.fill('#in-capture', 'half-typed');
    await old.click('#btn-refresh');
    await old.waitForSelector('#btn-refresh:not([disabled])');
    await old.waitForTimeout(500);
    if (!await old.evaluate(() => window.marker) || await old.inputValue('#in-capture') !== 'half-typed') throw new Error('reloaded over typed text');
    await old.fill('#in-capture', '');
    await old.click('#btn-refresh');
    await old.waitForFunction(() => !window.marker, null, { timeout: 10000 });
    await old.waitForSelector(row, { timeout: 15000 });
    await old.close();
  });
  /* The plugin sends the page compressed, as the build wrote it, to a browser that takes it (performance-plan, part 6):
     brotli, else gzip, each the page once decoded, with Vary: Accept-Encoding; the compressed copies aren't served by
     their own names. */
  await step('the-plugin-sends-the-page-compressed', async () => {
    const get = (url, enc) => new Promise((ok, fail) => (url.startsWith('https:') ? https : http).get(url, { headers: { 'Accept-Encoding': enc } }, res => {
      const parts = []; res.on('data', b => parts.push(b)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    }).on('error', fail));
    const plain = await get(APP, 'identity');
    if (plain.status !== 200 || plain.headers['content-encoding'] || !plain.body.includes('<html')) throw new Error(`the page as it is: ${plain.status} ${plain.headers['content-encoding']}`);
    for (const [enc, decode] of [['br', brotliDecompressSync], ['gzip', gunzipSync]]) {
      const r = await get(APP, enc);
      if (r.headers['content-encoding'] !== enc) throw new Error(`asked for ${enc}, sent ${r.headers['content-encoding']}`);
      if (!/accept-encoding/i.test(r.headers.vary || '')) throw new Error('Vary: ' + r.headers.vary);
      if (!decode(r.body).equals(plain.body)) throw new Error(`the ${enc} page isn't the page`);
      if (r.body.length >= plain.body.length / 2) throw new Error(`the ${enc} page is ${r.body.length} bytes of ${plain.body.length}`);
    }
    for (const name of ['index.html.br', 'index.html.gz']) if ((await get(APP + name, 'br')).status !== 404) throw new Error(name + ' is served by its name');
  });

  await step('tick-in-list-and-tick-again', async () => {
    // Ticked, its row stays where it is, done, until the rows ticked leave together; its tick again opens it.
    await page.click(`${row} .check`);
    await expect(page.locator(row)).toHaveClass(/\bleaving\b/);
    await expect(page.locator(row)).toHaveClass(/\bdone\b/);
    if (await page.$('#toast.show #toast-msg:has-text("Done")')) throw new Error('a tick in a list said: ' + await page.textContent('#toast-msg'));
    if (!(await page.textContent('#said')).startsWith('Done: ' + title)) throw new Error('a screen reader hears: ' + await page.textContent('#said'));
    await page.click(`${row} .check`);
    await expect(page.locator(row)).not.toHaveClass(/\bleaving\b/);
    if (await page.$eval(row, el => el.classList.contains('done'))) throw new Error('row still marked done after its tick again');
  });
  // A row swiped from `from`% to `to`% (100: a full swipe, done), with no hold, as with a finger (swipeRow).
  const slideProgress = (sel, to, check, from = 0) => swipeRow(page, sel, to, { start: from, check });
  // The progress a row's tick shows (its pie: --pct), and what's uncovered beside it while it's swiped.
  const tickPct = sel => page.locator(sel).evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--pct')) * 100));
  const apiTask = async () => (await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items.find(t => t.title === title);
  /* A plain swipe right, with no hold (parent-tasks-plan, 1 and 1b): the row's content moves with the finger, the space
     it uncovers showing the stop letting go would set, its ring filling a quarter at a time; nothing on the row changes
     until it's let go. Let go short of the first stop, nothing changes; dragged back to where it started, nothing. */
  await step('progress-by-a-plain-swipe-right', async () => {
    await slideProgress(row, 50, async () => {
      await expect(page.locator(`${row}.revealing > .row-prog`)).toHaveAttribute('data-pct', '50');
      await expect(page.locator(`${row} > .row-prog`)).not.toHaveClass(/\bfull\b/);
      if (await tickPct(row) !== 0) throw new Error('the row\'s tick changed while it was swiped: ' + await tickPct(row));
      if (await page.locator('#said').textContent() === `Progress of ${title} set to 50%`) throw new Error('said before it was let go');
    });
    await expect(page.locator('#said')).toHaveText(`Progress of ${title} set to 50%`);
    await noToast(page);
    if (await page.isVisible('#sheet')) throw new Error('letting go opened the task');
    await expect(page.locator(`${row} > .row-prog`)).toHaveCount(0);                // sprung back, the space gone
    await expect.poll(() => tickPct(row)).toBe(50);                              // its tick shows it: a half pie
    const pie = await page.locator(`${row} > .check`).evaluate(el => getComputedStyle(el).backgroundImage);
    if (!/^conic-gradient\(/.test(pie)) throw new Error('its tick has no pie: ' + pie);
    await synced(page);
    if (Math.round((await apiTask()).percent_done * 100) !== 50) throw new Error('saved percent_done ' + (await apiTask()).percent_done);
    // From the right of the row, a full swipe is still within reach before the screen's edge; dragged back to where it
    // started and let go, nothing changes, nor does it turn into its Delete.
    const box = await page.locator(row).boundingBox(), x = box.x + box.width * .9, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(page.viewportSize().width - 4, y + 3, { steps: 8 });
    await expect(page.locator(`${row} > .row-prog`)).toHaveClass(/\bfull\b/);
    await page.mouse.move(x - 60, y, { steps: 8 });
    if (await page.$(`${row}.swiping, ${row}.swipe-full`)) throw new Error('dragged back past where it started, it turned into its Delete');
    await page.mouse.up();
    // Short of the first stop: nothing.
    await page.mouse.move(box.x + 60, y); await page.mouse.down();
    await page.mouse.move(box.x + 75, y + 1, { steps: 4 });
    await page.mouse.up();
    if (await page.isVisible('#sheet')) throw new Error('letting go opened the task');
    await synced(page);
    if (Math.round((await apiTask()).percent_done * 100) !== 50) throw new Error('let go where it started, it saved ' + (await apiTask()).percent_done);
    await expect.poll(() => tickPct(row)).toBe(50);
    // Held on Today, a row does nothing: it isn't lifted, and moved after, nothing changes.
    await page.mouse.move(box.x + 100, y); await page.mouse.down();
    await later(700);
    await expect(page.locator(row)).not.toHaveClass(/\bheld\b/);
    await page.mouse.move(box.x + 100, y + 60, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('#view .dragged')).toHaveCount(0);
  });
  /* A full swipe right is done (1b): the row carries on off the screen, leaving a gap at its height, "Done" and Undo,
     until the batch clears; only `done` is sent, so Undo puts it back at its progress. A partly done tick tapped is
     done, whatever its progress, and tapped again, open with its progress as it was. */
  await step('a-full-swipe-is-done-with-undo-and-a-partly-done-tick-ticks', async () => {
    const sent = page.waitForRequest(r => r.method() === 'PATCH' && /\/tasks\/\d+$/.test(r.url()) && JSON.parse(r.postData() || '{}').done === true);
    const h = await page.locator(row).evaluate(el => el.offsetHeight);
    await slideProgress(row, 100, async () => { await expect(page.locator(`${row} > .row-prog`)).toHaveClass(/\bfull\b/); }, 50);
    const body = JSON.parse((await sent).postData());
    if ('percent_done' in body) throw new Error('done sent ' + JSON.stringify(body));
    await expect(page.locator(row)).toHaveClass(/\bswept\b/);
    await expect(page.locator(`${row} > .del-gap`)).toContainText('Done');
    const undo = page.locator(row).getByRole('button', { name: 'Undo: ' + title });
    await expect(undo).toBeVisible();
    if (await page.locator(row).evaluate(el => el.offsetHeight) !== h) throw new Error('its height changed');
    await undo.click();
    await expect(page.locator(row)).not.toHaveClass(/\bswept\b/);
    await expect(page.locator(row)).not.toHaveClass(/\bdone\b/);
    await synced(page);
    let t = await apiTask();
    if (t.done || Math.round(t.percent_done * 100) !== 50) throw new Error(`after Undo: done ${t.done}, percent_done ${t.percent_done}`);
    await expect.poll(() => tickPct(row)).toBe(50);
    // Its tick, half filled: tapped, done (only `done` sent); tapped again, open at 50%.
    const ticked = page.waitForRequest(r => r.method() === 'PATCH' && /\/tasks\/\d+$/.test(r.url()) && JSON.parse(r.postData() || '{}').done === true);
    await page.getByRole('button', { name: 'Mark done: ' + title, exact: true }).click();
    await expect(page.locator(row)).toHaveClass(/\bdone\b/);
    if ('percent_done' in JSON.parse((await ticked).postData())) throw new Error('its tick sent its progress');
    await page.getByRole('button', { name: 'Mark not done: ' + title, exact: true }).click();
    await expect(page.locator(row)).not.toHaveClass(/\bleaving\b/);
    await synced(page);
    t = await apiTask();
    if (t.done || Math.round(t.percent_done * 100) !== 50) throw new Error(`ticked again: done ${t.done}, percent_done ${t.percent_done}`);
    await expect.poll(() => tickPct(row)).toBe(50);
  });
  // This moves every overdue task of the test account to today, then puts them back with Undo.
  await step('move-overdue-to-today-and-undo', async () => {
    const me = await (await api('/user')).json();
    const due = new Date(); due.setDate(due.getDate() - 2); due.setHours(9, 0, 0, 0);
    const late = 'Pocket smoke overdue ' + stamp;
    const made = await (await api(`/projects/${me.settings.default_project_id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: late, due_date: due.toISOString() }) })).json();
    // A repeating task stays: moved, its next times would follow the new date.
    const daily = await (await api(`/projects/${me.settings.default_project_id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Pocket smoke repeats ' + stamp, due_date: due.toISOString(), repeat_after: 86400 }) })).json();
    const lateRow = `.row:has(.title:has-text("${late}"))`;
    await page.click('#btn-refresh');
    await page.waitForSelector(`.sec.overdue ~ .list ${lateRow}`, { timeout: 15000 });
    await page.click('#btn-overdue-today');
    await page.waitForSelector(`.sec.today ~ .list ${lateRow}`, { timeout: 15000 });
    // Said under the Overdue heading, which stays meanwhile, with its Undo.
    await expect(placeLine(page, 'overdue')).toContainText(/^Moved \d+ to today\. \d+ repeating tasks? stays?: tick/);
    await expect(placeLine(page, 'overdue').getByRole('button', { name: 'Undo' })).toBeVisible();
    await noToast(page);
    if (new Date((await (await api('/tasks/' + daily.id)).json()).due_date).getTime() !== due.getTime()) throw new Error('the repeating task was moved');
    await api('/tasks/' + daily.id, { method: 'DELETE' });
    // At 9:00 as it was, or, once 9:00 has gone today, the next whole hour (in the day's last hour, 11:59 PM).
    const now = new Date(), want = new Date(); want.setHours(9, 0, 0, 0);
    const next = new Date(now); next.setHours(now.getHours() + 1, 0, 0, 0);
    if (next.getDate() !== now.getDate()) next.setTime(new Date(now).setHours(23, 59, 0, 0));
    if (want < now) want.setTime(next.getTime());
    const moved = new Date((await (await api('/tasks/' + made.id)).json()).due_date);
    if (moved.getTime() !== want.getTime()) throw new Error('moved to ' + moved);
    await placeLine(page, 'overdue').getByRole('button', { name: 'Undo' }).click();
    await page.waitForSelector(`.sec.overdue ~ .list ${lateRow}`, { timeout: 15000 });
    const back = new Date((await (await api('/tasks/' + made.id)).json()).due_date);
    if (back.getTime() !== due.getTime()) throw new Error('undo put it at ' + back);
  });
  await step('search', async () => {
    await page.click('#btn-search');
    if (!await page.evaluate(() => document.activeElement?.id === 'in-search')) throw new Error('the search box isn\'t focused');
    await page.waitForSelector('#capture', { state: 'hidden', timeout: 5000 }).catch(() => { throw new Error('the add box still shows'); });
    await page.fill('#in-search', String(stamp));
    await page.waitForSelector(`#view .sec:has-text("Open") ~ .list ${row}`, { timeout: 10000 });
    await page.click('#btn-search-cancel');
    await page.waitForSelector('#capture:not([hidden])');
    if (await page.getAttribute('nav.tabs a[data-tab=today]', 'aria-current') !== 'page') throw new Error('Cancel didn\'t go back to Today');
  });
  await step('upload-html-attachment', async () => {
    const found = (await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items;
    const id = found.find(t => t.title === title)?.id;
    if (!id) throw new Error('task not found');
    const form = new FormData();
    form.append('files', new Blob(['<script>document.title="pwned"</script>'], { type: 'text/html' }), 'evil.html');
    const r = await api(`/tasks/${id}/attachments`, { method: 'POST', body: form });
    if (!r.ok) throw new Error('upload HTTP ' + r.status);
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
  await step('html-attachment-downloads', async () => {
    const popups = [];
    page.context().on('page', p => popups.push(p));
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.click('.att:has-text("evil.html")'),
    ]);
    if (download.suggestedFilename() !== 'evil.html') throw new Error('downloaded ' + download.suggestedFilename());
    if (popups.length) throw new Error('attachment opened in a new tab');
  });
  await step('row-details', async () => {
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    // On Today, one line (motion-and-rows-plan, section 9): its priority's bars, small, before when it's due, short, and
    // its project's dot at the right of its title (one-concept-plan, part 4: its tick's ring isn't its priority); no
    // labels or counts, which a screen reader doesn't need either, but its priority, when it's due in words and its
    // project it hears.
    const R = page.locator(row);
    await expect(R).toHaveClass(/\bone-line\b/);
    await expect(R.locator('.when > .bars.p3 ~ .due')).toHaveText(/\S/);
    const ring = await R.locator('> .check').evaluate(el => getComputedStyle(el).borderTopColor);
    const plain = await page.evaluate(() => { const b = document.createElement('button'); b.className = 'check'; document.body.append(b); const c = getComputedStyle(b).borderTopColor; b.remove(); return c; });
    if (ring !== plain) throw new Error(`its tick's ring is coloured ${ring}, not ${plain}`);
    await expect(R.locator('.when .dot')).toHaveCount(1);
    await expect(R.locator('.meta')).toHaveCount(0);
    const said = await R.locator('.title .sr').allTextContents();
    if (!said.some(s => /Priority: High/.test(s) && /Due |Late: /.test(s))) throw new Error('a screen reader hears ' + JSON.stringify(said));
    if (await R.evaluate(el => el.offsetHeight) > 57) throw new Error('a row on Today is more than one line: ' + await R.evaluate(el => el.offsetHeight));
    // On its project's list, its second line: its priority's bars, its comment and its attachment.
    await page.evaluate(id => { location.hash = '#/project/' + id; }, (await apiTask()).project_id);
    await expect(page.locator(`#view ${row} .meta [aria-label="Comments"]`)).toHaveText('1', { timeout: 15000 });
    const meta = await page.$$eval(`#view ${row} .meta > span[aria-label]`, els => els.map(e => e.getAttribute('aria-label') + '=' + e.textContent.trim()));
    for (const want of ['Priority: High=', 'Comments=1', 'Attachments=1']) if (!meta.includes(want)) throw new Error('row shows ' + JSON.stringify(meta));
    await page.click('nav.tabs a[data-tab=today]');
    await page.click(`.row .body:has-text("${title}")`, { timeout: 15000 });   // back into the task, for the steps below
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
  });
  await step('sanitizer', async () => {
    const r = await page.evaluate(() => {
      const t0 = performance.now();
      sanitize('<x><p>a</p></x>'.repeat(4000));
      return {
        ms: performance.now() - t0,
        frameset: sanitize('<frameset><frame></frameset>hi'),
        links: sanitize('<a href="javascript:alert(1)">a</a><a href="https:javascript:alert(1)">b</a><a href="https://ok.example/">c</a>'),
        alpine: sanitize('<div x-data x-init="alert(1)" @click="alert(1)" :class="x">t</div>'),
        foreign: sanitize('<svg><a href="https://x.example/"><text>s</text></a></svg><math><mi>m</mi></math>'),
        color: colorOf('fff url(https://beacon.example/)'),
      };
    });
    if (r.ms > 1000) throw new Error(`sanitize took ${Math.round(r.ms)} ms`);
    if (/javascript/i.test(r.links) || !r.links.includes('href="https://ok.example/"')) throw new Error('links: ' + r.links);
    if (/x-|@click|:class/.test(r.alpine)) throw new Error('attributes kept: ' + r.alpine);
    if (/<(svg|math|text|mi)\b/i.test(r.foreign)) throw new Error('SVG/MathML kept: ' + r.foreign);
    if (r.color !== 'var(--muted)') throw new Error('color not rejected: ' + r.color);
  });
  /* Priority is a row in Details, its bars and its word, its select over the whole row (Safari can't open a select from
     code); the top bar has the task's number at its left, and ⋯ and ×. */
  await step('set-priority', async () => {
    const card = await page.$('#d-card'), prio = page.locator('#sheet .prop.prio');
    await page.selectOption('#d-prio', '1');
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    if (!await card.evaluate(el => el.isConnected)) throw new Error('saving rebuilt the sheet');
    await expect(prio.locator('.k')).toHaveText('Priority');
    await expect(prio.locator('.v')).toContainText('Low');
    await expect(prio.locator('.bars.p1')).toBeVisible();
    if (await page.inputValue('#d-prio') !== '1') throw new Error('its select says ' + await page.inputValue('#d-prio'));
    await prio.scrollIntoViewIfNeeded();
    const at = await prio.boundingBox();
    for (const x of [at.x + 20, at.x + at.width / 2, at.x + at.width - 20]) {
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [x, at.y + at.height / 2]);
      if (hit !== 'd-prio') throw new Error(`a tap on Priority lands on ${hit || 'nothing'}, not its select`);
    }
    // Just above Progress.
    const keys = await page.locator('#sheet .prop > .k').allTextContents();
    if (keys[keys.indexOf('Priority') + 1] !== 'Progress') throw new Error('Details: ' + keys.join(', '));
    // The top bar: the number at its left, no picker there.
    await expect(page.locator('#sheet .bar .bar-meta #d-id')).toHaveText(/^#\d+$/);
    await expect(page.locator('#sheet .bar select')).toHaveCount(0);
    // Its bars say it; the tick doesn't (one-concept-plan, part 4).
    const tick = await page.locator('#sheet .row.own > .check').getAttribute('class');
    if (/\bp\d\b/.test(tick)) throw new Error("the sheet's tick has its priority: " + tick);
  });
  await page.screenshot({ path: `${OUT}/sheet.png` });
  await step('save-keeps-changes-made-elsewhere', async () => {
    // Notes edited on the web while the sheet is open, then the priority changed in Pocket: both must stick.
    const t = await apiTask();
    const r = await api('/tasks/' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...t, description: '<p>edited on the web</p>' }) });
    if (!r.ok) throw new Error('could not edit the notes: HTTP ' + r.status);
    await expect(page.locator('#d-saved')).not.toHaveText('Saved', { timeout: 5000 });     // (empty, it's hidden)
    await page.selectOption('#d-prio', '2');
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    const after = await apiTask();
    if (!after.description.includes('edited on the web') || after.priority !== 2) throw new Error(`notes ${JSON.stringify(after.description)}, priority ${after.priority}`);
  });
  /* The sheet leads with the task's own row (parent-tasks-plan, 6b): swiped as in a list, it sets progress there; the tap
     path is Details' Progress line, its quarters, the one it's at pressed. */
  await step('progress-in-sheet', async () => {
    const savedPct = async want => {
      await synced(page);
      const got = Math.round((await apiTask()).percent_done * 100);
      if (got !== want) throw new Error(`saved ${got}%, not ${want}%`);
    };
    const own = '#sheet .row.own', chip = n => page.locator('#d-progress').getByRole('button', { name: n + '% done' });
    await expect(page.locator('#d-progress').getByRole('button')).toHaveText(['0%', '25%', '50%', '75%']);
    await expect(chip(50)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, { timeout: 5000 });   // slid in
    await slideProgress(own, 75, null, 50);
    await savedPct(75);
    await expect(chip(75)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => tickPct(own)).toBe(75);
    await chip(50).click();
    await savedPct(50);
    await expect(chip(50)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => tickPct(`#view ${row}`)).toBe(50);                 // its row in the list behind, too
  });
  await step('attach-from-sheet', async () => {
    const before = (await apiTask()).attachments?.length || 0;
    await page.setInputFiles('#d-file', { name: 'smoke-note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await page.waitForSelector('#d-attachments button.att:has-text("smoke-note.txt")', { timeout: 10000 });   // uploaded, not "Uploading…"
    const after = (await apiTask()).attachments?.length || 0;
    if (after !== before + 1) throw new Error(`Vikunja has ${after} attachments, not ${before + 1}`);
  });
  await step('mark-done', async () => {
    await page.click('#sheet .row.own > .check');
    await expect(page.locator('#sheet .row.own')).toHaveClass(/\bdone\b/);
    await synced(page);
    if (!(await apiTask()).done) throw new Error('not done in Vikunja');
  });
  await step('delete', async () => {
    await page.click('#d-more');                                             // the task's ⋯
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
  });
  await step('tap-chip-to-ignore', async () => {
    await page.fill('#in-capture', 'Pay rent tomorrow');
    await page.waitForSelector('#cap-chips .chip[data-kind=due]');
    await page.click('#cap-chips .chip[data-kind=due]');
    await page.waitForSelector('#cap-chips .chip[data-kind=due].off');
    await page.click('#cap-chips .chip[data-kind=due]');
    await page.waitForSelector('#cap-chips .chip[data-kind=due]:not(.off)');
    await page.fill('#in-capture', '');
  });
  await step('mark-read-words', async () => {
    const marks = async n => {
      await page.waitForFunction(n => document.querySelectorAll('#cap-marks mark').length === n, n);
      return JSON.stringify(await page.$$eval('#cap-marks mark', els => els.map(e => e.dataset.kind + ':' + e.textContent)));
    };
    await page.fill('#in-capture', 'Pay rent tomorrow at 5pm *bills');
    let got = await marks(2);
    if (got !== '["due:tomorrow at 5pm","labels:*bills"]') throw new Error('marked ' + got);
    await page.click('#cap-chips .chip[data-kind=due]');                 // tapped off: those words stay, unmarked
    if ((got = await marks(1)) !== '["labels:*bills"]') throw new Error('after tapping the chip: ' + got);
    await page.fill('#in-capture', 'Groceries\n  - [ ] milk tomorrow\n\n- eggs !2');
    if ((got = await marks(2)) !== '["due:tomorrow","priority:!2"]') throw new Error('in a list: ' + got);
    await page.fill('#in-capture', '');
  });
  await step('photo-with-new-task', async () => {
    const t = 'Pocket smoke photo ' + stamp;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('#in-photo', { name: 'receipt.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('#cap-chips .chip.photo:has-text("receipt.png")');
    if (await page.getAttribute('#in-capture', 'placeholder') !== 'What\'s this photo for?') throw new Error('placeholder: ' + await page.getAttribute('#in-capture', 'placeholder'));
    await page.fill('#in-capture', t);
    await page.click('#f-capture .go');
    await expect(page.locator(`.row.fresh:has(.title:has-text("${t}"))`)).toBeVisible({ timeout: 15000 });   // where it went
    await synced(page);
    await noToast(page);
    const made = (await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items[0];
    if (made?.attachments?.[0]?.file?.name !== 'receipt.png') throw new Error('attachments: ' + JSON.stringify(made?.attachments));
  });
  await step('create-project-from-chip', async () => {
    const name = `PocketSmoke${stamp}`, t = `Pocket smoke new project task ${stamp}`;
    await page.fill('#in-capture', `${t} tomorrow +${name}`);
    await page.click('#cap-chips .chip[data-kind=new-project]');
    const made = await Promise.race([
      page.waitForSelector(`#cap-chips .chip[data-kind=project]:has-text("${name}")`, { timeout: 15000 }).then(() => true),
      page.waitForSelector('#capture .place-line:has-text("doesn\'t allow")', { timeout: 15000 }).then(() => false),
    ]);
    if (!made) { console.log('  (this token may not create projects: step skipped)'); await page.fill('#in-capture', ''); return; }
    const project = (await (await api('/projects')).json()).items.find(p => p.title === name);
    if (!project) throw new Error('project not found in Vikunja');
    createdProjects.push(project.id);
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row .title:has-text("${t}")`, { timeout: 15000 });
    await synced(page);
    const task = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
    if (task?.project_id !== project.id) throw new Error('task landed in project ' + task?.project_id);
  });
  await step('pasted-list-says-who-cant-get-it', async () => {
    // Someone named in a pasted list who isn't a user is said before it's sent, as for a single task. A line ticked off
    // already is left out, and so are its marks: the next line's are on its own words.
    await page.fill('#in-capture', `- [x] Pocket smoke napkins\n- Pocket smoke list tomorrow @nobody${stamp}\n- Pocket smoke cups`);
    await page.waitForSelector(`#cap-chips .chip.warn:has-text("No user @nobody${stamp}")`, { timeout: 10000 });
    const marked = await page.$$eval('#cap-marks mark', els => els.map(e => e.dataset.kind + ':' + e.textContent));
    if (!marked.includes('due:tomorrow')) throw new Error('marks: ' + JSON.stringify(marked));
    await page.fill('#in-capture', '');
  });
  await step('pasted-list-goes-to-one-project', async () => {
    // The first +project anywhere in a list applies to every line; a later, different one stays in its line's text.
    const name = `PocketList${stamp}`, line = x => `Pocket smoke list line ${x} ${stamp}`;
    await page.fill('#in-capture', `${line('A')} tomorrow\n${line('B')} tomorrow +${name}\nPocket smoke list line C +Other ${stamp}`);
    await page.click('#cap-chips .chip[data-kind=new-project]');
    const made = await Promise.race([
      page.waitForSelector(`#cap-chips .chip:not([data-kind]):has-text("${name}")`, { timeout: 15000 }).then(() => true),
      page.waitForSelector('#capture .place-line:has-text("doesn\'t allow")', { timeout: 15000 }).then(() => false),
    ]);
    if (!made) { console.log('  (this token may not create projects: step skipped)'); await page.fill('#in-capture', ''); return; }
    const project = (await (await api('/projects')).json()).items.find(p => p.title === name);
    createdProjects.push(project.id);
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row .title:has-text("${line('B')}")`, { timeout: 20000 });
    await synced(page);
    const find = async t => ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
    for (const t of [line('A'), line('B'), `Pocket smoke list line C +Other ${stamp}`]) {
      const task = await find(t);
      if (task?.project_id !== project.id) throw new Error(`"${t}" is in project ${task?.project_id}`);
    }
  });
  await step('repeat-from-quick-add-and-sheet', async () => {
    const t = `Pocket smoke repeat ${stamp}`;
    await page.fill('#in-capture', `${t} every week`);
    if (!(await page.textContent('#cap-chips')).includes('Every week')) throw new Error('chips: ' + await page.textContent('#cap-chips'));
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row .title:has-text("${t}")`, { timeout: 15000 });
    await page.click(`.row .body:has-text("${t}")`);
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });     // the sheet has finished loading
    await page.waitForFunction(() => document.querySelector('#d-repeat')?.value === 'week', null, { timeout: 10000 });
    await page.selectOption('#d-repeat', 'month');
    let saved;                                                  // "Saved" shows only briefly, so ask Vikunja instead
    for (let i = 0; i < 40; i++) {
      saved = (await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items[0];
      if (saved?.repeat_mode === 1) break;
      await page.waitForTimeout(250);
    }
    if (saved?.repeat_mode !== 1) throw new Error('server repeat_mode ' + saved?.repeat_mode);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  await step('added-today-no-date', async () => {
    // A task added today without a date stays on Today until it gets one. A pasted list's first line, with the rest
    // under it, is a card there, on its subtask: never a row of the subtask's own.
    const t = `Pocket smoke undated ${stamp}`, sub = `Pocket smoke undated sub ${stamp}`;
    const noDate = 'div:has(> .sec:has-text("Added today, no date"))';
    await page.fill('#in-capture', `${t}\n- ${sub}`);
    await page.click('#cap-nest');
    await page.click('#f-capture .go');
    await page.waitForSelector(`${noDate} :is(.row .title, .card-title):has-text("${t}")`, { timeout: 15000 });
    if (await page.isVisible(`.item > .row .title:has-text("${sub}")`)) throw new Error('the subtask is a row of its own on Today');
    await expect(page.locator(`${noDate} ${cardOf(t)} .step-line .title > span:not(.sr)`)).toHaveText(sub, { timeout: 15000 });
    await expect(page.locator(`${cardOf(t)} .card-more`)).toHaveCount(0);       // one open subtask: no More
    await expect(page.locator(`.item > .row .title:has-text("${sub}")`)).toHaveCount(0);
    await page.click(`${cardOf(t)} > .card-head`);
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
    const d = new Date(Date.now() + 86400000), p = n => String(n).padStart(2, '0');
    await page.fill('#d-due', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00`);
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector(`div:has(> .sec:has-text("Next 7 days")) ${cardOf(t)}`, { timeout: 15000 });
    if (await page.isVisible(`${noDate} ${cardOf(t)}`)) throw new Error('still under Added today, no date');
  });
  const parentTitle = `Pocket smoke list ${stamp}`;
  await step('paste-list-with-parent', async () => {
    // Pasted from an email or note: bullets and checkboxes are stripped, the first line becomes the parent.
    await page.fill('#in-capture', `${parentTitle} tomorrow\n- Pocket smoke sub A ${stamp}\n• [ ] Pocket smoke sub B ${stamp}`);
    if (!(await page.textContent('#cap-chips')).includes('3 tasks')) throw new Error('chips: ' + await page.textContent('#cap-chips'));
    await page.click('#cap-nest');
    if (!(await page.textContent('#cap-chips')).includes('1 task + 2 subtasks')) throw new Error('chips: ' + await page.textContent('#cap-chips'));
    await page.click('#f-capture .go');
    // Lit up where it went: its row, or, once read with its subtasks, its card.
    await page.waitForSelector(`:is(.row.fresh .title, .day-card.fresh .card-title):has-text("${parentTitle}")`, { timeout: 15000 });
    await noToast(page);
  });
  await step('subtasks-in-sheet', async () => {
    await page.click(opener(parentTitle));
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === 2, null, { timeout: 10000 });
    const names = await page.$$eval('#d-subtasks .row .title', els => els.map(e => e.textContent));
    if (!names.some(n => n === `Pocket smoke sub B ${stamp}`)) throw new Error('markers not stripped: ' + names.join(' | '));
    if (!await page.isVisible('#d-subform .go use[href="#i-plus"]')) throw new Error('the add button is not a +');
    await page.fill('#d-subin', `Pocket smoke sub C ${stamp}`);
    await page.press('#d-subin', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === 3, null, { timeout: 15000 });
    if (await page.evaluate(() => document.activeElement?.id) !== 'd-subin') throw new Error('the box lost the focus');
    await page.click('#d-subtasks .row:first-of-type .check');
    await page.waitForSelector('#d-subcount:text("1/3")', { timeout: 10000 });
  });
  await step('subtask-box-reads-like-quick-add', async () => {
    // The same marks and chips as quick add; a chip tapped off keeps its words in the title.
    await page.fill('#d-subin', `Pocket smoke sub D tomorrow !2 ${stamp}`);
    await page.waitForSelector('#d-subchips .chip[data-kind=due]');
    await page.waitForSelector('#d-subchips .chip[data-kind=priority]:has-text("Priority 2")');
    const marks = await page.$$eval('#d-subbox .cap-marks mark', els => els.map(e => e.dataset.kind + ':' + e.textContent));
    if (JSON.stringify(marks) !== JSON.stringify(['due:tomorrow', 'priority:!2'])) throw new Error('marks: ' + JSON.stringify(marks));
    await page.click('#d-subchips .chip[data-kind=due]');
    await page.waitForSelector('#d-subchips .chip.off[data-kind=due]');
    await page.click('#d-subform .go');
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === 4, null, { timeout: 15000 });
    if (await page.evaluate(() => document.activeElement?.id) !== 'd-subin') throw new Error('the box lost the focus after the + was tapped');
    // A subtask stays in its task's project: +project isn't read, or offered in the hint, and stays in the title.
    await page.waitForSelector('#d-subhint');
    if ((await page.textContent('#d-subhint')).includes('project')) throw new Error('hint: ' + await page.textContent('#d-subhint'));
    await page.fill('#d-subin', `Pocket smoke sub E +Elsewhere ${stamp}`);
    await page.waitForTimeout(300);
    if (await page.$('#d-subchips .chip[data-kind=project], #d-subchips .chip[data-kind=new-project]')) throw new Error('+project was read in a subtask');
    await page.waitForSelector('#d-subchips .chip.quiet:has-text("stays as words")');            // and says so
    await page.fill('#d-subin', '');
    const t = ((await (await api('/tasks?q=' + encodeURIComponent('sub D'))).json()).items || []).find(x => x.title.includes('sub D tomorrow') && x.title.endsWith(String(stamp)));
    if (!t || t.priority !== 2 || (t.due_date && !t.due_date.startsWith('0001'))) throw new Error('saved as ' + JSON.stringify(t && { title: t.title, priority: t.priority, due: t.due_date }));
  });
  await step('claim-a-subtask', async () => {
    // "+ me" on an open subtask assigns it to you, and your picture there lets it go. A done one has no slot.
    // Found by its id: the order Vikunja gives a task's subtasks in can differ from one reading to the next.
    const me = await (await api('/user')).json(), id = +await page.getAttribute('#d-subtasks .row:not(.done) >> nth=0', 'data-id');
    const row = `#d-subtasks .row[data-id="${id}"]`, people = async () => ((await (await api('/tasks/' + id)).json()).assignees || []).map(u => u.id);
    if (await page.$('#d-subtasks .row.done .claim')) throw new Error('a done subtask with no one on it has a slot');
    const radius = await page.$eval(`${row} > .check`, el => getComputedStyle(el).borderRadius);
    if (radius !== '50%') throw new Error("a subtask's box isn't round: " + radius);
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    for (let i = 0; JSON.stringify(await people()) !== JSON.stringify([me.id]); i++) { if (i > 40) throw new Error('never assigned'); await new Promise(r => setTimeout(r, 250)); }
    // Shown again when the sheet is opened again: Vikunja leaves a task's subtasks' assignees out, so Pocket asks.
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click(opener(parentTitle));
    await page.waitForSelector(`${row} .claim.mine .av`, { timeout: 10000 });
    if (!(await page.getAttribute(`${row} .claim`, 'aria-label')).startsWith("You're doing")) throw new Error('says ' + await page.getAttribute(`${row} .claim`, 'aria-label'));
    await page.click(`${row} .claim`);
    await page.waitForSelector(`${row} .claim .me`);
    for (let i = 0; (await people()).length; i++) { if (i > 40) throw new Error('never let go'); await new Promise(r => setTimeout(r, 250)); }
  });
  // The sheet's own row's title, as it shows it (not what a screen reader hears with it).
  const ownTitle = () => page.locator('#sheet .row.own .title > span:not(.sr)').first();
  await step('subtask-links-to-parent', async () => {
    await page.click('#d-subtasks .row:first-of-type .body');
    await page.waitForSelector(`#d-parent:has-text("${parentTitle}")`, { timeout: 10000 });
    await page.click('#d-parent');
    await expect(ownTitle()).toHaveText(parentTitle);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  /* On its project's list a task with open subtasks is a stacked card, open (parent-tasks-plan, part 2): its header, its
     ring for a tick with its count inside it, and every open subtask a row on it, in place of the indented rows under
     it; on Today, a card, its subtasks never rows of their own. */
  const parentCard = () => page.locator(`#view ${cardOf(parentTitle)}`);
  await step('subtasks-under-parent-in-list', async () => {
    const parent = ((await (await api('/tasks?q=' + encodeURIComponent(parentTitle))).json()).items || []).find(x => x.title === parentTitle);
    await page.evaluate(id => { location.hash = '#/project/' + id; }, parent.project_id);
    await expect(parentCard()).toBeVisible({ timeout: 15000 });
    await expect(parentCard()).toHaveClass(/\bopen\b/);
    await expect(parentCard().locator('.card-head > .ring .n')).toHaveText('1/4');
    await expect(parentCard().locator('.card-head > .check')).toHaveCount(0);
    const rows = parentCard().locator('.card-rows > .row');
    await expect(rows).toHaveCount(3);
    for (const t of await rows.locator('.title > span:not(.sr)').allTextContents()) if (!t.includes('sub') || !t.endsWith(String(stamp))) throw new Error('a row on the card: ' + t);
    await expect(parentCard().locator('.card-more')).toHaveCount(0);           // always open there: no More
    await expect(page.locator(`#view .list > .item > .row:has(.title:has-text("Pocket smoke sub"))`)).toHaveCount(0);
    // On Today, a card: its subtasks aren't rows of their own there.
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.waitForSelector(`div:has(> .sec:has-text("Next 7 days")) ${cardOf(parentTitle)}`, { timeout: 15000 });
    await expect(page.locator('.item > .row .title:has-text("Pocket smoke sub")')).toHaveCount(0);
  });
  /* A parent's ring (parent-tasks-plan, part 3): its progress worked out from its subtasks, a done one 100%, and written
     to its percent_done with the change that caused it, once; tapped, or its header swiped right all the way, it asks
     before completing its open subtasks with it, naming them in a sentence; a partial swipe springs back. Completed, the
     card is a gap with Undo, which opens again exactly those. With one open subtask, no question: both done, with Undo.
     Every subtask done, it waits for Close; a subtask added takes Close away and drops the ring back. Ticking a
     parent no longer closes its subtasks by itself (its tick is the ring). */
  await step('a-parents-ring-its-figure-and-the-question-it-asks', async () => {
    const parent = ((await (await api('/tasks?q=' + encodeURIComponent(parentTitle))).json()).items || []).find(x => x.title === parentTitle);
    const read = async () => (await (await api('/tasks/' + parent.id)).json());
    const subs = async () => (await read()).related_tasks?.subtask || [];
    const open = (await subs()).filter(s => !s.done), names = open.map(s => s.title);
    if (open.length !== 3) throw new Error('open subtasks before: ' + open.length);
    await page.evaluate(id => { location.hash = '#/project/' + id; }, parent.project_id);
    await loaded(page);
    const card = parentCard(), ring = card.locator('.card-head > .ring'), head = `#view ${cardOf(parentTitle)} > .card-head`;
    const arc = () => ring.evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100));
    // 1 of 4 done: 25%, written to it when that subtask was ticked in its sheet.
    await expect(ring.locator('.n')).toHaveText('1/4');
    await expect.poll(arc).toBe(25);
    if (Math.round((await read()).percent_done * 100) !== 25) throw new Error("the parent's progress in Vikunja: " + (await read()).percent_done);
    // A subtask swiped to 50% on the card: the figure, (100 + 50) / 4 = 38%, on the ring and in Vikunja, written once.
    const writes = [], see = r => r.method() !== 'GET' && new RegExp(`/tasks/${parent.id}$`).test(r.url()) && writes.push(r.postData());
    page.on('request', see);
    const first = card.locator('.card-rows > .row').first(), firstId = +await first.getAttribute('data-id');
    try {
      await slideProgress(`#view .card-rows > .row[data-id="${firstId}"]`, 50);
      await expect.poll(arc).toBe(38);
      await synced(page);
      await expect.poll(async () => Math.round((await read()).percent_done * 100)).toBe(38);
      if (writes.length !== 1 || JSON.parse(writes[0]).percent_done !== .38) throw new Error('written to the parent: ' + JSON.stringify(writes));
    } finally { page.off('request', see); }
    if ((await read()).done) throw new Error('the parent was done');
    // Its ring tapped: the question, its open subtasks named in a sentence. Cancel: nothing changes.
    const question = page.locator('#complete');
    const asks = async () => {
      await expect(question.locator('h2')).toHaveText(`Complete “${parentTitle}”?`);
      await expect(question.locator('#complete-note')).toContainText('Its 3 open subtasks will be marked done too: ');
      for (const n of names) await expect(question.locator('#complete-note')).toContainText(n);
      await expect(question.locator('#complete-yes')).toHaveText('Complete all 4');
      await expect(question.locator('input, .check, .complete-item')).toHaveCount(0);   // a sentence, not boxes to pick
    };
    await ring.click();
    await asks();
    await page.click('#complete-no');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    // Its header swiped right a little: it springs back, asking nothing; all the way: the same question.
    await swipeRow(page, head, 'back', { one: true });
    await page.waitForTimeout(300);
    if (await page.isVisible('#sheet')) throw new Error('a partial swipe on a header opened something');
    await expect(page.locator(`${head}.revealing`)).toHaveCount(0);
    await swipeRow(page, head, 100, { one: true });
    await asks();
    await page.click('#complete-no');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await synced(page);
    if ((await subs()).filter(s => !s.done).length !== 3 || (await read()).done) throw new Error('Cancel changed something');
    // Complete all: the card a gap, "Done" and Undo; all done in Vikunja. Undo opens again exactly those.
    await ring.click();
    await page.click('#complete-yes');
    await expect(card).toHaveClass(/\bswept\b/);
    await expect(card.locator('.del-gap')).toContainText('Done');
    await synced(page);
    if (!(await read()).done || (await subs()).some(s => !s.done)) throw new Error('not all completed in Vikunja');
    await card.getByRole('button', { name: 'Undo: ' + parentTitle }).click();
    await expect(card).not.toHaveClass(/\bswept\b/);
    await synced(page);
    if ((await read()).done) throw new Error('the parent is still done');
    if (JSON.stringify((await subs()).filter(s => !s.done).map(s => s.id).sort()) !== JSON.stringify(open.map(s => s.id).sort())) throw new Error('after Undo, open: ' + JSON.stringify((await subs()).map(s => [s.title, s.done])));
    // Two of its open subtasks ticked: with one open, its ring asks nothing: it and the parent are done, with Undo.
    for (const s of open.slice(1)) await page.getByRole('button', { name: 'Mark done: ' + s.title, exact: true }).click();
    await later(3000);
    await expect(card.locator('.card-rows > .row')).toHaveCount(1);
    await expect(ring.locator('.n')).toHaveText('3/4');
    await ring.click();
    await expect(card).toHaveClass(/\bswept\b/);
    if (await page.isVisible('#sheet')) throw new Error('it asked, with one open subtask');
    await synced(page);
    if (!(await read()).done || (await subs()).some(s => !s.done)) throw new Error('not both done');
    await card.getByRole('button', { name: 'Undo: ' + parentTitle }).click();
    await expect(card).not.toHaveClass(/\bswept\b/);
    await synced(page);
    if ((await read()).done || (await subs()).filter(s => !s.done).length !== 1) throw new Error('Undo: ' + JSON.stringify((await subs()).map(s => [s.title, s.done])));
    // The last one ticked: nothing closes by itself. "All subtasks done", and Close.
    await page.getByRole('button', { name: 'Mark done: ' + open[0].title, exact: true }).click();
    await later(3000);
    await expect(card.locator('.card-close')).toContainText('All subtasks done');
    await expect(ring.locator('.n')).toHaveText('4/4');
    await synced(page);
    if ((await read()).done) throw new Error('the last subtask done closed the parent');
    // A subtask added (the add box, aimed at it by opening its sheet): Close goes, the ring drops back.
    await page.click(`${head} > .card-open`);
    await expect(ownTitle()).toHaveText(parentTitle);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(page.locator('#cap-target')).toHaveText(`Add a subtask to ${parentTitle}`);
    const late = `Pocket smoke sub late ${stamp}`;
    await page.fill('#in-capture', late);
    await page.press('#in-capture', 'Enter');
    await expect(card.locator('.card-rows > .row')).toHaveCount(1);
    await expect(card.locator('.card-close')).toHaveCount(0);
    await expect(ring.locator('.n')).toHaveText('4/5');
    await synced(page);
    await expect.poll(async () => Math.round((await read()).percent_done * 100)).toBe(80);
    // Ticked, then Close: the parent done, a gap with Undo, gone with the batch.
    await page.getByRole('button', { name: 'Mark done: ' + late, exact: true }).click();
    await later(3000);
    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card).toHaveClass(/\bswept\b/);
    await synced(page);
    if (!(await read()).done) throw new Error('Close didn\'t complete it');
    await later(3000);
    await expect(card).toHaveCount(0);
    const instead = page.getByRole('button', { name: /^Add a task to .* instead$/ });
    if (await instead.isVisible()) await instead.click();
    await page.evaluate(() => { location.hash = '#/today'; });
    await loaded(page);
  });
  await step('a-pasted-list-on-screen-says-nothing', async () => {
    // Its rows light up where they went; one added by mistake is deleted from its row, which has its Undo.
    const a = `Pocket smoke paste 1 ${stamp}`, b = `Pocket smoke paste 2 ${stamp}`;
    await page.fill('#in-capture', `1. ${a} tomorrow\n2. ${b} tomorrow`);
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row.fresh .title:has-text("${b}")`, { timeout: 15000 });
    await page.waitForSelector(`.row.fresh .title:has-text("${a}")`, { timeout: 15000 });
    await synced(page);
    await noToast(page);
    if (await placeLine(page, 'cap').count()) throw new Error('the add box said: ' + await placeLine(page, 'cap').textContent());
  });
  if (ASSIGNEE) await step('assign-from-quick-add', async () => {
    const t = `Pocket smoke assign ${stamp}`;
    // A token without Projects → Users search can't check who sees a project: Pocket then assigns as best it can.
    const canLook = (await api('/projects/1/users/search?q=x')).status !== 401;
    await page.fill('#in-capture', `${t} tomorrow @${ASSIGNEE} @nobody-${stamp}` + (ASSIGNEE_PROJECT ? ` +"${ASSIGNEE_PROJECT}"` : ''));
    const chips = await page.textContent('#cap-chips');
    if (!chips.includes('@' + ASSIGNEE)) throw new Error('chips: ' + chips);
    if (canLook) await page.waitForSelector(`#cap-chips .chip.warn:has-text("No user @nobody-${stamp}")`, { timeout: 15000 });   // said before sending
    await page.click('#f-capture .go');
    await placeSays(page, 'cap', `no user @nobody-${stamp}`);               // what didn't go as asked, by the add box
    // The assigned person leaves the title, as in Vikunja, when Pocket could check; the unknown one stays.
    const saved = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title.startsWith(t));
    const want = canLook ? `${t} @nobody-${stamp}` : `${t} @${ASSIGNEE} @nobody-${stamp}`;
    if (saved?.title !== want) throw new Error('title: ' + saved?.title);
    await page.click(`.row .body:has-text("${t}")`);
    await page.waitForSelector(`#d-assignees .label-chip:has-text("${ASSIGNEE}")`, { timeout: 10000 });
    await page.click(`#d-assignees .label-chip:has-text("${ASSIGNEE}") .x`);
    await page.waitForSelector(`#d-assignees .label-chip:has-text("${ASSIGNEE}")`, { state: 'detached', timeout: 10000 });
    await page.click('#d-add-assignee');
    await page.fill('#d-assign-in', ASSIGNEE);
    await page.press('#d-assign-in', 'Enter');
    await page.waitForSelector(`#d-assignees .label-chip:has-text("${ASSIGNEE}")`, { timeout: 10000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  if (ASSIGNEE) await step('assign-picks-the-shared-project', async () => {
    // Only when the default project isn't shared with ASSIGNEE and exactly one other project is, as in the local setup.
    const me = await (await api('/user')).json(), projects = (await (await api('/projects')).json()).items.filter(p => p.id > 0);
    const home = me.settings?.default_project_id || projects[0]?.id;
    const sees = async id => { const r = await api(`/projects/${id}/users/search?q=${encodeURIComponent(ASSIGNEE)}`); return r.ok ? ((await r.json()).items || []).some(u => u.username === ASSIGNEE) : null; };
    const shared = [];
    for (const p of projects) { const v = await sees(p.id); if (v === null) { console.log('  (this token may not use Projects → Users search: step skipped)'); return; } if (v) shared.push(p); }
    if (shared.some(p => p.id === home) || shared.length !== 1) { console.log('  (needs exactly one project shared with ' + ASSIGNEE + ', not the default: step skipped)'); return; }
    const to = shared[0], homeTitle = projects.find(p => p.id === home)?.title, t = `Pocket smoke auto project ${stamp}`;
    await page.fill('#in-capture', `${t} tomorrow @${ASSIGNEE}`);
    const auto = `#cap-chips .chip[data-kind=autoProject]:has-text("${to.title}")`;
    await page.waitForSelector(auto, { timeout: 15000 });
    await page.click(auto);                                                        // undo: back to the default, with a warning
    await page.waitForSelector(`#cap-chips .chip.warn:has-text("@${ASSIGNEE} can't see ${homeTitle}")`);
    await page.click(auto);
    await page.waitForSelector(`#cap-chips .chip.warn`, { state: 'detached' });
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row .title:has-text("${t}")`, { timeout: 20000 });   // tomorrow: on Today, so nothing's said
    await synced(page);
    const task = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
    if (task?.project_id !== to.id) throw new Error('project ' + task?.project_id);
    if (!task.assignees?.some(u => u.username === ASSIGNEE)) throw new Error('not assigned');
  });
  await step('suggest-label-and-person', async () => {
    // Typing *pocket-sm offers the existing label; tapping it finishes the word. The same for @ and a person you share with.
    await page.fill('#in-capture', `Pocket smoke suggest ${stamp} *${label.slice(0, 9)}`);
    await page.click(`#cap-chips .chip[data-kind=suggest]:has-text("*${label}")`, { timeout: 15000 });
    if (await page.inputValue('#in-capture') !== `Pocket smoke suggest ${stamp} *${label} `) throw new Error('text: ' + await page.inputValue('#in-capture'));
    if (ASSIGNEE && (await api('/projects/1/users/search?q=x')).status !== 401) {
      await page.type('#in-capture', '@' + ASSIGNEE.slice(0, 2));
      await page.click(`#cap-chips .chip[data-kind=suggest]:has-text("@${ASSIGNEE}")`, { timeout: 15000 });
      if (!(await page.inputValue('#in-capture')).endsWith(`*${label} @${ASSIGNEE} `)) throw new Error('text: ' + await page.inputValue('#in-capture'));
    }
    await page.fill('#in-capture', '');
  });
  // ---- Things that work the same way everywhere: Undo, focus, the sheet's pickers, subtasks moving and going with their task ----
  const me2 = await (await api('/user')).json(), projects2 = (await (await api('/projects')).json()).items.filter(p => p.id > 0);
  const home2 = me2.settings?.default_project_id || projects2[0]?.id;
  const json = { 'Content-Type': 'application/json' };
  const make = async (t, extra = {}, pid = home2) => (await api(`/projects/${pid}/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title: t, ...extra }) })).json();
  const get = async id => { const r = await api('/tasks/' + id); return r.ok ? r.json() : null; };
  const todayAt = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const refreshToday = async () => { await page.evaluate(() => { location.hash = '#/today'; }); await page.click('#btn-refresh'); await page.waitForSelector('#btn-refresh:not([disabled])'); };
  const rowOf = t => `.row:has(> .body .title:has-text("${t}"))`;
  // A row's tick, found by what a screen reader hears it called.
  const tick = title => page.getByRole('button', { name: 'Mark done: ' + title, exact: true }).click({ timeout: 15000 });
  const toastGone = () => toastGoneOn(page).catch(() => {});

  await step('quick-add-keeps-focus-and-says-where-a-task-went', async () => {
    // On this screen, its row lights up and nothing's said; off it (due next month, on Today), the add box says where it
    // went, with Open. The box keeps the focus for the next one either way.
    const t = `Pocket smoke focus ${stamp}`, far = `Pocket smoke far ${stamp}`, home = projects2.find(p => p.id === home2)?.title;
    await toastGone();
    await page.focus('#in-capture');
    await page.fill('#in-capture', t);
    await page.click('#f-capture .go');
    await expect(page.locator(`.row.fresh:has(.title:has-text("${t}"))`)).toBeVisible({ timeout: 20000 });
    if (await page.evaluate(() => document.activeElement?.id) !== 'in-capture') throw new Error('the box lost the focus');
    await synced(page);
    await noToast(page);
    await page.fill('#in-capture', `${far} in 5 weeks`);
    await page.click('#f-capture .go');
    await placeSays(page, 'cap', `Added to ${home}, due `);
    await noToast(page);
    if (await page.evaluate(() => document.activeElement?.id) !== 'in-capture') throw new Error('the box lost the focus');
    if (!(await page.textContent('#said')).startsWith(`Added to ${home}`)) throw new Error('a screen reader hears: ' + await page.textContent('#said'));
    await placeLine(page, 'cap').getByRole('button', { name: 'Open' }).click();
    await expect(ownTitle()).toHaveText(far);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.evaluate(() => document.activeElement?.blur());
  });

  /* Rows ticked stay where they are, at their height, until 3 seconds after the last tick, counted from when the finger
     lifts; then they leave together, the rows below closing up once. A finger down holds them. */
  // Watches rows `ids` as they go: the heights each is drawn at (to see it fold), and which change took it off the
  // page, so rows that went together went in the same one. Read with gone().
  const watchGoing = ids => page.evaluate(ids => {
    const w = window.__going = { heights: {}, gone: {}, n: 0 };
    const ro = new ResizeObserver(es => { for (const e of es) (w.heights[e.target.dataset.id] ||= []).push(Math.round(e.target.getBoundingClientRect().height)); });
    for (const id of ids) for (const el of document.querySelectorAll(`#view .row[data-id="${id}"]`)) ro.observe(el);
    new MutationObserver(rs => { w.n++; for (const r of rs) for (const el of r.removedNodes) if (el.dataset?.id) w.gone[el.dataset.id] ??= w.n; })
      .observe(document.getElementById('view'), { childList: true, subtree: true });
  }, ids.map(String));
  const gone = () => page.evaluate(() => window.__going);
  await step('ticks-stay-in-place-then-leave-together', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(n => make(`Pocket smoke tick ${n} ${stamp}`, { due_date: todayAt(23) })));
    const A = rowOf(a.title), B = rowOf(b.title), C = rowOf(c.title), heights = () => Promise.all([A, B, C].map(r => page.locator(r).evaluate(el => el.offsetHeight)));
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(C)).toBeVisible();
      const before = await heights();
      await tick(a.title);
      await tick(b.title);
      await tick(c.title);
      for (const r of [A, B, C]) await expect(page.locator(r)).toHaveClass(/\bleaving\b/);
      await watchGoing([a.id, b.id]);
      if (JSON.stringify(await heights()) !== JSON.stringify(before)) throw new Error(`heights ${before} became ${await heights()}`);
      // A tap on a tick before they go opens it again, and it stays.
      await page.getByRole('button', { name: 'Mark not done: ' + c.title, exact: true }).click();
      await expect(page.locator(C)).not.toHaveClass(/\bleaving\b/);
      // A finger down, anywhere, holds them; 3 seconds after it lifts, they go.
      // (on a heading, in the middle of the screen: one scrolled off it would get no touch, and one under the header
      // would put the finger on a tab, and tapping Today clears them at once)
      await page.locator('#view .sec').first().evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const sec = await page.locator('#view .sec').first().boundingBox();
      await page.mouse.move(sec.x + 4, sec.y + sec.height / 2);
      await page.mouse.down();
      await later(6000);
      await expect(page.locator(A)).toHaveCount(1);
      await page.mouse.up();
      await later(2800);
      for (const r of [A, B]) await expect(page.locator(r)).toHaveClass(/\bleaving\b/);
      if (JSON.stringify(await heights()) !== JSON.stringify(before)) throw new Error(`while waiting, heights ${before} became ${await heights()}`);
      await later(300);
      await expect(page.locator(A)).toHaveCount(0);
      await expect(page.locator(B)).toHaveCount(0);
      const w = await gone();
      if (!w.gone[a.id] || w.gone[a.id] !== w.gone[b.id]) throw new Error('not taken off together: ' + JSON.stringify(w.gone));
      if (!w.heights[a.id]?.some(h => h > 0 && h < before[0])) throw new Error('A never folded: ' + JSON.stringify(w.heights));
      await expect(page.locator(C)).toBeVisible();
      await synced(page);
      if (!(await get(a.id)).done || !(await get(b.id)).done || (await get(c.id)).done) throw new Error('done in Vikunja: ' + [(await get(a.id)).done, (await get(b.id)).done, (await get(c.id)).done]);
      // Open again for the search below.
      await api('/tasks/' + a.id, { method: 'PATCH', headers: json, body: JSON.stringify({ done: false }) });
    } finally { for (const t of [b, c]) await api('/tasks/' + t.id, { method: 'DELETE' }); }
  });
  await step('with-less-motion-rows-ticked-go-without-folding', async () => {
    const d = await make(`Pocket smoke tick D ${stamp}`, { due_date: todayAt(23) }), D = rowOf(d.title);
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await refreshToday();
      await tick(d.title);
      await expect(page.locator(D)).toHaveClass(/\bleaving\b/);
      const full = await page.locator(D).evaluate(el => el.offsetHeight);
      await watchGoing([d.id]);
      await later(3000);
      await expect(page.locator(D)).toHaveCount(0);
      const w = await gone();
      if (w.heights[d.id]?.some(h => h > 0 && h < full - 1)) throw new Error('it folded: ' + JSON.stringify(w.heights[d.id]));
    } finally {
      await page.emulateMedia({ reducedMotion: null });
      await api('/tasks/' + d.id, { method: 'DELETE' });
    }
  });

  /* Every row has who's doing it at its end, as a subtask in a sheet does; a subtask's tick shows on its row, which stays
     until the batch clears; on a project's list (not Today), a row swiped left shows its Delete, which leaves the row
     dimmed, with Restore, and deletes only once the batch clears. */
  const swipe = async (sel, from = 200, by = -100) => {
    await page.locator(sel).scrollIntoViewIfNeeded();                       // once a sheet has slid in
    await page.$eval(sel, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));    // and clear of the header
    await page.waitForTimeout(100);
    const box = await page.locator(sel).boundingBox(), y = box.y + box.height / 2;
    await page.mouse.move(from, y); await page.mouse.down();
    await page.mouse.move(from + by, y + 4, { steps: 8 });
    await page.mouse.up();
  };
  /* Row `sel`, frame by frame for a second, from now: its height and width, how far its content is moved aside (x),
     whether it's deleted, its gap showing, and its title in sight. framesSeen() waits for them. */
  const watchFrames = sel => page.$eval(sel, el => {
    const seen = window.__frames = [], t0 = performance.now(); window.__framed = false;
    (function look(){
      const x = new DOMMatrix(getComputedStyle(el).transform).m41, body = el.querySelector(':scope > .body'), gap = el.querySelector(':scope > .del-gap');
      seen.push({ h: el.offsetHeight, w: el.clientWidth, x, deleted: el.classList.contains('deleted'), gap: !!gap,
        shown: getComputedStyle(body).visibility === 'visible' && x > -el.clientWidth / 2 });
      if (performance.now() - t0 < 1000) requestAnimationFrame(look); else window.__framed = true;
    })();
  });
  const framesSeen = async () => { await page.waitForFunction(() => window.__framed, null, { polling: 100 }); return page.evaluate(() => window.__frames); };
  // Its Delete, once the row has moved aside for it: tapped where it is, as a finger would.
  const tapDelete = async sel => {
    await page.waitForSelector(`${sel}.swiped > .row-del`);
    await page.waitForTimeout(300);
    const b = await page.locator(`${sel} > .row-del`).boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  await step('a-rows-slot-tick-and-swipe-to-delete', async () => {
    const me = await (await api('/user')).json();
    const p = await make(`Pocket smoke row parent ${stamp}`, { due_date: todayAt(23) }), k = await make(`Pocket smoke row kid ${stamp}`, { due_date: todayAt(23) }), o = await make(`Pocket smoke row own ${stamp}`, { due_date: todayAt(23) });
    await api(`/tasks/${p.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }) });
    const people = async id => ((await get(id)).assignees || []).map(u => u.id), P = rowOf(o.title), K = rowOf(k.title);
    try {
      await toastGone();
      // On its project's list: a row of its own, and a subtask, a row on its parent's card.
      await page.evaluate(id => { location.hash = '#/project/' + id; }, home2);
      await loaded(page);
      await page.waitForSelector(`${cardOf(p.title)} > .card-rows > ${K}`, { timeout: 15000 });
      // Claimed from its row, and let go again.
      const claim = page.getByRole('button', { name: `Tap to say you'll do ${o.title}` }), mine = page.getByRole('button', { name: `You're doing ${o.title}. Tap to let it go` });
      await claim.click();
      await expect(mine.locator('.av')).toBeVisible();
      await synced(page);
      if (JSON.stringify(await people(o.id)) !== JSON.stringify([me.id])) throw new Error('never assigned');
      await mine.click();
      await expect(claim).toBeVisible();
      await synced(page);
      if ((await people(o.id)).length) throw new Error('never let go');
      // A subtask ticked: no message, and its row stays, done, to tick back.
      await toastGone();
      await tick(k.title);
      await expect(page.locator(K)).toHaveClass(/\bdone\b/);
      await synced(page);
      if (!(await get(k.id)).done) throw new Error('never done');
      if (await page.$('#toast.show')) throw new Error('a subtask\'s tick said: ' + await page.textContent('#toast-msg'));
      await page.getByRole('button', { name: 'Mark not done: ' + k.title, exact: true }).click();
      await expect(page.locator(K)).not.toHaveClass(/\bdone\b/);
      // Three zones, each the row's full height and at least 48px across: its tick, the whole left gutter (a subtask's
      // from the row's edge); its title, which opens it; who's doing it, at its end.
      for (const R of [P, K]) {
        await page.$eval(R, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        const zones = await page.$eval(R, el => {
          const r = el.getBoundingClientRect(), at = (x, y) => document.elementFromPoint(r.left + x, r.top + y)?.closest('button');
          const name = b => b?.matches('.check') ? 'tick' : b?.matches('.body') ? 'title' : b?.matches('.claim') ? 'slot' : String(b?.className);
          const body = el.querySelector(':scope > .body').getBoundingClientRect(), slot = el.querySelector(':scope > .claim').getBoundingClientRect();
          // (8px in from the row's corners, which a list's rounded corners clip)
          const xs = { tick: [8, body.left - r.left - 1], title: [body.left - r.left + 1, slot.left - r.left - 1], slot: [slot.left - r.left + 1, r.width - 8] };
          const out = { widths: { tick: body.left - r.left, slot: slot.width }, wrong: [] };
          for (const [want, [x0, x1]] of Object.entries(xs)) for (const x of [x0, (x0 + x1) / 2, x1]) for (const y of [8, r.height / 2, r.height - 8])
            if (name(at(x, y)) !== want) out.wrong.push(`${want} at ${Math.round(x)},${Math.round(y)}: ${name(at(x, y))}`);
          return out;
        });
        if (zones.wrong.length) throw new Error('taps land elsewhere: ' + zones.wrong.join('; '));
        if (zones.widths.tick < 48 || zones.widths.slot < 48) throw new Error('a zone under 48px: ' + JSON.stringify(zones.widths));
      }
      // Swiped left at 0% to its Delete (on Today too: today-is-for-doing). The add box, given the task ticked by those
      // taps, back to adding a task first, so what a screen reader hears last is the deletion.
      const instead = page.getByRole('button', { name: /^Add a task to .* instead$/ });
      if (await instead.isVisible()) await instead.click();
      // Not from the screen's edge, where the phone's Back starts; tapped elsewhere, an open row shuts.
      await swipe(K, 370);
      if (await page.$(`${K}.swiped`)) throw new Error('a swipe from the edge opened the row');
      await swipe(P);
      await page.waitForSelector(`${P}.swiped > .row-del`);
      await page.click('#view .sec .n >> nth=0');                              // anything else, tapped
      await page.waitForSelector(`${P}.swiped`, { state: 'detached' });
      if (await page.isVisible('#sheet')) throw new Error('shutting the row opened a task');
      // Delete: the row goes, leaving a gap at its height, holding only "Deleted" and Restore where "+ me" was, and
      // nothing is sent; a tap anywhere on the gap brings the row back, sliding in from the left.
      const kh = await page.locator(K).evaluate(el => el.offsetHeight);
      await swipe(K);
      await tapDelete(K);
      await expect(page.locator(K)).toHaveClass(/\bdeleted\b/);
      await expect(page.locator(`${K} > .del-gap`)).toContainText('Deleted');
      await expect(page.locator(K).getByRole('button', { name: 'Restore ' + k.title })).toBeVisible();
      await expect(page.locator(`${K} > .body`)).toBeHidden();
      await expect(page.locator('#said')).toHaveText(`Deleted: ${k.title}. Restore is in its place`);
      if (await page.$('#toast.show')) throw new Error('deleting said: ' + await page.textContent('#toast-msg'));
      if (await page.locator(K).evaluate(el => el.offsetHeight) !== kh) throw new Error('its height changed');
      if (!await get(k.id)) throw new Error('sent while it can be restored');
      await watchFrames(K);
      await page.locator(`${K} > .del-gap`).click({ position: { x: 40, y: 10 } });
      await expect(page.locator(K)).not.toHaveClass(/\bdeleted\b/);
      await expect(page.locator(`${K} > .body`)).toBeVisible();
      const slid = await framesSeen();
      if (slid.some(s => s.h !== kh)) throw new Error('its height changed as it came back: ' + [...new Set(slid.map(s => s.h))]);
      if (!slid.some(s => !s.deleted && s.x < -s.w / 2)) throw new Error("it didn't slide back in from the left");
      if (await page.isVisible('#sheet')) throw new Error('restoring it opened the task');
      await synced(page);
      if (!await get(k.id)) throw new Error('Restore didn\'t keep it');
      // A full swipe: past half the row, the Delete fills it; back under half before letting go, it's only open.
      await page.locator(K).scrollIntoViewIfNeeded();
      await page.$eval(K, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.waitForTimeout(100);
      const kb = await page.locator(K).boundingBox(), ky = kb.y + kb.height / 2;
      await page.mouse.move(330, ky); await page.mouse.down();
      await page.mouse.move(80, ky + 3, { steps: 10 });
      if (!await page.$(`${K}.swipe-full`)) throw new Error("past half, the Delete didn't fill the row");
      await page.mouse.move(260, ky + 3, { steps: 6 });
      if (await page.$(`${K}.swipe-full`)) throw new Error('back under half, the Delete still filled the row');
      await page.mouse.up();
      await page.waitForSelector(`${K}.swiped`);
      if (await page.$(`${K}.deleted`)) throw new Error('backed off, it was deleted');
      // Carried on from there past half, and let go: it follows through, off the screen to the left, and doesn't come
      // back: its place is a gap, at its height all along (watched frame by frame); deleted for good once the batch
      // clears.
      await page.mouse.move(250, ky); await page.mouse.down();
      await page.mouse.move(90, ky + 3, { steps: 10 });
      await watchFrames(K);
      await page.mouse.up();
      await page.waitForSelector(`${K}.deleted`);
      const seen = await framesSeen(), far = seen.reduce((m, s, i) => s.x < seen[m].x ? i : m, 0);
      if (seen.some(s => s.h !== kh)) throw new Error('its height changed as it went: ' + [...new Set(seen.map(s => s.h))]);
      if (seen[far].x > -.9 * seen[far].w) throw new Error(`it went only to ${seen[far].x}px of ${seen[far].w}`);
      if (seen.slice(far).some(s => s.shown)) throw new Error('the row came back into sight');
      if (!seen.at(-1).deleted || !seen.at(-1).gap) throw new Error('no gap where it was: ' + JSON.stringify(seen.at(-1)));
      await expect(page.locator(`${K} > .body`)).toBeHidden();
      if (!await get(k.id)) throw new Error('deleted while it could be restored');
      await later(3000);
      await expect(page.locator(K)).toHaveCount(0);
      await synced(page);
      if (await get(k.id)) throw new Error('never deleted');
      if (await page.$(K)) throw new Error('the row came back');
    } finally {
      for (const t of [k, p, o]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  await step('a-subtask-swiped-in-its-sheet-is-restored-from-its-row', async () => {
    const p = await make(`Pocket smoke sheet parent ${stamp}`, { due_date: todayAt(23) }), k = await make(`Pocket smoke sheet kid ${stamp}`);
    await api(`/tasks/${p.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }) });
    const K = `#d-subtasks > .row:has(.title:text-is("${k.title}"))`;
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${cardOf(p.title)} > .card-head`, { timeout: 15000 });
      await page.waitForSelector(K, { timeout: 10000 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, { timeout: 5000 });   // slid in
      await swipe(K);
      await tapDelete(K);
      await page.waitForSelector(`${K}.deleted`);
      if (!await page.isVisible('#sheet')) throw new Error('the sheet closed');
      // (Its step line on the card behind the sheet shows it deleted too.)
      await page.locator('#sheet').getByRole('button', { name: 'Restore ' + k.title }).click();
      await page.waitForSelector(`${K}:not(.deleted)`);
      if (!await get(k.id)) throw new Error('Restore didn\'t keep it');
      // Its ⋯ deletes the task, with its subtask, after asking (the way for a keyboard or a screen reader): its card
      // on Today is a gap, with Restore.
      await page.click('#d-more');
      await page.click('#d-delete');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      await page.waitForSelector(`${cardOf(p.title)}.deleted`);
      await expect(page.locator(cardOf(p.title)).getByRole('button', { name: 'Restore ' + p.title })).toBeVisible();
      await expect(page.locator('#said')).toHaveText(`Deleted: ${p.title}. Restore is in its place`);
      await later(3000);
      await expect(page.locator(cardOf(p.title))).toHaveCount(0);
      await synced(page);
      if (await get(k.id) || await get(p.id)) throw new Error('never deleted');
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close');
      for (const t of [k, p]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A task's sheet leads with one card (parent-tasks-plan, 6b): the task's own row, its notes and its photos and files
     under it. Its title is changed where it is, with a tap. A full swipe right ticks it in place: the sheet is about
     this one task, so no gap. Swiped left at 0%, it's deleted: the sheet closes on the list, where its gap has Restore. */
  await step('a-tasks-sheet-leads-with-its-row', async () => {
    const t = await make(`Pocket smoke sheet card ${stamp}`, { due_date: todayAt(23), description: '<p>Bring the <b>ladder</b></p>' });
    const R = `#view ${rowOf(t.title)}`, own = '#sheet .row.own', renamed = `${t.title} renamed`;
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${R} > .body`, { timeout: 15000 });
      await expect(page.locator(`#d-card > ${own.slice(7)}`)).toBeVisible();
      await expect(ownTitle()).toHaveText(t.title);
      await expect(page.locator('#d-card #d-desc')).toContainText('Bring the ladder');
      await expect(page.locator('#d-card #d-file')).toBeAttached();
      await expect(page.locator('#sheet .h3', { hasText: /^(Notes|Attachments)/ })).toHaveCount(0);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, { timeout: 5000 });   // slid in
      // Its title tapped: a box in its place; Enter saves it.
      await ownTitle().click();
      await expect(page.locator(`${own} #d-title`)).toBeFocused();
      await page.fill('#d-title', renamed);
      await page.press('#d-title', 'Enter');
      await expect(ownTitle()).toHaveText(renamed);
      await synced(page);
      if ((await get(t.id)).title !== renamed) throw new Error('saved as ' + (await get(t.id)).title);
      // A full swipe right: ticked in place, no gap, the sheet still open on it.
      await slideProgress(own, 100);
      await expect(page.locator(own)).toHaveClass(/\bdone\b/);
      await expect(page.locator(`${own} > .del-gap`)).toHaveCount(0);
      await expect(page.locator('#sheet')).toBeVisible();
      await synced(page);
      if (!(await get(t.id)).done) throw new Error('not done in Vikunja');
      await page.click(`${own} > .check`);
      await expect(page.locator(own)).not.toHaveClass(/\bdone\b/);
      await synced(page);
      if ((await get(t.id)).done) throw new Error('its tick again left it done');
      // Swiped left at 0%: deleted, the sheet closing on the list, where its gap has Restore.
      await swipeRow(page, own, 'delete');
      await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
      await expect(page.locator(R)).toHaveClass(/\bdeleted\b/);
      await page.locator(R).getByRole('button', { name: 'Restore ' + renamed }).click();
      await expect(page.locator(R)).not.toHaveClass(/\bdeleted\b/);
      await synced(page);
      if (!await get(t.id)) throw new Error('Restore didn\'t keep it');
    } finally { await api('/tasks/' + t.id, { method: 'DELETE' }); }
  });
  /* A parent's sheet: its ring in its row (no Progress line in Details: its progress is its subtasks'). The question its
     ring asks, closed any way but its own buttons (×, the shade, the phone's Back), goes back to the task's sheet, as
     Cancel does; a full swipe right on its row asks the same. */
  await step('the-question-a-parents-ring-asks-from-its-sheet-goes-back-to-it', async () => {
    const P = await make(`Pocket smoke asked from its sheet ${stamp}`, { due_date: todayAt(23) }), kids = [await make(`Pocket smoke asked 1 ${stamp}`), await make(`Pocket smoke asked 2 ${stamp}`)];
    for (const k of kids) await api(`/tasks/${P.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }) });
    const ring = page.locator('#sheet .row.own > .ring'), question = page.locator('#complete h2');
    const backInIt = async () => { await expect(question).toHaveCount(0); await expect(ownTitle()).toHaveText(P.title); await expect(ring).toBeVisible(); };
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${cardOf(P.title)} > .card-head .card-open`, { timeout: 15000 });
      await expect(ring.locator('.n')).toHaveText('0/2');
      await expect(page.locator('#d-progress')).toHaveCount(0);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, { timeout: 5000 });
      await ring.click();
      await expect(question).toHaveText(`Complete “${P.title}”?`);
      await page.click('#btn-sheet-close');
      await backInIt();
      await ring.click();
      await expect(question).toBeVisible();
      await page.waitForSelector('#sheet.show');
      await page.mouse.click(195, 20);                                         // the shade above the sheet
      await backInIt();
      await page.waitForSelector('#sheet.show');
      await swipeRow(page, '#sheet .row.own', 100, { one: true });
      await expect(question).toBeVisible();
      await page.waitForSelector('#sheet.show');
      await page.goBack();                                                     // the phone's Back
      await backInIt();
      // Back once more closes the task's sheet, staying on Today.
      await page.waitForSelector('#sheet.show');
      await page.goBack();
      await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
      if (!(await page.evaluate(() => location.hash)).startsWith('#/today')) throw new Error('Back left Today');
      await synced(page);
      if ((await get(P.id)).done || (await Promise.all(kids.map(k => get(k.id)))).some(k => k.done)) throw new Error('something was completed');
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close');
      for (const t of [...kids, P]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* The sheet's slide down, by a finger (rows-and-sheet-fixes-plan, part 1; `finger`, helpers.mjs: Chrome's own touch
     input). A pull down that starts in a text field moves nothing, nor does one beside a field being typed in, which
     only puts the phone's keyboard away. From its bar it follows the finger and closes, a field focused or not; and
     with nothing being typed in, from anywhere at its top, as before: a select that kept the focus doesn't hold it. */
  const { touch, touchDrag } = await finger(page);
  await step('a-touch-in-a-text-field-never-slides-the-sheet-and-its-bar-always-does', async () => {
    const t = await make(`Pocket smoke sheet slide ${stamp}`, { due_date: todayAt(23), description: '<p>Bring the ladder</p>' });
    const R = `#view ${rowOf(t.title)}`, sheet = page.locator('#sheet');
    const open = async () => {
      await page.click(`${R} > .body`, { timeout: 15000 });
      await expect(page.locator('#sheet .row.own')).toBeVisible();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, { timeout: 5000 });   // slid in
    };
    // How far the sheet is pulled down while a finger is on it (its own style: none once it's let go), and where it's scrolled to.
    const pulled = () => sheet.evaluate(el => el.style.transform);
    const still = what => async () => { if (await pulled()) throw new Error(`a pull down ${what} moved the sheet: ${await pulled()}`); };
    const follows = what => () => expect.poll(pulled, { message: `a pull down ${what} moves the sheet with the finger` }).toBe('translateY(160px)');
    const atTop = async () => { if (await page.$eval('#sheet .scroll', el => el.scrollTop)) throw new Error('the sheet isn\'t scrolled to its top'); };
    const pull = (sel, check) => touchDrag(sel, 160, 8, 40, 0, { check });
    const closed = () => page.waitForSelector('#sheet', { state: 'hidden', timeout: 5000 });
    try {
      await toastGone();
      await refreshToday();
      await open();
      // Its notes being changed: a pull down that starts in them moves nothing, nor one beside them.
      await page.click('#d-desc');
      await expect(page.locator('#d-desc-in')).toBeFocused();
      await atTop();
      await pull('#d-desc-in', still('that starts in the notes'));
      await pull('#sheet #d-path', still('beside the notes, which have the focus,'));
      await expect(sheet).toBeVisible();
      await expect(page.locator('#d-desc-in')).toBeFocused();
      // From its bar, it follows the finger and closes, the notes still focused.
      await pull('#sheet .bar', follows('from the bar, with the notes focused,'));
      await closed();
      // Its title being changed: the same, and a pull that starts in its box isn't the row's either.
      await open();
      await ownTitle().click();
      await expect(page.locator('#d-title')).toBeFocused();
      await pull('#d-title', still('that starts in the title\'s box'));
      await pull('#sheet #d-path', still('beside the title, which has the focus,'));
      await expect(page.locator('#d-title')).toBeFocused();
      await page.press('#d-title', 'Escape');
      // With nothing focused: from its bar, and from anywhere at its top, as before.
      await expect(page.locator('#sheet #d-title')).toHaveCount(0);
      await pull('#sheet .bar', follows('from the bar'));
      await closed();
      await open();
      await atTop();
      await pull('#sheet #d-path', follows('at the sheet\'s top, with nothing focused,'));
      await closed();
      // A date, like a select, keeps the focus once its picker has closed, with no keyboard up: it doesn't hold the
      // sheet. A pull that starts on it is still its own.
      await open();
      await page.focus('#d-due');
      await atTop();
      await pull('#d-due', still('that starts on the due date'));
      await expect(page.locator('#d-due')).toBeFocused();
      await pull('#sheet #d-path', follows('beside a date that kept the focus'));
      await closed();
      await synced(page);
      const now = await get(t.id);
      if (now.title !== t.title || !now.description.includes('Bring the ladder')) throw new Error('something was changed: ' + JSON.stringify([now.title, now.description]));
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close', { timeout: 2000 }).catch(() => {});   // (it may be on its way down)
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* The notes box is as tall as its text, as every other box is (rows-and-sheet-fixes-plan, part 1): long notes scroll
     with the sheet, never inside their box, which would pull the sheet down as they're scrolled back up. Short ones
     keep the box's least height. Typing at their end leaves the sheet where it was scrolled to. */
  await step('the-notes-box-grows-with-its-text', async () => {
    const t = await make(`Pocket smoke long notes ${stamp}`, { due_date: todayAt(23), description: '<p>Short notes</p>' });
    const lines = n => Array.from({ length: n }, (_, i) => `Line ${i + 1} of the notes`).join('\n');
    // The box's height, how far its text can scroll inside it, and where the sheet is scrolled to.
    const box = () => page.$eval('#d-desc-in', ta => ({ height: ta.offsetHeight, inside: ta.scrollHeight - ta.clientHeight, line: parseFloat(getComputedStyle(ta).lineHeight), sheet: ta.closest('.scroll').scrollTop }));
    try {
      await toastGone();
      await refreshToday();
      await page.click(`#view ${rowOf(t.title)} > .body`, { timeout: 15000 });
      await page.click('#d-desc');
      await expect(page.locator('#d-desc-in')).toBeFocused();
      const short = await box();
      if (short.height !== 140 || short.inside > 0) throw new Error('short notes: ' + JSON.stringify(short));
      await page.fill('#d-desc-in', lines(120));
      await expect.poll(async () => (await box()).height).toBeGreaterThanOrEqual(120 * short.line);
      const long = await box();
      if (long.inside > 0) throw new Error(`long notes can scroll ${long.inside}px inside their box`);
      // Typed in their middle, the sheet scrolled so that line is in sight and their end isn't: the sheet stays where
      // it was (the box is measured at its least height first, which would pull the sheet's end up).
      await page.$eval('#d-desc-in', ta => ta.scrollIntoView({ block: 'end', behavior: 'instant' }));
      await page.$eval('#sheet .scroll', el => { el.scrollTop -= 300; });
      const was = await box();
      if (was.sheet < 100) throw new Error('the sheet didn\'t scroll with the notes: ' + JSON.stringify(was));
      await page.$eval('#d-desc-in', (ta, at) => ta.setSelectionRange(at, at), lines(100).length);
      await page.keyboard.press('Enter');
      await page.keyboard.type('and more');
      await expect.poll(async () => (await box()).height).toBeGreaterThanOrEqual(was.height + short.line - 1);   // a line taller
      if (await page.inputValue('#d-desc-in') !== lines(100) + '\nand more' + lines(120).slice(lines(100).length)) throw new Error('typed somewhere else');
      const more = await box();
      if (Math.abs(more.sheet - was.sheet) > 1 || more.inside > 0) throw new Error(`a line typed moved the sheet from ${was.sheet} to ${more.sheet}, or scrolls inside the box (${more.inside}px)`);
      // The phone turned: its lines wrap anew, and the box fits them again, both ways.
      await page.fill('#d-desc-in', 'some words to fill a line of the notes up, and on to the next. '.repeat(12));
      await expect.poll(async () => (await box()).height).toBeGreaterThan(300);
      const upright = await box();
      await page.setViewportSize({ width: 844, height: 390 });
      await expect.poll(async () => (await box()).height).toBeLessThan(upright.height - 100);
      if ((await box()).inside > 0) throw new Error('turned, the notes scroll inside their box');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => (await box()).height).toBe(upright.height);
      if ((await box()).inside > 0) throw new Error('turned back, the notes scroll inside their box');
      // Most of them taken out: back to its least height.
      await page.fill('#d-desc-in', lines(2));
      await expect.poll(async () => (await box()).height).toBe(140);
      await page.click('#d-desc-cancel');
    } finally {
      await page.setViewportSize({ width: 390, height: 844 });
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close', { timeout: 2000 }).catch(() => {});
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  /* A title being changed is saved when its sheet closes, whichever way (rows-and-sheet-fixes-plan, part 1). Its box
     saves as it loses the focus, which the × or a tap on the shade take from it; a sheet slid down by its bar, or
     closed by the phone's Back, doesn't, so leaving the sheet saves it too. Emptied, it stays as it was. */
  await step('a-title-being-changed-is-saved-however-the-sheet-closes', async () => {
    const name = how => `Pocket smoke title ${how} ${stamp}`, t = await make(name('as made'), { due_date: todayAt(23) });
    const R = `#view .row[data-id="${t.id}"]`;
    // Its sheet opened as on an iPhone, where a tap gives a button no focus: nothing to hand the focus back to as the
    // sheet closes (a mouse's click would leave it on the row, and the title's box would lose it then).
    const change = async to => {
      await expect(page.locator(`${R} > .body`)).toBeVisible({ timeout: 15000 });
      await page.$eval(`${R} > .body`, el => { document.activeElement?.blur(); el.click(); });
      await expect(page.locator('#sheet .row.own')).toBeVisible();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, { timeout: 5000 });   // slid in
      await ownTitle().click();
      await expect(page.locator('#d-title')).toBeFocused();
      await page.fill('#d-title', to);
    };
    const saved = async (to, how) => {
      await page.waitForSelector('#sheet', { state: 'hidden', timeout: 5000 });
      await expect(page.locator(`${R} > .body .title > span:not(.sr)`).first(), `its row after the sheet was ${how}`).toHaveText(to);
      await synced(page);
      if ((await get(t.id)).title !== to) throw new Error(`the sheet ${how}: Vikunja has "${(await get(t.id)).title}"`);
    };
    try {
      await toastGone();
      await refreshToday();
      await change(name('slid down'));
      await touchDrag('#sheet .bar', 160);
      await saved(name('slid down'), 'slid down by its bar');
      await change(name('gone back from'));
      await page.goBack();
      await saved(name('gone back from'), 'closed by the phone\'s Back');
      await change(name('closed'));
      await page.click('#btn-sheet-close');
      await saved(name('closed'), 'closed by its ×');
      await change(name('shaded'));
      await page.mouse.click(195, 20);                                         // the shade above the sheet
      await saved(name('shaded'), 'closed by a tap on the shade');
      // Emptied, then slid down: its title as it was.
      await change('   ');
      await touchDrag('#sheet .bar', 160);
      await saved(name('shaded'), 'slid down with its title emptied');
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close', { timeout: 2000 }).catch(() => {});
      await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('leaving-the-screen-sends-a-deletion-at-once', async () => {
    // Deleted on its project's list, then another tab tapped before the batch clears: it's sent then, not left waiting.
    const x = await make(`Pocket smoke leave ${stamp}`, { due_date: todayAt(23) }), X = rowOf(x.title);
    try {
      await toastGone();
      await refreshToday();
      await page.evaluate(id => { location.hash = '#/project/' + id; }, home2);
      await loaded(page);
      await swipe(X, 330, -260);
      await page.waitForSelector(`${X}.deleted`);
      await page.click('nav.tabs a[data-tab=today]');
      await page.waitForFunction(() => location.hash.startsWith('#/today'));
      await synced(page);
      if (await get(x.id)) throw new Error('not sent on leaving the screen');
      await loaded(page);
      await expect(page.locator(X)).toHaveCount(0);
    } finally { await api('/tasks/' + x.id, { method: 'DELETE' }); }
  });

  const positionsSent = () => { const sent = [], see = r => /\/position$/.test(r.url()) && sent.push(r.url()); page.on('request', see); return { sent, off: () => page.off('request', see) }; };
  const idsIn = (...ids) => page.locator(ids.map(id => `#view .row[data-id="${id}"]`).join(', ')).evaluateAll(els => els.map(el => +el.dataset.id));
  /* Held where a hold does nothing (Today, whose order is its due dates; search, which has none): not lifted, then moved
     up or down onto the row `to` and let go, nothing having followed the finger. */
  async function holdAndMove(sel, to){
    await page.locator(sel).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await steady(page.locator(sel)), x = box.x + box.width / 2, y0 = box.y + box.height / 2, y = (await page.locator(to).boundingBox()).y + 4;
    await page.mouse.move(x, y0); await page.mouse.down();
    await later(700);
    await expect(page.locator(sel)).not.toHaveClass(/\bheld\b/);
    await page.mouse.move(x, y0 + Math.sign(y - y0) * 14, { steps: 3 });
    await page.mouse.move(x, y, { steps: 12 });
    const moving = await page.$('#view .list.reordering, #view .dragged');
    await page.mouse.up();
    if (moving) throw new Error('the row followed the finger');
  }
  /* Today acts as any list (parent-tasks-plan, part 1): swiped left at 0%, a row's Delete, a full swipe its gap with
     Restore. A row with progress takes two swipes to delete: the first only lowers it, stopping at 0% however far it's
     pulled; the second is its Delete. Held, a row does nothing on Today (its order is its due dates): it isn't lifted,
     moved after it stays where it was, and no position is written. */
  await step('today-deletes-by-a-swipe-and-a-hold-does-nothing', async () => {
    const a = await make(`Pocket smoke doing A ${stamp}`, { due_date: todayAt(21) }), b = await make(`Pocket smoke doing B ${stamp}`, { due_date: todayAt(22), percent_done: .5 });
    const A = rowOf(a.title), B = rowOf(b.title), moves = positionsSent();
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(B)).toBeVisible({ timeout: 15000 });
      if (JSON.stringify(await idsIn(a.id, b.id)) !== JSON.stringify([a.id, b.id])) throw new Error('not in due order to start with');
      // Held and moved up past the row above: not lifted, nothing follows the finger; let go, it's where it was.
      await holdAndMove(B, A);
      if (await page.isVisible('#sheet')) throw new Error('letting go opened the task');
      if (JSON.stringify(await idsIn(a.id, b.id)) !== JSON.stringify([a.id, b.id])) throw new Error('moved on Today');
      // B, at 50%, swiped left all the way: only lowered, to 0%, no red on the way.
      await slideProgress(B, 0, async () => {
        await expect(page.locator(`${B} > .row-prog`)).toHaveAttribute('data-pct', '0');
        if (await page.$(`${B}.swiping, ${B}.swipe-full`)) throw new Error('a row with progress swiped left showed its Delete');
      }, 50);
      await expect(page.locator('#said')).toHaveText(`Progress of ${b.title} set to 0%`);
      await synced(page);
      if (!await get(b.id) || Math.round((await get(b.id)).percent_done * 100) !== 0) throw new Error('first swipe: ' + JSON.stringify(await get(b.id)));
      // Again, now at 0%: its Delete, a full swipe deleting it, its gap with Restore.
      await swipeRow(page, B, 'delete');
      await expect(page.locator(B)).toHaveClass(/\bdeleted\b/);
      await expect(page.locator(B).getByRole('button', { name: 'Restore ' + b.title })).toBeVisible();
      // A, at 0%, opened on its Delete by a short swipe, its Delete tapped.
      await swipeRow(page, A, 'open');
      await tapDelete(A);
      await expect(page.locator(A)).toHaveClass(/\bdeleted\b/);
      await later(3000);
      await expect(page.locator(`${A}, ${B}`)).toHaveCount(0);
      await synced(page);
      if (await get(a.id) || await get(b.id)) throw new Error('not deleted');
      if (moves.sent.length) throw new Error('a position was written: ' + moves.sent.join(', '));
    } finally { moves.off(); for (const t of [a, b]) await api('/tasks/' + t.id, { method: 'DELETE' }); }
  });
  /* Progress swiped on a task no one is doing says you're doing it (motion-and-rows-plan, section 3): your picture, and
     the claim sent, once it's let go having changed something (parent-tasks-plan, 1b: nothing changes while it's held). Let go where it started, nothing is
     claimed; slid back to 0% later, it stays yours; someone else's stays theirs. */
  await step('sliding-progress-claims-a-task-no-one-is-doing', async () => {
    const me = await (await api('/user')).json(), mine = (me.name || me.username).match(/[\p{L}\p{N}]+/gu).slice(0, 2).map(w => w[0].toUpperCase()).join('');
    const a = await make(`Pocket smoke slide claim ${stamp}`, { due_date: todayAt(21) }), A = rowOf(a.title);
    // Someone else's, in a project shared with them (ASSIGNEE), when there is one.
    const team = ASSIGNEE && projects2.find(p => p.title === ASSIGNEE_PROJECT);
    const found = team && await api(`/projects/${team.id}/users/search?q=${encodeURIComponent(ASSIGNEE)}`);
    const other = found?.ok ? ((await found.json()).items || []).find(u => u.username === ASSIGNEE) : null;
    const b = other && await make(`Pocket smoke slide theirs ${stamp}`, { due_date: todayAt(21) }, team.id), B = b && rowOf(b.title);
    if (b) await api(`/tasks/${b.id}/assignees`, { method: 'POST', headers: json, body: JSON.stringify({ user_id: other.id }) });
    const people = async id => ((await get(id)).assignees || []).map(u => u.id), pct = async id => Math.round((await get(id)).percent_done * 100);
    try {
      await toastGone();
      await refreshToday();
      await expect(page.locator(A)).toBeVisible({ timeout: 15000 });
      await page.locator(A).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      // Swiped a little, short of 25%, then let go: nothing changes while it's held (1b), and no one's on it after.
      const box = await page.locator(A).boundingBox(), x = box.x + 60, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + 20, y, { steps: 4 });
      await expect(page.locator(`${A} .claim .me`)).toBeVisible();
      await page.mouse.up();
      await expect(page.locator(`${A} .claim .me`)).toBeVisible();
      await expect(page.locator(`${A} .claim .me`)).toBeVisible();
      await synced(page);
      if ((await people(a.id)).length) throw new Error('a slide that changed nothing claimed it');
      // Swiped to 25%: still no one's while it's held; let go, yours, in Vikunja, its slot your initials.
      await slideProgress(A, 25, async () => { await expect(page.locator(`${A} .claim .me`)).toBeVisible(); });
      await expect(page.locator(`${A} .claim.mine .av`)).toHaveText(mine);
      await synced(page);
      if (JSON.stringify(await people(a.id)) !== JSON.stringify([me.id])) throw new Error('slid, assigned to ' + JSON.stringify(await people(a.id)));
      if (await pct(a.id) !== 25) throw new Error('progress saved ' + await pct(a.id));
      // Slid back to 0%: still yours. Letting go is a tap of its own.
      await slideProgress(A, 0, null, 25);
      await expect(page.locator('#said')).toHaveText(`Progress of ${a.title} set to 0%`);
      await synced(page);
      if (await pct(a.id) !== 0) throw new Error('slid back, progress saved ' + await pct(a.id));
      if (JSON.stringify(await people(a.id)) !== JSON.stringify([me.id])) throw new Error('slid back to 0%, it was let go');
      await expect(page.locator(`${A} .claim.mine .av`)).toBeVisible();
      if (!b) { console.log('  (no ASSIGNEE and ASSIGNEE_PROJECT: someone else\'s claim not checked)'); return; }
      // Someone else's: slid, its progress is set, and it stays theirs.
      await expect(page.locator(B)).toBeVisible({ timeout: 15000 });
      await page.locator(B).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await slideProgress(B, 25);
      await expect(page.locator('#said')).toHaveText(`Progress of ${b.title} set to 25%`);
      await synced(page);
      if (JSON.stringify(await people(b.id)) !== JSON.stringify([other.id])) throw new Error("someone else's task was claimed: " + JSON.stringify(await people(b.id)));
      if (await page.$(`${B} .claim.mine`)) throw new Error("someone else's task shows as yours");
    } finally { for (const t of [a, b].filter(Boolean)) await api('/tasks/' + t.id, { method: 'DELETE' }); }
  });
  /* The sheet's own row claims as a row's swipe does (user, 2026-10-08: the same rule everywhere), and so does a quarter
     tapped in Details' Progress line, its tap path: on a task no one is doing, it's yours once it's let go, in its
     Assigned row and in Vikunja; someone else's stays theirs. */
  await step('the-sheets-row-claims-a-task-no-one-is-doing', async () => {
    const me = await (await api('/user')).json(), chip = `#d-assignees .label-chip:has-text("${me.name || me.username}")`;
    const a = await make(`Pocket smoke bar claim ${stamp}`, { due_date: todayAt(21) }), c = await make(`Pocket smoke chip claim ${stamp}`, { due_date: todayAt(21) });
    const team = ASSIGNEE && projects2.find(p => p.title === ASSIGNEE_PROJECT);
    const found = team && await api(`/projects/${team.id}/users/search?q=${encodeURIComponent(ASSIGNEE)}`);
    const other = found?.ok ? ((await found.json()).items || []).find(u => u.username === ASSIGNEE) : null;
    const b = other && await make(`Pocket smoke bar theirs ${stamp}`, { due_date: todayAt(21) }, team.id);
    if (b) await api(`/tasks/${b.id}/assignees`, { method: 'POST', headers: json, body: JSON.stringify({ user_id: other.id }) });
    const people = async id => ((await get(id)).assignees || []).map(u => u.id), pct = async id => Math.round((await get(id)).percent_done * 100);
    const open = async t => {
      await page.click(`#view ${rowOf(t.title)} > .body`, { timeout: 15000 });
      await expect(ownTitle()).toHaveText(t.title);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, { timeout: 5000 });
    };
    const quarter = async n => { await page.locator('#d-progress').scrollIntoViewIfNeeded(); await page.locator('#d-progress').getByRole('button', { name: n + '% done' }).click(); await synced(page); };
    const close = async () => { await page.click('#btn-sheet-close'); await page.waitForSelector('#sheet', { state: 'hidden' }); };
    try {
      await toastGone();
      await refreshToday();
      await open(a);
      await slideProgress('#sheet .row.own', 25, async () => { await expect(page.locator(chip), 'in Assigned while it\'s held').toHaveCount(0); });
      await synced(page);
      if (JSON.stringify(await people(a.id)) !== JSON.stringify([me.id])) throw new Error('swiped, assigned to ' + JSON.stringify(await people(a.id)));
      if (await pct(a.id) !== 25) throw new Error('progress saved ' + await pct(a.id));
      await expect(page.locator(chip), 'not in Assigned once sent').toBeVisible();
      await close();
      await open(c);
      await quarter(50);
      if (JSON.stringify(await people(c.id)) !== JSON.stringify([me.id])) throw new Error('a quarter tapped, assigned to ' + JSON.stringify(await people(c.id)));
      if (await pct(c.id) !== 50) throw new Error('progress saved ' + await pct(c.id));
      await close();
      if (!b) { console.log('  (no ASSIGNEE and ASSIGNEE_PROJECT: someone else\'s claim not checked)'); return; }
      await open(b);
      await quarter(25);
      if (await pct(b.id) !== 25) throw new Error('their task\'s progress saved ' + await pct(b.id));
      if (JSON.stringify(await people(b.id)) !== JSON.stringify([other.id])) throw new Error("someone else's task was claimed: " + JSON.stringify(await people(b.id)));
      if (await page.locator(chip).count()) throw new Error("someone else's task shows you in Assigned");
      await close();
    } finally { for (const t of [a, b, c].filter(Boolean)) await api('/tasks/' + t.id, { method: 'DELETE' }); }
  });
  /* "+ me" only where someone else could take it (one-concept-plan, part 4): on a project no one else can see, no slot,
     nor your own picture, while someone given it in a shared project, then moved there, still shows; and a slide claims nothing. Who can
     see each project is loaded in the background once signed in, and kept. And under Today's heading, a row due today
     with no time shows no time ("Today" says nothing new there); its project's list still says Today. */
  await step('a-project-only-you-can-see-has-no-me', async () => {
    const proj = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: `PocketSmokeAlone${stamp}` }) })).json();
    createdProjects.push(proj.id);
    const me = await (await api('/user')).json();
    const free = await make(`Pocket smoke alone free ${stamp}`, { due_date: todayAt(21) }, proj.id), mine = await make(`Pocket smoke alone mine ${stamp}`, { due_date: todayAt(21) }, proj.id);
    const day = await make(`Pocket smoke alone day ${stamp}`, { due_date: todayAt(0) }, proj.id);
    await api(`/tasks/${mine.id}/assignees`, { method: 'POST', headers: json, body: JSON.stringify({ user_id: me.id }) });
    // Someone else's, given it in a project shared with them, then moved here: Vikunja keeps them on it (unsharing a
    // project takes its people off its tasks instead).
    let theirs = null, other = null;
    const team = ASSIGNEE && projects2.find(p => p.title === ASSIGNEE_PROJECT);
    if (team) {
      other = ((await (await api(`/projects/${team.id}/users/search`)).json()).items || []).find(u => u.username === ASSIGNEE);
      theirs = await make(`Pocket smoke alone theirs ${stamp}`, { due_date: todayAt(21) }, team.id);
      await api(`/tasks/${theirs.id}/assignees`, { method: 'POST', headers: json, body: JSON.stringify({ user_id: other.id }) });
      await api(`/tasks/${theirs.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ project_id: proj.id }) });
    }
    const people = async id => ((await get(id)).assignees || []).map(u => u.id), pct = async id => Math.round((await get(id)).percent_done * 100);
    const F = rowOf(free.title), M = rowOf(mine.title), D = rowOf(day.title);
    await toastGone();
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.reload();                                                     // signed in again: who can see each project, loaded
    await expect(page.locator(F)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`${F} .claim`), 'a project only you can see has "+ me"').toHaveCount(0, { timeout: 20000 });
    await expect(page.locator(`${M} .claim`), 'your own picture shows on a project only you can see').toHaveCount(0);
    if (theirs) await expect(page.locator(`${rowOf(theirs.title)} .claim[aria-disabled=true] .av`), 'someone else given it isn\'t shown').toBeVisible();
    // Under Today: no time, nothing at its right but its project's dot; its project's list says Today.
    await expect(page.locator(`.sec.today ~ .list ${D} .when .dot`)).toHaveCount(1);
    await expect(page.locator(`${D} .when .due`)).toHaveCount(0);
    // Slid, its progress is set, and no one's on it.
    await page.locator(F).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await slideProgress(F, 25, async () => { if (await page.$(`${F} .claim`)) throw new Error('a slide put someone on it'); });
    await expect(page.locator('#said')).toHaveText(`Progress of ${free.title} set to 25%`);
    await synced(page);
    if (await pct(free.id) !== 25) throw new Error('progress saved ' + await pct(free.id));
    if ((await people(free.id)).length) throw new Error('a slide claimed it: ' + JSON.stringify(await people(free.id)));
    if (theirs && JSON.stringify(await people(theirs.id)) !== JSON.stringify([other.id])) throw new Error('moved, it lost its assignee');
    await page.evaluate(id => { location.hash = '#/project/' + id; }, proj.id);
    await expect(page.locator(`#view ${D} .meta .due`)).toHaveText('Today', { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/today'; });
  });
  /* The one-time hint (motion-and-rows-plan, section 8), on a phone that's never swiped a row: on the first row that
     takes a swipe for its progress, drawn with it, so no row moves as it comes, nor as it goes (it fades, keeping its space). A tap puts
     it away, and so does the first swipe that sets progress; it stays away after a reload. */
  await step('a-hint-to-swipe-right-once', async () => {
    const proj = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: `PocketSmokeHint${stamp}` }) })).json();
    createdProjects.push(proj.id);
    for (const n of [1, 2, 3]) await make(`Pocket smoke hint ${n} ${stamp}`, {}, proj.id);
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } }), p = await fresh.newPage();
    p.on('pageerror', e => errors.push(String(e)));
    const first = '#view .list > .item:first-of-type > .row', hint = p.locator(`${first} .slide-hint`), shown = p.locator('.slide-hint:not(.gone)');
    // Where each row of the list starts.
    const rows = () => p.$$eval('#view .list > .item > .row', els => els.map(el => Math.round(el.getBoundingClientRect().top)));
    // Its three rows alike, the first at its own height again (but for the line above the others), once the hint's
    // space has closed.
    const sameHeights = () => p.$$eval('#view .list > .item > .row', els => els.every(el => Math.abs(el.offsetHeight - els[1].offsetHeight) <= 1));
    const open = async () => {
      await p.evaluate(id => { location.hash = '#/project/' + id; }, proj.id);
      await expect(p.locator('#view .list > .item > .row')).toHaveCount(3, { timeout: 15000 });
      await loaded(p);
    };
    try {
      await signIn(p, APP, TOKEN);
      await open();
      await expect(hint).toHaveText('Swipe right to start working on it');
      if (await p.locator('.slide-hint').count() !== 1) throw new Error('more than one hint');
      if (await p.evaluate(() => localStorage.getItem('pocket.hint.slide')) !== 'said') throw new Error('not said to a screen reader');
      const at = await rows();
      // A tap puts it away: it fades, its space kept, and the task doesn't open.
      await hint.click();
      await expect(hint).toHaveClass(/\bgone\b/);
      if (await p.isVisible('#sheet')) throw new Error('a tap on the hint opened the task');
      if (JSON.stringify(await rows()) !== JSON.stringify(at)) throw new Error(`rows moved as it went: ${at} then ${await rows()}`);
      // Its space stays while a finger is down (on the list's empty space below the rows): a real wait, past the second
      // after which it closes, as this page has no clock of its own.
      const below = await p.locator('#view .list > .item:last-of-type > .row').boundingBox(), bx = below.x + below.width / 2, by = below.y + below.height + 60;
      if (await p.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('button, a, input, textarea, .row'), [bx, by])) throw new Error('no empty space below the rows to hold');
      await p.mouse.move(bx, by); await p.mouse.down();
      await p.waitForTimeout(1500);
      if (JSON.stringify(await rows()) !== JSON.stringify(at)) throw new Error(`rows moved under a finger: ${at} then ${await rows()}`);
      // Lifted, it closes a second later: its row back at its own height, the rows below with it.
      await p.mouse.up();
      await expect(p.locator('.slide-hint')).toHaveCount(0, { timeout: 5000 });
      await expect.poll(sameHeights).toBe(true);
      if (!((await rows())[1] < at[1])) throw new Error('the rows below didn\'t close up');
      await p.reload();
      await open();
      if (await p.locator('.slide-hint').count()) throw new Error('back after a reload');
      // A phone that's never swiped one again: the first swipe that sets progress puts it away.
      await p.evaluate(() => localStorage.removeItem('pocket.hint.slide'));
      await p.reload();
      await open();
      await expect(shown).toHaveCount(1);
      const was = await rows();
      await swipeRow(p, first, 25);
      await expect(shown).toHaveCount(0);
      if (JSON.stringify(await rows()) !== JSON.stringify(was)) throw new Error(`rows moved as it went: ${was} then ${await rows()}`);
      await expect(p.locator('.slide-hint')).toHaveCount(0, { timeout: 5000 });       // then closed, a second after
      await expect.poll(sameHeights).toBe(true);
      await synced(p);
      await p.reload();
      await open();
      if (await p.locator('.slide-hint').count()) throw new Error('back after a reload');
    } finally { await fresh.close(); }
  });
  /* A label-and-value row in a task's sheet takes a tap anywhere (motion-and-rows-plan, section 7): Due opens the date's
     picker, Priority, Repeats and Project are a select over the whole row, Reminders opens its list, Labels and Assigned their
     Add. The × that clears a date keeps its own tap. */
  await step('the-sheets-rows-take-a-tap-anywhere', async () => {
    const t = await make(`Pocket smoke rows ${stamp}`, { due_date: todayAt(22) });
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(t.title)} > .body`, { timeout: 15000 });
      await page.waitForSelector('#d-due-card');
      // Due: its date and its × on one line, at 375px too, the date giving way (an iPhone's date has a width of its own).
      for (const width of [390, 375]) {
        await page.setViewportSize({ width, height: 844 });
        const one = await page.evaluate(() => { const i = document.getElementById('d-due').getBoundingClientRect(), x = document.getElementById('d-due-clear').getBoundingClientRect(); return i.right <= x.left + 1 && Math.abs((i.top + i.bottom) / 2 - (x.top + x.bottom) / 2) < 4 && x.right <= innerWidth; });
        if (!one) throw new Error(`at ${width}px, Due's date and its × aren't on one line`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      // showPicker, as the page has it, only noted: a headless browser shows no picker.
      await page.evaluate(() => {
        window.picked = [];
        for (const C of [HTMLInputElement, HTMLSelectElement]) C.prototype.showPicker = function(){ window.picked.push(this.id); };
      });
      const picked = () => page.evaluate(() => window.picked.slice());
      const key = what => page.locator('#sheet .prop > .k', { hasText: new RegExp(`^${what}$`) });
      await key('Due').click();
      await expect.poll(picked).toEqual(['d-due']);
      await key('Reminders').click();
      await expect.poll(picked).toEqual(['d-due', 'd-remind-add']);
      // Priority, Repeats and Project: the select itself is under the finger, wherever the row is tapped.
      for (const [what, id] of [['Priority', 'd-prio'], ['Repeats', 'd-repeat'], ['Project', 'd-proj']]) {
        await key(what).scrollIntoViewIfNeeded();
        const at = await key(what).boundingBox(), hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [at.x + at.width / 2, at.y + at.height / 2]);
        if (hit !== id) throw new Error(`a tap on ${what} lands on ${hit || 'nothing'}, not its select`);
      }
      await key('Labels').click();
      await expect(page.locator('#lp-q')).toBeFocused();
      await page.press('#lp-q', 'Escape');
      await key('Assigned').click();
      await expect(page.locator('#d-assign-in')).toBeFocused();
      await page.click('#d-assign-done');
      // The ×: clears the date, and opens no picker.
      await page.click('#d-due-clear');
      await synced(page);
      const due = (await get(t.id)).due_date;
      if (due && !due.startsWith('0001')) throw new Error('the × left the date: ' + (await get(t.id)).due_date);
      if ((await picked()).length !== 2) throw new Error('the × opened a picker: ' + (await picked()).join());
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    } finally { await api('/tasks/' + t.id, { method: 'DELETE' }); }
  });
  /* Search follows Projects, swiped to Delete, but not moved: its results have no order of their own. A task found with
     open subtasks is a stacked card, collapsed (parent-tasks-plan, part 2): its top subtask, and More, which opens it in
     place to show them all, Less to collapse it again; its subtasks are on it, not rows of their own. */
  await step('search-swipes-to-delete-and-doesnt-move-a-row', async () => {
    const w = `srch${stamp}`, p = await make(`Pocket smoke ${w} parent`), k = await make(`Pocket smoke ${w} kid`), k2 = await make(`Pocket smoke ${w} kid two`), c = await make(`Pocket smoke ${w} other`);
    for (const x of [k, k2]) await api(`/tasks/${p.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: x.id, relation_kind: 'subtask' }) });
    const P = `#view ${cardOf(p.title)}`, C = rowOf(c.title), moves = positionsSent();
    try {
      await toastGone();
      await page.click('#btn-search');
      await page.fill('#in-search', w);
      await expect(page.locator(P)).toBeVisible({ timeout: 10000 });
      const rows = page.locator(`${P} > .card-rows > .row`), more = page.locator(`${P} > .card-more`);
      await expect(rows).toHaveCount(1);
      await expect(page.locator(`#view .list > .item > .row:has(.title:has-text("${w} kid"))`)).toHaveCount(0);
      await expect(more).toHaveAccessibleName('More');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await more.click();
      await expect(rows).toHaveCount(2);
      await expect(more).toHaveAccessibleName('Show less');
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      if (await page.isVisible('#sheet')) throw new Error('More opened the task');
      await more.click();
      await expect(rows).toHaveCount(1);
      await expect(more).toHaveAccessibleName('More');
      // Held and moved over the card: let go, the results are as they were.
      const order = () => page.locator('#view .list > .item').evaluateAll(els => els.map(el => +el.dataset.id));
      const was = await order();
      await holdAndMove(C, P);
      if (JSON.stringify(await order()) !== JSON.stringify(was)) throw new Error('moved in search');
      if (await page.isVisible('#sheet')) throw new Error('letting go opened the task');
      // Swiped to its Delete: dimmed, with Restore, and deleted once the batch clears.
      await swipe(C);
      await tapDelete(C);
      await expect(page.locator(C)).toHaveClass(/\bdeleted\b/);
      await expect(page.locator(C).getByRole('button', { name: 'Restore ' + c.title })).toBeVisible();
      await later(3000);
      await expect(page.locator(C)).toHaveCount(0);
      await synced(page);
      if (await get(c.id)) throw new Error('never deleted');
      if (moves.sent.length) throw new Error('a position was written: ' + moves.sent.join(', '));
    } finally {
      moves.off();
      await page.click('#btn-search-cancel').catch(() => {});
      for (const t of [k, k2, p, c]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  // A phone's keyboard covers the bottom of the page without making it shorter: here visualViewport says it's h tall.
  const keyboard = h => page.evaluate(h => {
    if (h) Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => innerHeight - h }); else delete visualViewport.height;
    visualViewport.dispatchEvent(new Event('resize'));
  }, h);
  const subsOf = async id => (await get(id))?.related_tasks?.subtask || [];
  await step('a-subtask-added-keeps-the-keyboard-and-a-toast-shows-above-it', async () => {
    // The subtask box keeps the focus after an add, so the keyboard stays open. An added subtask shows in the sheet,
    // with no message; a message shown meanwhile is above the keyboard.
    const p = await make(`Pocket smoke toasts ${stamp}`, { due_date: todayAt(23) }), vh = page.viewportSize().height;
    const toastBottom = async () => { await page.waitForTimeout(300); return page.$eval('#toast', el => el.getBoundingClientRect().bottom); };
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(p.title)} > .body`, { timeout: 15000 });
      await page.focus('#d-subin');
      await keyboard(300);
      for (const n of [1, 2]) {
        await page.fill('#d-subin', `Pocket smoke toast sub ${n} ${stamp}`);
        await page.press('#d-subin', 'Enter');
        await page.waitForFunction(n => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === n, n, { timeout: 15000 });
        if (await page.$('#toast.show')) throw new Error(`adding subtask ${n} said: ${await page.textContent('#toast-msg')}`);
        if (await page.evaluate(() => document.activeElement?.id) !== 'd-subin') throw new Error(`the box lost the focus after add ${n}`);
      }
      await page.evaluate(() => Alpine.$data(document.body).notify('Saved'));
      const bottom = await toastBottom();
      if (bottom > vh - 300) throw new Error(`the toast is under the keyboard: its bottom is at ${bottom} of ${vh}`);
      await keyboard(0);
      if (await toastBottom() < vh - 100) throw new Error('the toast stayed up after the keyboard closed');
    } finally {
      await keyboard(0);
      await page.fill('#d-subin', '').catch(() => {});
      if (await page.isVisible('#sheet')) { await page.click('#btn-sheet-close'); await page.waitForSelector('#sheet', { state: 'hidden' }); }
      for (const s of await subsOf(p.id)) await api('/tasks/' + s.id, { method: 'DELETE' });
      await api('/tasks/' + p.id, { method: 'DELETE' });
    }
  });

  await step('turning-the-phone-keeps-the-boxes-working', async () => {
    // Portrait, landscape and back while typing (#158): the box keeps the focus and what's typed, and quick add's marks
    // stay over the words they mark: the layer behind the box is the same size, scrolled the same, with the same text
    // (and a zero-width space at its end).
    const p = await make(`Pocket smoke turn ${stamp}`, { due_date: todayAt(23) });
    const check = async (id, when) => {
      const s = await page.$eval('#' + id, ta => {
        const m = ta.previousElementSibling, a = ta.getBoundingClientRect(), b = m.getBoundingClientRect();
        return { focus: document.activeElement === ta, value: ta.value, text: m.textContent.slice(0, -1), marks: m.querySelectorAll('mark').length,
          box: [a.x, a.y, a.width, a.height, ta.clientWidth, ta.scrollTop].map(Math.round), layer: [b.x, b.y, b.width, b.height, m.clientWidth, m.scrollTop].map(Math.round) };
      });
      if (!s.focus) throw new Error(`${id} lost the focus ${when}`);
      if (s.text !== s.value || s.marks < 2) throw new Error(`${id}'s marks don't match its text ${when}: ${s.marks} marks`);
      if (JSON.stringify(s.box) !== JSON.stringify(s.layer)) throw new Error(`${id}'s marks moved off its words ${when}: box ${s.box}, marks ${s.layer}`);
      return s.value;
    };
    const turn = async id => {
      // Long enough to scroll once the phone is turned, with marks at the end
      await page.focus('#' + id);
      await page.fill('#' + id, 'Pocket smoke turn ' + 'some words to fill the box up '.repeat(14));
      await page.keyboard.type('tomorrow !2', { delay: 5 });
      for (const [width, height, name] of [[844, 390, 'in landscape'], [390, 844, 'back in portrait']]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(400);
        const was = await check(id, name);
        await page.keyboard.type(' *x', { delay: 5 });
        if (await check(id, name + ', typing') !== was + ' *x') throw new Error(`typing ${name} didn't reach ${id}`);
      }
      await page.fill('#' + id, '');
    };
    try {
      await toastGone();
      await refreshToday();
      await turn('in-capture');
      await page.click(`${rowOf(p.title)} > .body`, { timeout: 15000 });
      await turn('d-subin');
    } finally {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.fill('#d-subin', '').catch(() => {});
      await page.fill('#in-capture', '').catch(() => {});
      if (await page.isVisible('#sheet')) { await page.click('#btn-sheet-close'); await page.waitForSelector('#sheet', { state: 'hidden' }); }
      await api('/tasks/' + p.id, { method: 'DELETE' });
    }
  });

  await step('today-moves-a-task-to-overdue-as-its-time-passes', async () => {
    // Left open on Today: once a minute it regroups, without asking Vikunja, and a task whose time passes lights up as it
    // moves to Overdue, with no message at the bottom; a screen reader hears it.
    const t = `Pocket smoke due soon ${stamp}`, due = new Date(Date.now() + 6000);
    if (due.getDate() !== new Date().getDate() || !due.getHours() && !due.getMinutes()) return;   // midnight: a day without a time
    const made = await make(t, { due_date: due.toISOString() });
    try {
      await toastGone();
      await refreshToday();
      await page.waitForSelector(`.sec.today ~ .list ${rowOf(t)}`, { timeout: 15000 });
      // The page's clock is moved on past its time, not waited for. As Vikunja keeps the time: in whole seconds, so it's
      // due up to a second before `due`.
      await page.clock.fastForward(Math.max(0, Math.floor(due / 1000) * 1000 - await page.evaluate(() => Date.now()) + 1000));
      await page.evaluate(() => Alpine.$data(document.body).tickToday());     // what the minute's timer does
      await expect(page.locator(`.sec.overdue ~ .list ${rowOf(t)}`)).toHaveClass(/came-due/, { timeout: 5000 });
      await expect(page.locator('#said')).toHaveText(`“${t}” is due now`);
      await noToast(page);
    } finally { await page.clock.setSystemTime(Date.now()); await api('/tasks/' + made.id, { method: 'DELETE' }); }
  });

  await step('reminders-in-the-sheet', async () => {
    const t = `Pocket smoke remind ${stamp}`, made = await make(t, { due_date: todayAt(23) });
    const rems = async () => ((await get(made.id)).reminders || []).map(r => r.relative_to ? `${r.relative_to}${r.relative_period}` : 'at');
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
      await page.selectOption('#d-remind-add', { label: 'At due' });
      await page.waitForSelector('#d-reminders .chip.rem:has-text("At due")');
      await page.selectOption('#d-remind-add', { label: '1 hour before due' });
      await synced(page);
      if (JSON.stringify((await rems()).sort()) !== JSON.stringify(['due_date-3600', 'due_date0'])) throw new Error('reminders: ' + JSON.stringify(await rems()));
      // Taken off a preset once it's there; a set date and time too.
      if (await page.$('#d-remind-add option:text-is("At due")')) throw new Error('At due offered twice');
      await page.selectOption('#d-remind-add', { label: 'At a set date and time…' });
      const at = new Date(Date.now() + 2 * 864e5), p = n => String(n).padStart(2, '0');
      await page.fill('#d-remind-at', `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T09:30`);
      await synced(page);
      if (!(await rems()).includes('at')) throw new Error('no reminder at a set time: ' + JSON.stringify(await rems()));
      await page.waitForSelector('#d-reminders .chip.rem:has-text("9:30")');           // its time shows, not only its day
      // Removed with its ×.
      await page.click('#d-reminders .chip.rem:has-text("At due") .chip-x');
      await synced(page);
      if ((await rems()).includes('due_date0')) throw new Error('not removed: ' + JSON.stringify(await rems()));
      // A reminder added or removed elsewhere (on the web, say) since the sheet showed them stays that way.
      const elsewhere = async fn => {
        const list = (await get(made.id)).reminders.map(r => r.relative_to ? { relative_to: r.relative_to, relative_period: r.relative_period } : { reminder: r.reminder });
        await api('/tasks/' + made.id, { method: 'PATCH', headers: json, body: JSON.stringify({ reminders: fn(list) }) });
      };
      const remindersAre = async (want, what) => {
        await synced(page);
        if (JSON.stringify((await rems()).sort()) !== JSON.stringify(want)) throw new Error(what + ': ' + JSON.stringify(await rems()));
      };
      await elsewhere(list => [...list, { relative_to: 'due_date', relative_period: -86400 }]);
      await page.click('#d-reminders .chip.rem:has-text("1 hour before due") .chip-x');
      await remindersAre(['at', 'due_date-86400'], 'removing one took others with it');
      await page.waitForSelector('#d-reminders .chip.rem:has-text("1 day before due")');
      await elsewhere(list => list.filter(r => r.relative_to));
      await page.selectOption('#d-remind-add', { label: '15 min before due' });
      await remindersAre(['due_date-86400', 'due_date-900'], 'adding one brought back one removed elsewhere');
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    } finally { await api('/tasks/' + made.id, { method: 'DELETE' }); }
  });

  await step('remind-chip-in-quick-add', async () => {
    // Only when reminders reach you: the server sends reminder emails, and you have them on.
    const info = await (await fetch(SERVER + '/api/v2/info')).json(), me = await (await api('/user')).json();
    if (!info.email_reminders_enabled) return;
    const setReminders = on => api('/user/settings/general', { method: 'PATCH', headers: json, body: JSON.stringify({ ...me.settings, email_reminders_enabled: on }) });
    const t = `Pocket smoke call the plumber ${stamp}`;
    try {
      await setReminders(false);
      await page.reload(); await loaded(page);
      await page.fill('#in-capture', `${t} at 4pm`);
      await page.waitForSelector('#cap-chips .chip[data-kind=due]');
      if (await page.$('#cap-chips .chip[data-kind=remind]')) throw new Error('a 🔔 chip with your reminder emails off');
      await setReminders(true);
      await page.fill('#in-capture', '');
      await page.reload(); await loaded(page);
      // A date without a time: none. A time: there, off until tapped.
      await page.fill('#in-capture', `${t} friday`);
      await page.waitForSelector('#cap-chips .chip[data-kind=due]');
      if (await page.$('#cap-chips .chip[data-kind=remind]')) throw new Error('a 🔔 chip for a day without a time');
      // A time gone already: none, as Vikunja would never send it.
      await page.fill('#in-capture', `${t} yesterday at 4pm`);
      await page.waitForSelector('#cap-chips .chip[data-kind=due]');
      if (await page.$('#cap-chips .chip[data-kind=remind]')) throw new Error('a 🔔 chip for a time gone');
      await page.fill('#in-capture', `${t} at 4pm`);
      await page.waitForSelector('#cap-chips .chip[data-kind=remind][aria-pressed=false]:has-text("🔔 Remind me")');
      // The time is in its own chip already: this one doesn't say it again.
      if ((await page.textContent('#cap-chips .chip[data-kind=remind]')).trim() !== '🔔 Remind me') throw new Error('the 🔔 chip says ' + await page.textContent('#cap-chips .chip[data-kind=remind]'));
      await page.click('#cap-chips .chip[data-kind=remind]');
      await page.waitForSelector('#cap-chips .chip[data-kind=remind][aria-pressed=true]');
      await page.press('#in-capture', 'Enter');
      await page.waitForSelector(`.row .title:has-text("${t}")`, { timeout: 20000 });   // today at 4pm: on Today
      await synced(page);
      const made = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
      try {
        if (JSON.stringify((made?.reminders || []).map(r => [r.relative_to, r.relative_period])) !== JSON.stringify([['due_date', 0]])) throw new Error('reminders: ' + JSON.stringify(made?.reminders));
      } finally { if (made) await api('/tasks/' + made.id, { method: 'DELETE' }); }
    } finally {
      await api('/user/settings/general', { method: 'PATCH', headers: json, body: JSON.stringify(me.settings) });
      await page.evaluate(() => document.activeElement?.blur());
    }
  });

  await step('search-moves-a-ticked-task-to-done', async () => {
    const t = `Pocket smoke tick A ${stamp}`;
    await page.click('#btn-search');
    await page.fill('#in-search', t);
    const open = `#view div:has(> .sec:has-text("Open")) ${rowOf(t)}`, done = `#view div:has(> .sec:has-text("Done")) ${rowOf(t)}`;
    await page.waitForSelector(open, { timeout: 10000 });
    // Done where it is, as in a list; when the batch clears, the task is under Done.
    await page.click(`${open} > .check`);
    await expect(page.locator(`${open}.leaving`)).toHaveClass(/\bdone\b/);
    await noToast(page);
    await later(3000);
    await page.waitForSelector(done, { timeout: 10000 });
    await page.click(`${done} > .check`);                                   // and back
    await expect(page.locator(`${done}.leaving`)).not.toHaveClass(/\bdone\b/);
    await expect(page.locator('#said')).toHaveText('Not done: ' + t);
    await later(3000);
    await page.waitForSelector(open, { timeout: 10000 });
    await page.click('#btn-search-cancel');
  });

  await step('sheet-keeps-what-was-written', async () => {
    const t = `Pocket smoke tick A ${stamp}`, task = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).find(x => x.title === t);
    await refreshToday();
    await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Notes saved on close');
    await page.fill('#d-cin', 'half a comment');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await synced(page);
    if (!(await get(task.id)).description?.includes('Notes saved on close')) throw new Error('notes not saved');
    await page.click(`${rowOf(t)} > .body`);
    await page.waitForSelector('#d-cin');
    if (await page.inputValue('#d-cin') !== 'half a comment') throw new Error('comment: ' + await page.inputValue('#d-cin'));
    await page.fill('#d-cin', '');
    // Notes changed elsewhere while these were written aren't written over: both are shown, and saving again replaces them.
    const notes = async () => (await get(task.id)).description || '';
    const elsewhere = text => api('/tasks/' + task.id, { method: 'PATCH', headers: json, body: JSON.stringify({ description: `<p>${text}</p>` }) });
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Mine, from Pocket');
    await elsewhere('Theirs, from the web');
    await page.click('#d-desc-save');
    await page.waitForSelector('#d-desc-conflict:has-text("Theirs, from the web")', { timeout: 15000 });
    if (!(await notes()).includes('Theirs')) throw new Error('written over: ' + await notes());
    await page.click('#d-desc-save');
    await synced(page);
    if (!(await notes()).includes('Mine, from Pocket')) throw new Error('not saved again: ' + await notes());
    // The same when the sheet closes: they're kept on the phone instead.
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Mine again');
    await elsewhere('Theirs again');
    await page.click('#btn-sheet-close');
    // Said on its row, with Open, to see both.
    const seeBoth = rowLine(page, 'changed elsewhere').getByRole('button', { name: 'Open' });
    await expect(seeBoth).toBeVisible({ timeout: 15000 });
    await noToast(page);
    if (!(await notes()).includes('Theirs again')) throw new Error('written over on close: ' + await notes());
    await seeBoth.click();
    await page.waitForSelector('#d-desc-conflict:has-text("Theirs again")', { timeout: 15000 });
    if (await page.inputValue('#d-desc-in') !== 'Mine again') throw new Error('kept: ' + await page.inputValue('#d-desc-in'));
    await page.click('#d-desc-cancel');
    await page.waitForSelector('#d-desc:has-text("Theirs again")');
  });

  await step('label-on-enter-and-people-suggested', async () => {
    await page.click('#d-add-label');
    await page.fill('#lp-q', label);
    await page.press('#lp-q', 'Enter');
    await page.waitForSelector(`.prop:has(.k:text("Labels")) .label-chip:has-text("${label}")`, { timeout: 10000 });
    await page.click('#d-add-label');                                        // closes the picker
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    // People are suggested from those who can see the task's project: a task in the project shared with ASSIGNEE.
    const team = projects2.find(p => p.title === ASSIGNEE_PROJECT);
    if (ASSIGNEE && team && (await api('/projects/1/users/search?q=x')).status !== 401) {
      const shared = await make(`Pocket smoke assign pick ${stamp}`, { due_date: todayAt(23) }, team.id);
      await refreshToday();
      await page.click(`${rowOf(shared.title)} > .body`, { timeout: 15000 });
      await page.click('#d-add-assignee');
      await page.fill('#d-assign-in', ASSIGNEE.slice(0, 2));
      await page.click(`#d-assign-list .chip:has-text("@${ASSIGNEE}")`, { timeout: 15000 });
      await page.waitForSelector(`#d-assignees .label-chip:has-text("${ASSIGNEE}")`, { timeout: 10000 });
      await page.click('#d-assign-done');
      await page.waitForSelector('#d-assign-in', { state: 'detached' });
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    }
  });

  await step('enter-takes-the-suggestion', async () => {
    await page.fill('#in-capture', '');
    await page.type('#in-capture', `Pocket smoke enter ${stamp} *${label.slice(0, 9)}`);
    await page.waitForSelector(`#cap-chips .chip[data-kind=suggest]:has-text("*${label}")`, { timeout: 15000 });
    await page.press('#in-capture', 'Enter');
    if (await page.inputValue('#in-capture') !== `Pocket smoke enter ${stamp} *${label} `) throw new Error('text: ' + await page.inputValue('#in-capture'));
    await page.fill('#in-capture', 'Call Ana at 5');
    await page.waitForSelector('#cap-chips .chip[data-kind=due]:has-text("5:00 PM")');
    await page.fill('#in-capture', 'Standup every weekday');
    await page.waitForSelector('#cap-chips .chip.warn:has-text("can\'t repeat")');
    await page.fill('#in-capture', '');
  });

  await step('back-closes-the-sheet-and-keeps-the-draft', async () => {
    const t = `Pocket smoke tick A ${stamp}`;
    await refreshToday();
    await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
    await page.fill('#d-cin', 'written before Back');
    await page.waitForSelector('#sheet.show');                                // slid in: Back closes a sheet that's showing
    await page.goBack();                                                      // the phone's Back
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
    if (!(await page.evaluate(() => location.hash)).startsWith('#/today')) throw new Error('Back left Today: ' + await page.evaluate(() => location.href));
    await page.reload();                                                      // even after Pocket is closed
    await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
    if (await page.inputValue('#d-cin') !== 'written before Back') throw new Error('comment: ' + await page.inputValue('#d-cin'));
    await page.fill('#d-cin', '');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    // A sheet closed with ×: one Back goes to the screen before, not to the same screen again.
    await page.click('nav.tabs a[data-tab=projects]');
    await page.waitForFunction(() => location.hash === '#/projects');
    await page.click('nav.tabs a[data-tab=today]');
    await page.click(`${rowOf(t)} > .body`, { timeout: 15000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/projects', null, { timeout: 10000 });
    await page.click('nav.tabs a[data-tab=today]');
  });

  await step('repeating-tick-shows-done-then-its-next-date', async () => {
    // Shown done, with the date it had, until the batch clears; its tick before then puts its dates back, and its
    // reminder at a set time, which moved on with it, too.
    const r = await make(`Pocket smoke repeat undo ${stamp}`, { due_date: todayAt(9), repeat_after: 86400, reminders: [{ reminder: todayAt(8) }] });
    const R = page.locator(rowOf(r.title)), due = () => R.locator('.when .due').textContent();
    try {
      await toastGone();
      await refreshToday();
      const was = await due();
      await page.click(`${rowOf(r.title)} > .check`, { timeout: 15000 });
      await expect(R).toHaveClass(/\bleaving\b/);
      await expect(R).toHaveClass(/\bdone\b/);
      await expect(page.locator('#said')).toContainText(`Done: ${r.title}. It repeats, next `);
      if (await due() !== was) throw new Error(`its date changed to ${await due()} while it shows done`);
      await page.click(`${rowOf(r.title)} > .check`);
      await expect(R).not.toHaveClass(/\bleaving\b/);
      await noToast(page);
      const want = new Date(r.due_date).getTime();
      await synced(page);
      if (new Date((await get(r.id)).due_date).getTime() !== want) throw new Error('due ' + (await get(r.id)).due_date);
      const rem = (await get(r.id)).reminders?.[0]?.reminder;
      if (new Date(rem).getTime() !== new Date(todayAt(8)).getTime()) throw new Error('reminder at ' + rem);
      // Left to the batch: back, open, with its next date.
      await page.click(`${rowOf(r.title)} > .check`);
      await expect(R).toHaveClass(/\bleaving\b/);
      await later(3000);
      await expect(R).not.toHaveClass(/\bleaving\b/);
      await expect(R).not.toHaveClass(/\bdone\b/);
      await synced(page);
      const next = new Date((await get(r.id)).due_date).getTime();
      if (next <= want) throw new Error('not moved on: due ' + (await get(r.id)).due_date);
      if (await due() === was) throw new Error('its row still shows ' + was);
    } finally { await api('/tasks/' + r.id, { method: 'DELETE' }); }
  });
  await step('a-repeating-subtask-keeps-its-date', async () => {
    // Completing a parent leaves a subtask that repeats as it is: marked done, it would only move to its next date. Its
    // ring asks first, saying so.
    const parent = await make(`Pocket smoke parent of a repeat ${stamp}`), sub = await make(`Pocket smoke weekly subtask ${stamp}`, { due_date: todayAt(9), repeat_after: 604800 });
    try {
      await api(`/tasks/${parent.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: sub.id, relation_kind: 'subtask' }) });
      await toastGone();
      await page.evaluate(id => { location.hash = '#/project/' + id; }, home2);
      await loaded(page);
      await page.locator(`#view ${cardOf(parent.title)} > .card-head > .ring`).click({ timeout: 15000 });
      await expect(page.locator('#complete-note')).toHaveText('The one that repeats stays as it is.');
      await expect(page.locator('#complete-yes')).toHaveText('Complete it');
      await page.click('#complete-yes');
      await expect(page.locator(`#view ${cardOf(parent.title)}`)).toHaveClass(/\bswept\b/, { timeout: 20000 });
      await synced(page);
      if (!(await get(parent.id)).done) throw new Error('the parent isn\'t done');
      const s = await get(sub.id);
      if (s.done || new Date(s.due_date).getTime() !== new Date(sub.due_date).getTime()) throw new Error(`subtask done ${s.done}, due ${s.due_date}`);
    } finally {
      for (const id of [sub.id, parent.id]) await api('/tasks/' + id, { method: 'DELETE' });
      await page.evaluate(() => { location.hash = '#/today'; });
    }
  });
  await step('a-tick-whose-reply-is-lost-is-saved', async () => {
    // The tick reaches Vikunja, which moves the task to its next date, but the reply is lost: Pocket reads it back and
    // says it repeats, rather than that it wasn't saved, so it isn't ticked again and a date skipped.
    const r = await make(`Pocket smoke repeat lost ${stamp}`, { due_date: todayAt(9), repeat_after: 86400 });
    const lose = async x => { if (x.request().method() !== 'PATCH') return x.fallback(); await x.fetch(); return x.abort('connectionreset'); };
    try {
      await toastGone();
      await refreshToday();
      await page.route(`**/api/v2/tasks/${r.id}`, lose);
      await page.click(`${rowOf(r.title)} > .check`, { timeout: 15000 });
      await expect(page.locator('#said')).toContainText(`Done: ${r.title}. It repeats, next `, { timeout: 20000 });
      const due = new Date((await get(r.id)).due_date).getTime();
      if (due !== new Date(r.due_date).getTime() + 864e5) throw new Error('due ' + (await get(r.id)).due_date);
    } finally { await page.unroute(`**/api/v2/tasks/${r.id}`, lose); await api('/tasks/' + r.id, { method: 'DELETE' }); }
  });

  await step('a-tick-not-saved-says-so-on-its-row-with-try-again', async () => {
    // The tick goes back, and a line on its row says why, with Try again, which ticks it.
    const r = await make(`Pocket smoke not saved ${stamp}`, { due_date: todayAt(23) });
    const cut = x => x.request().method() === 'PATCH' ? x.abort('connectionreset') : x.fallback();
    try {
      await toastGone();
      await refreshToday();
      await page.route(`**/api/v2/tasks/${r.id}`, cut);
      await tick(r.title);
      const line = rowLine(page, 'Not saved: no connection');
      await expect(line).toBeVisible({ timeout: 20000 });
      await noToast(page);
      await page.unroute(`**/api/v2/tasks/${r.id}`, cut);
      await line.getByRole('button', { name: 'Try again' }).click();
      await expect(page.locator(`${rowOf(r.title)}.leaving`)).toHaveClass(/\bdone\b/);
      await synced(page);
      if (!(await get(r.id)).done) throw new Error('Try again did not tick it');
    } finally { await page.unroute(`**/api/v2/tasks/${r.id}`, cut); await api('/tasks/' + r.id, { method: 'DELETE' }); }
  });
  await step('a-sheet-save-not-made-says-so-in-the-sheet', async () => {
    // At the top of the sheet, with Try again; once saved, it goes.
    const r = await make(`Pocket smoke sheet not saved ${stamp}`, { due_date: todayAt(23) });
    const refuse = x => x.request().method() === 'PATCH' ? x.abort('connectionreset') : x.fallback();
    try {
      await refreshToday();
      await page.click(`${rowOf(r.title)} > .body`, { timeout: 15000 });
      await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
      await page.route(`**/api/v2/tasks/${r.id}`, refuse);
      await page.selectOption('#d-prio', '3');
      const line = placeLine(page, 'sheet:top');
      await expect(line).toContainText('Not saved: no connection', { timeout: 20000 });
      await expect(line).toHaveClass(/failed/);
      await noToast(page);
      await page.unroute(`**/api/v2/tasks/${r.id}`, refuse);
      await line.getByRole('button', { name: 'Try again' }).click();
      await expect(line).toHaveCount(0);
      await synced(page);
      if ((await get(r.id)).priority !== 3) throw new Error('Try again did not save it');
      await page.click('#btn-sheet-close');
      await page.waitForSelector('#sheet', { state: 'hidden' });
    } finally { await page.unroute(`**/api/v2/tasks/${r.id}`, refuse); await api('/tasks/' + r.id, { method: 'DELETE' }); }
  });

  await step('a-task-moves-and-goes-with-its-subtasks', async () => {
    const other = projects2.find(p => p.id !== home2);
    const parent = await make(`Pocket smoke move parent ${stamp}`, { due_date: todayAt(23) });
    const kids = [await make(`Pocket smoke move kid 1 ${stamp}`), await make(`Pocket smoke move kid 2 ${stamp}`)];
    for (const k of kids) await api(`/tasks/${parent.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }) });
    await refreshToday();
    await page.click(`${cardOf(parent.title)} > .card-head`, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row:not(.pending)').length === 2, null, { timeout: 10000 });
    if (other) {
      await page.selectOption('#d-proj', String(other.id));
      await synced(page);
      const where = await Promise.all([parent, ...kids].map(async t => (await get(t.id)).project_id));
      if (where.some(id => id !== other.id)) throw new Error('projects: ' + where);
    }
    await page.click('#d-more');
    if (await page.textContent('#d-delete') !== 'Delete task and its 2 subtasks') throw new Error('button: ' + await page.textContent('#d-delete'));
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 15000 });
    await later(5000);                                                       // sent once its Undo has gone
    await synced(page);
    if ((await Promise.all([parent, ...kids].map(t => get(t.id)))).some(Boolean)) throw new Error('something is left');
  });

  /* A project's list is in the order of its List view in Vikunja, each subtask under its parent in its own order: the
     same order as the web app's. Held and moved up or down, a task moves among its siblings, and its new place is
     written to that view. */
  const order = { project: null, view: null, tasks: {} };
  const viewOrder = async () => (await (await api(`/projects/${order.project.id}/views/${order.view}/tasks?expand=subtasks`)).json()).items;
  /* What a project's open list shows, top to bottom (parent-tasks-plan, part 2): each task's title, a row's or a card's,
     and a card's subtasks, its rows, after it, each marked "Subtask: ". */
  const listed = list => list.locator(':is(.item > .row > .body .title > span:not(.sr), .card-head .card-title, .card-rows > .row > .body .title > span:not(.sr))')
    .evaluateAll(els => els.map(el => (el.closest('.card-rows') ? 'Subtask: ' : '') + el.textContent.trim()));
  const openRows = () => listed(page.locator('#view .list').first());
  // Hold a row, move it past the first few pixels (so it's a move, not progress), then to the top or the bottom of the
  // row `to`, and let go.
  /* `selects`: [what a phone's long press selects as the finger goes down (the row's words, or the nearest it can
     select), where a selection tries to start as it moves]; the hold clears the one and stops the other. Returns what's
     selected after. */
  async function dragTo(sel, to, edge = 'top', selects = null){
    await page.locator(sel).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));   // clear of the edges, where it scrolls
    const box = await steady(page.locator(sel)), x = box.x + box.width / 2, y0 = box.y + box.height / 2;
    const b = await page.locator(to).boundingBox(), y = edge === 'top' ? b.y + 4 : b.y + b.height - 4;
    await page.mouse.move(x, y0); await page.mouse.down();
    if (selects) await page.locator(selects[0]).evaluate(el => getSelection().selectAllChildren(el));
    await expect(page.locator(sel)).toHaveClass(/held/);
    await page.mouse.move(x, y0 + Math.sign(y - y0) * 14, { steps: 3 });
    if (selects && await page.locator(selects[1]).evaluate(el => el.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })))) throw new Error('a selection could start while moving a row');
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.up();
    return page.evaluate(() => getSelection().toString());
  }
  const rowById = id => `#view .row[data-id="${id}"]`;
  await step('project-in-list-view-order', async () => {
    order.project = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: `PocketSmokeOrder${stamp}` }) })).json();
    createdProjects.push(order.project.id);
    order.view = order.project.views.filter(v => v.view_kind === 'list').sort((a, b) => a.position - b.position || a.id - b.id)[0].id;
    const mk = async (name, extra = {}) => order.tasks[name] = await (await api(`/projects/${order.project.id}/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title: `${name} ${stamp}`, ...extra }) })).json();
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'sub one', 'sub two', 'sub three']) await mk(name, name === 'Alpha' ? { description: '<p>Bring the long ladder</p>' } : {});
    await mk('Delta', { done: true });
    const T = order.tasks;
    for (const s of ['sub one', 'sub two', 'sub three']) await api(`/tasks/${T.Alpha.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: T[s].id, relation_kind: 'subtask' }) });
    // Put in an order of their own on the web: Bravo, Alpha (sub three, sub one, sub two), Charlie.
    const at = { Bravo: 1000, Alpha: 2000, Charlie: 3000, 'sub three': 100, 'sub one': 200, 'sub two': 300 };
    for (const [name, position] of Object.entries(at)) await api(`/tasks/${T[name].id}/position`, { method: 'PUT', headers: json, body: JSON.stringify({ project_view_id: order.view, position }) });
    await page.click('#btn-refresh');                                           // so Pocket knows the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await page.evaluate(id => { location.hash = '#/project/' + id; }, order.project.id);
    const want = ['Bravo', 'Alpha', 'Subtask: sub three', 'Subtask: sub one', 'Subtask: sub two', 'Charlie'].map(n => `${n} ${stamp}`);
    await expect.poll(openRows).toEqual(want);
    // Vikunja's own order, the same.
    const roots = (await viewOrder()).filter(t => !t.done && !t.related_tasks?.parenttask?.length).map(t => t.title);
    if (JSON.stringify(roots) !== JSON.stringify(['Bravo', 'Alpha', 'Charlie'].map(n => `${n} ${stamp}`))) throw new Error('Vikunja has ' + roots);
    // Its done task is in the Done section, folded, with how many.
    await expect(page.getByRole('button', { name: 'Done (1)' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#view .row', { hasText: `Delta ${stamp}` })).toHaveCount(0);
  });
  await step('drag-a-task-and-a-subtask', async () => {
    const T = order.tasks;
    // A row held and moved is a gesture, not text: nothing is left selected after it, whatever a phone's long press
    // started (dragTo's `selects`).
    const unselected = (where, sel) => { if (sel) throw new Error(`moving ${where} left "${sel}" selected`); };
    // Bravo, from the top to the bottom: under Charlie, past Alpha and its subtasks, which go with Alpha.
    unselected("a row on a project's list", await dragTo(rowById(T.Bravo.id), rowById(T.Charlie.id), 'bottom', [`${rowById(T.Bravo.id)} .title`, `${rowById(T.Bravo.id)} .title`]));
    await expect.poll(openRows).toEqual(['Alpha', 'Subtask: sub three', 'Subtask: sub one', 'Subtask: sub two', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
    await synced(page);
    const pos = async () => Object.fromEntries((await viewOrder()).map(t => [t.title.replace(` ${stamp}`, ''), t.position]));
    let p = await pos();
    if (!(p.Alpha < p.Charlie && p.Charlie < p.Bravo)) throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    // A subtask, among its parent's subtasks only: sub two to the top of them.
    await dragTo(rowById(T['sub two'].id), rowById(T['sub three'].id));
    await expect.poll(openRows).toEqual(['Alpha', 'Subtask: sub two', 'Subtask: sub three', 'Subtask: sub one', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
    await synced(page);
    p = await pos();
    if (!(p['sub two'] < p['sub three'] && p['sub three'] < p['sub one'])) throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    // Read again, the same; and in Alpha's sheet, its subtasks in that order too.
    await page.reload();
    await expect.poll(openRows, { timeout: 15000 }).toEqual(['Alpha', 'Subtask: sub two', 'Subtask: sub three', 'Subtask: sub one', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
    await page.click(`#view .day-card[data-id="${T.Alpha.id}"] > .card-head .card-open`);
    await expect(page.locator('#d-subtasks .row .title')).toHaveText(['sub two', 'sub three', 'sub one'].map(n => `${n} ${stamp}`));
    // In the sheet, moved the same way: sub one to the top, written to Vikunja's List view too.
    // In the sheet, the long press picks the nearest words: the Subtasks heading over them, or the notes.
    unselected('a subtask in its sheet', await dragTo(`#d-subtasks .row[data-id="${T['sub one'].id}"]`, `#d-subtasks .row[data-id="${T['sub two'].id}"]`, 'top', ['.h3:has(#d-subcount)', '#d-desc']));
    // The heading and the subtasks' card can't be selected; the notes, held on their own, can.
    const userSelect = q => page.locator(q).evaluate(el => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect);
    if (await userSelect('.h3:has(#d-subcount)') !== 'none' || await userSelect('#d-subtasks') !== 'none') throw new Error('the Subtasks heading or card can be selected');
    if (await userSelect('#d-desc') === 'none') throw new Error("the notes can't be selected");
    // (A tap on them opens them to edit, so the long press is only its selection, with no row held.)
    const notes = page.locator('#d-desc');
    if (!await notes.evaluate(el => el.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })))) throw new Error('a long press on the notes selects nothing');
    await notes.evaluate(el => getSelection().selectAllChildren(el));
    if (!(await page.evaluate(() => getSelection().toString())).includes('Bring the long ladder')) throw new Error('the notes lost their selection');
    await page.evaluate(() => getSelection().removeAllRanges());
    await expect(page.locator('#d-subtasks .row .title')).toHaveText(['sub one', 'sub two', 'sub three'].map(n => `${n} ${stamp}`));
    await synced(page);
    p = await pos();
    if (!(p['sub one'] < p['sub two'] && p['sub two'] < p['sub three'])) throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect.poll(openRows).toEqual(['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
  });
  await step('a-move-turned-down-goes-back-and-says-why', async () => {
    // Vikunja turns it down, as for an API token without Tasks → Position: back where it was, its row saying so.
    const T = order.tasks, refuse = r => r.request().method() === 'PUT' ? r.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"missing permission"}' }) : r.fallback();
    await page.route('**/api/v2/tasks/*/position', refuse);
    await dragTo(rowById(T.Charlie.id), rowById(T.Bravo.id), 'bottom');
    await expect(rowLine(page, 'Not moved: your API token doesn\'t allow reordering. Make one with Position ticked under Tasks.')).toBeVisible();
    await page.unroute('**/api/v2/tasks/*/position', refuse);
    await later(5000);                                                     // its line folds, giving the row back
    await expect.poll(openRows).toEqual(['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
    await synced(page);
    const roots = (await viewOrder()).filter(t => !t.related_tasks?.parenttask?.length && !t.done).map(t => t.title.replace(` ${stamp}`, ''));
    if (JSON.stringify(roots) !== JSON.stringify(['Alpha', 'Charlie', 'Bravo'])) throw new Error('Vikunja has ' + roots);
  });
  await step('move-up-from-the-tasks-menu', async () => {
    // The way for a keyboard or a screen reader: the task's ⋯, Move up; and Alt+↓ on its row.
    const T = order.tasks;
    await page.click(`${rowById(T.Bravo.id)} > .body`);
    await page.click('#d-more');
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect.poll(openRows).toEqual(['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Bravo', 'Charlie'].map(n => `${n} ${stamp}`));
    await page.focus(`${rowById(T['sub one'].id)} > .body`);
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(openRows).toEqual(['Alpha', 'Subtask: sub two', 'Subtask: sub one', 'Subtask: sub three', 'Bravo', 'Charlie'].map(n => `${n} ${stamp}`));
    await synced(page);
    const roots = (await viewOrder()).filter(t => !t.related_tasks?.parenttask?.length && !t.done).map(t => t.title.replace(` ${stamp}`, ''));
    if (JSON.stringify(roots) !== JSON.stringify(['Alpha', 'Bravo', 'Charlie'])) throw new Error('Vikunja has ' + roots);
  });
  await step('the-done-section-opens-loads-and-reopens', async () => {
    const T = order.tasks, done = page.getByRole('button', { name: /^Done/ }), delta = page.locator('#view .row', { hasText: `Delta ${stamp}` });
    // An old link to a project's done tasks opens its list with the Done section open.
    await page.evaluate(id => { location.hash = `#/project/${id}?done=1`; }, order.project.id);
    await expect(delta).toBeVisible({ timeout: 15000 });
    await expect(done).toHaveAttribute('aria-expanded', 'true');
    if (await page.evaluate(() => location.hash) !== '#/project/' + order.project.id) throw new Error('address: ' + await page.evaluate(() => location.hash));
    // Folded, and open again, as it was left, after a reload.
    await done.click();
    await expect(delta).toBeHidden();
    await done.click();
    await expect(delta).toBeVisible();
    await page.reload();
    await expect(delta).toBeVisible({ timeout: 15000 });
    // Ticked to reopen it: back in the open list, and not done in Vikunja.
    await page.getByRole('button', { name: `Mark not done: Delta ${stamp}` }).click();
    await expect(page.locator(`#view .row.leaving[data-id="${T.Delta.id}"]`)).not.toHaveClass(/\bdone\b/);
    await later(3000);
    await expect(page.locator('#view .list').first().locator(`.row[data-id="${T.Delta.id}"]`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /^Done/ })).toHaveCount(0);           // nothing done any more
    await synced(page);
    if ((await (await api('/tasks/' + T.Delta.id)).json()).done) throw new Error('still done in Vikunja');
    // Ticked done again: off the open list, and counted in Done.
    await page.getByRole('button', { name: `Mark done: Delta ${stamp}` }).click();
    await expect(page.locator(`#view .row.leaving[data-id="${T.Delta.id}"]`)).toHaveClass(/\bdone\b/);
    await later(3000);
    await expect(page.getByRole('button', { name: 'Done (1)' })).toBeVisible();
  });
  /* A parent completed from its ring, after asking (parent-tasks-plan, part 3), closes its open subtasks with it: its
     card a gap with "Done" and Undo. Undo opens those two again, and not the one done before. */
  const doneIn = async (...names) => Promise.all(names.map(async n => (await (await api('/tasks/' + order.tasks[n].id)).json()).done));
  const echoCard = () => page.locator(`#view .day-card[data-id="${order.tasks.Echo.id}"]`);
  await step('a-parent-completed-from-its-ring-and-undone-opens-only-those', async () => {
    const T = order.tasks, mk = async (name, extra = {}) => T[name] = await (await api(`/projects/${order.project.id}/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title: `${name} ${stamp}`, ...extra }) })).json();
    await mk('Echo');
    for (const s of ['echo one', 'echo two']) await mk(s);
    await mk('echo done', { done: true });
    for (const s of ['echo one', 'echo two', 'echo done']) await api(`/tasks/${T.Echo.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: T[s].id, relation_kind: 'subtask' }) });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await expect(echoCard().locator(`.row[data-id="${T['echo two'].id}"]`)).toBeVisible();
    await expect(echoCard().locator('.card-head > .ring .n')).toHaveText('1/3');
    await echoCard().locator('.card-head > .ring').click();
    await expect(page.locator('#complete-note')).toHaveText(/^Its 2 open subtasks will be marked done too: echo (one|two) \d+ and echo (one|two) \d+\.$/);
    await page.click('#complete-yes');
    await expect(echoCard()).toHaveClass(/\bswept\b/);
    await synced(page);
    if (JSON.stringify(await doneIn('Echo', 'echo one', 'echo two')) !== '[true,true,true]') throw new Error('not all closed in Vikunja');
    await echoCard().getByRole('button', { name: `Undo: Echo ${stamp}` }).click();
    await expect(echoCard()).not.toHaveClass(/\bswept\b/);
    await expect(echoCard().locator('.card-rows > .row')).toHaveCount(2);
    await synced(page);
    const now = await doneIn('Echo', 'echo one', 'echo two', 'echo done');
    if (JSON.stringify(now) !== '[false,false,false,true]') throw new Error('after Undo, done: ' + now);
  });
  /* A parent done with subtasks still open (ticked done on the web, which leaves them): a card, its title struck
     through, over them, not left out with them on their own at the top. It can't be moved, nor be what the add box adds
     to; tapped, its sheet opens; its ring opens it again, where it is, with no question (one thing to do). */
  await step('a-done-parent-shows-over-its-open-subtasks', async () => {
    const T = order.tasks;
    await api('/tasks/' + T.Echo.id, { method: 'PATCH', headers: json, body: JSON.stringify({ done: true }) });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await expect(echoCard()).toHaveClass(/\bdone\b/);
    await expect(echoCard().locator('.card-head .sr')).toContainText('Done, with subtasks still open');
    const rows = await openRows(), at = rows.indexOf(`Echo ${stamp}`);
    if (at < 0 || !rows.slice(at + 1, at + 3).every(r => /^Subtask: echo (one|two) /.test(r))) throw new Error('rows: ' + JSON.stringify(rows));
    if (rows.some(r => /^echo/.test(r))) throw new Error('a subtask on its own at the top: ' + JSON.stringify(rows));
    // Held, it isn't lifted to be moved.
    const head = echoCard().locator('.card-head');
    await head.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await steady(head);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await later(800);
    await expect(echoCard()).not.toHaveClass(/held/);
    await page.mouse.up();                                                      // a tap, then: its sheet
    await expect(page.locator('#sheet .row.own')).toHaveClass(/\bdone\b/);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(page.locator('#cap-target')).toHaveCount(0);                   // the add box adds a task, not to it
    // Its ring opens it again, where it is, with its subtasks on it, and out of Done.
    const count = +(await page.getByRole('button', { name: /^Done \(/ }).textContent()).match(/\d+/)[0];
    await expect(echoCard().locator('.card-head > .ring')).toHaveAttribute('aria-label', `Mark not done: Echo ${stamp}`);
    await echoCard().locator('.card-head > .ring').click();
    await expect(page.locator('#said')).toHaveText(`Not done: Echo ${stamp}`);
    if (await page.isVisible('#sheet')) throw new Error('it asked');
    await later(3000);
    await expect(echoCard()).not.toHaveClass(/\bdone\b/);
    await expect.poll(openRows).toEqual(rows);
    await expect(page.getByRole('button', { name: `Done (${count - 1})` })).toBeVisible();
    await synced(page);
    if (JSON.stringify(await doneIn('Echo', 'echo one', 'echo two')) !== '[false,false,false]') throw new Error('done in Vikunja: ' + await doneIn('Echo', 'echo one', 'echo two'));
  });

  /* On a project's list, quick add's box adds a task to the project, until a task is touched (its sheet opened, ticked):
     then it adds subtasks to that task, after its last, or after the subtask touched, each after the one before. */
  const foot = { project: null, view: null, tasks: {} };
  const footRows = () => listed(page.locator('#view .list').first());
  const footName = n => `${n} ${stamp}`;
  const box = page.locator('#in-capture'), target = page.locator('#cap-target');
  const footPositions = async () => Object.fromEntries((await (await api(`/projects/${foot.project.id}/views/${foot.view}/tasks?expand=subtasks`)).json()).items
    .map(t => [t.title.replace(` ${stamp}`, ''), t])); // by name: {position, related_tasks}
  // A task on the list, a row or a card (a task with open subtasks, lit up as a row is while the box adds to it), and
  // what opens it.
  const itemById = id => `#view :is(.item > .row, .day-card)[data-id="${id}"]`;
  const openAndClose = async id => {
    await page.click(`:is(${rowById(id)} > .body, #view .day-card[data-id="${id}"] > .card-head .card-open)`);
    await page.waitForSelector('#sheet .row.own');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  };
  await step('the-add-box-adds-subtasks-to-the-task-touched', async () => {
    foot.project = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: `PocketSmokeFoot${stamp}` }) })).json();
    createdProjects.push(foot.project.id);
    foot.view = foot.project.views.filter(v => v.view_kind === 'list').sort((a, b) => a.position - b.position || a.id - b.id)[0].id;
    const mk = async name => foot.tasks[name] = await (await api(`/projects/${foot.project.id}/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title: footName(name) }) })).json();
    for (const name of ['Van', 'Chairs', 'Tables', 'Lights']) await mk(name);
    const T = foot.tasks;
    for (const s of ['Chairs', 'Tables']) await api(`/tasks/${T.Van.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: T[s].id, relation_kind: 'subtask' }) });
    for (const [name, position] of Object.entries({ Van: 1000, Lights: 2000, Chairs: 100, Tables: 200 }))
      await api(`/tasks/${T[name].id}/position`, { method: 'PUT', headers: json, body: JSON.stringify({ project_view_id: foot.view, position }) });
    await page.click('#btn-refresh');                                           // so Pocket knows the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await page.evaluate(id => { location.hash = '#/project/' + id; }, foot.project.id);
    await expect.poll(footRows, { timeout: 15000 }).toEqual(['Van', 'Subtask: Chairs', 'Subtask: Tables', 'Lights'].map(footName));
    // Nothing touched yet: a task for the project.
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
    await expect(target).toHaveCount(0);
    // Its sheet opened and closed: the box names it, and its row is lit up.
    await openAndClose(T.Van.id);
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}`);
    await expect(page.locator(itemById(T.Van.id))).toHaveClass(/aimed/);
    await expect(page.getByRole('textbox', { name: `New subtask of ${footName('Van')}` })).toBeVisible();
    await expect(page.locator('#said')).toHaveText(`Add a subtask to ${footName('Van')}`);
    // Two typed with Enter: the box keeps the focus, and they go after its last subtask, in the order typed.
    await box.click();
    await box.fill(footName('Rope'));
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await box.fill(footName('Straps'));
    await box.press('Enter');
    await expect.poll(footRows).toEqual(['Van', 'Subtask: Chairs', 'Subtask: Tables', 'Subtask: Rope', 'Subtask: Straps', 'Lights'].map(footName));
    if (await page.evaluate(() => document.activeElement?.id) !== 'in-capture') throw new Error('the box lost the focus');
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}, after ${footName('Straps')}`);
    await noToast(page);
    await synced(page);
    const p = await footPositions();
    for (const s of ['Rope', 'Straps']) if (!p[s].related_tasks?.parenttask?.some(x => x.id === T.Van.id)) throw new Error(s + ' is not under Van');
    if (!(p.Tables.position < p.Rope.position && p.Rope.position < p.Straps.position)) throw new Error('positions: ' + ['Tables', 'Rope', 'Straps'].map(s => p[s].position));
    foot.tasks.Rope = p.Rope; foot.tasks.Straps = p.Straps;
    await page.reload();
    await expect.poll(footRows, { timeout: 15000 }).toEqual(['Van', 'Subtask: Chairs', 'Subtask: Tables', 'Subtask: Rope', 'Subtask: Straps', 'Lights'].map(footName));
    await expect(target).toHaveCount(0);                                      // a reload starts afresh
  });
  await step('the-add-box-adds-right-after-a-subtask-touched', async () => {
    const T = foot.tasks;
    await openAndClose(T.Chairs.id);
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}, after ${footName('Chairs')}`);
    // A pasted list is several subtasks, and the next one goes after them.
    await box.fill(`${footName('Ladder')}
${footName('Hooks')}`);
    await expect(page.locator('#cap-chips')).toContainText('2 subtasks');
    await box.press('Enter');
    await box.fill(`${footName('Tarp')} +Elsewhere`);                            // +project stays in its title
    await expect(page.locator('#cap-chips')).toContainText('+project stays as words: a subtask goes in its task\'s project');
    await box.press('Enter');
    const want = [footName('Van'), ...['Chairs', 'Ladder', 'Hooks'].map(n => 'Subtask: ' + footName(n)), `Subtask: Tarp ${stamp} +Elsewhere`,
      ...['Tables', 'Rope', 'Straps'].map(n => 'Subtask: ' + footName(n)), footName('Lights')];
    await expect.poll(footRows).toEqual(want);
    await synced(page);
    const p = await footPositions(), tarp = Object.keys(p).find(k => k.startsWith('Tarp'));
    const order = ['Chairs', 'Ladder', 'Hooks', tarp, 'Tables'].map(s => p[s].position);
    if (order.some((x, i) => i && x <= order[i - 1])) throw new Error('positions: ' + order);
    if (p[tarp].project_id !== foot.project.id) throw new Error('the subtask went to another project');
    await page.reload();
    await expect.poll(async () => (await footRows()).length, { timeout: 15000 }).toBe(want.length);
    await expect.poll(async () => (await footRows())[4]).toBe(`Subtask: Tarp ${stamp} +Elsewhere`);
  });
  await step('the-add-boxs-x-goes-back-to-adding-a-task', async () => {
    const T = foot.tasks;
    await openAndClose(T.Van.id);
    const x = page.getByRole('button', { name: `Add a task to PocketSmokeFoot${stamp} instead` });
    const size = await x.boundingBox();
    if (size.width < 48 || size.height < 48) throw new Error('× is ' + size.width + '×' + size.height);
    await x.click();
    await expect(target).toHaveCount(0);
    await expect(page.locator(itemById(T.Van.id))).not.toHaveClass(/aimed/);
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
    await box.fill(footName('Fuel'));
    await box.press('Enter');
    await expect.poll(async () => (await footRows())[0]).toBe(footName('Fuel'));            // a task of its own, first, where Vikunja puts it
    await synced(page);
    const p = await footPositions();
    if (p.Fuel?.related_tasks?.parenttask?.length) throw new Error('Fuel was added as a subtask');
  });
  await step('a-tick-moves-what-the-add-box-adds-to', async () => {
    const T = foot.tasks;
    // A subtask ticked done: its parent, to add more beside it. Ticked open again: the subtask itself.
    await page.getByRole('button', { name: 'Mark done: ' + footName('Rope'), exact: true }).click();
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}`);
    await expect(page.locator(itemById(T.Van.id))).toHaveClass(/aimed/);
    await page.getByRole('button', { name: 'Mark not done: ' + footName('Rope'), exact: true }).click();
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}, after ${footName('Rope')}`);
    await expect(page.locator(rowById(T.Rope.id))).toHaveClass(/aimed/);
    await synced(page);
  });
  await step('the-add-box-forgets-a-task-scrolled-away-or-left', async () => {
    const T = foot.tasks;
    await openAndClose(T.Lights.id);
    await expect(target).toHaveText(`Add a subtask to ${footName('Lights')}`);
    // Scrolled off the screen: a task again, and scrolling back doesn't bring it back.
    await page.evaluate(() => { document.getElementById('view').style.paddingBottom = '3000px'; });
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await expect(target).toHaveCount(0);
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page.locator(rowById(T.Lights.id))).toBeInViewport();
    await expect(target).toHaveCount(0);
    await page.evaluate(() => { document.getElementById('view').style.paddingBottom = ''; });
    // Another screen, and back: a task again.
    await openAndClose(T.Lights.id);
    await expect(target).toHaveCount(1);
    await page.click('nav.tabs a[data-tab=today]');
    await expect(box).toHaveAttribute('placeholder', 'Add a task');
    await page.goBack();
    await expect.poll(async () => (await footRows()).length, { timeout: 15000 }).toBeGreaterThan(0);
    await expect(target).toHaveCount(0);
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
  });
  /* A nudge (an experiment): a finger on a row that turns into a short, slow scroll aims the add box at it; a long or
     fast one, a hold, a tap (which opens the sheet, aiming as it closes), a row done or read only, and Today don't. The
     finger is Chrome's own touch input (`finger`, helpers.mjs), so the page scrolls under it as on a phone. Each one
     goes down from the top of the list, where the page can't scroll, so no row moves out of sight meanwhile. */
  const cursorId = () => page.evaluate(() => Alpine.$data(document.body).cursor?.id ?? null);
  await step('a-nudge-aims-the-add-box', async () => {
    const T = foot.tasks, Fuel = rowOf(footName('Fuel')), Hooks = rowOf(footName('Hooks'));
    await page.evaluate(() => scrollTo(0, 0));
    await expect(target).toHaveCount(0);
    // Down 40px, slowly: the row it started on is the target, lit up, and a screen reader hears it.
    await touchDrag(`#view .day-card[data-id="${T.Van.id}"] > .card-head`, 40);
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}`);
    await expect(page.locator(itemById(T.Van.id))).toHaveClass(/aimed/);
    await expect(page.locator('#said')).toHaveText(`Add a subtask to ${footName('Van')}`);
    // On a subtask: after it, under its task.
    await touchDrag(rowById(T.Tables.id), 30);
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}, after ${footName('Tables')}`);
    // Further than a row, however slowly; or fast: a scroll, and the target stays.
    await touchDrag(rowById(T.Chairs.id), 150, 30);
    await touchDrag(Fuel, 50, 2, 8);
    // Held, then lifted without moving: not a tap, nor a nudge.
    await touchDrag(rowById(T.Chairs.id), 0, 0, 0, 700);
    await expect(page.locator('#sheet')).toBeHidden();
    if (await cursorId() !== T.Tables.id) throw new Error('the target moved to ' + await cursorId());
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}, after ${footName('Tables')}`);
    // A row ticked done (its tick aims at its task) and a project read only: a nudge leaves the target as it is.
    await page.getByRole('button', { name: 'Mark done: ' + footName('Hooks'), exact: true }).click();
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}`);
    await touchDrag(Hooks, 30);
    if (await cursorId() !== T.Van.id) throw new Error('the target moved to ' + await cursorId());
    // Ticked open again, it's the target (its tick), and the project made read only, a nudge on another row leaves it.
    await page.getByRole('button', { name: 'Mark not done: ' + footName('Hooks'), exact: true }).click();
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}, after ${footName('Hooks')}`);
    await page.evaluate(id => { Alpine.$data(document.body).perms[id] = 0; }, foot.project.id);
    try { await touchDrag(Fuel, 30); if (await cursorId() !== +await page.locator(Hooks).getAttribute('data-id')) throw new Error('the target moved to ' + await cursorId()); }
    finally { await page.evaluate(id => { delete Alpine.$data(document.body).perms[id]; }, foot.project.id); }
    // A tap, by a finger too, still opens the sheet, which aims as it closes.
    const b = await steady(page.locator(Fuel + ' > .body'));
    await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2); await touch('touchEnd', 0, 0);
    await page.waitForSelector('#sheet .row.own');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(target).toHaveText(`Add a subtask to ${footName('Fuel')}`);
    await synced(page);
  });
  await step('a-nudge-on-today-does-nothing', async () => {
    const d = await make(`Pocket smoke nudge ${stamp}`, { due_date: todayAt(23) });
    try {
      await refreshToday();
      await expect(page.locator(rowOf(d.title))).toBeVisible({ timeout: 15000 });
      await page.locator(rowOf(d.title)).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await touchDrag(rowOf(d.title), 30);
      await expect(page.locator('#sheet')).toBeHidden();
      if (await cursorId() !== null) throw new Error('Today has a target: ' + await cursorId());
      await expect(target).toHaveCount(0);
    } finally { await api('/tasks/' + d.id, { method: 'DELETE' }); }
  });

  await step('share-progress-copy-it-and-open-it-in-vikunja', async () => {
    // A project of its own: Pack the van at 60%, its subtasks in this order (one done, one half way, one yours), with
    // notes and a comment; and Order milk after it.
    const proj = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: `PocketSmokeShare${stamp}` }) })).json();
    createdProjects.push(proj.id);
    const view = proj.views.filter(v => v.view_kind === 'list').sort((a, b) => a.position - b.position || a.id - b.id)[0].id;
    const me = await (await api('/user')).json(), my = (me.name || '').trim().split(/\s+/)[0] || me.username;
    const mk = async (name, extra = {}, position) => {
      const t = await (await api(`/projects/${proj.id}/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title: name, ...extra }) })).json();
      await api(`/tasks/${t.id}/position`, { method: 'PUT', headers: json, body: JSON.stringify({ project_view_id: view, position }) });
      return t;
    };
    const van = await mk(`Pack the van ${stamp}`, { percent_done: .6, description: '<p>Bring the long cable</p><p>Keys in the office</p>' }, 1000);
    await mk(`Order milk ${stamp}`, {}, 2000);
    const subs = [await mk('Load chairs', { done: true }, 100), await mk('Tables', { percent_done: .5 }, 200), await mk('Sound system', {}, 300), await mk('Lights', {}, 400)];
    for (const s of subs) await api(`/tasks/${van.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: s.id, relation_kind: 'subtask' }) });
    await api(`/tasks/${subs[2].id}/assignees/bulk`, { method: 'PUT', headers: json, body: JSON.stringify({ assignees: [{ id: me.id }] }) });
    await api(`/tasks/${van.id}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ comment: '<p>Van keys are <b>in the office</b></p>' }) });
    await page.click('#btn-refresh');                                           // so Pocket knows the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await page.evaluate(id => { location.hash = '#/project/' + id; }, proj.id);
    await page.click(`#view .day-card[data-id="${van.id}"] > .card-head .card-open`, { timeout: 15000 });
    await expect(page.locator('#d-subtasks .row .title')).toHaveText(['Load chairs', 'Tables', 'Sound system', 'Lights']);
    await expect(page.locator('#d-subtasks').getByRole('button', { name: 'You\'re doing Sound system. Tap to let it go' })).toBeVisible();
    await expect(page.locator('#d-comments .comment')).toHaveCount(1);

    // Through the phone's share sheet: plain text, with the task's name as its title. Its progress is its ring's, worked
    // out from its subtasks, (100 + 50 + 0 + 0) / 4 = 38%, not the 60% set on it before it had them, with a segment per
    // subtask, filled for each done (parent-tasks-plan, part 5).
    await expect(page.locator('#sheet .row.own > .ring .n')).toHaveText('1/4');
    await expect.poll(() => page.locator('#sheet .row.own > .ring').evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100))).toBe(38);
    const text = [`Pack the van ${stamp}  ▰▱▱▱ 38%`, '✓ Load chairs', '◐ Tables 50%', `○ Sound system · ${my}`, '○ Lights'].join('\n');
    await page.evaluate(() => { window.shared = []; navigator.share = async d => { window.shared.push(d); }; });
    const menu = async () => { if (!await page.locator('#d-menu').isVisible()) await page.click('#d-more'); return page.locator('#d-menu'); };
    await (await menu()).getByRole('menuitem', { name: 'Share progress as a text' }).click();
    await expect.poll(() => page.evaluate(() => window.shared)).toEqual([{ title: `Pack the van ${stamp}`, text }]);
    await expect(page.locator('#d-menu')).toHaveCount(0);
    // Without one, copied, and said so where it was shared from.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(APP).origin });
    // (Windows' clipboard gives the lines back with \r\n.)
    const clip = () => page.evaluate(() => navigator.clipboard.readText()).then(t => t.replace(/\r\n/g, '\n'));
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.evaluate(() => { navigator.share = undefined; });
    await (await menu()).getByRole('menuitem', { name: 'Share progress as a text' }).click();
    await placeSays(page, 'sheet:top', 'Copied: paste it into a message');
    await expect.poll(clip).toBe(text);
    // As a Markdown list.
    await (await menu()).getByRole('menuitem', { name: 'Copy as a Markdown list' }).click();
    await placeSays(page, 'sheet:top', 'Copied as a Markdown list');
    await expect.poll(clip).toBe([`## Pack the van ${stamp} (38%)`, '', '- [x] Load chairs', '- [ ] Tables (50%)', `- [ ] Sound system @${me.username}`, '- [ ] Lights'].join('\n'));
    // Its page in Vikunja, in the browser.
    const open = (await menu()).getByRole('menuitem', { name: 'Open in Vikunja' });
    await expect(open).toHaveAttribute('href', `${SERVER}/tasks/${van.id}`);
    await expect(open).toHaveAttribute('target', '_blank');
    await page.click('#d-more');
    // Its notes, and a comment, as plain text.
    await page.getByRole('button', { name: 'Copy the notes' }).click();
    await placeSays(page, 'sheet:notes', 'Copied the notes');
    await expect.poll(clip).toBe('Bring the long cable\n\nKeys in the office');
    await page.getByRole('button', { name: 'Copy this comment' }).click();
    await placeSays(page, 'sheet:comments', 'Copied the comment');
    await expect.poll(clip).toBe('Van keys are in the office');

    // The project, from its ⋯: its open tasks in its list's order, with their open subtasks, and how many are done.
    await page.click('#btn-sheet-close');
    await page.click('#btn-project');
    await page.evaluate(() => { window.shared = []; navigator.share = async d => { window.shared.push(d); }; });
    await page.click('#p-share-text');
    await expect.poll(() => page.evaluate(() => window.shared[0]?.text)).toBe([`PocketSmokeShare${stamp}  5 open · 1 done`, `◐ Pack the van ${stamp}  ▰▱▱▱ 38%`, '  ◐ Tables 50%',
      `  ○ Sound system · ${my}`, '  ○ Lights', `○ Order milk ${stamp}`, '✓ 1 done'].join('\n'));
    await page.click('#p-copy-md');
    await placeSays(page, 'sheet:top', 'Copied as a Markdown list');
    await expect.poll(clip).toBe([`# PocketSmokeShare${stamp}`, '', '5 open · 1 done', '', `- [ ] Pack the van ${stamp} (38%)`, '  - [ ] Tables (50%)',
      `  - [ ] Sound system @${me.username}`, '  - [ ] Lights', `- [ ] Order milk ${stamp}`].join('\n'));
    await expect(page.locator('#p-open-vikunja')).toHaveAttribute('href', `${SERVER}/projects/${proj.id}`);
    await page.click('#btn-sheet-close');
  });

  // ---- Instant feel: a tab opens at once with its last copy; a change looks waiting only after a few seconds ----
  await step('a-tab-opens-at-once-with-its-last-copy-then-changes-in-place', async () => {
    const t = await make(`Instant ${stamp}`, { due_date: todayAt(23) });
    await refreshToday();
    await expect(page.locator(rowOf(`Instant ${stamp}`))).toBeVisible();
    await page.click('nav.tabs a[data-tab=projects]');
    await page.click('.tree .row .body');
    await expect(page.locator('#btn-project')).toBeVisible();
    await api('/tasks/' + t.id, { method: 'PATCH', headers: json, body: JSON.stringify({ title: `Instant renamed ${stamp}` }) });
    // Today's lists answer late: what shows meanwhile is the copy kept of it, with no Loading.
    let answer; const late = new Promise(ok => { answer = ok; });
    const slow = async r => { await late; await r.fallback(); };
    await page.route(/\/api\/v2\/tasks\?/, slow);
    try {
      await page.click('nav.tabs a[data-tab=today]');
      await expect(page.locator(rowOf(`Instant ${stamp}`))).toBeVisible();
      await expect(page.locator('#view .loading')).toHaveCount(0);
      await page.locator(rowOf(`Instant ${stamp}`)).evaluate(el => { el.dataset.mark = 'kept'; });
      await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
      // Taking over a second, a line under the header says it's being loaded; not over the rows.
      await expect(page.locator('#behind')).toBeVisible();
    } finally { answer(); await page.unroute(/\/api\/v2\/tasks\?/, slow); }
    // The change, in place: the same row, not one drawn again.
    await expect(page.locator(`[data-mark="kept"] .title > span:not(.sr)`)).toHaveText(`Instant renamed ${stamp}`, { timeout: 15000 });
    await expect(page.locator('#behind')).toBeHidden();
    await expect(page.locator('#view[aria-busy]')).toHaveCount(0);
  });

  await step('a-change-shows-at-once-and-looks-waiting-only-after-a-few-seconds', async () => {
    let send; const sending = new Promise(ok => { send = ok; });
    const hold = async r => { if (r.request().method() === 'POST') await sending; await r.fallback(); };
    await page.route('**/api/v2/projects/*/tasks', hold);
    try {
      await page.fill('#in-capture', `Waits ${stamp}`);
      await page.press('#in-capture', 'Enter');
      // On Today at once, as it'll be: not dotted, nor the header's waiting button, for the first few seconds.
      const row = page.locator(`.row.pending:has(.title:has-text("Waits ${stamp}"))`);
      await expect(row).toBeVisible();
      await later(2000);
      await expect(row).not.toHaveClass(/\bwaits\b/);
      await expect(row.locator('.check.wait')).toHaveCount(0);
      await expect(page.locator('#btn-refresh.waits')).toHaveCount(0);
      // Then it looks waiting.
      await later(1000);
      await expect(row).toHaveClass(/\bwaits\b/);
      await expect(row.locator('.check.wait')).toHaveCount(1);
      await expect(page.locator('#btn-refresh.waits')).toBeVisible();
    } finally { send(); await page.unroute('**/api/v2/projects/*/tasks', hold); }
    await expect(page.locator(`.row:not(.pending):has(.title:has-text("Waits ${stamp}"))`)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#btn-refresh.waits')).toHaveCount(0);
    await synced(page);
  });

  /* The stacked card (parent-tasks-plan, part 2): a task with open subtasks is a card on Today, collapsed, its header
     (the parent's ring, with its count inside it, then its title, its priority's bars and when it's due) over its most
     urgent open subtask (overdue, then due today, then the earliest date, then its List view's order), with More under
     it, which opens it in place, and Less; its subtasks are never rows of their own on Today. Its rows act as any row: a
     tick, a swipe, each that subtask's; ticked, the top row stays until the batch clears, then the next slides up. */
  const listView = async pid => ((await (await api('/projects/' + pid)).json()).views || []).filter(v => v.view_kind === 'list').sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id)[0];
  const placeIn = async (view, pairs) => { for (const [t, position] of pairs) await api(`/tasks/${t.id}/position`, { method: 'PUT', headers: json, body: JSON.stringify({ project_view_id: view.id, position }) }); };
  const under = async (p, kids) => { for (const k of kids) await api(`/tasks/${p.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }) }); };
  // A collapsed card's top row, and what its title shows (without what a screen reader hears with it).
  const stepLine = t => `${cardOf(t)} .step-line`;
  const stepTitle = t => page.locator(`${stepLine(t)} .title > span:not(.sr)`);
  // A card's rows' titles, top to bottom.
  const cardRows = t => page.locator(`${cardOf(t)} > .card-rows > .row .title > span:not(.sr)`);
  // A parent's ring: its arc, the worked-out figure (--ring), in percent.
  const ringPct = sel => page.locator(sel).evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100));
  await step('a-task-with-subtasks-is-a-stacked-card-on-today', async () => {
    const P = await make(`Pocket smoke card ${stamp}`, { due_date: todayAt(23), priority: 3 });
    const [A, B, C] = [await make(`Pocket smoke card A ${stamp}`), await make(`Pocket smoke card B ${stamp}`), await make(`Pocket smoke card C ${stamp}`, { due_date: todayAt(22) })];
    const Q = await make(`Pocket smoke card's neighbour ${stamp}`, { due_date: todayAt(23) });     // a row beside it on Today
    await under(P, [A, B, C]);
    await placeIn(await listView(home2), [[B, 100], [C, 200], [A, 300]]);    // B, C, A in its List view
    const card = page.locator(cardOf(P.title)), line = page.locator(stepLine(P.title)), title = stepTitle(P.title), ring = card.locator('.card-head > .ring');
    const more = card.locator('.card-more');
    try {
      await toastGone();
      await refreshToday();
      // One card, under Today, collapsed on C, due today, before B and A, which come first in its List view.
      await expect(page.locator(`div:has(> .sec.today) ${cardOf(P.title)}`)).toBeVisible({ timeout: 15000 });
      await expect(card).toHaveAttribute('role', 'group');
      await expect(card).toHaveAttribute('aria-label', P.title);
      await expect(title).toHaveText(C.title);
      await expect(card.locator('.card-rows > .row')).toHaveCount(1);
      for (const k of [A, B, C]) await expect(page.locator(`.item > .row:has(.title:has-text("${k.title}"))`)).toHaveCount(0);
      // Its header: its ring with its count, no tick of its own; its title, its priority's bars, when it's due; a screen
      // reader hears its count and figure, its priority and when it's due.
      await expect(ring.locator('.n')).toHaveText('0/3');
      await expect(ring).toHaveAttribute('aria-label', `Complete “${P.title}” and its 3 open subtasks`);
      await expect(card.locator('.card-head > .check')).toHaveCount(0);
      await expect(card.locator('.card-head .bars.p3')).toBeVisible();
      await expect(card.locator('.card-head .due')).toHaveText(/\S/);
      await expect(card.locator('.card-head .sr')).toContainText('0 of 3 subtasks done, 0%');
      await expect(card.locator('.card-head .sr')).toContainText('Priority: High');
      await expect(card.locator('.card-head .sr')).toContainText('Due Today');
      await expect(line).toHaveClass(/\bone-line\b/);
      if (await card.locator('.card-head').evaluate(el => el.offsetHeight) > 46 || await line.evaluate(el => el.offsetHeight) > 57) throw new Error('its heading or its top row is more than one line');
      // Its top row, indented one level: its tick under the header's title, as a subtask's under its parent (a row's
      // tick sits 14px in); a plain row, each zone 48px across at least over its full height: the tick (the whole
      // gutter to its title), the title, who's on it.
      await line.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const zones = await line.evaluate(el => {
        const r = el.getBoundingClientRect();
        const name = (x, y) => { const b = document.elementFromPoint(x, r.top + y)?.closest('button'); return b?.matches('.check') ? 'tick' : b?.matches('.body') ? 'title' : b?.matches('.claim') ? 'slot' : String(b?.className); };
        const body = el.querySelector(':scope > .body').getBoundingClientRect(), slot = el.querySelector(':scope > .claim').getBoundingClientRect();
        const want = { tick: [r.left + 1, body.left - 1], title: [body.left + 1, slot.left - 1], slot: [slot.left + 1, r.right - 1] }, top = 2;
        const wrong = [];
        for (const [k, [x0, x1]] of Object.entries(want)) for (const x of [x0, (x0 + x1) / 2, x1]) for (const y of [top, r.height / 2, r.height - 2]) if (name(x, y) !== k) wrong.push(`${k} at ${Math.round(x - r.left)},${Math.round(y)}: ${name(x, y)}`);
        const head = el.closest('.day-card').querySelector('.card-title').getBoundingClientRect();
        return { wrong, tick: el.querySelector(':scope > .check').getBoundingClientRect().left - r.left, under: el.querySelector(':scope > .check').getBoundingClientRect().left - head.left, widths: { tick: body.left - r.left, slot: r.right - slot.left }, height: r.height - top + 1 };
      });
      if (zones.wrong.length) throw new Error('taps land elsewhere: ' + zones.wrong.join('; '));
      if (Object.values(zones.widths).some(w => w < 48) || zones.height < 48) throw new Error('a zone under 48px: ' + JSON.stringify(zones));
      const rowTick = await page.locator(`.item > .row:has(.title:has-text("${Q.title}"))`).evaluate(el => el.querySelector(':scope > .check').getBoundingClientRect().left - el.getBoundingClientRect().left);
      if (Math.abs(zones.under) > 0.5 || zones.tick <= rowTick + 20) throw new Error(`its top row's tick isn't under the header's title, a level in: ${JSON.stringify(zones)}, a row's at ${rowTick}`);
      // More, a slim tab hanging under its top row, ⌄ in it: its tap from the row's foot, 48px down to the next thing
      // listed, never the row's. Opened in place, every open subtask in the same order, the
      // top one first; then a plain ⌃ with no tab, "Show less", collapses it again.
      await expect(more).toHaveAccessibleName('More');
      const foot = () => card.evaluate(el => {
        const m = el.querySelector(':scope > .card-more'), row = el.querySelector('.card-rows > .row:last-child').getBoundingClientRect(), x = row.left + row.width / 2;
        const hit = y => document.elementFromPoint(x, y)?.closest('.card-more, .row, .day-card, .item');
        const last = !el.closest('.item').nextElementSibling?.matches('.item'), tab = getComputedStyle(m.querySelector('.tab'));
        return { row: hit(row.bottom - 1)?.matches('.row'), from: hit(row.bottom + 1) === m, to: hit(row.bottom + 47) === m, past: last || hit(row.bottom + 49) !== m,
          tab: tab.backgroundColor, corners: tab.borderBottomLeftRadius };
      });
      await card.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const shut = await foot();
      if (!shut.row || !shut.from || !shut.to || !shut.past || shut.tab === 'rgba(0, 0, 0, 0)' || shut.corners === '0px') throw new Error('its footer: ' + JSON.stringify(shut));
      await more.click();
      await expect(cardRows(P.title)).toHaveText([C.title, B.title, A.title]);
      await expect(more).toHaveAccessibleName('Show less');
      if (await page.isVisible('#sheet')) throw new Error('More opened the task');
      const opened = await foot();
      if (!opened.from || !opened.to || opened.tab !== 'rgba(0, 0, 0, 0)') throw new Error('opened, its footer: ' + JSON.stringify(opened));
      await more.click();
      await expect(cardRows(P.title)).toHaveText([C.title]);
      // Ticked: done where it is, the card's height kept, until the batch clears; then the next comes in, and the ring
      // counts it.
      const h = await card.evaluate(el => el.offsetHeight);
      await line.locator('> .check').click();
      await expect(line).toHaveClass(/\bdone\b/);
      await expect(title).toHaveText(C.title);
      await synced(page);
      if (!(await get(C.id)).done) throw new Error('never done');
      if (await card.evaluate(el => el.offsetHeight) !== h) throw new Error('the card changed height');
      await later(3000);
      await expect(title).toHaveText(B.title);
      await expect(line).not.toHaveClass(/\bdone\b/);
      await expect(ring.locator('.n')).toHaveText('1/3');
      if (await card.evaluate(el => el.offsetHeight) !== h) throw new Error('the card changed height as the batch cleared');
      // A plain swipe right on its top row: that subtask's progress, not its task's; the ring's figure follows, (100 +
      // 50 + 0) / 3 = 50%, and is written to the task.
      await slideProgress(stepLine(P.title), 50);
      await expect(page.locator('#said')).toHaveText(`Progress of ${B.title} set to 50%`);
      await expect.poll(() => ringPct(`${cardOf(P.title)} > .card-head > .ring`)).toBe(50);
      await synced(page);
      if (Math.round((await get(B.id)).percent_done * 100) !== 50) throw new Error(`the subtask's progress: ${(await get(B.id)).percent_done}`);
      await expect.poll(async () => Math.round((await get(P.id)).percent_done * 100)).toBe(50);
      // Its header swiped right a little springs back, asking nothing.
      await swipeRow(page, `${cardOf(P.title)} > .card-head`, 'back', { one: true });
      await page.waitForTimeout(300);
      if (await page.isVisible('#sheet')) throw new Error('a partial swipe on its header opened something');
      // A full swipe right on its top row: done, the gap with Undo in its place; once the batch clears, the next slides
      // up, the last one open, so no More.
      await slideProgress(stepLine(P.title), 100, null, 50);
      await expect(page.locator(`${cardOf(P.title)} .card-rows > .row.swept`)).toContainText('Done');
      await later(3000);
      await expect(title).toHaveText(A.title);
      await expect(more).toHaveCount(0);
      await expect(ring.locator('.n')).toHaveText('2/3');
      await synced(page);
      if (!(await get(B.id)).done || (await get(A.id)).done || (await get(P.id)).done) throw new Error('more than that subtask was changed');
      // Its ring tapped, with one open: no question; it and the task completed, the card a gap with Undo.
      await ring.click();
      await expect(card).toHaveClass(/\bswept\b/);
      if (await page.isVisible('#sheet')) throw new Error('it asked, with one open subtask');
      await card.getByRole('button', { name: 'Undo: ' + P.title }).click();
      await expect(card).not.toHaveClass(/\bswept\b/);
      await synced(page);
      if ((await get(P.id)).done || (await get(A.id)).done) throw new Error('Undo left them done');
    } finally { for (const t of [A, B, C, P, Q]) await api('/tasks/' + t.id, { method: 'DELETE' }); }
  });

  /* An opened card on Today collapses once it's scrolled off the screen, without moving what's in sight, and leaving
     Today collapses it too. */
  await step('an-opened-card-collapses-once-scrolled-away-or-left', async () => {
    const P = await make(`Pocket smoke folding card ${stamp}`, { due_date: todayAt(23) }), kids = [];
    for (let i = 1; i <= 3; i++) kids.push(await make(`Pocket smoke folding ${i} ${stamp}`));
    await under(P, kids);
    const card = page.locator(cardOf(P.title)), rows = card.locator('.card-rows > .row'), more = card.locator('.card-more');
    try {
      await toastGone();
      await refreshToday();
      await expect(card).toBeVisible({ timeout: 15000 });
      await card.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await more.click();
      await expect(rows).toHaveCount(3);
      // Scrolled until it's wholly off the top of the screen, and back.
      await page.evaluate(() => { document.getElementById('view').style.paddingBottom = '3000px'; });
      await page.evaluate(el => scrollBy(0, el.getBoundingClientRect().bottom + 200), await card.elementHandle());
      await expect(rows).toHaveCount(1);
      await page.evaluate(() => { document.getElementById('view').style.paddingBottom = ''; });
      await card.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await expect(more).toHaveAccessibleName('More');
      await more.click();
      await expect(rows).toHaveCount(3);
      await page.click('nav.tabs a[data-tab=projects]');
      await page.click('nav.tabs a[data-tab=today]');
      await expect(rows).toHaveCount(1, { timeout: 15000 });
    } finally {
      await page.evaluate(() => { document.getElementById('view').style.paddingBottom = ''; });
      for (const t of [...kids, P]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('a-subtask-of-yours-made-today-brings-its-task-an-old-one-doesnt', async () => {
    const me = await (await api('/user')).json(), far = new Date(Date.now() + 30 * 864e5).toISOString();
    const P = await make(`Pocket smoke later ${stamp}`, { due_date: far }), Q = await make(`Pocket smoke older ${stamp}`, { due_date: far });
    const first = await make(`Pocket smoke later first ${stamp}`), mine = await make(`Pocket smoke later mine ${stamp}`), old = await make(`Pocket smoke older mine ${stamp}`);
    await under(P, [first, mine]); await under(Q, [old]);
    await placeIn(await listView(home2), [[first, 100], [mine, 200]]);
    for (const t of [mine, old]) await api(`/tasks/${t.id}/assignees`, { method: 'POST', headers: json, body: JSON.stringify({ user_id: me.id }) });
    /* `old` as if made last week: Vikunja doesn't let a test date a task back, so its replies say so, and Today's read of
       what was made today leaves it out, as it would. */
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    const aged = async r => {
      const res = await r.fetch(), body = await res.json(), made = /created/.test(decodeURIComponent(r.request().url()));
      if (Array.isArray(body.items)) body.items = body.items.filter(t => !(made && t.id === old.id)).map(t => t.id === old.id ? { ...t, created: week } : t);
      await r.fulfill({ response: res, json: body });
    };
    await page.route(/\/api\/v2\/tasks\?/, aged);
    try {
      await toastGone();
      await refreshToday();
      const added = 'div:has(> .sec:has-text("Added today, no date"))';
      await expect(page.locator(`${added} ${cardOf(P.title)}`)).toBeVisible({ timeout: 15000 });
      // Its top row by the card's one rule, the first in its List view, neither dated (parent-tasks-plan, part 2: not
      // the one of yours that brought it); yours under it, opened.
      await expect(stepTitle(P.title)).toHaveText(first.title);
      await expect(page.locator(`${cardOf(P.title)} > .card-head > .ring .n`)).toHaveText('0/2');
      await page.locator(`${cardOf(P.title)} .card-more`).click();
      await expect(cardRows(P.title)).toHaveText([first.title, mine.title]);
      await expect(page.locator(`${cardOf(P.title)} .card-rows > .row:has(.title:has-text("${mine.title}")) .claim.mine`)).toBeVisible();
      await expect(page.locator(cardOf(Q.title))).toHaveCount(0);
      await expect(page.locator(`.row .title:has-text("${old.title}")`)).toHaveCount(0);
    } finally {
      await page.unroute(/\/api\/v2\/tasks\?/, aged);
      for (const t of [first, mine, old, P, Q]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });

  await step('a-subtask-due-today-brings-its-undated-task-and-today-opens-with-it-at-once', async () => {
    const P = await make(`Pocket smoke undated card ${stamp}`), X = await make(`Pocket smoke due kid ${stamp}`, { due_date: todayAt(23) }), Y = await make(`Pocket smoke undated kid ${stamp}`);
    await under(P, [X, Y]);
    await placeIn(await listView(home2), [[Y, 100], [X, 200]]);
    try {
      await toastGone();
      await refreshToday();
      // Under Today, by its subtask's date; that one on top, due today, though the other comes first in its List view.
      await expect(page.locator(`div:has(> .sec.today) ${cardOf(P.title)}`)).toBeVisible({ timeout: 15000 });
      await expect(stepTitle(P.title)).toHaveText(X.title);
      await expect(page.locator(`.item > .row:has(.title:has-text("${X.title}"))`)).toHaveCount(0);
      // Today opened again at once, from the copy kept of it, with its cards, while its lists answer late.
      await page.click('nav.tabs a[data-tab=projects]');
      await page.locator(stepLine(P.title)).waitFor({ state: 'detached' });
      let answer; const late = new Promise(ok => { answer = ok; });
      const slow = async r => { await late; await r.fallback(); };
      await page.route(/\/api\/v2\/tasks\?/, slow);
      try {
        await page.click('nav.tabs a[data-tab=today]');
        await expect(stepTitle(P.title)).toHaveText(X.title);
        await expect(page.locator(`${stepLine(P.title)} .claim`)).toBeVisible();
        await expect(page.locator('#view .loading')).toHaveCount(0);
        await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
      } finally { answer(); await page.unroute(/\/api\/v2\/tasks\?/, slow); }
      await loaded(page);
      await expect(stepTitle(P.title)).toHaveText(X.title);
    } finally { for (const t of [X, Y, P]) await api('/tasks/' + t.id, { method: 'DELETE' }); }
  });

  await step('a-long-title-with-no-spaces-doesnt-widen-the-page', async () => {
    const long = `Unbroken${'x'.repeat(120)}${stamp}`;
    const proj = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: long }) })).json();
    createdProjects.push(proj.id);
    await make(long, { due_date: todayAt(23) }, proj.id);
    // What's on screen and reaches past its right edge (not the words inside a title on one line, which it cuts short).
    const past = () => page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return [...document.querySelectorAll('#app *, #sheet *')].filter(el => el.offsetParent !== null && el.getBoundingClientRect().right > w + 1 && !el.parentElement.closest('.one-line .title, .card-title'))
        .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className : '')).slice(0, 3);
    });
    await refreshToday();
    await expect(page.locator(rowOf(long))).toBeVisible();
    expect(await past(), 'past the edge on Today').toEqual([]);
    // On one line, cut short with "…".
    const cut = await page.locator(`${rowOf(long)} .title`).evaluate(el => [el.scrollWidth > el.clientWidth, getComputedStyle(el).textOverflow, el.offsetHeight]);
    if (!cut[0] || cut[1] !== 'ellipsis' || cut[2] > 30) throw new Error('its title is not cut short on one line: ' + cut);
    await page.evaluate(id => { location.hash = '#/project/' + id; }, proj.id);
    await page.click('#btn-project', { timeout: 15000 });
    await expect(page.locator('#p-sharing')).toBeVisible();
    await page.waitForTimeout(300);                                          // the sheet sliding in
    expect(await past(), 'past the edge in the project\'s sheet').toEqual([]);
    await page.click('#btn-sheet-close');
    await page.click(`${rowOf(long)} > .body`);
    await expect(ownTitle()).toHaveText(long);
    await page.waitForTimeout(300);
    expect(await past(), 'past the edge in the task\'s sheet').toEqual([]);
    // Its title tapped: a box to change it in, where it was, no wider.
    await ownTitle().click();
    await expect(page.locator('#d-title')).toBeFocused();
    expect(await past(), 'past the edge with its title being changed').toEqual([]);
    await page.press('#d-title', 'Escape');
    await expect(page.locator('#d-title')).toHaveCount(0);
    await page.click('#btn-sheet-close');
  });

  // ---- A long project: its rows drawn in batches, Done's latest 100, its kept copy, opening on it ----
  /* A long project (performance-plan, parts 4 to 6 and 9), made through the API: 80 open tasks, more than a screen
     draws at once, and 105 done, more than Done shows at once. */
  const big = {}, word = `Longlist${stamp}`;
  const bigRows = () => page.locator('#view .list').first().locator('.row[data-id]');
  const doneRows = page.locator('#view .done-sec ~ .list .row[data-id]'), doneSec = page.locator('#sec-done'), moreRow = page.locator('#more-done');
  const ids = loc => loc.evaluateAll(els => els.map(el => +el.dataset.id));
  await step('a-long-screens-rows-are-all-there-once-its-loaded', async () => {
    big.project = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: `PocketSmokeLong${stamp}` }) })).json();
    createdProjects.push(big.project.id);
    const all = [...Array(80)].map((_, i) => [`${word} open ${i + 1}`, {}]).concat([...Array(105)].map((_, i) => [`${word} done ${i + 1}`, { done: true }]));
    const made = [];
    for (let i = 0; i < all.length; i += 8) made.push(...await Promise.all(all.slice(i, i + 8).map(([title, extra]) =>
      api(`/projects/${big.project.id}/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title, ...extra }) }).then(r => r.json()))));
    [big.open, big.done] = [made.slice(0, 80), made.slice(80)];
    await page.click('#btn-refresh');                                           // so Pocket knows the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    // The first rows are drawn at once and the rest in batches after, the screen busy until they all are: once it's
    // loaded, every row is there, read once. On a phone's CPU (4 times slower), so they do come in batches.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    let shown;
    try {
      await page.evaluate(id => { location.hash = '#/project/' + id; }, big.project.id);
      await expect(bigRows().first()).toBeVisible({ timeout: 15000 });
      await loaded(page);
      shown = await ids(bigRows());
    } finally { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await cdp.detach(); }
    if (shown.length !== 80 || !shown.includes(big.open.at(-1).id)) throw new Error(`${shown.length} rows once loaded, the last task's ${shown.includes(big.open.at(-1).id) ? '' : 'not '}among them`);
  });
  /* Done shows the 100 done most recently, its heading counting them all, and a row at its end for the rest; a tap shows
     them, and the row goes with none left, the focus on the first it showed (performance-plan, part 9). */
  await step('done-shows-its-latest-100-and-a-row-for-the-rest', async () => {
    await expect(doneSec).toHaveText('Done (105)');
    await doneSec.click();
    await expect(doneRows).toHaveCount(100, { timeout: 15000 });
    await expect(moreRow).toHaveText('Show the last 5, done before these');
    await moreRow.click();
    await expect(doneRows).toHaveCount(105);
    await expect(moreRow).toHaveCount(0);
    const shown = await ids(doneRows);
    if (new Set(shown).size !== 105 || big.done.some(t => !shown.includes(t.id))) throw new Error('Done shows ' + shown.length + ', not every one made');
    const focus = await page.evaluate(() => +document.activeElement?.closest('.row')?.dataset.id);
    if (!shown.slice(100).includes(focus)) throw new Error('the focus is on ' + focus + ', not the first row shown by the tap');
  });
  /* The copy kept of a project opens Done only if it's open now, and keeps Done's count, not its tasks (part 4): opened,
     closed and left, the project shows no done rows when it's back, from the copy or loaded afresh; and Done starts
     again at its latest 100. */
  await step('a-projects-kept-copy-opens-done-only-if-its-open-now', async () => {
    await doneSec.click();
    await expect(doneSec).toHaveAttribute('aria-expanded', 'false');
    await page.click('nav.tabs a[data-tab=today]');
    await expect(page.locator('nav.tabs a[data-tab=today]')).toHaveAttribute('aria-current', 'page');
    await loaded(page);
    // Its lists answer late, so what shows meanwhile is the copy.
    let answer; const late = new Promise(ok => { answer = ok; });
    const slow = async r => { await late; await r.fallback(); };
    const lists = new RegExp(`/api/v2/projects/${big.project.id}/(views/\\d+/)?tasks`);
    await page.route(lists, slow);
    try {
      await page.evaluate(id => { location.hash = '#/project/' + id; }, big.project.id);
      await expect(page.locator(rowById(big.open[0].id))).toBeVisible();
      await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
      await expect(doneSec).toHaveAttribute('aria-expanded', 'false');
      await expect(doneSec).toHaveText('Done (105)');
      if (await page.locator('#view .done-sec ~ .list .row').count()) throw new Error('the copy has done rows');
      const kept = await page.evaluate(id => JSON.parse(localStorage.getItem(`pocket.saved.project.${id}.open`)).groups.find(g => g.key === 'done'), big.project.id);
      if (kept.tasks.length || kept.count !== 105) throw new Error(`the copy keeps ${kept.tasks.length} done tasks, counting ${kept.count}`);
    } finally { answer(); await page.unroute(lists, slow); }
    await loaded(page);
    if (await page.locator('#view .done-sec ~ .list .row').count()) throw new Error('done rows once loaded');
    await doneSec.click();
    await expect(doneRows).toHaveCount(100, { timeout: 15000 });
    await expect(moreRow).toHaveText('Show the last 5, done before these');
    await doneSec.click();
  });
  /* Search's done matches: the 50 done most recently, the heading counting them all, and the same row for 50 more. */
  await step('search-shows-its-latest-50-done-and-a-row-for-more', async () => {
    await page.click('#btn-search');
    await page.fill('#in-search', word);
    const found = page.locator('#view div:has(> .sec:has-text("Done")) .row[data-id]');
    await expect(found).toHaveCount(50, { timeout: 15000 });
    await expect(page.locator('#view .sec:has-text("Done") .n')).toHaveText('105');
    await expect(moreRow.locator('.title')).toHaveText('Show 50 more, done before these');
    await expect(moreRow.locator('.note')).toHaveText('55 more not shown');
    await moreRow.click();
    await expect(found).toHaveCount(100);
    await expect(moreRow).toHaveText('Show the last 5, done before these');
    await moreRow.click();
    await expect(found).toHaveCount(105);
    await expect(moreRow).toHaveCount(0);
    await page.click('#btn-search-cancel');
  });
  /* Opening Pocket with the sign-in it last confirmed shows the kept screen at once, before Vikunja says who's signed
     in (performance-plan, part 6); a change made meanwhile waits, and is sent once Vikunja has said. */
  await step('opens-on-the-kept-screen-before-vikunja-says-whos-signed-in', async () => {
    const t = big.open[0], sent = [];
    await page.evaluate(id => { location.hash = '#/project/' + id; }, big.project.id);
    await expect(page.locator(rowById(t.id))).toBeVisible();
    await loaded(page);
    let answer, asked = false; const late = new Promise(ok => { answer = ok; });
    const user = /\/api\/v2\/user(\?|$)/, slow = async r => { asked = true; await late; await r.fallback(); };
    const sends = r => r.method() !== 'GET' && r.url().includes('/api/v2/') && sent.push(r.url());
    await page.route(user, slow);
    page.on('request', sends);
    try {
      await page.reload();
      await expect.poll(() => asked).toBe(true);
      await expect(page.locator(rowById(t.id))).toBeVisible();
      await page.getByRole('button', { name: 'Mark done: ' + t.title, exact: true }).click();
      await expect(page.locator(rowById(t.id))).toHaveClass(/\bdone\b/);
      await page.waitForTimeout(1000);                                      // time for a request that mustn't go yet
      if (sent.length) throw new Error('sent before Vikunja said who it is: ' + sent);
    } finally { answer(); await page.unroute(user, slow); }
    await synced(page);
    page.off('request', sends);
    if (!sent.some(u => u.endsWith('/tasks/' + t.id))) throw new Error('the tick was never sent: ' + sent);
    if (!(await (await api('/tasks/' + t.id)).json()).done) throw new Error('not done in Vikunja');
    await later(3000);
    await page.click('nav.tabs a[data-tab=today]');
    await api('/projects/' + big.project.id, { method: 'DELETE' });            // its tasks off Today for the steps after
  });
  await step('project-sheet-renames-and-deletes', async () => {
    const proj = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: `PocketSmokeSheet${stamp}` }) })).json();
    createdProjects.push(proj.id);
    await page.click('#btn-refresh');                                           // so Pocket knows the project
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await page.evaluate(id => { location.hash = '#/project/' + id; }, proj.id);
    await page.click('#btn-project', { timeout: 15000 });
    await page.fill('#p-name', `PocketSmokeSheet${stamp} renamed`);
    await page.press('#p-name', 'Enter');
    await synced(page);
    if ((await (await api('/projects/' + proj.id)).json()).title !== `PocketSmokeSheet${stamp} renamed`) throw new Error('not renamed');
    await page.waitForSelector('#p-archive');
    if (await page.textContent('#p-delete') !== 'Delete project and its 0 tasks') throw new Error('delete: ' + await page.textContent('#p-delete'));
    await page.click('#p-delete');
    await page.waitForFunction(() => location.hash === '#/projects', null, { timeout: 15000 });
    if ((await api('/projects/' + proj.id)).ok) throw new Error('the project is still there');
  });

  await step('projects', async () => {
    await page.click('nav.tabs a[data-tab=projects]');
    await page.click('.tree .row .body');
    await expect(page.locator('#btn-project')).toBeVisible();
  });
  await page.screenshot({ path: `${OUT}/project.png` });
  await step('deep-link-add', async () => {
    await page.goto(APP + '#/add?text=Buy+milk+friday');
    await page.waitForFunction(() => document.querySelector('#in-capture').value === 'Buy milk friday');
  });
  if (errors.length) { failed++; console.log('FAIL console errors:', errors); }
} finally {
  await synced(page, { timeout: 5000 }).catch(() => {});                  // what Pocket was still sending, first
  await browser.close();
  for (const id of createdProjects) await api('/projects/' + id, { method: 'DELETE' });   // with their tasks
  // Delete anything this run left behind (every title it creates ends with the run's stamp).
  const tasks = await (await api('/tasks?q=' + stamp)).json().then(d => d.items).catch(() => []);
  for (const t of tasks || []) if (t.title.endsWith(String(stamp))) {
    // A few tries: a Vikunja on SQLite (the local one with DB=sqlite) can answer 500 "database is locked" while busy.
    let r;
    for (let i = 0; i < 5 && !(r = await api('/tasks/' + t.id, { method: 'DELETE' })).ok; i++) await new Promise(ok => setTimeout(ok, 500));
    if (!r.ok) console.log(`Could not delete leftover task ${t.id} (HTTP ${r.status})`);
  }
}

console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
