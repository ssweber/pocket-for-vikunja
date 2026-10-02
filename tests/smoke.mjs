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

const api = (path, init = {}) => fetch(SERVER + '/api/v1' + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, ...init.headers } });

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
// A token without some permission gets 401s, which Pocket handles; the browser still logs them, so they're left out here.
page.on('console', m => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push(m.text()));
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
  });
  const row = `.row:has(.title:has-text("${title}"))`;
  await step('refresh-keeps-rows', async () => {
    const before = await page.$(row);
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    if (!await before.evaluate(el => el.isConnected)) throw new Error('refresh rebuilt the list');
  });
  await step('tick-in-list-and-undo', async () => {
    await page.click(`${row} .check`);
    await page.waitForSelector(row, { state: 'detached', timeout: 10000 });
    await page.click('#toast-act:has-text("Undo")');
    await page.waitForSelector(row, { timeout: 15000 });
    if (await page.$eval(row, el => el.classList.contains('done'))) throw new Error('row still marked done after undo');
  });
  // Hold a row, then slide it sideways by `steps` tens of percent, as with a finger.
  async function slideProgress(sel, steps, check){
    const box = await page.locator(sel).boundingBox();
    const x = box.x + box.width * .2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForSelector(`${sel}.setting`, { timeout: 2000 });
    await page.mouse.move(x + box.width * .8 * steps / 10, y, { steps: 10 });
    await check?.();
    await page.mouse.up();
  }
  const apiTask = async () => (await (await api('/tasks?s=' + encodeURIComponent(title))).json()).find(t => t.title === title);
  await step('progress-hold-and-slide', async () => {
    await slideProgress(row, 4, async () => {
      const shown = await page.getAttribute(row, 'data-pct');
      if (shown !== '40%') throw new Error('showed ' + shown + ' while sliding');
    });
    await page.waitForSelector('#toast-msg:text("Progress set to 40%")', { timeout: 10000 });
    if (await page.isVisible('#sheet')) throw new Error('letting go opened the task');
    const t = await apiTask();
    if (Math.round(t.percent_done * 100) !== 40) throw new Error('saved percent_done ' + t.percent_done);
  });
  await step('progress-100-marks-done-and-undo', async () => {
    await slideProgress(row, 6);
    await page.waitForSelector(row, { state: 'detached', timeout: 10000 });
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
    const made = await (await api(`/projects/${me.settings.default_project_id}/tasks`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: late, due_date: due.toISOString() }) })).json();
    const lateRow = `.row:has(.title:has-text("${late}"))`;
    await page.click('#btn-refresh');
    await page.waitForSelector(`.sec.overdue + .list ${lateRow}`, { timeout: 15000 });
    await page.click('#btn-overdue-today');
    await page.waitForSelector(`.sec.today + .list ${lateRow}`, { timeout: 15000 });
    const msg = await page.textContent('#toast-msg');
    if (!/^Moved \d+ tasks? to today$/.test(msg)) throw new Error('toast: ' + msg);
    const want = new Date(); want.setHours(9, 0, 0, 0);
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
    if (await page.isVisible('#capture')) throw new Error('the add box still shows');
    await page.fill('#in-search', String(stamp));
    await page.waitForSelector(`#view .sec:has-text("Open") + .list ${row}`, { timeout: 10000 });
    await page.click('#btn-search-cancel');
    await page.waitForSelector('#capture:not([hidden])');
    if (await page.getAttribute('nav.tabs a[data-tab=today]', 'aria-current') !== 'page') throw new Error('Cancel didn\'t go back to Today');
  });
  await step('upload-html-attachment', async () => {
    const found = await (await api('/tasks?s=' + encodeURIComponent(title))).json();
    const id = found.find(t => t.title === title)?.id;
    if (!id) throw new Error('task not found');
    const form = new FormData();
    form.append('files', new Blob(['<script>document.title="pwned"</script>'], { type: 'text/html' }), 'evil.html');
    const r = await api(`/tasks/${id}/attachments`, { method: 'PUT', body: form });
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
    if (/<(svg|math|text|mi)/i.test(r.foreign)) throw new Error('SVG/MathML kept: ' + r.foreign);
    if (r.color !== 'var(--muted)') throw new Error('color not rejected: ' + r.color);
  });
  await step('set-priority', async () => {
    const titleBox = await page.$('#d-title');
    await page.click('[data-prio="1"]');
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    if (!await titleBox.evaluate(el => el.isConnected)) throw new Error('saving rebuilt the sheet');
    if (await page.getAttribute('[data-prio="1"]', 'aria-pressed') !== 'true') throw new Error('priority not shown as selected');
  });
  await page.screenshot({ path: `${OUT}/sheet.png` });
  await step('progress-in-sheet', async () => {
    if (await page.inputValue('#d-progress') !== '40') throw new Error('sheet shows ' + await page.inputValue('#d-progress'));
    await page.$eval('#d-progress', el => { el.value = '60'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    const t = await apiTask();
    if (Math.round(t.percent_done * 100) !== 60) throw new Error('saved percent_done ' + t.percent_done);
  });
  await step('mark-done', async () => {
    await page.click('#d-done');
    await page.waitForSelector('#d-done.on', { timeout: 10000 });
  });
  await step('delete', async () => {
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
  await step('create-project-from-chip', async () => {
    const name = `PocketSmoke${stamp}`, t = `Pocket smoke new project task ${stamp}`;
    await page.fill('#in-capture', `${t} tomorrow +${name}`);
    await page.click('#cap-chips .chip[data-kind=new-project]');
    const made = await Promise.race([
      page.waitForSelector(`#cap-chips .chip[data-kind=project]:has-text("${name}")`, { timeout: 15000 }).then(() => true),
      page.waitForSelector('#toast-msg:has-text("doesn\'t allow")', { timeout: 15000 }).then(() => false),
    ]);
    if (!made) { console.log('  (this token may not create projects: step skipped)'); await page.fill('#in-capture', ''); return; }
    const project = (await (await api('/projects')).json()).find(p => p.title === name);
    if (!project) throw new Error('project not found in Vikunja');
    createdProjects.push(project.id);
    await page.click('#f-capture .go');
    await page.waitForSelector(`#toast-msg:has-text("Added to ${name}")`, { timeout: 15000 });
    const task = ((await (await api('/tasks?s=' + encodeURIComponent(t))).json()) || []).find(x => x.title === t);
    if (task?.project_id !== project.id) throw new Error('task landed in project ' + task?.project_id);
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
    const project = (await (await api('/projects')).json()).find(p => p.title === name);
    createdProjects.push(project.id);
    await page.click('#f-capture .go');
    await page.waitForSelector('#toast-msg:has-text("Added 3 tasks")', { timeout: 20000 });
    const find = async t => ((await (await api('/tasks?s=' + encodeURIComponent(t))).json()) || []).find(x => x.title === t);
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
    await page.waitForSelector('#d-saved:text("Saved")', { timeout: 10000 });
    const saved = await (await api('/tasks?s=' + encodeURIComponent(t))).json();
    if (saved[0]?.repeat_mode !== 1) throw new Error('server repeat_mode ' + saved[0]?.repeat_mode);
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
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row').length === 2, null, { timeout: 10000 });
    const names = await page.$$eval('#d-subtasks .row .title', els => els.map(e => e.textContent));
    if (!names.some(n => n === `Pocket smoke sub B ${stamp}`)) throw new Error('markers not stripped: ' + names.join(' | '));
    await page.fill('#d-subin', `Pocket smoke sub C ${stamp}`);
    await page.press('#d-subin', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row').length === 3, null, { timeout: 15000 });
    await page.click('#d-subtasks .row:first-of-type .check');
    await page.waitForSelector('#d-subcount:text("1/3")', { timeout: 10000 });
  });
  await step('subtask-links-to-parent', async () => {
    await page.click('#d-subtasks .row:first-of-type .body');
    await page.waitForSelector(`#d-parent:has-text("${parentTitle}")`, { timeout: 10000 });
    await page.click('#d-parent');
    await page.waitForFunction(t => document.querySelector('#d-title')?.value === t, parentTitle, { timeout: 10000 });
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
    // A token without Projects → projectusers can't check who sees a project: Pocket then assigns as best it can.
    const canLook = (await api('/projects/1/projectusers?s=x')).status !== 401;
    await page.fill('#in-capture', `${t} tomorrow @${ASSIGNEE} @nobody-${stamp}` + (ASSIGNEE_PROJECT ? ` +"${ASSIGNEE_PROJECT}"` : ''));
    const chips = await page.textContent('#cap-chips');
    if (!chips.includes('@' + ASSIGNEE)) throw new Error('chips: ' + chips);
    if (canLook) await page.waitForSelector(`#cap-chips .chip.warn:has-text("No user @nobody-${stamp}")`, { timeout: 15000 });   // said before sending
    await page.click('#f-capture .go');
    await page.waitForSelector(`#toast-msg:has-text("no user @nobody-${stamp}")`, { timeout: 20000 });
    // The assigned person leaves the title, as in Vikunja, when Pocket could check; the unknown one stays.
    const saved = ((await (await api('/tasks?s=' + encodeURIComponent(t))).json()) || []).find(x => x.title.startsWith(t));
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
    const me = await (await api('/user')).json(), projects = (await (await api('/projects')).json()).filter(p => p.id > 0);
    const home = me.settings?.default_project_id || projects[0]?.id;
    const sees = async id => { const r = await api(`/projects/${id}/projectusers?s=${encodeURIComponent(ASSIGNEE)}`); return r.ok ? ((await r.json()) || []).some(u => u.username === ASSIGNEE) : null; };
    const shared = [];
    for (const p of projects) { const v = await sees(p.id); if (v === null) { console.log('  (this token may not use Projects → projectusers: step skipped)'); return; } if (v) shared.push(p); }
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
    const task = ((await (await api('/tasks?s=' + encodeURIComponent(t))).json()) || []).find(x => x.title === t);
    if (task?.project_id !== to.id) throw new Error('project ' + task?.project_id);
    if (!task.assignees?.some(u => u.username === ASSIGNEE)) throw new Error('not assigned');
  });
  await step('suggest-label-and-person', async () => {
    // Typing *pocket-sm offers the existing label; tapping it finishes the word. The same for @ and a person you share with.
    await page.fill('#in-capture', `Pocket smoke suggest ${stamp} *${label.slice(0, 9)}`);
    await page.click(`#cap-chips .chip[data-kind=suggest]:has-text("*${label}")`, { timeout: 15000 });
    if (await page.inputValue('#in-capture') !== `Pocket smoke suggest ${stamp} *${label} `) throw new Error('text: ' + await page.inputValue('#in-capture'));
    if (ASSIGNEE && (await api('/projects/1/projectusers?s=x')).status !== 401) {
      await page.type('#in-capture', '@' + ASSIGNEE.slice(0, 2));
      await page.click(`#cap-chips .chip[data-kind=suggest]:has-text("@${ASSIGNEE}")`, { timeout: 15000 });
      if (!(await page.inputValue('#in-capture')).endsWith(`*${label} @${ASSIGNEE} `)) throw new Error('text: ' + await page.inputValue('#in-capture'));
    }
    await page.fill('#in-capture', '');
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
  const tasks = await (await api('/tasks?s=' + stamp)).json().catch(() => []);
  for (const t of tasks || []) if (t.title.endsWith(String(stamp))) {
    const r = await api('/tasks/' + t.id, { method: 'DELETE' });
    if (!r.ok) console.log(`Could not delete leftover task ${t.id} (HTTP ${r.status})`);
  }
}

console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
