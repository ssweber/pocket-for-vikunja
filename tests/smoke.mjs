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
import { chromium } from 'playwright';
import { expect, noToast, placeLine, placeSays, rowLine, signIn, steady, synced, toastGone as toastGoneOn } from './helpers.mjs';

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

try {
  await step('sign-in-with-a-token', () => signIn(page, APP, TOKEN));
  await page.screenshot({ path: `${OUT}/today.png` });

  await step('quick-add', async () => {
    await page.fill('#in-capture', `${title} tomorrow at 5pm !3 *${label}`);
    const chips = await page.textContent('#cap-chips');
    if (!/Tomorrow/.test(chips) || !/Priority 3/.test(chips)) throw new Error('chips: ' + chips);
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row .title:has-text("${title}")`, { timeout: 15000 });
    if (!await page.$(`.row.fresh:has(.title:has-text("${title}"))`)) throw new Error('the new row isn\'t highlighted');
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
  await step('tick-in-list-and-undo', async () => {
    // Ticked off the list, its row is a line saying so, with its Undo, in its place.
    await page.click(`${row} .check`);
    await page.waitForSelector(`${row}.lined .row-line:has-text("Done:")`, { timeout: 10000 });
    if (await page.$('#toast.show #toast-msg:has-text("Done")')) throw new Error('a tick in a list said: ' + await page.textContent('#toast-msg'));
    if (!(await page.textContent('#said')).startsWith('Done: ' + title)) throw new Error('a screen reader hears: ' + await page.textContent('#said'));
    await page.click(`${row} .line-act`);
    await page.waitForSelector(`${row}:not(.lined)`, { timeout: 15000 });
    if (await page.$eval(row, el => el.classList.contains('done'))) throw new Error('row still marked done after undo');
  });
  /* How far right a finger at x slides to go from `from`% to `to`%: the room to the screen's edge is the rest of the way
     to 100%, 48px short of it (holdToSlide's EDGE). */
  const slideBy = (x, from, to) => (page.viewportSize().width - 48 - x) * (to - from) / (100 - from);
  // Hold a row, then slide it sideways from `from`% to `to`%, as with a finger.
  async function slideProgress(sel, to, check, from = 0){
    const box = await page.locator(sel).boundingBox();
    const x = box.x + box.width * .2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForSelector(`${sel}.setting.held`, { timeout: 2000 });
    await page.mouse.move(x + slideBy(x, from, to), y, { steps: 10 });
    await check?.();
    await page.mouse.up();
  }
  const apiTask = async () => (await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items.find(t => t.title === title);
  await step('progress-hold-and-slide', async () => {
    // Snaps to the quarters: slid to 45%, it's 50%.
    await slideProgress(row, 45, async () => {
      const shown = await page.getAttribute(row, 'data-pct');
      if (shown !== '50%') throw new Error('showed ' + shown + ' while sliding');
    });
    // On its bar only: sliding it back is the undo. A screen reader hears it.
    await expect(page.locator('#said')).toHaveText(`Progress of ${title} set to 50%`);
    await noToast(page);
    if (await page.isVisible('#sheet')) throw new Error('letting go opened the task');
    if (await page.$(`${row}.held, ${row}.setting`)) throw new Error('the row is still held');
    const t = await apiTask();
    if (Math.round(t.percent_done * 100) !== 50) throw new Error('saved percent_done ' + t.percent_done);
    // Held in the right tenth of the row, 100% is still within reach before the screen's edge, its percentage on the
    // left, clear of the thumb. Slid back to where it was, nothing changes.
    const box = await page.locator(row).boundingBox(), x = box.x + box.width * .9, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.waitForSelector(`${row}.setting[data-side=left]`, { timeout: 2000 });
    await page.mouse.move(page.viewportSize().width - 4, y + 3, { steps: 8 });
    const shown = await page.getAttribute(row, 'data-pct'), full = await page.$(`${row}.setting.full`);
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    if (shown !== '100%' || !full) throw new Error('from the right of the row, at most ' + shown + (full ? '' : ", and the tick didn't fill"));
    if (Math.round((await apiTask()).percent_done * 100) !== 50) throw new Error('slid back, it saved ' + (await apiTask()).percent_done);
    // Moved up or down after the hold, it's let go: nothing changes, and the task doesn't open.
    await page.mouse.move(x, y); await page.mouse.down();
    await page.waitForSelector(`${row}.held`, { timeout: 2000 });
    await page.mouse.move(x + 3, y + 30, { steps: 5 });
    await page.waitForSelector(`${row}.held`, { state: 'detached', timeout: 2000 });
    await page.mouse.move(x + 150, y + 30, { steps: 5 });
    await page.mouse.up();
    if (await page.isVisible('#sheet')) throw new Error('letting go opened the task');
    if (Math.round((await apiTask()).percent_done * 100) !== 50) throw new Error('moved down, it saved ' + (await apiTask()).percent_done);
  });
  await step('progress-100-marks-done-and-undo', async () => {
    await slideProgress(row, 100, null, 50);                               // from 50%, to the edge: 100%
    await page.waitForSelector(`${row}.lined`, { timeout: 10000 });
    // Done, with its progress as it was, so marked not done it's back at 50%.
    await synced(page);
    if (!(await apiTask()).done) throw new Error('100% never marked it done');
    if (Math.round((await apiTask()).percent_done * 100) !== 50) throw new Error('done saved percent_done ' + (await apiTask()).percent_done);
    await page.click(`${row} .line-act`);
    await page.waitForSelector(`${row}:not(.lined)`, { timeout: 15000 });
    await synced(page);
    const t = await apiTask();
    if (t.done || Math.round(t.percent_done * 100) !== 50) throw new Error(`after undo: done ${t.done}, percent_done ${t.percent_done}`);
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
    const meta = await page.$$eval(`${row} .meta > span[aria-label]`, els => els.map(e => e.getAttribute('aria-label') + '=' + e.textContent.trim()));
    for (const want of ['Priority: High=', 'Comments=1', 'Attachments=1']) if (!meta.includes(want)) throw new Error('row shows ' + JSON.stringify(meta));
    await page.click(`.row .body:has-text("${title}")`);                 // back into the task, for the steps below
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
  await step('set-priority', async () => {
    const titleBox = await page.$('#d-title');
    await page.selectOption('#d-prio', '1');
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    if (!await titleBox.evaluate(el => el.isConnected)) throw new Error('saving rebuilt the sheet');
    const shown = await page.textContent('.prio-pick');
    if (await page.inputValue('#d-prio') !== '1' || !shown.includes('Low')) throw new Error('priority shows ' + shown.trim());
  });
  await page.screenshot({ path: `${OUT}/sheet.png` });
  await step('save-keeps-changes-made-elsewhere', async () => {
    // Notes edited on the web while the sheet is open, then the priority changed in Pocket: both must stick.
    const t = await apiTask();
    const r = await api('/tasks/' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...t, description: '<p>edited on the web</p>' }) });
    if (!r.ok) throw new Error('could not edit the notes: HTTP ' + r.status);
    await page.waitForSelector('#d-saved:not(:text("Saved"))', { timeout: 5000 });
    await page.selectOption('#d-prio', '2');
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    const after = await apiTask();
    if (!after.description.includes('edited on the web') || after.priority !== 2) throw new Error(`notes ${JSON.stringify(after.description)}, priority ${after.priority}`);
  });
  await step('progress-in-sheet', async () => {
    const savedPct = async want => {
      await synced(page);
      const got = Math.round((await apiTask()).percent_done * 100);
      if (got !== want) throw new Error(`saved ${got}%, not ${want}%`);
    };
    if (await page.getAttribute('#d-progress', 'aria-valuenow') !== '50') throw new Error('sheet shows ' + await page.getAttribute('#d-progress', 'aria-valuenow'));
    await page.locator('#d-progress').scrollIntoViewIfNeeded();
    const bar = await page.locator('#d-progress .track').boundingBox();
    await page.mouse.move(bar.x + 20, bar.y + bar.height / 2);              // hold the bar, then slide to the next snap
    await page.mouse.down();
    await page.waitForSelector('.d-head.setting', { timeout: 2000 });
    await page.mouse.move(bar.x + 20 + slideBy(bar.x + 20, 50, 75), bar.y + bar.height / 2, { steps: 6 });
    if (await page.getAttribute('.d-head', 'data-pct') !== '75%') throw new Error('showed ' + await page.getAttribute('.d-head', 'data-pct') + ' while sliding');
    await page.mouse.up();
    await savedPct(75);
    await page.focus('#d-progress');                                          // and back a snap with the arrow key
    await page.keyboard.press('ArrowLeft');
    await savedPct(50);
  });
  await step('attach-from-sheet', async () => {
    const before = (await apiTask()).attachments?.length || 0;
    await page.setInputFiles('#d-file', { name: 'smoke-note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await page.waitForSelector('#d-attachments button.att:has-text("smoke-note.txt")', { timeout: 10000 });   // uploaded, not "Uploading…"
    const after = (await apiTask()).attachments?.length || 0;
    if (after !== before + 1) throw new Error(`Vikunja has ${after} attachments, not ${before + 1}`);
  });
  await step('mark-done', async () => {
    await page.click('#d-done');
    await page.waitForSelector('#d-done.on', { timeout: 10000 });
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
    // A task added today without a date stays on Today until it gets one; of a pasted list, only the parent shows.
    const t = `Pocket smoke undated ${stamp}`, sub = `Pocket smoke undated sub ${stamp}`;
    const noDate = 'div:has(> .sec:has-text("Added today, no date"))';
    await page.fill('#in-capture', `${t}\n- ${sub}`);
    await page.click('#cap-nest');
    await page.click('#f-capture .go');
    await page.waitForSelector(`${noDate} .row .title:has-text("${t}")`, { timeout: 15000 });
    if (await page.isVisible(`.row .title:has-text("${sub}")`)) throw new Error('the subtask is shown in Today');
    await page.click(`.row .body:has-text("${t}")`);
    await page.waitForSelector('#d-comments .comment-form', { timeout: 10000 });
    const d = new Date(Date.now() + 86400000), p = n => String(n).padStart(2, '0');
    await page.fill('#d-due', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00`);
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector(`div:has(> .sec:has-text("Next 7 days")) .row .title:has-text("${t}")`, { timeout: 15000 });
    if (await page.isVisible(`${noDate} .row .title:has-text("${t}")`)) throw new Error('still under Added today, no date');
  });
  const parentTitle = `Pocket smoke list ${stamp}`;
  await step('paste-list-with-parent', async () => {
    // Pasted from an email or note: bullets and checkboxes are stripped, the first line becomes the parent.
    await page.fill('#in-capture', `${parentTitle} tomorrow\n- Pocket smoke sub A ${stamp}\n• [ ] Pocket smoke sub B ${stamp}`);
    if (!(await page.textContent('#cap-chips')).includes('3 tasks')) throw new Error('chips: ' + await page.textContent('#cap-chips'));
    await page.click('#cap-nest');
    if (!(await page.textContent('#cap-chips')).includes('1 task + 2 subtasks')) throw new Error('chips: ' + await page.textContent('#cap-chips'));
    await page.click('#f-capture .go');
    await page.waitForSelector(`.row.fresh .title:has-text("${parentTitle}")`, { timeout: 15000 });
    await noToast(page);
  });
  await step('subtasks-in-sheet', async () => {
    await page.click(`.row .body:has-text("${parentTitle}")`);
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
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    for (let i = 0; JSON.stringify(await people()) !== JSON.stringify([me.id]); i++) { if (i > 40) throw new Error('never assigned'); await new Promise(r => setTimeout(r, 250)); }
    // Shown again when the sheet is opened again: Vikunja leaves a task's subtasks' assignees out, so Pocket asks.
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click(`.row .body:has-text("${parentTitle}")`);
    await page.waitForSelector(`${row} .claim.mine .av`, { timeout: 10000 });
    if (!(await page.getAttribute(`${row} .claim`, 'aria-label')).startsWith("You're doing")) throw new Error('says ' + await page.getAttribute(`${row} .claim`, 'aria-label'));
    await page.click(`${row} .claim`);
    await page.waitForSelector(`${row} .claim .me`);
    for (let i = 0; (await people()).length; i++) { if (i > 40) throw new Error('never let go'); await new Promise(r => setTimeout(r, 250)); }
  });
  await step('subtask-links-to-parent', async () => {
    await page.click('#d-subtasks .row:first-of-type .body');
    await page.waitForSelector(`#d-parent:has-text("${parentTitle}")`, { timeout: 10000 });
    await page.click('#d-parent');
    await page.waitForFunction(t => document.querySelector('#d-title')?.value === t, parentTitle, { timeout: 10000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  await step('subtasks-under-parent-in-list', async () => {
    // In the project's list, the two still open come straight after their parent, indented.
    const parent = ((await (await api('/tasks?q=' + encodeURIComponent(parentTitle))).json()).items || []).find(x => x.title === parentTitle);
    await page.evaluate(id => { location.hash = '#/project/' + id; }, parent.project_id);
    const rows = `.list .row:has(.title:has-text("${parentTitle}"))`;
    await page.waitForSelector(rows, { timeout: 15000 });
    const after = await page.$eval(rows, el => [el.nextElementSibling, el.nextElementSibling?.nextElementSibling]
      .map(r => r && { sub: r.classList.contains('sub'), title: r.querySelector('.title').textContent, left: r.querySelector('.check').getBoundingClientRect().left - el.querySelector('.check').getBoundingClientRect().left }));
    if (!after.every(r => r?.sub && r.title.includes(`sub`) && r.title.includes(stamp) && r.left > 20)) throw new Error('rows after the parent: ' + JSON.stringify(after));
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.waitForSelector(`div:has(> .sec:has-text("Next 7 days")) .row .title:has-text("${parentTitle}")`, { timeout: 15000 });
  });
  await step('done-closes-its-subtasks', async () => {
    // Ticking a parent ticks its open subtasks too; Undo opens them all again, and not the one done before.
    const parent = ((await (await api('/tasks?q=' + encodeURIComponent(parentTitle))).json()).items || []).find(x => x.title === parentTitle);
    const subs = async () => (await (await api('/tasks/' + parent.id)).json()).related_tasks?.subtask || [];
    const open = (await subs()).filter(s => !s.done).map(s => s.id);
    if (open.length !== 3) throw new Error('open subtasks before: ' + open.length);
    const parentRow = `.row:has(> .body .title:has-text("${parentTitle}"))`;
    await page.click(`${parentRow} > .check`);
    await expect(page.locator(`${parentRow}.lined .row-line`)).toContainText(`Closed ${parentTitle} + 3 subtasks`, { timeout: 20000 });
    if ((await subs()).some(s => !s.done)) throw new Error('a subtask is still open');
    await page.click(`${parentRow} .line-act`);
    await synced(page);
    const after = await subs();
    if (JSON.stringify(after.filter(s => !s.done).map(s => s.id).sort()) !== JSON.stringify([...open].sort())) throw new Error('open after undo: ' + JSON.stringify(after.map(s => [s.title, s.done])));
    if ((await (await api('/tasks/' + parent.id)).json()).done) throw new Error('the parent is still done');
    // The same from its sheet, whose subtasks show as done straight away.
    await page.click(`.row .body:has-text("${parentTitle}")`);
    await page.waitForSelector('#d-subcount:text("1/4")', { timeout: 10000 });
    await page.click('#d-done');
    await placeSays(page, 'sheet:subtasks', `Closed ${parentTitle} + 3 subtasks`);
    await page.waitForSelector('#d-subcount:text("4/4")', { timeout: 5000 });
    await placeLine(page, 'sheet:subtasks').getByRole('button', { name: 'Undo' }).click();
    await page.waitForSelector('#d-subcount:text("1/4")', { timeout: 15000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
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
    await expect(page.locator('#d-title')).toHaveValue(far);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.evaluate(() => document.activeElement?.blur());
  });

  await step('two-ticks-each-keep-their-undo', async () => {
    const a = await make(`Pocket smoke tick A ${stamp}`, { due_date: todayAt(23) }), b = await make(`Pocket smoke tick B ${stamp}`, { due_date: todayAt(23) });
    const A = rowOf(a.title), B = rowOf(b.title);
    await toastGone();
    await refreshToday();
    await tick(a.title);
    await expect(page.locator(A)).toHaveClass(/lined/);
    await tick(b.title);
    await expect(page.locator(B)).toHaveClass(/lined/);
    // Each its own line: A's Undo opens A only.
    await page.locator(A).getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator(A)).not.toHaveClass(/lined/);
    await synced(page);
    if ((await get(a.id)).done || !(await get(b.id)).done) throw new Error(`after A's Undo: A done ${(await get(a.id)).done}, B done ${(await get(b.id)).done}`);
    // B's folds away once its time is up.
    await later(5000);
    await page.waitForSelector(B, { state: 'detached', timeout: 5000 });
    if (!await page.$(`${A}:not(.lined)`)) throw new Error('A went too');
  });

  /* Every row has who's doing it at its end, as a subtask in a sheet does; a subtask's tick shows on its row, which stays;
     a row swiped left shows its Delete, which deletes with an Undo, and only once the Undo has gone. */
  const swipe = async (sel, from = 200, by = -100) => {
    await page.locator(sel).scrollIntoViewIfNeeded();                       // once a sheet has slid in
    await page.$eval(sel, el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));    // and clear of the header
    await page.waitForTimeout(100);
    const box = await page.locator(sel).boundingBox(), y = box.y + box.height / 2;
    await page.mouse.move(from, y); await page.mouse.down();
    await page.mouse.move(from + by, y + 4, { steps: 8 });
    await page.mouse.up();
  };
  // Its Delete, once the row has moved aside for it: tapped where it is, as a finger would.
  const tapDelete = async sel => {
    await page.waitForSelector(`${sel}.swiped > .row-del`);
    await page.waitForTimeout(300);
    const b = await page.locator(`${sel} > .row-del`).boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  await step('a-rows-slot-tick-and-swipe-to-delete', async () => {
    const me = await (await api('/user')).json();
    const p = await make(`Pocket smoke row parent ${stamp}`, { due_date: todayAt(23) }), k = await make(`Pocket smoke row kid ${stamp}`, { due_date: todayAt(23) });
    await api(`/tasks/${p.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }) });
    const people = async id => ((await get(id)).assignees || []).map(u => u.id), P = rowOf(p.title), K = rowOf(k.title);
    try {
      await toastGone();
      await refreshToday();
      await page.waitForSelector(`${K}.sub`, { timeout: 15000 });
      // Claimed from its row, and let go again.
      const claim = page.getByRole('button', { name: `Tap to say you'll do ${p.title}` }), mine = page.getByRole('button', { name: `You're doing ${p.title}. Tap to let it go` });
      await claim.click();
      await expect(mine.locator('.av')).toBeVisible();
      await synced(page);
      if (JSON.stringify(await people(p.id)) !== JSON.stringify([me.id])) throw new Error('never assigned');
      await mine.click();
      await expect(claim).toBeVisible();
      await synced(page);
      if ((await people(p.id)).length) throw new Error('never let go');
      // A subtask ticked: no message, and its row stays, done, to tick back.
      await toastGone();
      await tick(k.title);
      await expect(page.locator(K)).toHaveClass(/\bdone\b/);
      await synced(page);
      if (!(await get(k.id)).done) throw new Error('never done');
      await later(900);                                                      // when a row would have slid away
      await expect(page.locator(K)).toHaveClass(/\bdone\b/);
      if (await page.$('#toast.show')) throw new Error('a subtask\'s tick said: ' + await page.textContent('#toast-msg'));
      await page.getByRole('button', { name: 'Mark not done: ' + k.title, exact: true }).click();
      await expect(page.locator(K)).not.toHaveClass(/\bdone\b/);
      // Not from the screen's edge, where the phone's Back starts; tapped elsewhere, an open row shuts.
      await swipe(K, 370);
      if (await page.$(`${K}.swiped`)) throw new Error('a swipe from the edge opened the row');
      await swipe(P);
      await page.waitForSelector(`${P}.swiped > .row-del`);
      await page.click('#view .sec .n >> nth=0');                              // anything else, tapped
      await page.waitForSelector(`${P}.swiped`, { state: 'detached' });
      if (await page.isVisible('#sheet')) throw new Error('shutting the row opened a task');
      // Delete: a line in its place at once, with its Undo, and nothing sent until it folds.
      await swipe(K);
      await tapDelete(K);
      await expect(page.locator(`${K}.lined .row-line`)).toContainText('Deleted');
      if (await page.$('#toast.show')) throw new Error('deleting said: ' + await page.textContent('#toast-msg'));
      await page.locator(K).getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator(K)).not.toHaveClass(/lined/);
      await synced(page);
      if (!await get(k.id)) throw new Error('Undo didn\'t keep it');
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
      if (await page.$(`${K}.lined`)) throw new Error('backed off, it was deleted');
      // Carried on from there past half, and let go: deleted, for good once its line has folded.
      await page.mouse.move(250, ky); await page.mouse.down();
      await page.mouse.move(90, ky + 3, { steps: 10 });
      await page.mouse.up();
      await page.waitForSelector(`${K}.lined .row-line:has-text("Deleted")`);
      if (!await get(k.id)) throw new Error('deleted while its Undo showed');
      await later(5000);
      await expect(page.locator(K)).toHaveCount(0);
      await synced(page);
      if (await get(k.id)) throw new Error('never deleted');
      if (await page.$(K)) throw new Error('the row came back');
    } finally {
      for (const t of [k, p]) await api('/tasks/' + t.id, { method: 'DELETE' });
    }
  });
  await step('a-subtask-swiped-in-its-sheet-deletes-with-an-undo', async () => {
    const p = await make(`Pocket smoke sheet parent ${stamp}`, { due_date: todayAt(23) }), k = await make(`Pocket smoke sheet kid ${stamp}`);
    await api(`/tasks/${p.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: k.id, relation_kind: 'subtask' }) });
    const K = `#d-subtasks > .row:has(.title:text-is("${k.title}"))`;
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(p.title)} > .body`, { timeout: 15000 });
      await page.waitForSelector(K, { timeout: 10000 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet')).transform === 'none', null, { timeout: 5000 });   // slid in
      await swipe(K);
      await tapDelete(K);
      await page.waitForSelector(`${K}.lined`);
      if (!await page.isVisible('#sheet')) throw new Error('the sheet closed');
      await page.click(`${K} .line-act`);
      await page.waitForSelector(`${K}:not(.lined)`);
      if (!await get(k.id)) throw new Error('Undo didn\'t keep it');
      // Its ⋯ deletes the task, with its subtask, after asking: the line is in its row's place in the list.
      await page.click('#d-more');
      await page.click('#d-delete');
      await page.waitForSelector('#sheet', { state: 'hidden' });
      await page.waitForSelector(`${rowOf(p.title)}.lined .row-line:has-text("+ 1 subtask")`);
      await later(5000);
      await expect(page.locator(rowOf(p.title))).toHaveCount(0);
      await synced(page);
      if (await get(k.id) || await get(p.id)) throw new Error('never deleted');
    } finally {
      if (await page.isVisible('#sheet')) await page.click('#btn-sheet-close');
      for (const t of [k, p]) await api('/tasks/' + t.id, { method: 'DELETE' });
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
      await page.reload(); await page.waitForSelector('#view .loading', { state: 'detached', timeout: 15000 });
      await page.fill('#in-capture', `${t} at 4pm`);
      await page.waitForSelector('#cap-chips .chip[data-kind=due]');
      if (await page.$('#cap-chips .chip[data-kind=remind]')) throw new Error('a 🔔 chip with your reminder emails off');
      await setReminders(true);
      await page.fill('#in-capture', '');
      await page.reload(); await page.waitForSelector('#view .loading', { state: 'detached', timeout: 15000 });
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
    // A line where it was, with its Undo, as in a list; when it folds, the task is under Done.
    await page.click(`${open} > .check`);
    await expect(page.locator(`${open}.lined .row-line`)).toContainText('Done:');
    await noToast(page);
    await later(5000);
    await page.waitForSelector(done, { timeout: 10000 });
    await page.click(`${done} > .check`);                                   // and back
    await expect(page.locator(`${done}.lined .row-line`)).toContainText('Not done:');
    await later(5000);
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

  await step('repeating-tick-can-be-undone', async () => {
    // Its dates and its reminder at a set time, which moved on with it, go back too.
    const r = await make(`Pocket smoke repeat undo ${stamp}`, { due_date: todayAt(9), repeat_after: 86400, reminders: [{ reminder: todayAt(8) }] });
    await toastGone();
    await refreshToday();
    await page.click(`${rowOf(r.title)} > .check`, { timeout: 15000 });
    // On its row, which stays, with its next date.
    await rowLine(page, 'Repeats · next').getByRole('button', { name: 'Undo' }).click();
    await noToast(page);
    const want = new Date(r.due_date).getTime();
    await synced(page);
    if (new Date((await get(r.id)).due_date).getTime() !== want) throw new Error('due ' + (await get(r.id)).due_date);
    const rem = (await get(r.id)).reminders?.[0]?.reminder;
    if (new Date(rem).getTime() !== new Date(todayAt(8)).getTime()) throw new Error('reminder at ' + rem);
  });
  await step('a-repeating-subtask-keeps-its-date', async () => {
    // Ticking a parent leaves a subtask that repeats as it is: marked done, it would only move to its next date.
    const parent = await make(`Pocket smoke parent of a repeat ${stamp}`), sub = await make(`Pocket smoke weekly subtask ${stamp}`, { due_date: todayAt(9), repeat_after: 604800 });
    try {
      await api(`/tasks/${parent.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: sub.id, relation_kind: 'subtask' }) });
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(parent.title)} > .check`, { timeout: 15000 });
      await page.waitForSelector(`${rowOf(parent.title)}.lined`, { timeout: 20000 });
      const s = await get(sub.id);
      if (s.done || new Date(s.due_date).getTime() !== new Date(sub.due_date).getTime()) throw new Error(`subtask done ${s.done}, due ${s.due_date}`);
    } finally { for (const id of [sub.id, parent.id]) await api('/tasks/' + id, { method: 'DELETE' }); }
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
      await expect(rowLine(page, 'Repeats · next')).toBeVisible({ timeout: 20000 });
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
      await expect(rowLine(page, 'Done:')).toContainText(r.title);
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
    await page.click(`${rowOf(parent.title)} > .body`, { timeout: 15000 });
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
  // The rows on the project's open list, by title, its subtasks marked "Subtask: " as a screen reader hears them.
  const openRows = () => page.locator('#view .list').first().locator('.row > .body .title');
  // Hold a row, move it past the first few pixels (so it's a move, not progress), then to the top or the bottom of the
  // row `to`, and let go.
  async function dragTo(sel, to, edge = 'top'){
    await page.locator(sel).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));   // clear of the edges, where it scrolls
    const box = await steady(page.locator(sel)), x = box.x + box.width / 2, y0 = box.y + box.height / 2;
    const b = await page.locator(to).boundingBox(), y = edge === 'top' ? b.y + 4 : b.y + b.height - 4;
    await page.mouse.move(x, y0); await page.mouse.down();
    await expect(page.locator(sel)).toHaveClass(/held/);
    await page.mouse.move(x, y0 + Math.sign(y - y0) * 14, { steps: 3 });
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.up();
  }
  const rowById = id => `#view .row[data-id="${id}"]`;
  await step('project-in-list-view-order', async () => {
    order.project = await (await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ title: `PocketSmokeOrder${stamp}` }) })).json();
    createdProjects.push(order.project.id);
    order.view = order.project.views.filter(v => v.view_kind === 'list').sort((a, b) => a.position - b.position || a.id - b.id)[0].id;
    const mk = async (name, extra = {}) => order.tasks[name] = await (await api(`/projects/${order.project.id}/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title: `${name} ${stamp}`, ...extra }) })).json();
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'sub one', 'sub two', 'sub three']) await mk(name);
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
    await expect(openRows()).toHaveText(want);
    // Vikunja's own order, the same.
    const roots = (await viewOrder()).filter(t => !t.done && !t.related_tasks?.parenttask?.length).map(t => t.title);
    if (JSON.stringify(roots) !== JSON.stringify(['Bravo', 'Alpha', 'Charlie'].map(n => `${n} ${stamp}`))) throw new Error('Vikunja has ' + roots);
    // Its done task is in the Done section, folded, with how many.
    await expect(page.getByRole('button', { name: 'Done (1)' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#view .row', { hasText: `Delta ${stamp}` })).toHaveCount(0);
  });
  await step('drag-a-task-and-a-subtask', async () => {
    const T = order.tasks;
    // Bravo, from the top to the bottom: under Charlie, past Alpha and its subtasks, which go with Alpha.
    await dragTo(rowById(T.Bravo.id), rowById(T.Charlie.id), 'bottom');
    await expect(openRows()).toHaveText(['Alpha', 'Subtask: sub three', 'Subtask: sub one', 'Subtask: sub two', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
    await synced(page);
    const pos = async () => Object.fromEntries((await viewOrder()).map(t => [t.title.replace(` ${stamp}`, ''), t.position]));
    let p = await pos();
    if (!(p.Alpha < p.Charlie && p.Charlie < p.Bravo)) throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    // A subtask, among its parent's subtasks only: sub two to the top of them.
    await dragTo(rowById(T['sub two'].id), rowById(T['sub three'].id));
    await expect(openRows()).toHaveText(['Alpha', 'Subtask: sub two', 'Subtask: sub three', 'Subtask: sub one', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
    await synced(page);
    p = await pos();
    if (!(p['sub two'] < p['sub three'] && p['sub three'] < p['sub one'])) throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    // Read again, the same; and in Alpha's sheet, its subtasks in that order too.
    await page.reload();
    await expect(openRows()).toHaveText(['Alpha', 'Subtask: sub two', 'Subtask: sub three', 'Subtask: sub one', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`), { timeout: 15000 });
    await page.click(`${rowById(T.Alpha.id)} > .body`);
    await expect(page.locator('#d-subtasks .row .title')).toHaveText(['sub two', 'sub three', 'sub one'].map(n => `${n} ${stamp}`));
    // In the sheet, moved the same way: sub one to the top, written to Vikunja's List view too.
    await dragTo(`#d-subtasks .row[data-id="${T['sub one'].id}"]`, `#d-subtasks .row[data-id="${T['sub two'].id}"]`);
    await expect(page.locator('#d-subtasks .row .title')).toHaveText(['sub one', 'sub two', 'sub three'].map(n => `${n} ${stamp}`));
    await synced(page);
    p = await pos();
    if (!(p['sub one'] < p['sub two'] && p['sub two'] < p['sub three'])) throw new Error('positions in Vikunja: ' + JSON.stringify(p));
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(openRows()).toHaveText(['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
  });
  await step('a-move-turned-down-goes-back-and-says-why', async () => {
    // Vikunja turns it down, as for an API token without Tasks → Position: back where it was, its row saying so.
    const T = order.tasks, refuse = r => r.request().method() === 'PUT' ? r.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"missing permission"}' }) : r.fallback();
    await page.route('**/api/v2/tasks/*/position', refuse);
    await dragTo(rowById(T.Charlie.id), rowById(T.Bravo.id), 'bottom');
    await expect(rowLine(page, 'Not moved: your API token doesn\'t allow reordering. Make one with Position ticked under Tasks.')).toBeVisible();
    await page.unroute('**/api/v2/tasks/*/position', refuse);
    await later(5000);                                                     // its line folds, giving the row back
    await expect(openRows()).toHaveText(['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Charlie', 'Bravo'].map(n => `${n} ${stamp}`));
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
    await expect(openRows()).toHaveText(['Alpha', 'Subtask: sub one', 'Subtask: sub two', 'Subtask: sub three', 'Bravo', 'Charlie'].map(n => `${n} ${stamp}`));
    await page.focus(`${rowById(T['sub one'].id)} > .body`);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(openRows()).toHaveText(['Alpha', 'Subtask: sub two', 'Subtask: sub one', 'Subtask: sub three', 'Bravo', 'Charlie'].map(n => `${n} ${stamp}`));
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
    await expect(rowLine(page, 'Not done:')).toBeVisible();
    await later(5000);
    await expect(page.locator('#view .list').first().locator(`.row[data-id="${T.Delta.id}"]`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /^Done/ })).toHaveCount(0);           // nothing done any more
    await synced(page);
    if ((await (await api('/tasks/' + T.Delta.id)).json()).done) throw new Error('still done in Vikunja');
    // Ticked done again: off the open list, and counted in Done.
    await page.getByRole('button', { name: `Mark done: Delta ${stamp}` }).click();
    await later(5000);
    await expect(page.getByRole('button', { name: 'Done (1)' })).toBeVisible();
  });
  /* A parent ticked closes its open subtasks with it, and says so: "Closed Echo + 2 subtasks". Its Undo opens those two
     again, and not the one done before. */
  const openList = () => page.locator('#view .list').first();
  const doneIn = async (...names) => Promise.all(names.map(async n => (await (await api('/tasks/' + order.tasks[n].id)).json()).done));
  await step('a-parent-ticked-closes-its-open-subtasks-and-undo-opens-only-those', async () => {
    const T = order.tasks, mk = async (name, extra = {}) => T[name] = await (await api(`/projects/${order.project.id}/tasks`, { method: 'POST', headers: json, body: JSON.stringify({ title: `${name} ${stamp}`, ...extra }) })).json();
    await mk('Echo');
    for (const s of ['echo one', 'echo two']) await mk(s);
    await mk('echo done', { done: true });
    for (const s of ['echo one', 'echo two', 'echo done']) await api(`/tasks/${T.Echo.id}/relations`, { method: 'POST', headers: json, body: JSON.stringify({ other_task_id: T[s].id, relation_kind: 'subtask' }) });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await expect(page.locator(rowById(T['echo two'].id))).toBeVisible();
    await openList().getByRole('button', { name: `Mark done: Echo ${stamp}`, exact: true }).click();
    const line = rowLine(page, `Echo ${stamp}`);
    await expect(line).toContainText(`Closed Echo ${stamp} + 2 subtasks`);
    await expect(page.locator('#said')).toContainText(`Closed Echo ${stamp} + 2 subtasks`);
    await synced(page);
    if (JSON.stringify(await doneIn('Echo', 'echo one', 'echo two')) !== '[true,true,true]') throw new Error('not all closed in Vikunja');
    await line.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator(rowById(T['echo one'].id))).toBeVisible();
    await synced(page);
    const now = await doneIn('Echo', 'echo one', 'echo two', 'echo done');
    if (JSON.stringify(now) !== '[false,false,false,true]') throw new Error('after Undo, done: ' + now);
  });
  /* A parent done with subtasks still open (ticked done on the web, which leaves them): struck through over them, not
     left out with them on their own at the top. It can't be moved, nor be what the add box adds to; tapped, its sheet
     opens; its tick opens it again, where it is. */
  await step('a-done-parent-shows-over-its-open-subtasks', async () => {
    const T = order.tasks, head = page.locator(rowById(T.Echo.id)).first();
    await api('/tasks/' + T.Echo.id, { method: 'PATCH', headers: json, body: JSON.stringify({ done: true }) });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await expect(head).toHaveClass(/head/);
    await expect(head).toHaveClass(/done/);
    await expect(head.locator('.meta')).toContainText('Done, but 2 subtasks are still open');
    const rows = await openList().locator('.row > .body .title').allTextContents(), at = rows.indexOf(`Echo ${stamp}`);
    if (at < 0 || !rows.slice(at + 1, at + 3).every(r => /^Subtask: echo (one|two) /.test(r))) throw new Error('rows: ' + JSON.stringify(rows));
    if (rows.some(r => /^echo/.test(r))) throw new Error('a subtask on its own at the top: ' + JSON.stringify(rows));
    // Held, it isn't lifted to be moved; Alt+↓ leaves it where it is.
    await head.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await steady(head);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await later(800);
    await expect(head).not.toHaveClass(/held/);
    await page.mouse.up();                                                      // a tap, then: its sheet
    await expect(page.locator('#d-done.on')).toBeVisible();
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await expect(page.locator('#cap-target')).toHaveCount(0);                   // the add box adds a task, not to it
    await head.locator(':scope > .body').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(openList().locator('.row > .body .title')).toHaveText(rows);
    // Its tick opens it again, where it is, with its subtasks under it, and out of Done.
    const count = +(await page.getByRole('button', { name: /^Done \(/ }).textContent()).match(/\d+/)[0];
    await openList().getByRole('button', { name: `Mark not done: Echo ${stamp}`, exact: true }).click();
    await expect(rowLine(page, 'Not done:')).toContainText(`Echo ${stamp}`);
    await later(5000);
    await expect(head).not.toHaveClass(/done/);
    await expect(openList().locator('.row > .body .title')).toHaveText(rows);
    await expect(page.getByRole('button', { name: `Done (${count - 1})` })).toBeVisible();
    await synced(page);
    if (JSON.stringify(await doneIn('Echo', 'echo one', 'echo two')) !== '[false,false,false]') throw new Error('done in Vikunja: ' + await doneIn('Echo', 'echo one', 'echo two'));
  });

  /* On a project's list, quick add's box adds a task to the project, until a task is touched (its sheet opened, ticked):
     then it adds subtasks to that task, after its last, or after the subtask touched, each after the one before. */
  const foot = { project: null, view: null, tasks: {} };
  const footRows = () => page.locator('#view .list').first().locator('.row > .body .title');
  const footName = n => `${n} ${stamp}`;
  const box = page.locator('#in-capture'), target = page.locator('#cap-target');
  const footPositions = async () => Object.fromEntries((await (await api(`/projects/${foot.project.id}/views/${foot.view}/tasks?expand=subtasks`)).json()).items
    .map(t => [t.title.replace(` ${stamp}`, ''), t])); // by name: {position, related_tasks}
  const openAndClose = async id => {
    await page.click(`${rowById(id)} > .body`);
    await page.waitForSelector('#d-title');
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
    await expect(footRows()).toHaveText(['Van', 'Subtask: Chairs', 'Subtask: Tables', 'Lights'].map(footName), { timeout: 15000 });
    // Nothing touched yet: a task for the project.
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
    await expect(target).toHaveCount(0);
    // Its sheet opened and closed: the box names it, and its row is lit up.
    await openAndClose(T.Van.id);
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}`);
    await expect(page.locator(rowById(T.Van.id))).toHaveClass(/aimed/);
    await expect(page.getByRole('textbox', { name: `New subtask of ${footName('Van')}` })).toBeVisible();
    await expect(page.locator('#said')).toHaveText(`Add a subtask to ${footName('Van')}`);
    // Two typed with Enter: the box keeps the focus, and they go after its last subtask, in the order typed.
    await box.click();
    await box.fill(footName('Rope'));
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await box.fill(footName('Straps'));
    await box.press('Enter');
    await expect(footRows()).toHaveText(['Van', 'Subtask: Chairs', 'Subtask: Tables', 'Subtask: Rope', 'Subtask: Straps', 'Lights'].map(footName));
    if (await page.evaluate(() => document.activeElement?.id) !== 'in-capture') throw new Error('the box lost the focus');
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}, after ${footName('Straps')}`);
    await noToast(page);
    await synced(page);
    const p = await footPositions();
    for (const s of ['Rope', 'Straps']) if (!p[s].related_tasks?.parenttask?.some(x => x.id === T.Van.id)) throw new Error(s + ' is not under Van');
    if (!(p.Tables.position < p.Rope.position && p.Rope.position < p.Straps.position)) throw new Error('positions: ' + ['Tables', 'Rope', 'Straps'].map(s => p[s].position));
    foot.tasks.Rope = p.Rope; foot.tasks.Straps = p.Straps;
    await page.reload();
    await expect(footRows()).toHaveText(['Van', 'Subtask: Chairs', 'Subtask: Tables', 'Subtask: Rope', 'Subtask: Straps', 'Lights'].map(footName), { timeout: 15000 });
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
    await expect(footRows()).toHaveText(want);
    await synced(page);
    const p = await footPositions(), tarp = Object.keys(p).find(k => k.startsWith('Tarp'));
    const order = ['Chairs', 'Ladder', 'Hooks', tarp, 'Tables'].map(s => p[s].position);
    if (order.some((x, i) => i && x <= order[i - 1])) throw new Error('positions: ' + order);
    if (p[tarp].project_id !== foot.project.id) throw new Error('the subtask went to another project');
    await page.reload();
    await expect(footRows()).toHaveCount(want.length, { timeout: 15000 });
    await expect(footRows().nth(4)).toHaveText(`Subtask: Tarp ${stamp} +Elsewhere`);
  });
  await step('the-add-boxs-x-goes-back-to-adding-a-task', async () => {
    const T = foot.tasks;
    await openAndClose(T.Van.id);
    const x = page.getByRole('button', { name: `Add a task to PocketSmokeFoot${stamp} instead` });
    const size = await x.boundingBox();
    if (size.width < 48 || size.height < 48) throw new Error('× is ' + size.width + '×' + size.height);
    await x.click();
    await expect(target).toHaveCount(0);
    await expect(page.locator(rowById(T.Van.id))).not.toHaveClass(/aimed/);
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
    await box.fill(footName('Fuel'));
    await box.press('Enter');
    await expect(footRows().first()).toHaveText(footName('Fuel'));            // a task of its own, first, where Vikunja puts it
    await synced(page);
    const p = await footPositions();
    if (p.Fuel?.related_tasks?.parenttask?.length) throw new Error('Fuel was added as a subtask');
  });
  await step('a-tick-moves-what-the-add-box-adds-to', async () => {
    const T = foot.tasks;
    // A subtask ticked done: its parent, to add more beside it. Ticked open again: the subtask itself.
    await page.getByRole('button', { name: 'Mark done: ' + footName('Rope'), exact: true }).click();
    await expect(target).toHaveText(`Add a subtask to ${footName('Van')}`);
    await expect(page.locator(rowById(T.Van.id))).toHaveClass(/aimed/);
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
    await expect(footRows().first()).toBeVisible({ timeout: 15000 });
    await expect(target).toHaveCount(0);
    await expect(box).toHaveAttribute('placeholder', `Add a task to PocketSmokeFoot${stamp}`);
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
    await page.click(`${rowById(van.id)} .body`, { timeout: 15000 });
    await expect(page.locator('#d-subtasks .row .title')).toHaveText(['Load chairs', 'Tables', 'Sound system', 'Lights']);
    await expect(page.locator('#d-subtasks').getByRole('button', { name: 'You\'re doing Sound system. Tap to let it go' })).toBeVisible();
    await expect(page.locator('#d-comments .comment')).toHaveCount(1);

    // Through the phone's share sheet: plain text, with the task's name as its title.
    const text = [`Pack the van ${stamp}  ▰▰▰▱▱ 60%`, '✓ Load chairs', '◐ Tables 50%', `○ Sound system · ${my}`, '○ Lights'].join('\n');
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
    await expect.poll(clip).toBe([`## Pack the van ${stamp} (60%)`, '', '- [x] Load chairs', '- [ ] Tables (50%)', `- [ ] Sound system @${me.username}`, '- [ ] Lights'].join('\n'));
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
    await expect.poll(() => page.evaluate(() => window.shared[0]?.text)).toBe([`PocketSmokeShare${stamp}  5 open · 1 done`, `◐ Pack the van ${stamp}  ▰▰▰▱▱ 60%`, '  ◐ Tables 50%',
      `  ○ Sound system · ${my}`, '  ○ Lights', `○ Order milk ${stamp}`, '✓ 1 done'].join('\n'));
    await page.click('#p-copy-md');
    await placeSays(page, 'sheet:top', 'Copied as a Markdown list');
    await expect.poll(clip).toBe([`# PocketSmokeShare${stamp}`, '', '5 open · 1 done', '', `- [ ] Pack the van ${stamp} (60%)`, '  - [ ] Tables (50%)',
      `  - [ ] Sound system @${me.username}`, '  - [ ] Lights', `- [ ] Order milk ${stamp}`].join('\n'));
    await expect(page.locator('#p-open-vikunja')).toHaveAttribute('href', `${SERVER}/projects/${proj.id}`);
    await page.click('#btn-sheet-close');
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
