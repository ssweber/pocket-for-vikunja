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

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const ASSIGNEE = process.env.ASSIGNEE;         // optional: a username to assign; the token needs Other -> Users
const ASSIGNEE_PROJECT = process.env.ASSIGNEE_PROJECT;   // a project shared with ASSIGNEE (default: your default project)
const TOKEN = process.env.VIKUNJA_TOKEN;
const OUT = process.env.OUT || 'test-results';
if (!SERVER || !TOKEN) { console.error('Set VIKUNJA_URL and VIKUNJA_TOKEN'); process.exit(2); }
const APP = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';

const api = (path, init = {}) => fetch(SERVER + '/api/v2' + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, ...init.headers } });

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
// A token without some permission gets 401s, which Pocket handles; the browser still logs them, so they're left out here,
// with the reply a test cuts off on purpose.
page.on('console', m => m.type() === 'error' && !/status of 401|ERR_CONNECTION_RESET/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());

let failed = 0;
async function step(name, fn){
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/fail-${name}.png` }); }
}

const stamp = Date.now();
const title = 'Pocket smoke test ' + stamp;
const label = 'pocket-smoke';
const createdProjects = [];

try {
  await page.goto(APP);
  await step('sign-in-screen', async () => {
    await page.waitForSelector('#auth-step:not([hidden])', { timeout: 10000 });   // no address to enter: it's this Vikunja
  });
  await step('login-token', async () => {
    if (await page.isVisible('.seg button[data-mode=token]')) await page.click('.seg button[data-mode=token]');
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
    await page.click(`${row} .check`);
    await page.waitForSelector(row, { state: 'detached', timeout: 10000 });
    await page.click('#toast-act:has-text("Undo")');
    await page.waitForSelector(row, { timeout: 15000 });
    if (await page.$eval(row, el => el.classList.contains('done'))) throw new Error('row still marked done after undo');
  });
  /* How far right a finger at x slides to go from `from`% to `to`%: the room to the screen's edge is the rest of the way
     to 100%, 48px short of it (holdToSlide's EDGE). */
  const slideBy = (x, from, to) => (page.viewportSize().width - 48 - x) * (to - from) / (100 - from);
  // Hold a row, then slide it sideways from `from`% by `steps` tens of percent, as with a finger.
  async function slideProgress(sel, steps, check, from = 0){
    const box = await page.locator(sel).boundingBox();
    const x = box.x + box.width * .2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForSelector(`${sel}.setting`, { timeout: 2000 });
    await page.mouse.move(x + slideBy(x, from, from + steps * 10), y, { steps: 10 });
    await check?.();
    await page.mouse.up();
  }
  const apiTask = async () => (await (await api('/tasks?q=' + encodeURIComponent(title))).json()).items.find(t => t.title === title);
  await step('progress-hold-and-slide', async () => {
    await slideProgress(row, 4, async () => {
      const shown = await page.getAttribute(row, 'data-pct');
      if (shown !== '40%') throw new Error('showed ' + shown + ' while sliding');
    });
    await page.waitForSelector('#toast-msg:text("Progress set to 40%")', { timeout: 10000 });
    if (await page.isVisible('#sheet')) throw new Error('letting go opened the task');
    const t = await apiTask();
    if (Math.round(t.percent_done * 100) !== 40) throw new Error('saved percent_done ' + t.percent_done);
    // Held in the right tenth of the row, 100% is still within reach before the screen's edge, its percentage on the
    // left, clear of the thumb. Slid back to where it was, nothing changes.
    const box = await page.locator(row).boundingBox(), x = box.x + box.width * .9, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.waitForSelector(`${row}.setting[data-side=left]`, { timeout: 2000 });
    await page.mouse.move(page.viewportSize().width - 4, y, { steps: 8 });
    const shown = await page.getAttribute(row, 'data-pct');
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    if (shown !== '100%') throw new Error('from the right of the row, at most ' + shown);
    if (Math.round((await apiTask()).percent_done * 100) !== 40) throw new Error('slid back, it saved ' + (await apiTask()).percent_done);
  });
  await step('progress-100-marks-done-and-undo', async () => {
    await slideProgress(row, 6, null, 40);                                 // from 40%, to the edge: 100%
    await page.waitForSelector(row, { state: 'detached', timeout: 10000 });
    // Done, with its progress as it was, so marked not done it's back at 40%.
    for (let i = 0; i < 40 && !(await apiTask()).done; i++) await page.waitForTimeout(250);
    if (!(await apiTask()).done) throw new Error('100% never marked it done');
    if (Math.round((await apiTask()).percent_done * 100) !== 40) throw new Error('done saved percent_done ' + (await apiTask()).percent_done);
    await page.click('#toast-act:has-text("Undo")');
    await page.waitForSelector(row, { timeout: 15000 });
    const t = await apiTask();
    if (t.done || Math.round(t.percent_done * 100) !== 40) throw new Error(`after undo: done ${t.done}, percent_done ${t.percent_done}`);
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
    await page.waitForSelector(`.sec.overdue + .list ${lateRow}`, { timeout: 15000 });
    await page.click('#btn-overdue-today');
    await page.waitForSelector(`.sec.today + .list ${lateRow}`, { timeout: 15000 });
    const msg = await page.textContent('#toast-msg');
    if (!/^Moved \d+ tasks? to today\. \d+ repeating tasks? stays?: tick/.test(msg)) throw new Error('toast: ' + msg);
    if (new Date((await (await api('/tasks/' + daily.id)).json()).due_date).getTime() !== due.getTime()) throw new Error('the repeating task was moved');
    await api('/tasks/' + daily.id, { method: 'DELETE' });
    // At 9:00 as it was, or, once 9:00 has gone today, the next whole hour (in the day's last hour, 11:59 PM).
    const now = new Date(), want = new Date(); want.setHours(9, 0, 0, 0);
    const next = new Date(now); next.setHours(now.getHours() + 1, 0, 0, 0);
    if (next.getDate() !== now.getDate()) next.setTime(new Date(now).setHours(23, 59, 0, 0));
    if (want < now) want.setTime(next.getTime());
    const moved = new Date((await (await api('/tasks/' + made.id)).json()).due_date);
    if (moved.getTime() !== want.getTime()) throw new Error('moved to ' + moved);
    await page.click('#toast-act:has-text("Undo")');
    await page.waitForSelector(`.sec.overdue + .list ${lateRow}`, { timeout: 15000 });
    const back = new Date((await (await api('/tasks/' + made.id)).json()).due_date);
    if (back.getTime() !== due.getTime()) throw new Error('undo put it at ' + back);
  });
  await step('search', async () => {
    await page.click('#btn-search');
    if (!await page.evaluate(() => document.activeElement?.id === 'in-search')) throw new Error('the search box isn\'t focused');
    await page.waitForSelector('#capture', { state: 'hidden', timeout: 5000 }).catch(() => { throw new Error('the add box still shows'); });
    await page.fill('#in-search', String(stamp));
    await page.waitForSelector(`#view .sec:has-text("Open") + .list ${row}`, { timeout: 10000 });
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
      for (let i = 0; i < 40 && Math.round((await apiTask()).percent_done * 100) !== want; i++) await page.waitForTimeout(250);
      const got = Math.round((await apiTask()).percent_done * 100);
      if (got !== want) throw new Error(`saved ${got}%, not ${want}%`);
    };
    if (await page.getAttribute('#d-progress', 'aria-valuenow') !== '40') throw new Error('sheet shows ' + await page.getAttribute('#d-progress', 'aria-valuenow'));
    await page.locator('#d-progress').scrollIntoViewIfNeeded();
    const bar = await page.locator('#d-progress .track').boundingBox();
    await page.mouse.move(bar.x + 20, bar.y + bar.height / 2);              // hold the bar, then slide two steps
    await page.mouse.down();
    await page.waitForSelector('.d-head.setting', { timeout: 2000 });
    await page.mouse.move(bar.x + 20 + slideBy(bar.x + 20, 40, 60), bar.y + bar.height / 2, { steps: 6 });
    if (await page.getAttribute('.d-head', 'data-pct') !== '60%') throw new Error('showed ' + await page.getAttribute('.d-head', 'data-pct') + ' while sliding');
    await page.mouse.up();
    await savedPct(60);
    await page.focus('#d-progress');                                          // and one more with the arrow key
    await page.keyboard.press('ArrowRight');
    await savedPct(70);
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
    await page.waitForSelector('#toast-msg:has-text("with the photo")', { timeout: 15000 });
    const made = (await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items[0];
    if (made?.attachments?.[0]?.file?.name !== 'receipt.png') throw new Error('attachments: ' + JSON.stringify(made?.attachments));
  });
  await step('create-project-from-chip', async () => {
    const name = `PocketSmoke${stamp}`, t = `Pocket smoke new project task ${stamp}`;
    await page.fill('#in-capture', `${t} tomorrow +${name}`);
    await page.click('#cap-chips .chip[data-kind=new-project]');
    const made = await Promise.race([
      page.waitForSelector(`#cap-chips .chip[data-kind=project]:has-text("${name}")`, { timeout: 15000 }).then(() => true),
      page.waitForSelector('#toast-msg:has-text("doesn\'t allow")', { timeout: 15000 }).then(() => false),
    ]);
    if (!made) { console.log('  (this token may not create projects: step skipped)'); await page.fill('#in-capture', ''); return; }
    const project = (await (await api('/projects')).json()).items.find(p => p.title === name);
    if (!project) throw new Error('project not found in Vikunja');
    createdProjects.push(project.id);
    await page.click('#f-capture .go');
    await page.waitForSelector(`#toast-msg:has-text("Added to ${name}")`, { timeout: 15000 });
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
      page.waitForSelector('#toast-msg:has-text("doesn\'t allow")', { timeout: 15000 }).then(() => false),
    ]);
    if (!made) { console.log('  (this token may not create projects: step skipped)'); await page.fill('#in-capture', ''); return; }
    const project = (await (await api('/projects')).json()).items.find(p => p.title === name);
    createdProjects.push(project.id);
    await page.click('#f-capture .go');
    await page.waitForSelector('#toast-msg:has-text("Added 3 tasks")', { timeout: 20000 });
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
    await page.waitForSelector('#toast-msg:has-text("Added 1 task with 2 subtasks")', { timeout: 20000 });
    await page.waitForSelector(`.row .title:has-text("${parentTitle}")`, { timeout: 15000 });
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
    const me = await (await api('/user')).json(), row = '#d-subtasks .row:nth-of-type(2)';
    const id = +await page.getAttribute(row, 'data-id'), people = async () => ((await (await api('/tasks/' + id)).json()).assignees || []).map(u => u.id);
    if (await page.$('#d-subtasks .row:first-of-type .claim')) throw new Error('a done subtask with no one on it has a slot');
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
    await page.click(`.row:has(> .body .title:has-text("${parentTitle}")) > .check`);
    await page.waitForSelector('#toast.show #toast-msg:has-text("with 3 subtasks")', { timeout: 20000 });
    if ((await subs()).some(s => !s.done)) throw new Error('a subtask is still open');
    await page.click('#toast-act:has-text("Undo")');
    for (let i = 0; i < 40 && (await subs()).filter(s => !s.done).length !== 3; i++) await page.waitForTimeout(250);
    const after = await subs();
    if (JSON.stringify(after.filter(s => !s.done).map(s => s.id).sort()) !== JSON.stringify([...open].sort())) throw new Error('open after undo: ' + JSON.stringify(after.map(s => [s.title, s.done])));
    if ((await (await api('/tasks/' + parent.id)).json()).done) throw new Error('the parent is still done');
    // The same from its sheet, whose subtasks show as done straight away.
    await page.click(`.row .body:has-text("${parentTitle}")`);
    await page.waitForSelector('#d-subcount:text("1/4")', { timeout: 10000 });
    await page.click('#d-done');
    await page.waitForSelector('#toast.show #toast-msg:has-text("with 3 subtasks")', { timeout: 20000 });
    await page.waitForSelector('#d-subcount:text("4/4")', { timeout: 5000 });
    await page.click('#toast-act:has-text("Undo")');
    await page.waitForSelector('#d-subcount:text("1/4")', { timeout: 15000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });
  await step('paste-list-undo', async () => {
    const a = `Pocket smoke undo 1 ${stamp}`, b = `Pocket smoke undo 2 ${stamp}`;
    await page.fill('#in-capture', `1. ${a} tomorrow\n2. ${b} tomorrow`);
    await page.click('#f-capture .go');
    await page.waitForSelector('#toast-msg:has-text("Added 2 tasks")', { timeout: 20000 });
    await page.waitForSelector(`.row .title:has-text("${b}")`, { timeout: 15000 });
    await page.click('#toast-act:has-text("Undo")');
    await page.waitForSelector(`.row .title:has-text("${a}")`, { state: 'detached', timeout: 15000 });
    await page.waitForSelector(`.row .title:has-text("${b}")`, { state: 'detached', timeout: 15000 });
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
    await page.waitForSelector(`#toast-msg:has-text("no user @nobody-${stamp}")`, { timeout: 20000 });
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
    await page.waitForSelector(`#toast-msg:text-is("Added to ${to.title}")`, { timeout: 20000 });   // not the last step's toast
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
  const toastGone = () => page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 }).catch(() => {});

  await step('quick-add-keeps-focus-with-undo-and-open', async () => {
    const t = `Pocket smoke focus ${stamp}`;
    await toastGone();
    await page.focus('#in-capture');
    await page.fill('#in-capture', t);
    await page.click('#f-capture .go');
    await page.waitForSelector('#toast.show #toast-msg:has-text("Added to")', { timeout: 20000 });
    if (await page.evaluate(() => document.activeElement?.id) !== 'in-capture') throw new Error('the box lost the focus');
    if (await page.textContent('#toast-act') !== 'Undo' || await page.textContent('#toast-act2') !== 'Open') throw new Error('actions: ' + await page.textContent('#toast'));
    const [made2] = ((await (await api('/tasks?q=' + encodeURIComponent(t))).json()).items || []).filter(x => x.title === t);
    await page.click('#toast-act');
    for (let i = 0; i < 40 && await get(made2.id); i++) await page.waitForTimeout(250);
    if (await get(made2.id)) throw new Error('Undo left the task');
    await page.evaluate(() => document.activeElement?.blur());
  });

  await step('quick-ticks-add-up', async () => {
    const a = await make(`Pocket smoke tick A ${stamp}`, { due_date: todayAt(23) }), b = await make(`Pocket smoke tick B ${stamp}`, { due_date: todayAt(23) });
    await toastGone();
    await refreshToday();
    await page.click(`${rowOf(a.title)} > .check`, { timeout: 15000 });
    await page.waitForSelector(`#toast.show #toast-msg:text-is("Done: ${a.title}")`);
    await page.click(`${rowOf(b.title)} > .check`);
    // The two add up: one message, whose Undo opens both again.
    await page.waitForSelector('#toast.show #toast-msg:text-is("2 done")');
    await page.click('#toast-act:has-text("Undo")');
    for (let i = 0; i < 40 && ((await get(a.id)).done || (await get(b.id)).done); i++) await page.waitForTimeout(250);
    if ((await get(a.id)).done || (await get(b.id)).done) throw new Error('Undo didn\'t open both');
  });

  // A phone's keyboard covers the bottom of the page without making it shorter: here visualViewport says it's h tall.
  const keyboard = h => page.evaluate(h => {
    if (h) Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => innerHeight - h }); else delete visualViewport.height;
    visualViewport.dispatchEvent(new Event('resize'));
  }, h);
  const subsOf = async id => (await get(id))?.related_tasks?.subtask || [];
  await step('a-toast-for-each-subtask-added-shows-above-the-keyboard', async () => {
    // The subtask box keeps the focus after an add, so the keyboard stays open: each add's toast shows above it.
    const p = await make(`Pocket smoke toasts ${stamp}`, { due_date: todayAt(23) }), vh = page.viewportSize().height;
    const toastBottom = async () => { await page.waitForTimeout(300); return page.$eval('#toast', el => el.getBoundingClientRect().bottom); };
    try {
      await toastGone();
      await refreshToday();
      await page.click(`${rowOf(p.title)} > .body`, { timeout: 15000 });
      await page.focus('#d-subin');
      await keyboard(300);
      for (const n of [1, 2]) {
        const before = await page.evaluate(() => Alpine.$data(document.body).toast.until);
        await page.fill('#d-subin', `Pocket smoke toast sub ${n} ${stamp}`);
        await page.press('#d-subin', 'Enter');
        await page.waitForFunction(b => { const t = Alpine.$data(document.body).toast; return t.show && t.until !== b; }, before, { timeout: 15000 });
        await page.waitForSelector('#toast.show #toast-msg:text-is("Added 1 subtask")');
        if (await page.evaluate(() => document.activeElement?.id) !== 'd-subin') throw new Error(`the box lost the focus after add ${n}`);
        const bottom = await toastBottom();
        if (bottom > vh - 300) throw new Error(`toast ${n} is under the keyboard: its bottom is at ${bottom} of ${vh}`);
      }
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


  await step('today-moves-a-task-to-overdue-as-its-time-passes', async () => {
    // Left open on Today: once a minute it regroups, without asking Vikunja, and a task whose time passes says so.
    const t = `Pocket smoke due soon ${stamp}`, due = new Date(Date.now() + 6000);
    if (due.getDate() !== new Date().getDate() || !due.getHours() && !due.getMinutes()) return;   // midnight: a day without a time
    const made = await make(t, { due_date: due.toISOString() });
    try {
      await toastGone();
      await refreshToday();
      await page.waitForSelector(`.sec.today + .list ${rowOf(t)}`, { timeout: 15000 });
      // An Undo showing (a tick's, say) isn't replaced: the message waits for it to go. It's put up just before the time
      // passes: the minute's own timer, should it come between, then waits for it too, rather than say it first.
      await page.waitForTimeout(Math.max(0, due - Date.now() - 500));
      await page.evaluate(() => Alpine.$data(document.body).notify('Done: something', { label: 'Undo', done: true, fn(){} }));
      await page.waitForTimeout(Math.max(0, due - Date.now()) + 1000);
      await page.evaluate(() => Alpine.$data(document.body).tickToday());     // what the minute's timer does
      await page.waitForSelector(`.sec.overdue + .list ${rowOf(t)}`, { timeout: 5000 });
      if (!await page.$('#toast.show #toast-msg:text-is("Done: something")')) throw new Error('the Undo was replaced');
      await page.waitForSelector(`#toast.show #toast-msg:text-is("“${t}” is due now")`, { timeout: 10000 });
    } finally { await api('/tasks/' + made.id, { method: 'DELETE' }); }
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
      for (let i = 0; i < 40 && (await rems()).length < 2; i++) await page.waitForTimeout(250);
      if (JSON.stringify((await rems()).sort()) !== JSON.stringify(['due_date-3600', 'due_date0'])) throw new Error('reminders: ' + JSON.stringify(await rems()));
      // Taken off a preset once it's there; a set date and time too.
      if (await page.$('#d-remind-add option:text-is("At due")')) throw new Error('At due offered twice');
      await page.selectOption('#d-remind-add', { label: 'At a set date and time…' });
      const at = new Date(Date.now() + 2 * 864e5), p = n => String(n).padStart(2, '0');
      await page.fill('#d-remind-at', `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T09:30`);
      for (let i = 0; i < 40 && (await rems()).length < 3; i++) await page.waitForTimeout(250);
      if (!(await rems()).includes('at')) throw new Error('no reminder at a set time: ' + JSON.stringify(await rems()));
      await page.waitForSelector('#d-reminders .chip.rem:has-text("9:30")');           // its time shows, not only its day
      // Removed with its ×.
      await page.click('#d-reminders .chip.rem:has-text("At due") .chip-x');
      for (let i = 0; i < 40 && (await rems()).includes('due_date0'); i++) await page.waitForTimeout(250);
      if ((await rems()).includes('due_date0')) throw new Error('not removed: ' + JSON.stringify(await rems()));
      // A reminder added or removed elsewhere (on the web, say) since the sheet showed them stays that way.
      const elsewhere = async fn => {
        const list = (await get(made.id)).reminders.map(r => r.relative_to ? { relative_to: r.relative_to, relative_period: r.relative_period } : { reminder: r.reminder });
        await api('/tasks/' + made.id, { method: 'PATCH', headers: json, body: JSON.stringify({ reminders: fn(list) }) });
      };
      const expect = async (want, what) => {
        for (let i = 0; i < 40 && JSON.stringify((await rems()).sort()) !== JSON.stringify(want); i++) await page.waitForTimeout(250);
        if (JSON.stringify((await rems()).sort()) !== JSON.stringify(want)) throw new Error(what + ': ' + JSON.stringify(await rems()));
      };
      await elsewhere(list => [...list, { relative_to: 'due_date', relative_period: -86400 }]);
      await page.click('#d-reminders .chip.rem:has-text("1 hour before due") .chip-x');
      await expect(['at', 'due_date-86400'], 'removing one took others with it');
      await page.waitForSelector('#d-reminders .chip.rem:has-text("1 day before due")');
      await elsewhere(list => list.filter(r => r.relative_to));
      await page.selectOption('#d-remind-add', { label: '15 min before due' });
      await expect(['due_date-86400', 'due_date-900'], 'adding one brought back one removed elsewhere');
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
      await page.waitForSelector('#toast.show #toast-msg:has-text("Added to")', { timeout: 20000 });
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
    await page.click(`${open} > .check`);
    await page.waitForSelector(done, { timeout: 10000 });
    await page.click(`${done} > .check`);                                   // and back
    await page.waitForSelector(open, { timeout: 10000 });
    await page.waitForSelector('#toast.show #toast-msg:text-is("Marked not done")');
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
    for (let i = 0; i < 40 && !(await get(task.id)).description?.includes('Notes saved on close'); i++) await page.waitForTimeout(250);
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
    for (let i = 0; i < 40 && !(await notes()).includes('Mine'); i++) await page.waitForTimeout(250);
    if (!(await notes()).includes('Mine, from Pocket')) throw new Error('not saved again: ' + await notes());
    // The same when the sheet closes: they're kept on the phone instead.
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Mine again');
    await elsewhere('Theirs again');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#toast.show #toast-msg:has-text("changed elsewhere")', { timeout: 15000 });
    if (!(await notes()).includes('Theirs again')) throw new Error('written over on close: ' + await notes());
    await page.click(`${rowOf(t)} > .body`);
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
    await page.waitForSelector('#toast.show #toast-msg:has-text("Repeats")');
    await page.click('#toast-act:has-text("Undo")');
    const want = new Date(r.due_date).getTime();
    for (let i = 0; i < 40 && new Date((await get(r.id)).due_date).getTime() !== want; i++) await page.waitForTimeout(250);
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
      await page.waitForSelector('#toast.show #toast-msg:has-text("Done: Pocket smoke parent")', { timeout: 20000 });
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
      await page.waitForSelector('#toast.show #toast-msg:has-text("Repeats")', { timeout: 20000 });
      const due = new Date((await get(r.id)).due_date).getTime();
      if (due !== new Date(r.due_date).getTime() + 864e5) throw new Error('due ' + (await get(r.id)).due_date);
    } finally { await page.unroute(`**/api/v2/tasks/${r.id}`, lose); await api('/tasks/' + r.id, { method: 'DELETE' }); }
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
      for (let i = 0; i < 40 && (await get(kids[1].id)).project_id !== other.id; i++) await page.waitForTimeout(250);
      const where = await Promise.all([parent, ...kids].map(async t => (await get(t.id)).project_id));
      if (where.some(id => id !== other.id)) throw new Error('projects: ' + where);
    }
    await page.click('#d-more');
    if (await page.textContent('#d-delete') !== 'Delete task and its 2 subtasks') throw new Error('button: ' + await page.textContent('#d-delete'));
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 15000 });
    for (let i = 0; i < 40 && await get(kids[1].id); i++) await page.waitForTimeout(250);
    if ((await Promise.all([parent, ...kids].map(t => get(t.id)))).some(Boolean)) throw new Error('something is left');
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
    for (let i = 0; i < 40 && (await (await api('/projects/' + proj.id)).json()).title !== `PocketSmokeSheet${stamp} renamed`; i++) await page.waitForTimeout(250);
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
  for (const id of createdProjects) await api('/projects/' + id, { method: 'DELETE' });   // with their tasks
  // Delete anything this run left behind (every title it creates ends with the run's stamp).
  const tasks = await (await api('/tasks?q=' + stamp)).json().then(d => d.items).catch(() => []);
  for (const t of tasks || []) if (t.title.endsWith(String(stamp))) {
    // A few tries: a Vikunja on SQLite (like the local one) can answer 500 "database is locked" while busy.
    let r;
    for (let i = 0; i < 5 && !(r = await api('/tasks/' + t.id, { method: 'DELETE' })).ok; i++) await new Promise(ok => setTimeout(ok, 500));
    if (!r.ok) console.log(`Could not delete leftover task ${t.id} (HTTP ${r.status})`);
  }
}

console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
