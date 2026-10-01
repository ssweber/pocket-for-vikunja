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
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
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
    await page.fill('#in-capture', `${t} tomorrow @${ASSIGNEE} @nobody-${stamp}` + (ASSIGNEE_PROJECT ? ` +"${ASSIGNEE_PROJECT}"` : ''));
    const chips = await page.textContent('#cap-chips');
    if (!chips.includes('@' + ASSIGNEE)) throw new Error('chips: ' + chips);
    await page.click('#f-capture .go');
    await page.waitForSelector(`#toast-msg:has-text("no user @nobody-${stamp}")`, { timeout: 20000 });
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
