// Checklists, end to end. The test makes a project for checklists and a template with steps. It then starts checklists,
// works through them, finishes them and hands them over, online and offline.
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... node tests/checklists.mjs
//   npm run test:local        (starts a local Vikunja with the plugin and runs everything against it)
//
// Creates its own project ("Pocket checklists <stamp>") and deletes it at the end, with everything in it. Leaves a
// "template" label behind, which later test runs reuse, because Task Management tokens can't delete labels. The token
// needs Projects → Create and Update, and Reactions.
// Optional: OTHER_USER and OTHER_PASSWORD, a second account. The test shares the project with that account, starts a
// checklist for it, and checks its Today and Checklists tabs too.
// BROWSER_CHANNEL=msedge|chrome (default: Playwright's Chromium), OUT=<dir> for screenshots.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { shortTime } from '../src/js/dates.js';
import { expect, finger, hintSeen, laidUnder, loaded, noToast, placeLine, placeSays, signIn as signInAt, steady, swipeRow, synced, toast as toastOn, toastGone as toastGoneOn, uncovered } from './helpers.mjs';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN;
const OUT = process.env.OUT || 'test-results';
const OTHER = process.env.OTHER_USER, OTHER_PASSWORD = process.env.OTHER_PASSWORD;
if (!SERVER || !TOKEN) { console.error('Set VIKUNJA_URL and VIKUNJA_TOKEN'); process.exit(2); }
const APP = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';

// Vikunja on SQLite sometimes answers 500 "database is locked" when a request arrives while the previous request is
// still being written. The test retries its own requests, as Pocket does.
const call = async (token, path, init = {}) => {
  for (let i = 0; ; i++) {
    const r = await fetch(SERVER + '/api/v2' + path, { ...init, headers: { Authorization: 'Bearer ' + token, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
    if (r.status === 500 && i < 4) { await new Promise(res => setTimeout(res, 300 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`${init.method || 'GET'} ${path}: HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
};
const api = (path, init) => call(TOKEN, path, init);
const task = id => api(`/tasks/${id}?expand=reactions&expand=comments`);
// The step ids of a template or checklist in the order Pocket shows them. The order comes from the "pocket:order …"
// line in the description. Steps missing from that line come after, sorted by id.
const stepOrder = desc => (desc || '').match(/<p>pocket:order((?:\s+\d+)*)<\/p>/i)?.[1].trim().split(/\s+/).filter(Boolean).map(Number) || null;
const subtasks = async id => {
  const t = await api('/tasks/' + id), subs = t.related_tasks?.subtask || [], order = stepOrder(t.description);
  const at = s => order?.includes(s.id) ? order.indexOf(s.id) : Infinity;
  return t.related_tasks?.copiedfrom?.length || t.labels?.some(l => l.title === 'template') ? [...subs].sort((a, b) => at(a) - at(b) || a.id - b.id) : subs;
};
async function until(what, fn, ms = 20000){
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 300))) { if (await fn()) return; if (Date.now() > end) throw new Error(what); }
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await hintSeen(context);                         // skips the one-time hint, as smoke.mjs does
// The page uses Playwright's clock. It follows the real time, and later() moves it forward instead of waiting.
await context.clock.install();
const page = await context.newPage();
const errors = [];
/* Moves the page's clock forward by `ms` and runs the timers that fall due (a toast disappearing, a countdown ticking).
   Then the clock goes back to the real time, which is what Vikunja's dates use. */
const later = async ms => { await page.clock.fastForward(Math.max(0, Math.round(ms))); await page.clock.setSystemTime(Date.now()); };
const pageNow = () => page.evaluate(() => Date.now());
page.on('console', m => m.type() === 'error' && !/status of (401|404)|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());

let failed = 0;
async function step(name, fn){
  const start = Date.now(), secs = () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`;   // shows each step's duration, so a slow step stands out
  try { await fn(); console.log('PASS', name + secs()); }
  catch (e) {
    failed++; console.log('FAIL', name + secs(), '-', e.message.split('\n').slice(0, process.env.VERBOSE ? 8 : 1).join(' · ')); await page.screenshot({ path: `${OUT}/checklists-fail-${name}.png` }).catch(() => {});
    await context.setOffline(false); await page.unrouteAll();                // so one failure doesn't break the steps after it
  }
}
const signIn = (p, token) => signInAt(p, APP, token);
// The card on Today for a checklist with open steps, found by its name.
const cardOf = t => `.day-card:has(> .card-head .card-title:has-text("${t}"))`;
// A checklist's name on its Today card and its Checklists row has no start date. "Line 4 · Oct 8 · #1" is shown as
// "Line 4 · #1" (see `dayless` in checklists.js).
const dayless = t => t.split(' · ').filter((_, i) => i !== 1).join(' · ');
// The title of a new checklist (`runTitle` in sync.js): the template name, the start date, then a name or a number.
const RUN_TITLE = (template, name = '#\\d+') => new RegExp(`^${template} · \\w{3} \\d{1,2} · ${name}$`);
const toast = text => toastOn(page, text), toastGone = () => toastGoneOn(page);
// Checks the message shown at a named position (lines.js), such as "checklists", "step" or "sheet:subtasks".
const said = (where, text) => placeSays(page, where, text);
const online = () => page.evaluate(() => window.dispatchEvent(new Event('online')));
// Touch input through Chrome itself, so the page scrolls during a touch as on a phone (`finger` in helpers.mjs).
const { touchDrag } = await finger(page);

const stamp = Date.now();
const TEMPLATE = `Startup ${stamp}`;
// The steps as typed in New template, and as saved. A time in words becomes T#, and a step that another step counts from gets a name.
const WRITTEN = ['Check the guards at 3pm', 'First article check 2 hours later', 'Warm up the press in 30 min'];
const STEPS = ['Check the guards at 3pm {#check-the-guards}', 'Warm up the press T#30m', 'First article check T#2h:check-the-guards'];
const GUARDS = '“Check the guards at 3pm”';
const tplRow = `.cl-tpl:has(.title:text-is("${TEMPLATE}"))`;
// Tapping a template step opens the quick-add box in its row. Holding the closed row reorders it. Swiping left deletes it.
// Returns the selector for step n's box, opening the box first if it is closed.
const stepBox = async n => {
  const row = `#d-subtasks .row:nth-of-type(${n})`;
  if (!await page.$(`${row} .step-in`)) await page.click(`${row} > button.body`);
  await page.waitForSelector(`${row} .step-in textarea`);
  return `${row} .step-in textarea`;
};
// Swipes the step all the way left to delete it. The confirmation dialog is accepted by the handler above.
const removeStep = n => swipeRow(page, `#d-subtasks .row:nth-of-type(${n})`, 'delete');
// Waits until the sheet has finished saving or rejecting a step move.
const stepsSettled = () => page.waitForFunction(() => !Alpine.$data(document.body).sheet.checklistBusy);
// Holds step n's row, drags it past the first few pixels (so it counts as a drag), on to the middle of step `to`'s row,
// and releases it there.
async function dragStep(n, to){
  await page.locator('#d-subtasks').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));   // away from the screen edges, where the page scrolls
  const row = page.locator(`#d-subtasks .row:nth-of-type(${n})`), box = await steady(row), x = box.x + box.width / 2, y0 = box.y + box.height / 2;
  const b = await page.locator(`#d-subtasks .row:nth-of-type(${to})`).boundingBox(), y = b.y + b.height / 2 + Math.sign(b.y - box.y) * 4;
  await page.mouse.move(x, y0); await page.mouse.down();
  await expect(row).toHaveClass(/held/);
  await page.mouse.move(x, y0 + Math.sign(y - y0) * 14, { steps: 3 });
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}
// Moves a step up or down by one, relative to Vikunja's latest order. A drag instead picks a destination in the displayed order.
const tapStep = (n, label) => page.evaluate(([n, dir]) => Alpine.$data(document.body).moveStep(n - 1, dir), [n, label === 'Move up' ? -1 : 1]);
let project, template, me, other, otherToken;
const runs = [];                                 // ids of the checklists, in the order they were started

try {
  me = await api('/user');
  project = await api('/projects', { method: 'POST', body: JSON.stringify({ title: `Pocket checklists ${stamp}` }) });
  if (OTHER && OTHER_PASSWORD) {
    otherToken = (await (await fetch(SERVER + '/api/v2/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: OTHER, password: OTHER_PASSWORD }) })).json()).token;
    other = await call(otherToken, '/user');
    await api(`/projects/${project.id}/users`, { method: 'POST', body: JSON.stringify({ username: OTHER, permission: 1 }) });
  }
  const checklistsBefore = (await api('/projects')).items.filter(p => /pocket:checklists/i.test(p.description || '')).length;

  await step('sign-in', () => signIn(page, TOKEN));

  // With no project for checklists, the Projects tab offers to set one up. That makes a project "Checklists" with an
  // example template, then opens the Checklists tab with a Getting started card. Skipped if the account has one already.
  if (!checklistsBefore) await step('set-up-checklists', async () => {
    await page.click('nav.tabs a[data-tab=projects]');
    await page.click('#btn-setup-checklists', { timeout: 15000 });
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 30000 });
    await said('checklists', 'Created the Checklists project, with an example template');
    const made = (await api('/projects')).items.filter(p => p.title === 'Checklists' && /pocket:checklists/i.test(p.description || '')).pop();
    try {
      if (!made) throw new Error('Set up checklists made no project named Checklists');
      await page.waitForSelector(`.cl[data-project="${made.id}"] .cl-tpl .title:text-is("Example: Opening up")`, { timeout: 15000 });
      await page.waitForSelector(`#getting-started-${made.id} a[href$="/projects/${made.id}/settings/share"]`);
      const tpl = (await api(`/projects/${made.id}/tasks?filter=${encodeURIComponent('done = true')}`)).items.find(t => t.title === 'TEMPLATE: Example: Opening up');
      const steps = await Promise.all((await subtasks(tpl.id)).map(s => api('/tasks/' + s.id)));
      if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(['Turn on the espresso machine', 'Put the croissants in the oven', 'Take the croissants out T#18m', 'Wipe down the tables']))
        throw new Error('the example template has the wrong steps: ' + steps.map(s => s.title).join(' | '));
      if (!steps[0].assignees?.some(u => u.id === me.id)) throw new Error('the first step isn\'t for you');
      if (!steps.every(s => s.done) || !tpl.labels?.some(l => l.title === 'template')) throw new Error('the example template lacks the template label, or a step is not done');
      // The Start sheet shows who each step is for.
      await page.click(`.cl[data-project="${made.id}"] .cl-start`);
      await page.waitForSelector('#start-steps .prop:nth-of-type(1) .start-who:text-is("For you")', { timeout: 15000 });
      await page.click('#start-go');
      await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
      await page.waitForSelector('#step-title:text-is("Turn on the espresso machine")');
      await page.click('#step-done');
      await page.waitForSelector('#step-title:text-is("Put the croissants in the oven")');
      // After the second step is done, the next step in order shows, counting down its 18 minutes.
      await page.click('#step-done');
      await page.waitForSelector('#step-title:text-is("Take the croissants out")');
      await expect(page.locator('#step-card .step-due')).toHaveText(/^Due in 1[78]m$/);
      // The set-up card disappears once a project for checklists exists.
      await page.click('nav.tabs a[data-tab=projects]');
      await page.waitForSelector('.tree');
      if (await page.$('#btn-setup-checklists')) throw new Error('Set up checklists is still offered');
    } finally {
      // The last tick's ✅ reaction may still be waiting to send. Deleting the project first would get it rejected, so
      // it would stay in the outbox and block the ticks after it.
      await synced(page).catch(() => {});
      if (made) await api('/projects/' + made.id, { method: 'DELETE' }).catch(() => {});
    }
    await page.click('#btn-refresh');
    await page.waitForSelector('nav.tabs a[data-tab=checklists]', { state: 'detached', timeout: 15000 });
  });

  await step('use-for-checklists', async () => {
    if (!checklistsBefore && await page.isVisible('nav.tabs a[data-tab=checklists]')) throw new Error('a Checklists tab without any checklist project');
    if (!checklistsBefore && await page.$eval('nav.tabs a[data-tab=today] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('the tab names are hidden');
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click('#btn-project');
    await page.click('#p-use-checklists');
    await said('sheet:top', 'This project is now used for checklists');
    await page.waitForSelector('nav.tabs.icons a[data-tab=checklists]');
    if (!await page.$eval('nav.tabs a[data-tab=today] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('the tab names still show beside the icons');
    if (await page.$eval('nav.tabs a[aria-current=page] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('the tab you\'re on lost its name');
    if (!/<p>pocket:checklists<\/p>/.test((await api('/projects/' + project.id)).description)) throw new Error('no marker in the description');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('new-template', async () => {
    await page.click('nav.tabs a[data-tab=checklists]');
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.waitForFunction(() => document.activeElement?.id === 'nt-name');   // wait for the sheet to focus the name before typing
    await page.fill('#nt-name', TEMPLATE);
    await page.press('#nt-name', 'Enter');                                   // moves to the box at the end of the step list
    // Steps are typed into that box. Each Enter adds a row and leaves the box empty and focused. A time in words
    // shows a chip under the box, where the user picks which step it counts from.
    await page.waitForFunction(() => document.activeElement?.id === 'd-subin' && !document.activeElement.value);
    const row = i => page.locator('#d-subtasks > .row').nth(i), chip = page.locator('#d-subbox .draft-time');
    await page.keyboard.type(WRITTEN[0]); await page.keyboard.press('Enter');
    await expect(row(0).locator('.title')).toHaveText('Check the guards at 3pm');
    await page.keyboard.type(WRITTEN[1]);
    await expect(chip).toContainText('2h after');
    // After moving down, First article check still counts from the guards step.
    await chip.locator('select').selectOption({ label: 'Check the guards at 3pm' });
    await page.keyboard.press('Enter');
    await expect(row(1).locator('.meta')).toHaveText(`Due 2h after ${GUARDS}`);
    await page.keyboard.type(WRITTEN[2]); await page.keyboard.press('Enter');
    await expect(page.locator('#d-subtasks > .row')).toHaveCount(3);
    await tapStep(2, 'Move down');
    await expect(row(2).locator('.title')).toHaveText('First article check');
    await expect(row(2).locator('.meta')).toHaveText(`Due 2h after ${GUARDS}`);
    await expect(row(0).locator('.meta')).toHaveText('Named “check-the-guards”');
    // The reply to the second step's request is lost. Pressing Create template again continues with the same template and adds nothing twice.
    let posts = 0;
    const loseStep = async r => { if (r.request().method() !== 'POST' || ++posts !== 3) return r.fallback(); await r.fetch(); return r.abort('connectionreset'); };
    await page.route(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await page.click('#nt-create');
    await said('sheet:top', 'Tap Create template again');
    await page.unroute(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await page.click('#nt-create');
    await said('checklists', `Created ${TEMPLATE}`);
    const named = async title => (await api('/tasks?q=' + encodeURIComponent(title))).items.filter(t => t.title === title && t.project_id === project.id).length;
    // Vikunja shows the "TEMPLATE: " title prefix everywhere. Pocket shows only the template's name (tplRow).
    for (const title of [`TEMPLATE: ${TEMPLATE}`, ...STEPS]) if (await named(title) !== 1) throw new Error(`${await named(title)} tasks are titled “${title}”`);
    await page.waitForSelector(tplRow, { timeout: 15000 });
    // On a 375px phone too, the template row and the New template row each fit on one line. The icon is on the left,
    // the text beside it, and Start on the right.
    for (const width of [390, 375]) {
      await page.setViewportSize({ width, height: 844 });
      const laid = await page.$eval(tplRow, el => {
        const box = s => el.querySelector(s).getBoundingClientRect(), icon = box('.body > svg'), title = box('.title'), start = box('.cl-start');
        const n = el.parentElement.querySelector('.cl-new'), plus = n.querySelector('svg').getBoundingClientRect(), words = n.querySelector('.title').getBoundingClientRect();
        return { tpl: icon.right <= title.left && title.right <= start.left && icon.top < title.bottom && title.top < icon.bottom, start: start.height + 10 >= 48,
          add: plus.right <= words.left && plus.top < words.bottom && words.top < plus.bottom };
      });
      if (!laid.tpl || !laid.add || !laid.start) throw new Error(`at ${width}px: ` + JSON.stringify(laid));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    template = (await api('/tasks?q=' + encodeURIComponent(TEMPLATE))).items.find(t => t.title === `TEMPLATE: ${TEMPLATE}`);
    // Sort by id (the order they were made), because Vikunja's order of a task's subtasks can change as they are saved.
    const t = await api('/tasks/' + template.id), steps = (t.related_tasks?.subtask || []).sort((a, b) => a.id - b.id);
    if (!t.done || !t.labels?.some(l => l.title === 'template')) throw new Error(`done ${t.done}, labels ${JSON.stringify(t.labels?.map(l => l.title))}`);
    if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(STEPS)) throw new Error('the template has the wrong steps: ' + steps.map(s => s.title).join(' | '));   // "at 3pm" stays in the title
    if (!steps.every(s => s.done)) throw new Error('a step isn\'t done');
    // The template's sheet shows when each step is due.
    await page.click(`${tplRow} .body`);
    await page.waitForSelector('#d-start');
    if (await page.inputValue('#d-title') !== TEMPLATE) throw new Error('the template\'s sheet is titled ' + await page.inputValue('#d-title'));
    const shown = await page.$$eval('#d-subtasks .row', els => els.map(e => e.querySelector('.title').textContent.trim() + '|' + (e.querySelector('.meta')?.textContent || '').trim()));
    if (JSON.stringify(shown) !== JSON.stringify([`Check the guards at 3pm|Named “check-the-guards”`, `Warm up the press|Due 30m after ${GUARDS}`, `First article check|Due 2h after ${GUARDS}`]))
      throw new Error('sheet shows ' + JSON.stringify(shown));
    // Steps are numbered, as on the Start sheet. A square box would mean a step to tick in a checklist. The sheet shows
    // what a checklist copies from the template: notes, labels except "template", people and the repeat. It has no
    // Comments, because Vikunja's copy of a template does not copy comments.
    const n = page.locator('#d-subtasks .row .step-n').first();
    await expect(n).toHaveText('1');
    await expect(n).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('#d-comments')).toHaveCount(0);
    await expect(page.locator('#d-template-label')).toHaveText('Every checklist started from this template gets its labels, except “template”, which marks it as a template.');
    for (const id of ['#d-desc', '#d-due', '#d-repeat', '#d-assignees']) await expect(page.locator(id)).toBeVisible();
  });

  await step('a-step-it-counts-from-removed', async () => {
    // A step counts from another step, which is then deleted. The step now counts from the start. The template is never created.
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.waitForFunction(() => document.activeElement?.id === 'nt-name');   // wait for the sheet to focus the name before typing
    await page.fill('#nt-name', 'Not made');
    await page.press('#nt-name', 'Enter');
    const row = i => page.locator('#d-subtasks > .row').nth(i), box = '#d-subin', rows = page.locator('#d-subtasks > .row');
    await page.fill(box, 'Put the roast in'); await page.press(box, 'Enter');
    await page.fill(box, 'Baste in 20 min');
    await page.locator('#d-subbox .draft-time select').selectOption({ label: 'Put the roast in' });
    await page.press(box, 'Enter');
    await expect(rows).toHaveCount(2);
    await removeStep(1);                                                      // a row never sent is simply deleted
    await expect(rows).toHaveCount(1);
    // Deleting a step makes the step that counted from it count from the previous step. Here that is the start.
    await expect(row(0).locator('.meta')).toHaveText('Due 20m after the start');
    await page.waitForSelector('#nt-create:not([disabled])');
    // The step editor ignores Alt+arrow keys. Dragging the closed row still reorders it.
    const typing = () => page.evaluate(() => document.activeElement?.classList.contains('draft-in') ? document.activeElement.value : document.activeElement?.tagName);
    const types = async (what, value) => { await page.waitForTimeout(200); if (await typing() !== value) throw new Error(`${what}: the focus is on ${await typing()}`); };
    for (const text of ['Rest it', 'Carve it']) { await page.fill(box, text); await page.press(box, 'Enter'); }
    await expect(rows).toHaveCount(3);                                        // Baste, Rest, Carve
    await page.press(await stepBox(2), 'Alt+ArrowDown');
    await types('Alt+Down in the step editor', 'Rest it');
    await page.press('#d-subtasks .step-in textarea', 'Alt+ArrowUp');
    await types('Alt+Up in the step editor', 'Rest it');
    await page.press('#d-subtasks .step-in textarea', 'Escape');
    await expect(row(1).locator('.title')).toHaveText('Rest it');
    await dragStep(2, 3);
    await expect(row(2).locator('.title')).toHaveText('Rest it');
    await dragStep(3, 2);
    await expect(row(1).locator('.title')).toHaveText('Rest it');
    await removeStep(3);
    await expect(rows).toHaveCount(2);
    // Delete every row and clear the name, so nothing carries over to the next New template (`openNewTemplate` keeps whatever is written).
    await removeStep(1); await removeStep(1);
    await expect(rows).toHaveCount(0);
    await page.fill('#nt-name', '');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click(`${tplRow} .body`);                                    // reopen the template's sheet
    await page.waitForSelector('#d-start');
  });

  await step('reorder-steps', async () => {
    // The step ids sorted by id, which is the order the steps were made. On Postgres, Vikunja returns subtasks in no fixed order.
    const links = (await api('/tasks/' + template.id)).related_tasks.subtask.map(s => s.id).sort((a, b) => a - b);
    // Hold the third step and drag it up to second place.
    await dragStep(3, 2);
    await until('the step never moved up in Vikunja', async () => (await subtasks(template.id)).map(s => s.title)[1] === STEPS[2]);
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    // Only the order line is written. The steps stay linked as before, and the notes don't show the line.
    const t = await api('/tasks/' + template.id);
    if (JSON.stringify(stepOrder(t.description)) !== JSON.stringify([links[0], links[2], links[1]])) throw new Error('the order line is wrong: ' + t.description);
    if (JSON.stringify(t.related_tasks.subtask.map(s => s.id).sort((a, b) => a - b)) !== JSON.stringify(links)) throw new Error('the steps were linked again');
    if (/pocket:order/.test(await page.textContent('#d-desc'))) throw new Error('the notes show the order line');
    // Tapping a step opens its editor. Holding the closed row reorders it. Swiping left deletes it.
    await page.click('#d-subtasks .row:nth-of-type(1) > button.body');
    const open = page.locator('#sheet.show'), box = page.locator('#d-subtasks .step-in textarea');
    await expect(box).toBeFocused();
    await expect(page.locator('#d-subtasks [aria-label^="Remove step"], #d-subtasks [aria-label^="More for step"], #d-subtasks [aria-label^="Move up"], #d-subtasks [aria-label^="Move down"]')).toHaveCount(0);
    /* Escape closes the innermost thing first. In the step editor it closes the editor and leaves the template's sheet
       open. In the template's name it cancels the rename, as with a task's title, and neither saves it nor closes
       the sheet. */
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await page.focus('#d-title');
    await page.keyboard.type(' renamed');
    await page.keyboard.press('Escape');
    await expect(page.locator('#d-title')).toHaveValue(TEMPLATE);
    await expect(page.locator('#d-title')).not.toBeFocused();
    await page.waitForTimeout(400);                                          // long enough for a closing sheet to have disappeared
    await expect(open, 'Escape in a template\'s name closed its sheet').toBeVisible();
    await synced(page);
    if ((await api('/tasks/' + template.id)).title !== 'TEMPLATE: ' + TEMPLATE) throw new Error('a cancelled rename was saved: ' + (await api('/tasks/' + template.id)).title);
    // The order stays after a reload.
    await page.reload();
    await loaded(page);
    if (!await page.waitForSelector('#d-start', { timeout: 3000 }).catch(() => null)) { await page.evaluate(() => { location.hash = '#/checklists'; }); await page.click(`${tplRow} .body`, { timeout: 15000 }); }
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")', { timeout: 15000 });
    // If the connection drops during a move, the step goes back where it was and a message says "Not moved".
    await page.route(`**/api/v2/tasks/${template.id}`, r => r.request().method() === 'PATCH' ? r.abort('internetdisconnected') : r.continue());
    await tapStep(2, 'Move down');
    await said('sheet:subtasks', 'Not moved');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    await page.unrouteAll(); await online(); await toastGone();
    if ((await subtasks(template.id)).map(s => s.title)[1] !== STEPS[2]) throw new Error('the step moved in Vikunja anyway');
    // Moving a step above the step it counts from is rejected before any request is sent.
    await stepsSettled();
    await tapStep(2, 'Move up');
    await said('sheet:subtasks', 'Not moved: step 2, “First article check”: its time counts from “check-the-guards”, which has to be an earlier step');
    if ((await subtasks(template.id)).map(s => s.title)[0] !== STEPS[0]) throw new Error('the step moved anyway');
    await stepsSettled();
    await tapStep(2, 'Move down');
    await until('the step never moved back', async () => JSON.stringify((await subtasks(template.id)).map(s => s.title)) === JSON.stringify(STEPS));
    await page.waitForSelector('#d-subtasks .row:nth-of-type(3) .title:text-is("First article check")');
    // The reply to a move is lost. Vikunja has still saved the move, so Pocket must not show "Not moved".
    const loseReply = async r => { if (r.request().method() !== 'PATCH') return r.fallback(); await r.fetch(); return r.abort('connectionreset'); };
    await page.route(`**/api/v2/tasks/${template.id}`, loseReply);
    await toastGone().catch(() => {});
    await tapStep(2, 'Move down');
    await until('the move never reached Vikunja', async () => (await subtasks(template.id)).map(s => s.title)[1] === STEPS[2]);
    await stepsSettled();   // saving has finished
    await page.unroute(`**/api/v2/tasks/${template.id}`, loseReply);
    if (await page.$('.place-line:has-text("Not moved")')) throw new Error('the sheet shows "Not moved"');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    await tapStep(3, 'Move up');
    await until('the step never moved back again', async () => JSON.stringify((await subtasks(template.id)).map(s => s.title)) === JSON.stringify(STEPS));
    await page.waitForSelector('#d-subtasks .row:nth-of-type(3) .title:text-is("First article check")');
    await stepsSettled();
    // Saving a move changes only the order, and saving notes changes only the notes, using what Vikunja has when the
    // request is sent. So a change made elsewhere (the web app, another phone) since the sheet opened is kept.
    const ids = (await subtasks(template.id)).map(s => s.id), was = (await api('/tasks/' + template.id)).description;
    const elsewhere = () => api('/tasks/' + template.id, { method: 'PATCH', body: JSON.stringify({ description: `<p>Wear gloves for the press.</p><p>pocket:order ${ids[0]} ${ids[2]} ${ids[1]}</p>` }) });
    const order = async () => JSON.stringify(stepOrder((await api('/tasks/' + template.id)).description));
    await elsewhere();
    await tapStep(2, 'Move up');   // "Warm up the press" is third in Vikunja now
    await until('the move did not follow the order in Vikunja: ' + await order(), async () => await order() === JSON.stringify(ids));
    if (!/Wear gloves/.test((await api('/tasks/' + template.id)).description)) throw new Error('the move deleted the notes');
    await page.waitForSelector('#d-desc:has-text("Wear gloves for the press")');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("Warm up the press")');
    await elsewhere();
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Wear gloves and goggles.');
    await page.click('#d-desc-save');
    await until('the notes were never saved', async () => /goggles/.test((await api('/tasks/' + template.id)).description));
    if (await order() !== JSON.stringify([ids[0], ids[2], ids[1]])) throw new Error('saving the notes restored an older order: ' + await order());
    await api('/tasks/' + template.id, { method: 'PATCH', body: JSON.stringify({ description: was }) });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  const startRun = async (who) => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${tplRow} .cl-start`, { timeout: 15000 });
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
    // The checklist starts assigned to you. With `who`, assign it to that user instead and remove yourself.
    if (who) { await page.click(`#start-for .chip[data-user="${who}"]`); await page.click(`#start-for .chip[data-user="${me.username}"]`); }
    const before = new Set((await api('/tasks/' + template.id)).related_tasks?.copiedto?.map(t => t.id) || []);
    const started = Date.now();
    await page.click('#start-go');
    await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
    const id = +(await page.evaluate(() => location.hash)).split('/').pop();
    if (before.has(id)) throw new Error('opened an older checklist');
    runs.push(id);
    await page.waitForSelector('#step-title', { timeout: 15000 });
    return { id, started };
  };

  let first;
  await step('start-a-run', async () => {
    first = await startRun();
    const run = await api('/tasks/' + first.id), steps = await Promise.all((await subtasks(first.id)).map(s => api('/tasks/' + s.id)));
    if (!RUN_TITLE(TEMPLATE).test(run.title)) throw new Error('the checklist title is wrong: ' + run.title);
    if (run.done || run.labels?.some(l => l.title === 'template')) throw new Error(`done ${run.done}, labels ${JSON.stringify(run.labels?.map(l => l.title))}`);
    if (JSON.stringify(run.assignees?.map(u => u.id)) !== JSON.stringify([me.id])) throw new Error('wrong assignees: ' +JSON.stringify(run.assignees?.map(u => u.username)));
    if (run.related_tasks?.copiedfrom?.[0]?.id !== template.id) throw new Error('the checklist is not linked to its template');
    if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(['Check the guards at 3pm', 'Warm up the press', 'First article check'])) throw new Error('the checklist has the wrong steps: ' + steps.map(s => s.title).join(' | '));
    if (steps.some(s => s.done)) throw new Error('a step is done already');
    // The checklist has its own order line, listing its steps as copied. It never reads the template's order line again.
    if (JSON.stringify(stepOrder(run.description)) !== JSON.stringify(steps.map(s => s.id))) throw new Error('the order line is wrong: ' + run.description);
    // Nothing has a due date yet. Each timed step counts from the moment another step is done, and the checklist has no due date.
    const dated = [run, ...steps].filter(t => t.due_date && !t.due_date.startsWith('0001'));
    if (dated.length) throw new Error('unexpected due dates: ' + dated.map(t => `${t.title} ${t.due_date}`).join(', '));
    // A timed step has a reminder at its due time, which applies once the step gets a due date. A step without a time has none.
    const rems = steps.map(s => (s.reminders || []).map(r => `${r.relative_to}${r.relative_period}`).join());
    if (JSON.stringify(rems) !== JSON.stringify(['', 'due_date0', 'due_date0'])) throw new Error('wrong reminders: ' + JSON.stringify(rems));
    await page.waitForSelector(`#run-steps .row:nth-of-type(2) .meta:has-text("Due 30m after ${GUARDS}")`);
    await page.waitForSelector(`#run-steps .row:nth-of-type(3) .meta:has-text("Due 2h after ${GUARDS}")`);
    if (await page.textContent('#step-title') !== 'Check the guards at 3pm') throw new Error('the card shows the step ' + await page.textContent('#step-title'));
    // Who the checklist is for shows in the claim slot on its own row at the top of the screen. The ⋯ menu shows who started it.
    await expect(page.locator('#run-own .claim')).toHaveAttribute('aria-label', 'For you');
  });
  const runStep = async (run, i) => (await subtasks(run))[i];

  await step('a-template-changed-after-a-start-leaves-the-run', async () => {
    // A checklist keeps the step times it started with. Changing a template step's time affects later checklists only.
    const warm = (await subtasks(template.id)).find(s => s.title === STEPS[1]);
    await api('/tasks/' + warm.id, { method: 'PATCH', body: JSON.stringify({ title: 'Warm up the press T#45m' }) });
    try {
      await page.reload();
      await page.waitForSelector(`#run-steps .row:nth-of-type(2) .meta:has-text("Due 30m after ${GUARDS}")`, { timeout: 15000 });
      if (/pocket:/.test(await page.textContent('#run'))) throw new Error('a "pocket:" line shows on the checklist');
      const run = await api('/tasks/' + first.id), step2 = await api('/tasks/' + (await runStep(first.id, 1)).id);
      if (!/pocket:run/.test(run.description) || !step2.description.includes('pocket:step Warm up the press T#30m')) throw new Error(`checklist description ${run.description}, step description ${step2.description}`);
    } finally { await api('/tasks/' + warm.id, { method: 'PATCH', body: JSON.stringify({ title: STEPS[1] }) }); }
  });

  await step('tick-a-step', async () => {
    await page.click('#step-done');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    const id = (await runStep(first.id, 0)).id;
    // The done status and the ✅ reaction are sent one after the other, so wait for both.
    await until('the step was never done with a ✅ from you', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector('#run-steps .row:nth-of-type(1).done .did[aria-label^="Done by"][aria-label*=" at "]');   // and the time it was done
    // Both timed steps count down now. The next step's countdown is on the card, and the other is pinned above it.
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (30|29)m$")');
    await page.waitForSelector('#run-timers .timer:has-text("First article check"):has-text("in 2h")');
    // Tapping a pinned countdown shows its step. Then go back to the previous step.
    await page.click('#run-timers .timer:has-text("First article check")');
    await page.waitForSelector('#step-title:text-is("First article check")');
    await page.click('#run-steps .row:nth-of-type(2) .body');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    // Change the due date directly in Vikunja after the tick. Wait over a second first, because a change in the same second as the tick counts as before it.
    await new Promise(r => setTimeout(r, 1100));
    const warm = (await runStep(first.id, 1)).id;
    await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ due_date: new Date(Date.now() + 3 * 36e5).toISOString() }) });
    await page.reload();
    await page.waitForSelector('#step-card .step-due:text-is("Due in 3h")', { timeout: 15000 });
  });

  await step('countdown-alerts-at-zero', async () => {
    // A countdown on screen that reaches zero shows a message once, and not again after a reload. The test moves the
    // page's clock to that time instead of waiting, plus 1.5 seconds because the Date header has whole seconds.
    const warm = (await runStep(first.id, 1)).id, back = (await task(warm)).due_date, due = Date.now() + 5000;
    await toastGone().catch(() => {});
    await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ due_date: new Date(due).toISOString() }) });
    try {
      await page.reload();
      await page.waitForSelector('#step-title:text-is("Warm up the press")', { timeout: 15000 });
      await page.clock.fastForward(due + 1500 - await pageNow());
      await toast('“Warm up the press” is due now');
      await page.clock.setSystemTime(Date.now());
      await toastGone();
      await page.reload();
      await page.waitForSelector('#step-title:text-is("Warm up the press")', { timeout: 15000 });
      await page.clock.fastForward(due + 1500 - await pageNow());
      await later(2000);
      if (await page.$('#toast.show #toast-msg:has-text("is due now")')) throw new Error('the due message showed again after a reload');
    } finally { await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ due_date: back }) }); }
    await page.reload();
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (3h|2h 5[0-9]m)$")', { timeout: 15000 });
  });

  /* A checklist on screen is recalculated only when something in it changes. It is not recalculated once for each
     binding that reads it, or every second. Its countdown here is hours away, so in 5 seconds its text changes at
     most once (when a minute turns over) and it is read again at most once (every 20 seconds). It used to be
     recalculated about 45 times a second. The test counts the calls on the page. */
  await step('a-run-on-screen-is-worked-out-when-it-changes-not-every-second', async () => {
    const counting = on => page.evaluate(on => {
      const a = window.Alpine.raw(document.body._x_dataStack[0]);
      if (on) { window.__worked = 0; window.__workOut = a.workOutRun; a.workOutRun = function(...x){ window.__worked++; return window.__workOut.apply(this, x); }; return 0; }
      a.workOutRun = window.__workOut; return window.__worked;
    }, on);
    await loaded(page);
    await counting(true);
    let n;
    try { await later(5000); } finally { n = await counting(false); }
    if (n > 4) throw new Error(`the checklist was recalculated ${n} times in 5 seconds with nothing changed`);
    await expect(page.locator('#step-card .step-due')).toHaveText(/^Due in (3h|2h 5[0-9]m)$/);
  });

  /* The step card has no progress strip. The steps listed under it show where the checklist is, and tapping a step
     shows it on the card, including a done step. The card also shows who is on the step, the same as its row. */
  await step('the-step-card-and-the-steps-under-it', async () => {
    await expect(page.locator('#run-bar')).toHaveCount(0);
    await expect(page.locator('#step-card .card-strip, #step-card .card-n, #step-card .pg')).toHaveCount(0);
    await expect(page.locator('#run-steps .row.current .title')).toHaveText('Warm up the press');
    // Tapping a done step's row shows it on the card with who did it, and no slot to claim it.
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await page.waitForSelector('#step-title:text-is("Check the guards at 3pm")');
    await expect(page.locator('#run-steps .row.current .title')).toHaveText('Check the guards at 3pm');
    await expect(page.locator('#step-who')).toContainText('Done by');
    await expect(page.locator('#step-card .claim')).toHaveCount(0);
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await page.waitForSelector('#step-title:text-is("First article check")');
    await page.click('#run-steps .row:nth-of-type(2) .body');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    // The row's claim slot ("+ me") also appears on the card. Claiming the step on the card makes it yours on both.
    const id = (await runStep(first.id, 1)).id, people = async () => ((await task(id)).assignees || []).map(u => u.id);
    await page.click('#step-card .claim:has(.me)');
    await page.waitForSelector('#step-card .claim.mine .av');
    await page.waitForSelector('#run-steps .row:nth-of-type(2) .claim.mine .av');
    await until('claiming on the card never reached Vikunja', async () => JSON.stringify(await people()) === JSON.stringify([me.id]));
    await page.click('#step-card .claim');
    await page.waitForSelector('#step-card .claim .me');
    await until('the claim was never removed', async () => !(await people()).length);
    await synced(page);
  });

  await step('skip-with-a-reason', async () => {
    await page.fill('#step-note', 'Press 2 is down');
    await expect(page.locator('#step-note-with')).toHaveText('Tap Done to send this comment. Tap Skip to send it as the reason.');   // the button keeps the label Skip and its size
    if (await page.textContent('#step-skip') !== 'Skip') throw new Error('the Skip button is labelled ' + await page.textContent('#step-skip'));
    await page.click('#step-skip');
    await page.waitForSelector('#step-title:text-is("First article check")');
    const id = (await runStep(first.id, 1)).id;
    await until('the skip never reached Vikunja', async () => {
      const t = await task(id);
      return t.done && t.reactions?.['⏭️']?.some(u => u.id === me.id) && (t.comments || []).some(c => c.comment.includes('Skipped: Press 2 is down'));
    });
    await page.waitForSelector('#run-steps .row:nth-of-type(2) .did[aria-label^="Skipped by"]');
  });

  await step('a-note-being-written-stays-with-its-step', async () => {
    // A note being written belongs to its step. Tapping the skipped "Warm up the press" row shows that step with an
    // empty note. Tapping back to the open step restores the note.
    await page.fill('#step-note', 'Only for this step');
    await page.click('#run-steps .row:nth-of-type(2) .body');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    if (await page.inputValue('#step-note') !== '') throw new Error('the note carried over to another step: ' + await page.inputValue('#step-note'));
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await page.waitForSelector('#step-title:text-is("First article check")');
    if (await page.inputValue('#step-note') !== 'Only for this step') throw new Error('the note was lost');
    await page.fill('#step-note', '');
    await page.reload();                                                     // reopens on the first step that isn't done, the same as before
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
  });

  await step('done-with-a-note-sends-it', async () => {
    // Untick the first step, write a note on it and press Done. The note is saved on the step along with the tick.
    const id = (await runStep(first.id, 0)).id;
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('the step was never unticked', async () => !(await task(id)).done);
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await page.waitForSelector('#step-title:text-is("Check the guards at 3pm")');
    await page.fill('#step-note', 'Guard 3 tightened');
    await expect(page.locator('#step-note-with')).toHaveText('Tap Done to send this comment. Tap Skip to send it as the reason.');
    await page.click('#step-done');
    await until('the note never reached the step', async () => { const t = await task(id); return t.done && (t.comments || []).some(c => c.comment.includes('Guard 3 tightened')); });
    await page.reload();
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
  });

  await step('note-on-a-step-and-the-run', async () => {
    // Text written on a checklist is a Vikunja comment and is labelled Comment, as in a task's sheet. "Notes" means the task's description.
    await expect(page.locator('#step-note-form button')).toBeDisabled();
    await page.fill('#step-note', '   ');
    await expect(page.locator('#step-note-form button')).toBeDisabled();
    await page.getByRole('textbox', { name: 'Comment on this step' }).fill('Looks good');
    await expect(page.locator('#step-note-form button')).toBeEnabled();
    await page.locator('#step-note-form').getByRole('button', { name: 'Post comment' }).click();
    await page.waitForSelector('#step-extra .comment:has-text("Looks good")');
    await expect(page.locator('#step-note-form button')).toBeDisabled();
    await expect(page.locator('#run-steps .row:nth-of-type(3) .note-mark')).toHaveAttribute('aria-label', 'A comment');   // the row shows it has a comment
    await expect(page.locator('#run .h3:has-text("Comments on this checklist")')).toBeVisible();
    await expect(page.locator('#run-note')).toHaveAttribute('placeholder', 'Comment, also shown next time');
    await expect(page.locator('#run-note-form button')).toBeDisabled();
    await page.fill('#run-note', '   ');
    await expect(page.locator('#run-note-form button')).toBeDisabled();
    await page.getByRole('textbox', { name: 'Comment on this checklist' }).fill('Line 2 ran slow today');
    await page.locator('#run-note-form').getByRole('button', { name: 'Post comment' }).click();
    await page.waitForSelector('#run-notes .comment:has-text("Line 2 ran slow today")');
    await expect(page.locator('#run-note-form button')).toBeDisabled();
    const step3 = await task((await runStep(first.id, 2)).id), run = await task(first.id);
    if ((step3.comments || []).filter(c => c.comment.includes('Looks good')).length !== 1) throw new Error('the step has the wrong comments: ' + JSON.stringify(step3.comments?.map(c => c.comment)));
    if (!(run.comments || []).some(c => c.comment.includes('Line 2 ran slow today'))) throw new Error('the checklist has no comment');
  });

  await step('share-a-runs-progress', async () => {
    // The ⋯ menu shares progress as text: who did each step, who skipped one, and who is on the remaining step (you, claimed
    // in this test). A skipped step counts as done, as in the ring: 2 of 3, 67%, one segment per step.
    const run = await api('/tasks/' + first.id), my = (me.name || '').trim().split(/\s+/)[0] || me.username, row = '#run-steps .row:nth-of-type(3)';
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    await page.click('#btn-run-more');
    // A checklist offers only the text, with no Markdown copy, because the record of who did each step can't be turned back into tasks.
    await expect(page.locator('#r-sharing button')).toHaveText(['Share progress as a text']);
    await page.evaluate(() => { window.shared = []; navigator.share = async d => { window.shared.push(d); }; });
    await page.click('#r-share-text');
    await expect.poll(() => page.evaluate(() => window.shared)).toEqual([{ title: run.title, text: [`${run.title}  ▰▰▱ 67% · 1 skipped`,
      `✓ Check the guards at 3pm · ${my}`, `– Warm up the press · skipped by ${my}`, `○ First article check · ${my}`].join('\n') }]);
    await expect(page.locator('#r-open-vikunja')).toHaveAttribute('href', `${SERVER}/tasks/${first.id}`);
    await page.click('#btn-sheet-close');
    await page.click(`${row} .claim`);                                       // release the claim again
    await page.waitForSelector(`${row} .claim .me`);
    await synced(page);
  });

  await step('untick-and-tick-again', async () => {
    const id = (await runStep(first.id, 0)).id;
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('the step was never unticked', async () => { const t = await task(id); return !t.done && !t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector('#step-title:text-is("Check the guards at 3pm")');     // goes back to the first step that isn't done
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('the step was never done again', async () => (await task(id)).done);
    // Vikunja rejects the ✅ reaction after the done status was saved. Pocket shows a message saying what was saved, and shows the step as done, matching Vikunja.
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('the step was never unticked again', async () => !(await task(id)).done);
    const refuse = r => r.request().method() === 'POST' ? r.fulfill({ status: 403, contentType: 'application/json', body: '{}' }) : r.fallback();
    await page.route('**/api/v2/tasks/*/reactions', refuse);
    await toastGone().catch(() => {});
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await said('step', 'couldn\'t be saved in full (it\'s marked done)');
    await page.unroute('**/api/v2/tasks/*/reactions', refuse);
    await page.waitForSelector('#run-steps .row:nth-of-type(1).done', { timeout: 15000 });
    if (!(await task(id)).done) throw new Error('the step is not done in Vikunja');
    // Pocket keeps the rejected change to retry, and the header shows a warning. An untick in the meantime waits behind it, so it can't arrive first.
    await page.waitForSelector('#btn-refresh.trouble[aria-label="1 couldn\'t be sent"]');
    await toastGone().catch(() => {});
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await said('step', 'Not sent. Vikunja refused an earlier change');
    if (!(await task(id)).done) throw new Error('the untick reached Vikunja before the tick it waits behind');
    await page.click('#btn-refresh');
    await page.waitForSelector('#outbox-rows .ob-row.failed:has-text("Done: Check the guards at 3pm"):has-text("Vikunja refused it")');
    await page.click('#outbox-rows .ob-row.failed .ob-retry');
    await page.waitForSelector('#outbox-status:has-text("Everything has reached Vikunja")', { timeout: 15000 });
    await page.click('#btn-sheet-close');
    await until('the ✅ and then the untick never arrived', async () => { const t = await task(id); return !t.done && !t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector('#btn-refresh[aria-label="Refresh"]');
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('the step was never done with a ✅', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    if (!other) return;
    // Another user skips the step, then it is unticked and done here. It counts as done, not skipped, although their
    // ⏭️ stays (only they can remove it).
    const row1 = '#run-steps .row:nth-of-type(1)', as = (path, body, method = 'POST') => call(otherToken, path, { method, body: JSON.stringify(body) });
    await page.click(`${row1} .check`);
    await until('the step was never unticked after their skip', async () => !(await task(id)).done);
    await as('/tasks/' + id, { done: true }, 'PATCH');
    await as(`/tasks/${id}/reactions`, { value: '⏭️' });
    await as(`/tasks/${id}/comments`, { comment: '<p>Skipped: it was done already</p>' });
    try {
      await page.reload();
      await page.waitForSelector(`${row1} .did[aria-label^="Skipped by ${other.name || other.username} at "]`, { timeout: 15000 })
        .catch(async () => { throw new Error('the step is not shown as skipped by the other user: ' + await page.$eval(`${row1} .did`, e => e.getAttribute('aria-label')).catch(() => 'no ✅ or ⏭️')); });
      await new Promise(r => setTimeout(r, 1100));                            // Vikunja's times are whole seconds
      await page.click(`${row1} .check`);
      await until('the skipped step was never unticked', async () => !(await task(id)).done);
      await page.click(`${row1} .check`);
      await until('the step was never done after their skip', async () => (await task(id)).done);
      await page.reload();
      await page.waitForSelector(`${row1} .did[aria-label^="Done by"]`, { timeout: 15000 })
        .catch(async () => { const t = await task(id); throw new Error(`not shown as done: ${await page.$eval(`${row1} .did`, e => e.getAttribute('aria-label')).catch(() => 'no ✅ or ⏭️')}; done_at ${t.done_at}, notes ${JSON.stringify((t.comments || []).map(c => [c.created, c.comment]))}`); });
      if (await page.$(`${row1} .meta:has-text("Skipped")`)) throw new Error('still shows as skipped');
    } finally { await as(`/tasks/${id}/reactions/delete`, { value: '⏭️' }).catch(() => {}); }
  });

  await step('claim-a-step', async () => {
    // "+ me" on a step assigns it to you. Tapping your picture removes you. A done step that nobody was assigned to shows no slot.
    const row = '#run-steps .row:nth-of-type(3)', id = (await runStep(first.id, 2)).id;
    const people = async () => ((await task(id)).assignees || []).map(u => u.id);
    if (await page.$('#run-steps .row:nth-of-type(1) .claim')) throw new Error('a done step with no one on it has a slot');
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    await until('the step was never assigned to you', async () => JSON.stringify(await people()) === JSON.stringify([me.id]));
    await page.reload();
    await page.waitForSelector(`${row} .claim.mine .av`, { timeout: 15000 });
    await page.click(`${row} .claim`);
    await page.waitForSelector(`${row} .claim .me`);
    await until('the claim was never removed', async () => !(await people()).length);
    // Offline, a claim waits to be sent like a tick, and shows as yours meanwhile.
    await context.setOffline(true);
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    await context.setOffline(false); await online();
    await until('the claim made offline never arrived', async () => JSON.stringify(await people()) === JSON.stringify([me.id]));
    await page.click(`${row} .claim`);
    await until('the claim was never removed', async () => !(await people()).length);
    if (!other) return;
    // A step assigned to someone else shows who, and tapping the picture does nothing. Done still works and adds a ✅ from whoever taps it.
    await api(`/tasks/${id}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: other.id }) });
    try {
      await page.reload();
      await page.waitForSelector(`${row} .claim[aria-disabled=true] .av`, { timeout: 15000 });
      const said = await page.getAttribute(`${row} .claim`, 'aria-label');
      if (!said.startsWith(`${other.name || other.username} is doing`)) throw new Error('the claim label is ' + said);
      // Scroll the row to the middle of the screen first. A forced click lands on whatever is at that spot, which could be the Repeat control of the add box at the bottom.
      await page.locator(row).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.click(`${row} .claim`, { force: true });                       // Playwright won't click an aria-disabled button, so force it
      await new Promise(r => setTimeout(r, 1000));
      if (JSON.stringify(await people()) !== JSON.stringify([other.id])) throw new Error('tapping the other user\'s picture changed the assignee');
      await page.click(`${row} .check`);
      await until('Done on their step has no ✅ from you', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
      await page.click(`${row} .check`);
      await until('the step was never unticked', async () => !(await task(id)).done);
    } finally { await api(`/tasks/${id}/assignees/${other.id}`, { method: 'DELETE' }); }
    await page.reload();
    await page.waitForSelector(`${row} .claim .me`, { timeout: 15000 });
  });

  /* Swiping progress on a step that nobody is doing assigns it to you when the user releases, as on a task's row.
     Swiping back to 0% keeps the step yours, and a step assigned to someone else stays theirs. A step's box is
     square. */
  await step('sliding-a-step-claims-it', async () => {
    const row = '#run-steps .row:nth-of-type(3)', id = (await runStep(first.id, 2)).id;
    const people = async () => ((await task(id)).assignees || []).map(u => u.id), pct = async () => Math.round((await task(id)).percent_done * 100);
    // Swipes from `from`% to `to`% (see swipeRow). The row is scrolled to the middle of the screen, away from the screen edges and the add box at the bottom.
    const slide = (to, from = 0, check = null) => swipeRow(page, row, to, { start: from, check });
    await page.waitForSelector(`${row} .claim .me`, { timeout: 15000 });
    const radius = await page.$eval(`${row} > .check`, el => getComputedStyle(el).borderRadius);
    if (radius !== '7px') throw new Error("a step's box isn't square: " + radius);
    try {
      await toastGone().catch(() => {});
      await slide(25, 0, async () => { await expect(page.locator(`${row} .claim .me`)).toBeVisible(); });   // 25%: becomes yours on release
      await page.waitForSelector(`${row} .claim.mine .av`);
      await until('sliding never claimed it', async () => JSON.stringify(await people()) === JSON.stringify([me.id]));
      await until('the step\'s progress never reached Vikunja', async () => await pct() === 25);
      await slide(0, 25);                                                    // back to 0%: the step stays yours
      await until('sliding back never reset the progress to 0%', async () => await pct() === 0);
      if (JSON.stringify(await people()) !== JSON.stringify([me.id])) throw new Error('sliding back to 0% removed you from the step');
      await page.click(`${row} .claim`);                                     // removing yourself takes a separate tap
      await until('the claim was never removed', async () => !(await people()).length);
      await page.waitForSelector(`${row} .claim .me`);
      if (!other) return;
      // A step assigned to someone else: sliding sets its progress, and the step stays theirs.
      await api(`/tasks/${id}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: other.id }) });
      await page.reload();
      await page.waitForSelector(`${row} .claim[aria-disabled=true] .av`, { timeout: 15000 });
      await toastGone().catch(() => {});
      await slide(25);
      await until('the step\'s progress never reached Vikunja', async () => await pct() === 25);
      await synced(page);
      if (JSON.stringify(await people()) !== JSON.stringify([other.id])) throw new Error("someone else's step was claimed: " + JSON.stringify(await people()));
      if (await page.$(`${row} .claim.mine`)) throw new Error("someone else's step shows as yours");
    } finally {
      if (other) await api(`/tasks/${id}/assignees/${other.id}`, { method: 'DELETE' }).catch(() => {});
      await api(`/tasks/${id}/assignees/${me.id}`, { method: 'DELETE' }).catch(() => {});
      await api('/tasks/' + id, { method: 'PATCH', body: JSON.stringify({ percent_done: 0 }) });
      await page.reload();
      await page.waitForSelector(`${row} .claim .me`, { timeout: 15000 });
    }
  });

  /* "+ me" appears only where someone else could take the step. A checklist in a project that nobody else can see has
     no claim slots on its steps or its card, and no picture on a step assigned to you. Sliding a step claims nothing.
     Pocket loads who can see each project when it signs in, and keeps it. smoke.mjs covers someone else's picture
     still showing there, because unsharing a project removes its people from its tasks. */
  if (other) await step('a-run-only-you-can-see-has-no-slots', async () => {
    const row = '#run-steps .row:nth-of-type(3)', id = (await runStep(first.id, 2)).id;          // the open step, shown on the card
    const people = async () => ((await task(id)).assignees || []).map(u => u.id), assign = u => api(`/tasks/${id}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: u }) });
    await assign(me.id);
    await api(`/projects/${project.id}/users/${encodeURIComponent(OTHER)}`, { method: 'DELETE' });
    try {
      await page.reload();                                                   // signs in again and loads who can see the project
      await page.waitForSelector(`${row}:not(.done)`, { timeout: 15000 });
      await expect(page.locator(`${row} .claim`), 'your picture shows, in a project only you can see').toHaveCount(0, { timeout: 20000 });
      await expect(page.locator('#step-card .claim'), 'the card has a claim slot').toHaveCount(0);
      // With no one on the step there is no "+ me", and a slide sets progress and claims nothing.
      await api(`/tasks/${id}/assignees/${me.id}`, { method: 'DELETE' });
      await page.reload();
      await page.waitForSelector(`${row}:not(.done)`, { timeout: 15000 });
      await expect(page.locator(`${row} .claim`), '"+ me" in a project only you can see').toHaveCount(0);
      await expect(page.locator('#step-card .claim')).toHaveCount(0);
      await swipeRow(page, row, 25, { check: async () => { if (await page.$(`${row} .claim`)) throw new Error('a swipe assigned someone to the step'); } });
      if (await page.$(`${row} .claim`)) throw new Error('a swipe assigned someone to the step');
      await until('the step\'s progress never reached Vikunja', async () => Math.round((await task(id)).percent_done * 100) > 0);
      await synced(page);
      if ((await people()).length) throw new Error('a slide claimed the step: ' + JSON.stringify(await people()));
    } finally {
      await api(`/projects/${project.id}/users`, { method: 'POST', body: JSON.stringify({ username: OTHER, permission: 1 }) });
      await api(`/tasks/${id}/assignees/${me.id}`, { method: 'DELETE' }).catch(() => {});
      await api('/tasks/' + id, { method: 'PATCH', body: JSON.stringify({ percent_done: 0 }) });
      await page.reload();
      await page.waitForSelector(`${row} .claim .me`, { timeout: 20000 });
    }
  });

  await step('today-shows-your-run-as-a-card', async () => {
    await page.click('nav.tabs a[data-tab=today]');
    // The card shows the checklist's name and who it is for, then its next step with that step's countdown. Its steps are not separate rows.
    const card = page.locator(cardOf(`${TEMPLATE} · #`));
    await expect(card.locator('.card-head .sr')).toContainText('For you', { timeout: 15000 });
    // The heading looks like a task card's. It shows the name without the start date, and nothing on the right
    // because the checklist has no due date.
    await expect(card.locator('.card-title')).toHaveText(dayless((await api('/tasks/' + first.id)).title));
    await expect(card.locator('.card-head .due')).toHaveCount(0);
    await expect(card.locator('.step-line .title > span:not(.sr)')).toHaveText('First article check');
    await expect(card.locator('.step-line .when .due')).toHaveText(/^in \d+[hm]( \d+m)?$/);
    await expect(card.locator('.step-line > .check')).toHaveCSS('border-radius', '6px');   // a step's box is square, while a card's row has the smaller tick
    await expect(page.locator('.item > .row .title:has-text("First article check")')).toHaveCount(0);
  });

  await step('today-run-has-no-tick-and-a-step-tick-says-who', async () => {
    const runCard = cardOf(`${TEMPLATE} · #`);
    await page.waitForSelector(`${runCard} > .card-head`, { timeout: 15000 });
    // A parent task shows a ring instead of a tick, here and in its project's list, where it is an open card with its open steps.
    await expect(page.locator(`${runCard} > .card-head > .check`)).toHaveCount(0);
    await expect(page.locator(`${runCard} > .card-head > .ring`)).toBeVisible();
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.waitForSelector(`#view ${runCard}.open > .card-head > .ring`, { timeout: 15000 });
    await expect(page.locator(`#view ${runCard} > .card-head > .check`)).toHaveCount(0);
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
    // A step ticked on its card is ticked the same as on the checklist's screen, with a ✅ from you. No message appears.
    // The step stays on the card, done, until the batch clears, so ticking it again before then undoes both.
    const check = (await runStep(first.id, 2)).id, stepRow = `${runCard} .step-line:has(> .body .title:has-text("First article check"))`;
    await toastGone().catch(() => {});
    await page.click(`${stepRow} > .check`, { timeout: 15000 });
    await until('the tick from Today has no ✅', async () => { const t = await task(check); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector(`${stepRow}.done`);
    if (await page.$('#toast.show')) throw new Error('a step ticked on Today showed a message: ' + await page.textContent('#toast-msg'));
    await page.click(`${stepRow} > .check`);
    await until('ticking the step again did not undo it', async () => { const t = await task(check); return !t.done && !t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector(`${stepRow}:not(.done)`, { timeout: 15000 });
    // The ⋯ menu opens the checklist's sheet. A step there opens its own sheet, where it can be handed over with
    // Assigned (there is no Repeats). That sheet opens the checklist on that step.
    await page.click(`${runCard} > .card-head`);
    await page.waitForFunction(id => location.hash === '#/run/' + id, first.id, { timeout: 15000 });
    await page.waitForSelector('#step-title');
    await page.click('#btn-run-more');
    await page.click('#r-open-task');
    await page.waitForSelector('#d-subtasks .row');
    // A checklist's sheet has Comments, the same as "Comments on this checklist" on its screen. Steps are added on its screen.
    await expect(page.locator('#d-comments')).toBeVisible();
    await expect(page.locator('#d-run-steps-note')).toHaveText('Open the checklist. Add a step in the box under its steps. New steps are added to this checklist only.');
    await page.click('#d-subtasks .row:nth-of-type(2) .body');
    await page.waitForSelector('#d-assignees');
    if (await page.$('#d-repeat')) throw new Error('a checklist step has a Repeats field');
    await page.click('#d-open-run');
    await page.waitForFunction(id => location.hash.startsWith(`#/run/${id}?step=`), first.id, { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("Warm up the press")', { timeout: 15000 });
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
  });

  await step('today-opens-the-run', async () => {
    // A checklist's card has a ring with the count of done steps (skipped ones too) inside it, 2 of 3, and an arc
    // showing the percentage, 67%. Its top row is its one open step, so there is no More. Its name opens the
    // checklist's screen, not its sheet, and Back returns to Today.
    const runCard = cardOf(`${TEMPLATE} · #`), ring = page.locator(`${runCard} > .card-head > .ring`);
    await page.waitForSelector(runCard, { timeout: 15000 });
    await expect(ring.locator('.n')).toHaveText('2/3');
    await expect.poll(() => ring.evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100))).toBe(67);
    await expect(page.locator(`${runCard} .card-more`)).toHaveCount(0);
    await expect(page.locator(`${runCard} .step-line .title > span:not(.sr)`)).toHaveText('First article check');
    // The header comes first, then the top row. The top row is a plain row one level in, with its tick 10px before the
    // header's title (a subtask's tick is smaller and less far in). It has no priority, so no bars.
    const stack = await page.$eval(runCard, el => ['.card-head', '.step-line'].map(s => { const r = el.querySelector(s).getBoundingClientRect(); return [r.top, r.bottom]; }));
    if (!(stack[0][1] <= stack[1][0] + 0.5)) throw new Error('the top row is not under the header: ' + JSON.stringify(stack));
    const under = await page.$eval(runCard, el => el.querySelector('.step-line > .check').getBoundingClientRect().left - el.querySelector('.card-title').getBoundingClientRect().left);
    if (Math.abs(under + 10) > 0.5) throw new Error("the top row's tick is not 10px before the header's title: " + under);
    await expect(page.locator(`${runCard} .card-head .bars`)).toHaveCount(0);
    await page.click(`${runCard} > .card-head .card-open`);
    await page.waitForFunction(id => location.hash === '#/run/' + id, first.id, { timeout: 15000 });
    if (await page.getAttribute('#btn-back', 'aria-label') !== 'Back to Today') throw new Error('the Back label is ' + await page.getAttribute('#btn-back', 'aria-label'));
    if (await page.isVisible('#sheet')) throw new Error('the sheet opened');
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
    // Tapping a step opens the checklist on that step.
    await page.click(`${runCard} .step-line > .body:has(.title:has-text("First article check"))`, { timeout: 15000 });
    await page.waitForFunction(id => location.hash.startsWith(`#/run/${id}?step=`), first.id, { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
  });

  let forOther;
  if (other) await step('a-run-for-someone-else', async () => {
    forOther = await startRun(OTHER);
    const run = await api('/tasks/' + forOther.id);
    if (JSON.stringify(run.assignees?.map(u => u.id)) !== JSON.stringify([other.id])) throw new Error('wrong assignees: ' +JSON.stringify(run.assignees?.map(u => u.username)));
    await expect(page.locator('#run-own .claim')).toHaveAttribute('aria-label', `For ${other.name || other.username}`);
    // Their Today shows the checklist. Their checklist and yours are both in progress under their Checklists tab.
    const theirs = await context.browser().newContext({ viewport: { width: 390, height: 844 } });
    await hintSeen(theirs);
    const p = await theirs.newPage();
    p.on('pageerror', e => errors.push('(other) ' + e));
    p.on('console', m => m.type() === 'error' && console.log('  (other) console:', m.text()));
    const rows = () => p.$$eval('.row .title, .card-title', els => els.map(x => x.textContent));
    // When they claim a step of your checklist, your checklist appears on their Today as a card opened on that step,
    // though it has no due date. The step is done by now, so the test marks it not done first.
    const guards = (await runStep(first.id, 0)).id;
    await api('/tasks/' + guards, { method: 'PATCH', body: JSON.stringify({ done: false }) });
    await call(otherToken, `/tasks/${guards}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: other.id }) });
    try {
      await signIn(p, otherToken);
      await p.waitForSelector(cardOf(dayless(run.title)), { timeout: 15000 });
      const mine = (await api('/tasks/' + first.id)).title;
      await p.waitForSelector(`${cardOf(dayless(mine))} .step-line .title:has-text("Check the guards at 3pm")`, { timeout: 15000 }).catch(() => { throw new Error("the checklist with their claimed step is not on their Today, opened on that step"); });
      // Your checklist's last step is due but isn't theirs, so it doesn't appear as a separate row there.
      if (await p.$('.item > .row .title:has-text("First article check")')) throw new Error('their Today lists the step: ' + JSON.stringify(await rows()));
      await p.click('nav.tabs a[data-tab=checklists]');
      await p.waitForSelector(`.cl-run .title:has-text("${mine}")`, { timeout: 15000 });   // under Checklists, with its start date
      await p.waitForSelector(`.cl-run .title:has-text("${run.title}")`, { timeout: 20000 }).catch(() => { throw new Error("their checklist is not under Checklists"); });
    } catch (e) {
      await p.screenshot({ path: `${OUT}/checklists-fail-other.png` });
      throw new Error(`${e.message.split('\n')[0]}; looking for "${run.title}", their rows: ${JSON.stringify(await rows())}`, { cause: e });
    } finally {
      await theirs.close();
      await api(`/tasks/${guards}/assignees/${other.id}`, { method: 'DELETE' }).catch(() => {});
      await api('/tasks/' + guards, { method: 'PATCH', body: JSON.stringify({ done: true }) });
    }
  });

  await step('finish-a-run', async () => {
    // Opened from Checklists, so finishing goes back there. The checklist's row there is a project row. It shows who
    // the checklist is for and its ring, which shows progress. So it has no count of done steps, no next step under
    // the title, and no line.
    await page.evaluate(() => { location.hash = '#/checklists'; });
    const runRow = `.cl-run:has(.title:has-text("${(await api('/tasks/' + first.id)).title}"))`;
    await expect(page.locator(`${runRow} .claim`)).toHaveAttribute('aria-label', 'For you', { timeout: 15000 });
    await expect(page.locator(`${runRow} .meta`)).not.toHaveText(/Next:|\d+\/\d+/);
    await expect(page.locator(`${runRow} > .ring .n`)).toHaveText('2/3');
    if (await page.$eval(runRow, el => getComputedStyle(el, '::after').content) !== 'none') throw new Error('a line shows under the checklist\'s row');
    await page.click(`.cl-run .body:has(.title:has-text("${(await api('/tasks/' + first.id)).title}"))`, { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
    await page.click('#step-done');
    await page.waitForSelector('#finish-card');
    // A skipped step isn't counted as done.
    const card = await page.textContent('#finish-card');
    if (!card.includes('Every step done or skipped') || !card.includes('2 of 3 done · 1 skipped')) throw new Error('the finish summary is wrong: ' + card);
    await page.click('#run-finish');
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
    await until('the checklist was never finished', async () => (await api('/tasks/' + first.id)).done);
    // Undo reopens the checklist and shows its screen. Then the test finishes it again.
    await page.click('#toast-act:has-text("Undo")');
    await until('Undo never reopened the checklist', async () => !(await api('/tasks/' + first.id)).done);
    await page.waitForFunction(id => location.hash === '#/run/' + id, first.id, { timeout: 15000 });
    await page.click('#run-finish', { timeout: 15000 });
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
    await until('the checklist was never finished again', async () => (await api('/tasks/' + first.id)).done);
    await page.waitForSelector(`.cl-done .title:text-is("${(await api('/tasks/' + first.id)).title}")`, { timeout: 15000 });
    if (await page.isVisible(`.cl-run:has(.title:has-text("${(await api('/tasks/' + first.id)).title}"))`)) throw new Error('the checklist is still in progress');
  });

  let third;
  await step('last-time-and-undo-a-start', async () => {
    third = await startRun();
    await page.waitForSelector('#run-last .comment:has-text("Press 2 is down")', { timeout: 15000 });
    for (const note of ['Looks good', 'Line 2 ran slow today']) await page.waitForSelector(`#run-last .comment:has-text("${note}")`);
    // The Undo message stays at the top of the checklist until any step is done. It doesn't repeat the checklist's name, which is already in the header.
    await expect(placeLine(page, 'run').locator('.what')).toHaveText('Started');
    await placeLine(page, 'run').getByRole('button', { name: 'Undo' }).click();
    await expect(page).toHaveURL(/#\/checklists$/, { timeout: 15000 });
    await synced(page);
    if (((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).some(t => t.id === third.id)) throw new Error('the checklist is still in Vikunja');
    runs.splice(runs.indexOf(third.id), 1);
  });

  const newRun = async () => {
    const id = ((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).map(t => t.id).filter(id => !runs.includes(id)).pop();
    runs.push(id);
    if ((await subtasks(id)).length !== 3) throw new Error('wrong number of steps: ' + (await subtasks(id)).length);
    return id;
  };
  const openStart = async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${tplRow} .cl-start`, { timeout: 15000 });
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
  };

  await step('name-a-run-then-delete-it', async () => {
    // The name typed at the start replaces the "#3" in the title. ⋯ → Delete removes the checklist and its steps.
    await openStart();
    const called = async () => (await page.textContent('#start-title')).match(/Called “([^”]*)”/)?.[1] || await page.textContent('#start-title');
    if (!RUN_TITLE(TEMPLATE).test(await called())) throw new Error('the start sheet shows ' + await page.textContent('#start-title'));
    await page.fill('#start-name', 'Night shift');
    if (!RUN_TITLE(TEMPLATE, 'Night shift').test(await called())) throw new Error('the start sheet shows ' + await page.textContent('#start-title'));
    await page.click('#start-go');
    await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
    const id = +(await page.evaluate(() => location.hash)).split('/').pop();
    await page.waitForSelector('#step-title', { timeout: 15000 });
    const run = await api('/tasks/' + id), steps = (run.related_tasks?.subtask || []).map(s => s.id);
    if (!RUN_TITLE(TEMPLATE, 'Night shift').test(run.title)) throw new Error('the checklist title is wrong: ' + run.title);
    if (steps.length !== 3) throw new Error('wrong number of steps: ' + steps.length);
    // The ⋯ menu has the checklist's name and who it is for.
    await toastGone();
    await page.click('#btn-run-more');
    if (await page.inputValue('#r-name') !== 'Night shift') throw new Error('the name field shows ' + await page.inputValue('#r-name'));
    await page.fill('#r-name', 'Day shift');
    await page.press('#r-name', 'Enter');
    await until('the checklist was never renamed', async () => RUN_TITLE(TEMPLATE, 'Day shift').test((await api('/tasks/' + id)).title));
    if (other) {
      // Assign it to them as well, then to them only.
      const forIds = async () => JSON.stringify((await api('/tasks/' + id)).assignees?.map(u => u.id).sort((a, b) => a - b));
      await page.click(`#r-for .chip[data-user="${OTHER}"]`);
      await until('the checklist was never also assigned to them', async () => await forIds() === JSON.stringify([me.id, other.id].sort((a, b) => a - b)));
      await page.click(`#r-for .chip[data-user="${me.username}"]`);
      await until('the checklist was never assigned to them only', async () => await forIds() === JSON.stringify([other.id]));
    }
    await page.click('#btn-sheet-close');
    // Last time opens the checklist that was finished before. It can be viewed but not ticked, and reopened from its ⋯ menu.
    await page.click('#run-last-open', { timeout: 15000 });
    await page.waitForFunction(fid => location.hash === '#/run/' + fid, first.id, { timeout: 15000 });
    await page.waitForSelector('#run-steps .row .check[disabled]', { timeout: 15000 });
    if (await page.isVisible('#step-done')) throw new Error('a finished checklist can be ticked');
    await expect(page.locator('#capture')).toBeHidden();                    // and no steps can be added: no add box at the bottom
    await page.click('#btn-run-more');
    await page.waitForSelector('#r-reopen');
    await page.click('#btn-sheet-close');
    await page.evaluate(rid => { location.hash = '#/run/' + rid; }, id);
    await page.waitForSelector('#step-title', { timeout: 15000 });
    await toastGone();
    await page.click('#btn-run-more');
    await expect(page.locator('#r-delete + .note')).toHaveText(/^Deletes the checklist and its \d+ steps, with their comments and photos, for everyone\.$/);
    await page.click('#r-delete');
    await toast('Checklist deleted');
    await expect(page).toHaveURL(/#\/checklists$/, { timeout: 15000 });
    await synced(page);
    const gone = async tid => { const r = await fetch(SERVER + '/api/v2/tasks/' + tid, { headers: { Authorization: 'Bearer ' + TOKEN } }); return r.status === 404 || r.status === 403; };
    if (!(await Promise.all([id, ...steps].map(gone))).every(Boolean)) throw new Error('the checklist or a step is still in Vikunja');
  });

  /* A checklist is one row on its project's list, as under Checklists. Its steps are not listed under it or counted in
     Open, and its row shows who it is for, not the steps done or the next step. Templates, their steps and
     checklist steps stay out of Done too. */
  await step('a-run-finished-from-its-ring-in-its-project', async () => {
    // On its project's list, a checklist in progress is an open card, and its steps that are not done are its rows.
    // Tapping the ring first asks for confirmation, naming those steps in a sentence. Then it finishes the checklist
    // through the outbox, as the Finish button does, and leaves the steps as they are. The card stays where it is,
    // shown done, and tapping the ring again reopens it.
    const { id } = await startRun();
    const title = (await api('/tasks/' + id)).title, want = (await subtasks(id)).map(s => s.title);
    // Reads the project's group headed `name`: its heading, its count, and the titles of its rows and cards (including the rows inside a card).
    const group = name => page.evaluate(name => {
      const sec = [...document.querySelectorAll('#view .sec')].find(s => s.textContent.trim().startsWith(name)), g = sec.parentElement;
      const titles = [...g.querySelectorAll('.list :is(.row > .body .title > span:not(.sr), .card-head .card-title)')];
      return { head: sec.textContent.trim(), n: +(sec.querySelector('.n')?.textContent || 0), titles: titles.map(t => t.textContent.trim()) };
    }, name);
    try {
      await page.evaluate(pid => { location.hash = '#/project/' + pid; }, project.id);
      await loaded(page);
      await page.click('#btn-refresh');                                       // load the rows from Vikunja, not the saved copy shown first
      await page.waitForSelector('#btn-refresh:not([disabled])');
      const card = page.locator(`#view ${cardOf(dayless(title))}`), ring = card.locator('.card-head > .ring');
      await expect(card).toHaveClass(/\bopen\b/, { timeout: 15000 });
      await expect(card.locator('.card-head .sr')).toContainText('For you');
      await expect(card.locator('.card-rows > .row .title > span:not(.sr)')).toHaveText(want);
      await expect(ring.locator('.n')).toHaveText('0/3');
      // The steps are on the card, not separate rows. Open counts every open task listed, the checklist and its steps.
      const open = await group('Open');
      if (open.n !== open.titles.length) throw new Error(`Open says ${open.n}, with ${open.titles.length} listed: ${open.titles.join(' | ')}`);
      await toastGone().catch(() => {});
      await ring.click();
      await expect(page.locator('#complete h2')).toHaveText('Finish this checklist with 3 steps not done?');
      await expect(page.locator('#complete-note')).toHaveText(`These 3 steps stay not done: ${want[0]}, ${want[1]} and ${want[2]}.`);
      await expect(page.locator('#complete-open-run')).toBeVisible();
      await page.click('#complete-yes');
      await until('the checklist was never finished', async () => (await api('/tasks/' + id)).done);
      if ((await subtasks(id)).some(x => x.done)) throw new Error('finishing the checklist ticked a step');
      // The card stays in place, shown as done with its title struck through and no gap, until the batch clears. Tapping its ring reopens it.
      await expect(card).toHaveClass(/\bdone\b/);
      await expect(card.locator('.del-gap')).toHaveCount(0);
      await synced(page);
      await ring.click();
      await until('tapping the ring never reopened the checklist', async () => !(await api('/tasks/' + id)).done);
      await expect(card).not.toHaveClass(/\bdone\b/);
      // When finished again, the card leaves the list with the batch and moves to Done, as a task does. Its steps that
      // are not done don't stay on the list.
      await synced(page);
      await ring.click();
      await page.click('#complete-yes');
      await until('the checklist was never finished again', async () => (await api('/tasks/' + id)).done);
      await later(3000);
      await expect(card).toHaveCount(0);
      /* Done isn't counted until it is opened. Most of the done tasks in a project for checklists are template steps
         and checklist steps, which Done leaves out. Once opened, Done lists the checklist, and its count matches the
         rows shown. It lists no template, no template step (whose times are written raw, like T#30m) and no
         checklist step. */
      await expect(page.locator('#sec-done')).toHaveText('Done');
      await page.click('#sec-done');
      await page.waitForSelector(`#view .row.done:has(> .body .title:has-text("${title}"))`, { timeout: 15000 });
      await expect(page.locator('#sec-done')).toContainText(/Done \(\d+\)/);
      const done = await group('Done'), n = +done.head.match(/\((\d+)\)/)[1];
      const stray = done.titles.filter(t => t === TEMPLATE || /^TEMPLATE/i.test(t) || /T#|\{#/.test(t) || STEPS.includes(t) || want.includes(t));
      if (stray.length) throw new Error('Done lists tasks it should leave out: ' + stray.join(' | '));
      if (n !== done.titles.length) throw new Error(`Done says ${n}, with ${done.titles.length} rows`);
      await page.click('#sec-done');                                          // collapse it again, as the next steps expect
    } finally {
      for (const x of await subtasks(id)) await api('/tasks/' + x.id, { method: 'DELETE' }).catch(() => {});
      await api('/tasks/' + id, { method: 'DELETE' }).catch(() => {});
    }
  });

  /* Templates and their steps stay out of search. They live on Checklists, and as Vikunja tasks marked done they would
     fill Done, with their times written raw. A checklist step found in search has no 🔔, because its reminder
     belongs to Pocket and drives the countdown its row shows. */
  await step('templates-out-of-search-and-no-bell-on-a-step', async () => {
    const { id } = await startRun();
    const runTitle = (await api('/tasks/' + id)).title, [guards, warm] = await subtasks(id);
    const titles = () => page.$$eval('#view :is(.row > .body .title, .card-title)', ts => ts.map(t => t.textContent.trim()));
    try {
      await api('/tasks/' + guards.id, { method: 'PATCH', body: JSON.stringify({ done: true }) });
      await until('the next step never got its due time and reminder', async () => ((await api('/tasks/' + warm.id)).reminders || []).some(r => Date.parse(r.reminder) > Date.now()));
      await page.click('#btn-search');
      // The template's name finds its checklists (cards, with their steps that are not done), not the template.
      await page.fill('#in-search', TEMPLATE);
      await page.waitForSelector(`#view ${cardOf(dayless(runTitle))}`, { timeout: 15000 });
      if ((await titles()).includes(TEMPLATE)) throw new Error('the template is in search: ' + (await titles()).join(' | '));
      // A step's text finds the checklists' steps, not the template's, and a checklist step that is counting down has no 🔔.
      const stepRow = `#view .row:has(> .body .title:has-text("Warm up the press")):has(.meta:has-text("${runTitle}"))`;
      await page.fill('#in-search', 'Warm up the press');
      await page.waitForSelector(stepRow, { timeout: 15000 });
      const raw = (await titles()).filter(t => /T#|\{#/.test(t));
      if (raw.length) throw new Error('a template\'s step in search: ' + raw.join(' | '));
      await expect(page.locator(`${stepRow} .meta .due`)).toHaveText(/^in (30|29)m$/);
      await expect(page.locator(`${stepRow} [aria-label="A reminder is still to come"]`)).toHaveCount(0);
    } finally {
      await page.click('#btn-search-cancel').catch(() => {});
      for (const x of await subtasks(id)) await api('/tasks/' + x.id, { method: 'DELETE' }).catch(() => {});
      await api('/tasks/' + id, { method: 'DELETE' }).catch(() => {});
    }
  });

  await step('start-offline-waits', async () => {
    await openStart();
    await context.setOffline(true);
    await page.click('#start-go');
    await said('checklists', 'starts as soon as Pocket reaches Vikunja');
    await page.waitForSelector(`.cl .row.pending:has-text("Starting ${TEMPLATE}"):has-text("Waiting for a connection")`);
    await context.setOffline(false);
    await page.waitForSelector('.cl .row.pending', { state: 'detached', timeout: 30000 });
    await newRun();
  });

  await step('cancel-a-start-that-waits', async () => {
    const before = ((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).length;
    await toastGone();
    await openStart();
    await page.fill('#start-name', 'Never');
    await context.setOffline(true);
    await page.click('#start-go');
    await said('checklists', 'starts as soon as Pocket reaches Vikunja');
    const waiting = `.cl .row.pending:has-text("Starting ${TEMPLATE} ·"):has-text("· Never")`;   // "Starting Startup · Oct 12 · Never"
    await page.waitForSelector(`${waiting}:has-text("For you")`);
    await page.click(`${waiting} button[aria-label^="Don't start"]`);
    await page.waitForSelector(waiting, { state: 'detached' });
    await context.setOffline(false);
    await online();
    await page.waitForTimeout(2000);
    const after = ((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).length;
    if (after !== before) throw new Error(`checklists: ${before} before, ${after} after`);
  });

  await step('cancel-a-start-whose-copy-was-made', async () => {
    // The checklist's copy reaches Vikunja but the reply doesn't, and the start is cancelled without a connection. Once
    // Pocket reaches Vikunja, it finds and deletes the copy, so no half-made checklist is left looking like a second template.
    const copies = async () => ((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).length;
    const before = await copies();
    let first = true;
    const lose = async r => { if (r.request().method() !== 'POST') return r.fallback(); if (first) { first = false; await r.fetch(); } return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/tasks/*/duplicate', lose);
    await toastGone();
    await openStart();
    await page.fill('#start-name', 'Called off');
    await page.click('#start-go');
    await said('checklists', 'starts as soon as Pocket reaches Vikunja');
    await until('the copy never reached Vikunja', async () => await copies() === before + 1);
    await context.setOffline(true);
    const waiting = `.cl .row.pending:has-text("Starting ${TEMPLATE} ·"):has-text("· Called off")`;
    await page.click(`${waiting} button[aria-label^="Don't start"]`);
    await page.waitForSelector(waiting, { state: 'detached' });
    await page.unroute('**/api/v2/tasks/*/duplicate', lose);
    await context.setOffline(false);
    await online();
    await until('the copy is still in Vikunja', async () => await copies() === before, 40000);
  });

  await step('start-cut-off-is-not-copied-twice', async () => {
    // A step's copy reaches Vikunja but the reply doesn't. The start continues later without making a second copy.
    const copies = async () => Promise.all((await subtasks(template.id)).map(async s => ((await api('/tasks/' + s.id)).related_tasks?.copiedto || []).length));
    const before = await copies();
    let cut = true, seen = 0;
    const lose = async r => { if (!cut || r.request().method() !== 'POST' || ++seen < 2) return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/tasks/*/duplicate', lose);                  // the checklist's own copy goes through, and the reply to its first step's copy is lost
    await toastGone();
    await openStart();
    await page.click('#start-go');
    await said('checklists', 'starts as soon as Pocket reaches Vikunja');
    await online();
    await page.waitForSelector('.cl .row.pending', { state: 'detached', timeout: 30000 });
    await page.unroute('**/api/v2/tasks/*/duplicate', lose);
    const after = await copies();
    if (after.some((n, i) => n !== before[i] + 1)) throw new Error(`copies of each step: ${before} before, ${after} after`);
    await newRun();
  });

  await step('ticks-and-notes-offline', async () => {
    const run = runs[runs.length - 1];
    await page.evaluate(id => { location.hash = '#/run/' + id; }, run);
    await page.waitForSelector('#step-title:text-is("Check the guards at 3pm")', { timeout: 15000 });
    await context.setOffline(true);
    // The tick is made 8 seconds in the past on the page's clock, so Vikunja receives it well after it was made.
    await page.clock.setSystemTime(Date.now() - 8000);
    await page.click('#step-done');
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .check.wait');
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .did.waiting[aria-label$="waiting to send"]');
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (30|29)m$")');    // counts from the tick made here
    await page.fill('#step-note', 'Written offline');
    await page.click('#step-note-form button');
    await page.waitForSelector('#step-extra .comment:has-text("Written offline"):has-text("Waiting to send")');
    await page.reload();                                                     // as if the phone closed the app
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .check.wait', { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    await page.clock.setSystemTime(Date.now());
    // Dispatch the online event, as the other steps do. After a reload while offline, Chrome's offline emulation can
    // leave the page thinking it is already online, so it never hears the connection return.
    await context.setOffline(false);
    await online();
    await page.waitForSelector('#run-steps .row:nth-of-type(1):not(:has(.check.wait))', { timeout: 20000 });
    const id = (await runStep(run, 0)).id, step2 = (await runStep(run, 1)).id;
    await until('the tick never reached Vikunja', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    // After sending, the steps timed from this tick still count from the tick made here, not from when Vikunja received it.
    await until('the countdown jumped to when Vikunja got the tick', async () => {
      const shown = await page.evaluate(() => Alpine.$data(document.body).runView?.steps[0].doneAt), t = await task(id);
      return !!shown && Date.parse(t.done_at) - Date.parse(shown) > 4000;
    });
    await until('the note never reached Vikunja', async () => ((await task(step2)).comments || []).filter(c => c.comment.includes('Written offline')).length === 1);
  });

  await step('note-whose-reply-is-lost-is-posted-once', async () => {
    const run = runs[runs.length - 1], id = (await runStep(run, 1)).id;
    let cut = true;
    const lose = async r => { if (!cut || r.request().method() !== 'POST') return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/tasks/*/comments', lose);
    await page.fill('#step-note', 'Said once');
    await page.click('#step-note-form button');
    await online();
    await until('the note never reached Vikunja', async () => ((await task(id)).comments || []).some(c => c.comment.includes('Said once')));
    await page.waitForSelector('#step-extra .comment:has-text("Said once"):not(:has-text("Waiting to send"))', { timeout: 20000 });
    const n = ((await task(id)).comments || []).filter(c => c.comment.includes('Said once')).length;
    if (n !== 1) throw new Error(n + ' copies of the note');
    await page.unroute('**/api/v2/tasks/*/comments', lose);
  });

  /* A photo waiting to upload to a checklist step has "Don't upload", as a photo waiting on a task has. Cancelling
     a photo removes it at once and it never reaches Vikunja. The other photo uploads. */
  await step('a-photo-waiting-on-a-step-can-be-called-off', async () => {
    const run = runs[runs.length - 1], id = (await runStep(run, 1)).id;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const photo = name => ({ name, mimeType: 'image/png', buffer: png });
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    await context.setOffline(true);
    await page.setInputFiles('#step-file', [photo('keep.png'), photo('drop.png')]);
    await page.waitForSelector('#step-extra .att.uploading:has-text("keep.png"):has-text("Waiting for a connection")');
    await page.getByRole('button', { name: 'Don\'t upload drop.png' }).click();
    await expect(page.locator('#step-extra .att:has-text("drop.png")')).toHaveCount(0);
    await expect(page.locator('#step-extra .att.uploading')).toHaveCount(1);
    await context.setOffline(false);
    await online();
    await until('the photo kept never reached Vikunja', async () => ((await task(id)).attachments || []).some(a => a.file.name === 'keep.png'));
    await expect(page.locator('#step-extra .att.uploading')).toHaveCount(0, { timeout: 20000 });
    const names = ((await task(id)).attachments || []).map(a => a.file.name);
    if (names.join() !== 'keep.png') throw new Error('the step has the wrong attachments: ' + names.join());
  });

  await step('insert-and-repeat-a-step', async () => {
    // The add box at the bottom inserts a step after the step shown on the card, and a line above the box says so. The
    // next step typed goes after that one. Repeat adds a fresh copy of the step above the box, right after that step.
    // Neither changes the template.
    const { id } = await startRun(), tplSteps = (await subtasks(template.id)).length;
    const titles = async () => (await subtasks(id)).map(s => s.title).join(' | ');
    // The box is at the end of the steps, and the screen has no bar at the bottom. What is typed there goes after the
    // last step. After a nudge (a short drag) on a step, the box moves under that step and what is typed goes after
    // that step. `what` is the step on the card.
    const box = '#run-in', what = page.locator('#step-title'), go = '#run-box form .go';
    const add = async text => { await page.fill(box, text); await page.press(box, 'Enter'); };
    await page.click('#step-done');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    // The rows have no › button, and their ticks are at their left edge. The box is at the bottom, and the ↑ button is disabled while the box is empty.
    const [rowBox, tickBox] = await Promise.all(['', ' > .check'].map(s => page.locator('#run-steps .row:nth-of-type(1)' + s).boundingBox()));
    if (tickBox.x - rowBox.x > 24) throw new Error(`the tick is ${tickBox.x - rowBox.x}px in from the row's edge`);
    await expect(page.locator('#run-box')).not.toHaveClass(/\binline\b/);
    await expect(page.locator(box)).toHaveAttribute('placeholder', 'Add steps, or paste a list');
    await expect(page.locator(box)).toHaveAttribute('aria-label', 'Add steps');
    if (!await page.isDisabled(go)) throw new Error('the ↑ button works with nothing in the box');
    // Tapping a done step's row puts it on the card, and the box stays at the bottom. After a nudge, the box sits under
    // that row to add after it, and its position at the bottom stays, shown dashed.
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await expect(what).toHaveText('Check the guards at 3pm');
    await expect(page.locator('#run-box')).not.toHaveClass(/\binline\b/);
    await touchDrag('#run-steps .row:nth-of-type(1)', 30);
    await expect(page.locator('#run-box')).toHaveClass(/\binline\b/);
    await expect(page.locator(box)).toHaveAttribute('placeholder', 'Step');
    await expect(page.locator('#run-box-place')).toBeVisible();
    await page.fill(box, 'Draft');
    await page.press(box, 'Alt+ArrowDown');
    await expect(page.locator('#run-steps .row:nth-of-type(2)')).toHaveClass(/sub-boxed/);
    await page.press(box, 'Alt+ArrowUp');
    await expect(page.locator('#run-steps .row:nth-of-type(1)')).toHaveClass(/sub-boxed/);
    await expect(page.locator(box)).toHaveValue('Draft');
    await expect(page.locator(box)).toBeFocused();
    await add('Wipe the oil off the floor');
    // The new step appears at once, right after the nudged step. The box is empty, focused and under the new step, ready for the next one.
    await page.waitForSelector('#run-steps .row:nth-of-type(2):has-text("Wipe the oil off the floor")');
    await expect(page.locator(box)).toHaveValue('');
    await expect(page.locator(box)).toBeFocused();
    await expect(page.locator('#run-box')).toHaveClass(/\binline\b/);
    await expect(page.locator('#step-title')).toHaveText('Check the guards at 3pm');                // the card keeps showing the same step
    await until('the step was not inserted before Warm up the press', async () => await titles() === 'Check the guards at 3pm | Wipe the oil off the floor | Warm up the press | First article check');
    const inserted = await api('/tasks/' + (await runStep(id, 1)).id);
    if (!/pocket:added/.test(inserted.description) || inserted.related_tasks?.copiedfrom?.length || inserted.done) throw new Error('the inserted step is wrong: ' + JSON.stringify(inserted.description));
    await page.click('#run-steps .row:nth-of-type(2) .body');
    await page.waitForSelector('#step-added:text-is("Inserted")', { timeout: 15000 });
    // The step after the inserted one still counts from the template step before the inserted one.
    await page.waitForSelector('#run-steps .row:nth-of-type(3) .meta .due span:text-matches("^Due in (30|29)m$")');
    // Repeat copies the step above the box. After a nudge puts the box under the first step, Repeat adds a copy of
    // that step, not done, at once, right after it. An Undo button appears by the box.
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await touchDrag('#run-steps .row:nth-of-type(1)', 30);
    await page.getByRole('button', { name: 'Repeat “Check the guards at 3pm”' }).click();
    await page.waitForSelector('#run-steps .row:nth-of-type(2):has-text("Check the guards at 3pm")');
    await expect(what).toHaveText('Check the guards at 3pm');
    const runLine = page.locator('#run-box .place-line');                  // the message in the box (the bottom bar is hidden here and has a copy)
    await expect(runLine).toContainText('Repeated “Check the guards at 3pm”');
    await until('the step was not repeated after the first step', async () => await titles() === 'Check the guards at 3pm | Check the guards at 3pm | Wipe the oil off the floor | Warm up the press | First article check');
    const [orig, copy] = await Promise.all([0, 1].map(async i => task((await runStep(id, i)).id)));
    if (copy.done || copy.reactions?.['✅']?.length || copy.related_tasks?.copiedfrom?.[0]?.id === orig.id) throw new Error('the copy has the original step\'s history');
    if (!/pocket:added/.test(copy.description) || !copy.description.includes('pocket:step Check the guards at 3pm')) throw new Error('the copy is wrong: ' + copy.description);
    if ((await subtasks(template.id)).length !== tplSteps) throw new Error('the template changed');
    // Repeat again, then Undo. The second copy is deleted, and the box points after the first copy again.
    await toastGone().catch(() => {});
    await page.getByRole('button', { name: 'Repeat “Check the guards at 3pm”' }).click();
    await page.waitForSelector('#run-steps .row:nth-of-type(3):has-text("Check the guards at 3pm")');
    await runLine.getByRole('button', { name: 'Undo' }).click();
    await page.waitForSelector('#run-steps .row:nth-of-type(3):has-text("Wipe the oil off the floor")', { timeout: 15000 });
    await until('the repeated step is still there after Undo', async () => (await titles()).split('Check the guards at 3pm').length === 3);
    await expect(what).toHaveText('Check the guards at 3pm');
    // Putting another step on the card makes the box point after that step.
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await expect(what).toHaveText('Wipe the oil off the floor');
    // The order stays after a reload, and each added step keeps its Repeated or Inserted label.
    await page.reload();
    await page.waitForSelector('#run-steps .row:nth-of-type(2) .meta .added span:text-is("Repeated")', { timeout: 15000 });
    await page.waitForSelector('#run-steps .row:nth-of-type(3) .meta .added span:text-is("Inserted")');
    // A step added by mistake can be deleted until it is done. Swiping it all the way left asks for confirmation
    // before the row is removed. The test answers no in the page, and the row comes back.
    const ins = '#run-steps .row:nth-of-type(3)';
    await page.locator(ins).evaluate(row => {
      window.__asked = []; window.__confirm = window.confirm;
      window.confirm = q => { window.__asked.push({ q, x: new DOMMatrix(getComputedStyle(row).transform).m41, w: row.clientWidth, moving: row.getAnimations().length }); return false; };
    });
    try {
      await swipeRow(page, ins, 'delete');
      await expect.poll(() => page.evaluate(() => window.__asked.length)).toBe(1);
      const a = (await page.evaluate(() => window.__asked))[0];
      if (!a.q.startsWith('Delete “Wipe the oil off the floor”?') || a.x > -a.w / 2 || a.moving) throw new Error('the confirmation appeared after the row had moved: ' + JSON.stringify(a));
      await expect(page.locator(ins)).not.toHaveClass(/\bswip/);
      await expect(uncovered(page, '.row-red')).toHaveCount(0);
    } finally { await page.evaluate(() => { window.confirm = window.__confirm; }); }
    if (!(await titles()).includes('Wipe the oil')) throw new Error('the step was deleted although the confirmation was refused');
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await page.click('#step-delete');
    await expect(page.locator('.place-line', { hasText: 'Step deleted' })).toBeVisible();   // the message shows in its sheet or on the checklist screen
    await until('the inserted step is still there', async () => !(await titles()).includes('Wipe the oil'));
    // If the reply is lost, the step is inserted once only.
    let cut = true;
    const lose = async r => { if (!cut || r.request().method() !== 'POST') return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/projects/*/tasks', lose);
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await expect(what).toHaveText('Check the guards at 3pm');
    await add('Sweep up');
    await online();
    await until('the step was never inserted after its reply was lost', async () => (await titles()).includes('Sweep up'));
    await page.unroute('**/api/v2/projects/*/tasks', lose);
    if ((await titles()).split('Sweep up').length !== 2) throw new Error('the step was inserted twice: ' + await titles());
    // Offline, the new step appears in its position after the previous step, waiting to send, and is ticked meanwhile.
    // Both reach Vikunja when the connection returns. (A new step goes where the box points, not onto the card.
    // Tapping the step puts it on the card.)
    await page.waitForSelector('#run-steps .row:has-text("Sweep up")', { timeout: 15000 });   // after the last step, because the box is at the bottom
    await context.setOffline(true);
    await add('Offline step');
    await page.waitForSelector('#run-steps .row:has-text("Offline step")');
    await page.click('#run-steps .row:has-text("Offline step") > .body');
    await page.waitForSelector('#step-added:text-is("Inserted · waiting to send")');
    await page.click('#step-done');
    await page.waitForSelector('#run-steps .row:has-text("Offline step") .check.wait');
    await context.setOffline(false);
    await online();
    await until('the step inserted offline, and its tick, never reached Vikunja', async () => {
      const s = (await subtasks(id)).find(x => x.title === 'Offline step');
      if (!s) return false;
      const t = await task(s.id);
      return t.done && t.reactions?.['✅']?.some(u => u.id === me.id);
    }, 30000);
    const order = (await titles()).split(' | ');
    if (order.indexOf('Offline step') !== order.indexOf('Sweep up') + 1) throw new Error('the step is not where it was added: ' + order.join(' | '));
    // Cancelling a step from Waiting to send leaves nothing of it, even though Pocket tried to send it before the
    // connection dropped. The box points at the card's step again.
    await context.setOffline(true);
    await add('Not after all');
    await page.waitForSelector('#run-steps .row:has-text("Not after all")');
    await page.waitForSelector('#btn-refresh.waits', { timeout: 5000 });
    await page.click('#btn-refresh');
    await page.click('#outbox-rows .ob-row:has-text("Not after all") .ob-drop');
    await page.waitForSelector('#run-steps .row:has-text("Not after all")', { state: 'detached' });
    await page.click('#btn-sheet-close');
    await expect(page.locator('#run-box')).not.toHaveClass(/\binline\b/);  // the box is back at the bottom
    await context.setOffline(false);
    await online();
    await synced(page);                                                      // nothing is left waiting, including the cancelled step
    if ((await titles()).includes('Not after all')) throw new Error('the cancelled step was inserted anyway: ' + await titles());
    if ((await api('/tasks?q=' + encodeURIComponent('Not after all'))).items.some(t => t.title === 'Not after all')) throw new Error('left as a separate task');
    // Quick add works as in the subtask box. It shows chips and marks but reads no date, because a step's time comes
    // from its template. A pasted list becomes one step per line, in order.
    await page.fill(box, 'Mop up !3 tomorrow');
    await page.waitForSelector('#run-box-chips .chip:has-text("Priority 3")');
    await page.waitForSelector('#run-box .cap-marks mark[data-kind="priority"]', { state: 'attached' });
    if (await page.$('#run-box-chips .chip[data-kind="due"]')) throw new Error('the add box read a date');
    await page.fill(box, 'Mop up !3 tomorrow\nRinse the mop');
    await page.waitForSelector('#run-box-chips .chip:has-text("2 steps")');
    await page.press(box, 'Enter');
    await until('the pasted steps were never inserted', async () => (await titles()).includes('Mop up tomorrow | Rinse the mop'));
    const mop = (await subtasks(id)).find(s => s.title === 'Mop up tomorrow');
    if ((await api('/tasks/' + mop.id)).priority !== 3) throw new Error('the step\'s priority was not read');
    // A nudge on a step's row (a short, slow scroll that starts on it) moves the box under that row. The card keeps
    // its step, which only a tap on a row changes. A longer drag only scrolls.
    const rowOf = t => `#run-steps .row:has-text("${t}") >> nth=0`, sweep = rowOf('Sweep up'), guards = rowOf('Check the guards at 3pm');   // the guards step was repeated, so use its first row
    const onCard = await what.textContent();
    await page.locator(sweep).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await touchDrag(sweep, 30);
    await expect(page.locator(sweep)).toHaveClass(/sub-boxed/);
    await expect(page.locator('#run-box')).toHaveClass(/\binline\b/);
    await expect(what).toHaveText(onCard);
    await touchDrag(guards, 150, 30);                                        // further than a row, so it is a scroll
    await expect(page.locator(guards)).not.toHaveClass(/sub-boxed/);
    await touchDrag(guards, 30);
    await expect(page.locator(guards)).toHaveClass(/sub-boxed/);
    await expect(what).toHaveText(onCard);
  });

  await step('add-a-step-after-the-last', async () => {
    // With every step done and the checklist not finished, the box points at the last step, and what is added goes at the end.
    const { id } = await startRun();
    for (const t of ['Warm up the press', 'First article check']) { await page.click('#step-done'); await page.waitForSelector(`#step-title:text-is("${t}")`); }
    await page.click('#step-done');
    await page.waitForSelector('#finish-card');
    await expect(page.locator('#run-in')).toHaveAttribute('placeholder', 'Add steps, or paste a list');
    await page.fill('#run-in', 'Lock the back door');
    await page.press('#run-in', 'Enter');
    await page.waitForSelector('#step-title:text-is("Lock the back door")', { timeout: 15000 });
    await until('the step was not added at the end', async () => (await subtasks(id)).map(s => s.title).pop() === 'Lock the back door');
  });

  await step('a-run-and-its-card-open-on-its-next-step-in-order', async () => {
    // A checklist's screen and its card on Today open on the same step (`whereNext`). That is the next open step in
    // order, even one that is counting down, but a timed step whose time has arrived comes before it. Here the guards
    // are done and the press and the check count down. The press is next, not the step added after them.
    const { id } = await startRun();
    await page.click('#step-done');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await expect(page.locator('#step-title')).toHaveText('First article check');
    await page.fill('#run-in', 'Sweep the floor');
    await page.press('#run-in', 'Enter');
    await until('the step was never added', async () => (await subtasks(id)).length === 4);
    await until('the times were never set', async () => (await Promise.all((await subtasks(id)).slice(1, 3).map(s => task(s.id)))).every(t => !t.due_date.startsWith('0001')));
    await synced(page);
    await page.reload();
    await page.waitForSelector('#step-title:text-is("Warm up the press")', { timeout: 15000 });
    await expect(page.locator('#step-card .step-due')).toHaveText(/^Due in /);
    await expect(page.locator('#run-steps .row.current .title')).toHaveText('Warm up the press');
    const title = (await api('/tasks/' + id)).title, card = cardOf(dayless(title));
    await page.click('nav.tabs a[data-tab=today]');
    await expect(page.locator(`${card} .step-line .title > span:not(.sr)`)).toHaveText('Warm up the press', { timeout: 15000 });
    await expect(page.locator(`${card} .step-line .when .due`)).toHaveText(/^in \d+[hm]/);
    // When the check's time arrives (moved back by hand here), it comes first, on Today and on the checklist's screen.
    const check = (await runStep(id, 2)).id;
    await api('/tasks/' + check, { method: 'PATCH', body: JSON.stringify({ due_date: new Date(Date.now() - 60000).toISOString() }) });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await expect(page.locator(`${card} .step-line .title > span:not(.sr)`)).toHaveText('First article check', { timeout: 15000 });
    await page.click(`${card} > .card-head .card-open`);
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
  });

  await step('swipe-a-step-to-set-its-progress', async () => {
    // As on a task's row, a plain swipe sets progress in steps of 25% and is sent like a tick. A full swipe is Done,
    // with its ✅, the same as tapping its box. Last time's notes arrive late in this test, after the checklist is on
    // screen. A step's notes are shown on its card, above the steps. Late notes are not added to the card on screen,
    // so nothing moves while the user is touching it.
    const last = ((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).filter(x => x.done).sort((a, b) => Date.parse(b.done_at) - Date.parse(a.done_at))[0];
    const lastNotes = `**/api/v2/tasks/${last.id}?expand=comments`, slow = async r => { await new Promise(ok => setTimeout(ok, 1500)); await r.fallback(); };
    await page.route(lastNotes, slow);
    let id, before;
    try {
      ({ id } = await startRun());
      before = await steady(page.locator('#run-steps .row:nth-of-type(2)'));
      await expect(page.locator('#run-last')).toBeVisible({ timeout: 15000 });
    } finally { await page.unroute(lastNotes, slow); }
    const row = '#run-steps .row:nth-of-type(2)', step2 = (await runStep(id, 1)).id;
    await expect(page.locator('#run-last .loading')).toHaveCount(0);
    const after = await steady(page.locator(row));
    if (Math.abs(after.y - before.y) > 0.5) throw new Error(`the steps moved ${after.y - before.y}px as Last time came`);
    // A step's row and the checklist's own row at the top of the screen tell the phone that a sideways drag on them is
    // a swipe, not a scroll (as a task's rows do, see smoke.mjs). So the browser never takes the touch away when the swipe starts.
    for (const sel of [row, '#run-own > .row']) await expect(page.locator(sel), sel).toHaveCSS('touch-action', 'pan-y pinch-zoom');
    // Swipes from `from`% to `to`% (see swipeRow). The row is scrolled to the middle of the screen, away from the screen edges and the add box at the bottom.
    const slide = (to, from, check) => swipeRow(page, row, to, { start: from, check });
    // The tick shows progress as a pie (--pct), as a task's tick does.
    const pie = () => page.$eval(row, el => getComputedStyle(el).getPropertyValue('--pct').trim());
    await toastGone().catch(() => {});
    await slide(25, 0, async () => { if (await pie() !== '0') throw new Error('the tick changed while the row was held: ' + await pie()); });
    // As for a task, the result shows only on the tick. A screen reader announces it, and swiping back undoes it.
    await expect(page.locator('#said')).toHaveText('Progress of Warm up the press set to 25%');
    await noToast(page);
    await until('the step\'s progress never reached Vikunja', async () => Math.round((await api('/tasks/' + step2)).percent_done * 100) === 25);
    await expect.poll(pie).toBe('0.25');
    if (await page.textContent('#step-title') !== 'Check the guards at 3pm') throw new Error('releasing the swipe opened the step');
    await slide(0, 25);
    await until('swiping back never reset the progress', async () => !(await api('/tasks/' + step2)).percent_done);
    await expect.poll(pie).toBe('0');
    // With the add box at the bottom focused, a step's row still swipes, and the box keeps pointing at the card's step.
    await toastGone().catch(() => {});
    await page.focus('#run-in');
    await slide(50, 0);
    await expect(page.locator('#said')).toHaveText('Progress of Warm up the press set to 50%');
    await until('the step\'s progress never reached Vikunja with the box focused', async () => Math.round((await api('/tasks/' + step2)).percent_done * 100) === 50);
    await expect(page.locator('#step-title')).toHaveText('Check the guards at 3pm');
    await page.locator('#run-in').blur();
    await toastGone().catch(() => {});
    // Offline, the outbox names the waiting change.
    await context.setOffline(true);
    await slide(75, 50);
    await page.waitForSelector('#btn-refresh.waits', { timeout: 5000 });
    await page.click('#btn-refresh');
    await page.waitForSelector('#outbox-rows .ob-row:has-text("Progress: 75% on “Warm up the press”")');
    await page.click('#btn-sheet-close');
    await context.setOffline(false);
    await online();
    await until('the progress set offline never reached Vikunja', async () => Math.round((await api('/tasks/' + step2)).percent_done * 100) === 75);
    await toastGone().catch(() => {});
    // Swipe all the way and hold while the checklist's screen redraws (every second, for countdowns). It stays full.
    // On release the step becomes done with its ✅, in place with no gap, as when its box is tapped. Tapping its box unticks it.
    await slide(100, 75, async () => {
      await page.waitForTimeout(1500);
      await expect(uncovered(page)).toHaveClass(/\bfull\b/);
      // The green area stays still under the step's row, inside its list, and the box is a step's, so it is square.
      const lies = await laidUnder(page, row);
      if (lies.inside || lies.off > .5 || lies.ring !== 10) throw new Error('the layer under the swiped step is not where it should be: ' + JSON.stringify(lies));
      await expect(uncovered(page)).toHaveClass(/\bsq\b/);
    });
    await until('a full swipe never marked the step done', async () => { const t = await task(step2); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    await expect(page.locator(row)).toHaveClass(/\bdone\b/);
    await expect(page.locator(`${row} > .del-gap`)).toHaveCount(0);
    await expect(page.locator('#said')).toHaveText('Done: Warm up the press');
    await expect(uncovered(page)).toHaveCount(0);
    await page.locator(row).getByRole('button', { name: 'Mark not done: Warm up the press', exact: true }).click();
    await until('tapping the box never marked the step not done', async () => !(await task(step2)).done);
  });

  await step('a-time-after-a-step-named-in-words', async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.waitForFunction(() => document.activeElement?.id === 'nt-name');   // wait for the sheet to focus the name before typing
    await page.fill('#nt-name', `Words ${stamp}`);
    await page.press('#nt-name', 'Enter');
    for (const text of ['Start the hydraulics', 'Wipe the bed', 'Check the oil 30 minutes after Start the hydraulics']) { await page.fill('#d-subin', text); await page.press('#d-subin', 'Enter'); }
    await expect(page.locator('#d-subtasks > .row')).toHaveCount(3);
    await page.click('#nt-create');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 20000 });
    let tpl;
    await until('the template never appeared', async () => (tpl = ((await api(`/projects/${project.id}/tasks?filter=${encodeURIComponent('done = true')}`)).items || []).find(t => t.title === `TEMPLATE: Words ${stamp}`)));
    const titles = (await subtasks(tpl.id)).map(s => s.title);
    if (JSON.stringify(titles) !== JSON.stringify(['Start the hydraulics {#start-the-hydraulics}', 'Wipe the bed', 'Check the oil T#30m:start-the-hydraulics'])) throw new Error('the template has the wrong steps: ' + titles.join(' | '));
    for (const s of await subtasks(tpl.id)) await api('/tasks/' + s.id, { method: 'DELETE' });
    await api('/tasks/' + tpl.id, { method: 'DELETE' });
  });

  await step('back-from-a-project-opened-from-checklists', async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl[data-project="${project.id}"] .sec-act`, { timeout: 15000 });
    await page.waitForFunction(id => location.hash === '#/project/' + id, project.id, { timeout: 15000 });
    if (await page.getAttribute('#btn-back', 'aria-label') !== 'Back to checklists') throw new Error('the Back label is ' + await page.getAttribute('#btn-back', 'aria-label'));
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
  });

  await step('change-remove-and-delete-a-template', async () => {
    // This test uses a separate template, so the steps of the other templates stay as they are. It has two steps. One is
    // changed in place and one is removed, then the template is deleted with its steps. The template's sheet has no
    // tick, because a template is never done or not done.
    const label = (await api('/labels?s=template')).items?.find(l => l.title === 'template') || (await api('/labels')).items?.find(l => l.title === 'template');
    const make = async (title, done) => api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title, done }) });
    const tpl = await make(`Scratch ${stamp}`, false), a = await make('Stir', true), b = await make('Rest T#5m', true);
    for (const st of [a, b]) await api(`/tasks/${tpl.id}/relations`, { method: 'POST', body: JSON.stringify({ other_task_id: st.id, relation_kind: 'subtask' }) });
    await api(`/tasks/${tpl.id}/labels`, { method: 'POST', body: JSON.stringify({ label_id: label.id }) });
    await api('/tasks/' + tpl.id, { method: 'PATCH', body: JSON.stringify({ done: true }) });
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl-tpl:has(.title:text-is("Scratch ${stamp}")) .body`, { timeout: 15000 });
    await page.waitForSelector('#d-start');
    if (await page.$('#d-done') || await page.$('#d-progress')) throw new Error('a template can be ticked');
    await page.click('#d-subtasks .row:nth-of-type(1) .body');
    // Tapping the step focuses its text box, ready for typing or dictation.
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, a.id, { timeout: 5000 });
    await page.fill(`#step-edit-${a.id}`, 'Stir in 2 min');
    await page.press(`#step-edit-${a.id}`, 'Enter');
    await until('the step never changed', async () => (await api('/tasks/' + a.id)).title === 'Stir T#2m');
    // If Vikunja rejects the change, the typed text stays in the box so the user can fix it. The test types only after the box has focus, as a user would.
    await page.click('#d-subtasks .row:nth-of-type(1) .body');
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, a.id, { timeout: 5000 });
    await page.fill(`#step-edit-${a.id}`, 'Stir T#2m:nope');
    await page.press(`#step-edit-${a.id}`, 'Enter');
    await said('sheet:subtasks', 'Not changed: step 1, “Stir”');
    if (await page.inputValue(`#step-edit-${a.id}`) !== 'Stir T#2m:nope') throw new Error('the typed text was lost');
    await page.press(`#step-edit-${a.id}`, 'Escape');
    await page.waitForSelector(`#step-edit-${a.id}`, { state: 'detached' });
    if ((await api('/tasks/' + a.id)).title !== 'Stir T#2m') throw new Error('the step changed anyway');
    // A step's notes and photos are edited in its own sheet. The sheet shows the name without the time, has no tick or due date, and links back to the template.
    await page.click('#d-subtasks .row:nth-of-type(1) > button.body');
    if (await page.$$eval('#d-subtasks .step-in', els => els.length) !== 1) throw new Error('more than one step has a box');
    await page.click(`#step-notes-${a.id}`);
    await page.waitForSelector('#d-step-title:text-is("Stir")');
    await page.waitForSelector('#d-step-when:has-text("Step 1 of 2")');
    await expect(page.locator('#d-comments')).toHaveCount(0);                // a checklist's copy of the step doesn't copy comments
    if (await page.$('#d-done') || await page.$('#d-progress') || await page.isVisible('#d-due') || await page.isVisible('#d-subtasks')) throw new Error("a template's step has a tick, a date or subtasks");
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Use the long spoon.\nNot the whisk.');
    await page.click('#d-desc-save');
    await until('the notes never reached the step', async () => /long spoon/.test((await api('/tasks/' + a.id)).description || ''));
    await page.click('#d-open-template');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(1) .step-note:has-text("Use the long spoon.")', { timeout: 10000 });
    await removeStep(2);
    await until('the step was never removed', async () => (await subtasks(tpl.id)).length === 1);
    await page.click('#d-more');
    await page.waitForSelector('#d-delete:text-is("Delete template and its 1 step")', { timeout: 10000 });
    await page.click('#d-delete');
    await expect(page.locator('#sheet')).toBeHidden({ timeout: 15000 });
    await synced(page);
    const gone = async tid => { const r = await fetch(SERVER + '/api/v2/tasks/' + tid, { headers: { Authorization: 'Bearer ' + TOKEN } }); return r.status === 404 || r.status === 403; };
    if (!(await Promise.all([tpl.id, a.id, b.id].map(gone))).every(Boolean)) throw new Error('the template or a step is still there');
  });

  await step('make-a-template-from-the-menu', async () => {
    // A task with subtasks in a project for checklists can be made a template from its ⋯ menu. An ordinary task's sheet shows no card offering that.
    const make = async (title) => api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title }) });
    const t = await make(`Deliveries ${stamp}`), a = await make('Check the delivery note'), b = await make('Put the milk in the fridge');
    for (const st of [a, b]) await api(`/tasks/${t.id}/relations`, { method: 'POST', body: JSON.stringify({ other_task_id: st.id, relation_kind: 'subtask' }) });
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click(`${cardOf(`Deliveries ${stamp}`)} > .card-head .card-open`, { timeout: 15000 });   // shown as a card because it has open subtasks
    await page.waitForSelector('#d-subtasks .row');
    if (await page.$('#d-checklist')) throw new Error('the task sheet shows a checklist card');
    await page.click('#d-more');
    await page.click('#d-make-template');
    await until('the task was never made a template', async () => { const x = await api('/tasks/' + t.id); return x.done && x.labels?.some(l => l.title === 'template') && x.title === `TEMPLATE: Deliveries ${stamp}`; });
    await page.waitForSelector('#d-start', { timeout: 15000 });           // the sheet is now a template's
    await page.click('#d-more');
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 15000 });
  });

  await step('quick-add-in-a-template', async () => {
    // The name and each step are typed in the quick-add box. What the box reads shows as chips and is sent to Vikunja.
    // A step edited in place is read the same way, and the marks (like !1) are left out of its title.
    const name = `Quick ${stamp}`;
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.waitForFunction(() => document.activeElement?.id === 'nt-name');
    // When empty, each box shows a hint about what it reads. In the name, @user is who its checklists are for.
    await page.waitForSelector('.nt-name .box-chips .hint:has-text("assigns its checklists")');
    /* The name holds one line, so Shift+Enter acts as Enter there. It moves on to the steps' box, and it saves a step
       being edited. The steps' box takes a list, like every list's box, so Shift+Enter breaks the line there. Each
       box is as tall as its text, with nothing to scroll inside it. */
    const size = sel => page.$eval(sel, ta => ({ tall: ta.clientHeight, inside: ta.scrollHeight - ta.clientHeight })), LONG = 'a great many words, '.repeat(9);
    for (const sel of ['#nt-name', '#d-subin']) {
      await page.fill(sel, '');
      const one = await size(sel);
      await page.fill(sel, LONG);
      await expect.poll(async () => (await size(sel)).tall, { message: sel + ' didn\'t grow with its text' }).toBeGreaterThan(one.tall * 2);
      await expect.poll(async () => (await size(sel)).inside, { message: sel + ' scrolls its text inside the box' }).toBeLessThanOrEqual(0);
      await page.fill(sel, '');
      await expect.poll(async () => (await size(sel)).tall).toBe(one.tall);
    }
    await page.fill('#nt-name', 'One line');
    await page.press('#nt-name', 'Shift+Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'd-subin');
    expect(await page.inputValue('#nt-name'), 'Shift+Enter in a template\'s name adds no line break').toBe('One line');
    await page.fill('#nt-name', '');
    await page.focus('#nt-name');
    // A date isn't read from the name, and a chip says so.
    await page.keyboard.type(`${name} every day at 7`);
    await page.waitForSelector('.nt-name .box-chips .chip.quiet:has-text("Dates stay in the name")');
    await page.fill('#nt-name', '');
    await page.keyboard.type(other ? `${name} @${OTHER}` : `${name} !2`);
    await page.waitForSelector(`.nt-name .box-chips .chip:has-text("${other ? '@' + OTHER : 'Priority 2'}")`);
    await page.focus('#d-subin');
    await page.waitForSelector('#d-subbox-chips .hint:has-text("assigns the step")');
    // A step being written looks up its @people as every add box does. For an unknown person, a chip warns before the
    // step is made, and the name is left unmarked.
    await page.keyboard.type(`Sweep up @nobody${stamp}`);
    await expect(page.locator('#d-subbox-chips .chip.warn')).toHaveText(`No user @nobody${stamp}`);
    await expect(page.locator('#d-subbox .cap-marks mark')).toHaveCount(0);
    await page.fill('#d-subin', 'Unlock the door !3');
    await page.waitForSelector('#d-subbox-chips .chip:has-text("Priority 3")');
    await page.press('#d-subin', 'Enter');
    await expect(page.locator('#d-subtasks > .row:nth-of-type(1) .title')).toHaveText('Unlock the door');   // the row looks like a saved step's
    await page.waitForFunction(() => document.activeElement?.id === 'd-subin' && !document.activeElement.value);
    // Type immediately, as a fast typist does. No letter is lost while the new row appears.
    await page.keyboard.type(`Turn the sign 5 min later${other ? ' @' + OTHER : ''}`);
    await page.waitForSelector('#d-subbox .cap-marks mark[data-kind="due"]:text-is("5 min later")', { state: 'attached' });
    const second = await page.inputValue('#d-subin');
    await page.press('#d-subin', 'Shift+Enter');                           // inserts a line break, as in any list's box
    expect(await page.inputValue('#d-subin'), 'Shift+Enter in a step being written adds a line break').toBe(second + '\n');
    await page.keyboard.press('Backspace');
    await page.press('#d-subin', 'Enter');
    await expect(page.locator('#d-subtasks > .row')).toHaveCount(2);
    await page.keyboard.type('Count the till !4');                       // the priority chip is tapped off below, so "!4" stays in the name
    await page.click('#d-subbox-chips .chip:has-text("Priority 4")');
    await page.click('#nt-create');                                       // text still in the box becomes a step too
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 20000 });
    let tpl;
    await until('the template never appeared', async () => (tpl = ((await api(`/projects/${project.id}/tasks?filter=${encodeURIComponent('done = true')}`)).items || []).find(t => t.title === `TEMPLATE: ${name}`)));
    tpl = await api('/tasks/' + tpl.id);
    if (other ? !tpl.assignees?.some(u => u.id === other.id) : tpl.priority !== 2) throw new Error(`template: assignees ${JSON.stringify(tpl.assignees?.map(u => u.username))}, priority ${tpl.priority}`);
    const steps = await Promise.all((await subtasks(tpl.id)).map(s => api('/tasks/' + s.id)));
    if (JSON.stringify(steps.map(s => [s.title, s.priority])) !== JSON.stringify([['Unlock the door', 3], ['Turn the sign T#5m', 0], ['Count the till !4', 0]])) throw new Error('the steps are wrong: ' + JSON.stringify(steps.map(s => [s.title, s.priority])));
    // Editing in place: !1 sets the priority and leaves the name unchanged.
    await page.click(`.cl-tpl:has(.title:text-is("${name}")) .body`, { timeout: 15000 });
    await page.click('#d-subtasks .row:nth-of-type(1) > button.body');
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, steps[0].id, { timeout: 5000 });
    await page.fill(`#step-edit-${steps[0].id}`, 'Unlock the door !1');
    await page.waitForSelector('.step-in .box-chips .chip:has-text("Priority 1")');
    await page.press(`#step-edit-${steps[0].id}`, 'Enter');
    await until('the step\'s priority never changed', async () => (await api('/tasks/' + steps[0].id)).priority === 1);
    if ((await api('/tasks/' + steps[0].id)).title !== 'Unlock the door') throw new Error('the step title is wrong: ' + (await api('/tasks/' + steps[0].id)).title);
    // Text kept as text when the step was written stays text when the step is edited. "!4" is not read as a priority now.
    await page.click('#d-subtasks .row:nth-of-type(3) > button.body');
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, steps[2].id, { timeout: 5000 });
    await page.fill(`#step-edit-${steps[2].id}`, 'Count the till !4 twice');
    await page.press(`#step-edit-${steps[2].id}`, 'Shift+Enter');         // acts as Enter: saves, with no line break
    await until('the step never changed', async () => (await api('/tasks/' + steps[2].id)).title === 'Count the till !4 twice');
    if ((await api('/tasks/' + steps[2].id)).priority) throw new Error('"!4" was read as a priority');
    /* A step tapped straight after another step was being edited. Its box has focus and knows it, so when emptied it
       shows what it reads, as any add box does (and @ and * show suggestions). The box that was left reports losing
       focus a moment later, and the box opened meanwhile must not mistake that for its own. */
    await page.click('#d-subtasks .row:nth-of-type(1) > button.body');
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, steps[0].id, { timeout: 5000 });
    await page.click('#d-subtasks .row:nth-of-type(3) > button.body');
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, steps[2].id, { timeout: 5000 });
    await page.waitForTimeout(300);                                          // wait until the box that was left has reported losing focus
    await page.fill(`#step-edit-${steps[2].id}`, '');
    await expect(page.locator('.step-in .box-chips .hint'), 'a step opened right after another step shows no hint').toContainText('assigns the step');
    await page.press(`#step-edit-${steps[2].id}`, 'Escape');
    await expect(page.locator('#d-subtasks .step-box')).toHaveCount(0);
    // Tapping the assignee chip removes that person from the step while it is edited.
    if (other) {
      await page.click('#d-subtasks .row:nth-of-type(2) > button.body');
      await page.click(`.step-in .box-chips .chip:has-text("@${OTHER}")`);
      await page.waitForSelector(`.step-in .box-chips .chip.off:has-text("@${OTHER}")`);
      await page.press(`#step-edit-${steps[1].id}`, 'Enter');
      await until('the other user was never removed from the step', async () => !(await api('/tasks/' + steps[1].id)).assignees?.length);
    }
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    for (const st of steps) await api('/tasks/' + st.id, { method: 'DELETE' });
    await api('/tasks/' + tpl.id, { method: 'DELETE' });
  });

  await step('add-steps-to-a-template', async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${tplRow} .body`, { timeout: 15000 });
    await page.waitForSelector('#d-start');
    // Steps are added under a template from the box at the end of its list, sent with Enter. If a step counts from a
    // name that no step has, it is not added and the ↑ button is disabled.
    const box = '#d-subin', go = '#d-subbox form .go', chip = page.locator('#d-subbox .draft-time');
    await page.fill(box, 'Pull a sample T#5m:nope');
    await page.locator('#d-subbox .draft-meta .bad:has-text("no step is named “nope”")').waitFor();
    if (await page.isEnabled(go)) throw new Error('a step that counts from a missing name can be added');
    // The chip is still shown, to pick a step to count from.
    await chip.locator('select').selectOption({ label: 'Warm up the press' });
    await page.waitForSelector(go + ':not([disabled])');
    // A time in words after an existing step gives that step a name. The reply is lost. The text that wasn't added
    // returns to the box, and pressing Enter again finds the task already created instead of leaving a stray copy.
    await page.fill(box, 'Pull a sample 5 min after Warm up the press');
    await expect(chip).toContainText('5m after');
    let posts = 0;
    const loseStep = async r => { if (r.request().method() !== 'POST' || ++posts !== 1) return r.fallback(); await r.fetch(); return r.abort('connectionreset'); };
    await page.route(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await toastGone().catch(() => {});
    await page.press(box, 'Enter');
    await said('sheet:subtasks', 'Added 0 of 1');
    await page.unroute(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await expect(page.locator(box)).toHaveValue('Pull a sample 5 min after Warm up the press');
    // Vikunja on SQLite is briefly busy ("database is locked") while a step is linked under the template. Pocket retries.
    let locked = 0;
    const lock = r => r.request().method() === 'POST' && ++locked === 1 ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"database is locked"}' }) : r.fallback();
    await page.route('**/api/v2/tasks/*/relations', lock);
    await toastGone().catch(() => {});
    await page.press(box, 'Enter');
    await until('the step was never added', async () => (await subtasks(template.id)).length === 4);
    await page.unroute('**/api/v2/tasks/*/relations', lock);
    if (!locked) throw new Error('no step was put under the template');
    if (await page.isVisible('.place-line:has-text("Added")')) throw new Error('the sheet showed a message: ' + await page.textContent('.place-line'));
    const sample = (await api('/tasks?q=' + encodeURIComponent('Pull a sample'))).items.filter(t => t.project_id === project.id);
    if (sample.length !== 1) throw new Error(`${sample.length} tasks “Pull a sample”`);
    await expect(page.locator(box)).toHaveValue('');
    await page.fill(box, 'Log the weights');
    await page.press(box, 'Enter');
    await until('the second step was never added', async () => (await subtasks(template.id)).length === 5);
    const titles = (await subtasks(template.id)).map(s => s.title);
    const want = [STEPS[0], 'Warm up the press T#30m {#warm-up}', STEPS[2], 'Pull a sample T#5m:warm-up', 'Log the weights'];
    if (JSON.stringify(titles) !== JSON.stringify(want)) throw new Error('the template has the wrong steps: ' + titles.join(' | '));
    if (!(await subtasks(template.id)).every(s => s.done)) throw new Error('a new step isn\'t done');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(4) .meta:has-text("Due 5m after “Warm up the press”")');
    // If Vikunja is still busy after a few tries, the step that was created is not left behind as a separate task, and the typed line stays in the box.
    const stray = `Stray step ${stamp}`, busy = r => r.request().method() === 'POST' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"database is locked"}' }) : r.fallback();
    await page.fill(box, stray);
    await page.route('**/api/v2/tasks/*/relations', busy);
    await page.press(box, 'Enter');
    await said('sheet:subtasks', 'Added 0 of 1');
    await page.unroute('**/api/v2/tasks/*/relations', busy);
    await until('the step was left behind as a separate task', async () => !(await api('/tasks?q=' + encodeURIComponent(stray))).items.some(t => t.title === stray));
    await expect(page.locator(box)).toHaveValue(stray);
    await page.fill(box, '');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  /* A template that repeats. Setting a date in its sheet leaves it not done, as a repeating task in Vikunja. On Today
     it has no tick and opens Start. Starting it ticks it, so Vikunja moves it on, unless it isn't due until later. A
     lost reply to the tick doesn't skip twice. A template left for months moves to its next time after now. Without
     a repeat, a start ends it. Removing its date leaves it done. These tests use a separate template with one step. */
  const ZERO = '0001-01-01T00:00:00Z';
  const minute = ms => new Date(Math.floor(ms / 60000) * 60000);
  const local = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
  const DAILY = `Daily ${stamp}`, dailyRow = `.cl-tpl:has(.title:text-is("${DAILY}"))`;
  let daily;
  const setDaily = fields => api('/tasks/' + daily.id, { method: 'PATCH', body: JSON.stringify(fields) });
  // Starts the template from its Checklists row. Returns the new checklist, the template afterwards and the note shown on the Start sheet.
  const startDaily = async () => {
    await toastGone().catch(() => {});
    const before = new Set(((await api('/tasks/' + daily.id)).related_tasks?.copiedto || []).map(t => t.id));
    await page.evaluate(() => { location.hash = '#/today'; });
    await loaded(page);
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${dailyRow} .cl-start`, { timeout: 15000 });
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
    const note = await page.textContent('#start-note').catch(() => '');
    await page.click('#start-go');
    await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
    const id = (((await api('/tasks/' + daily.id)).related_tasks?.copiedto || []).find(t => !before.has(t.id)) || {}).id;
    return { run: await api('/tasks/' + id), tpl: await api('/tasks/' + daily.id), note };
  };

  await step('a-template-that-comes-round', async () => {
    const label = (await api('/labels?s=template')).items?.find(l => l.title === 'template') || (await api('/labels')).items?.find(l => l.title === 'template');
    daily = await api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: `TEMPLATE: ${DAILY}` }) });
    const st = await api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: 'Unlock the door', done: true }) });
    await api(`/tasks/${daily.id}/relations`, { method: 'POST', body: JSON.stringify({ other_task_id: st.id, relation_kind: 'subtask' }) });
    await api(`/tasks/${daily.id}/labels`, { method: 'POST', body: JSON.stringify({ label_id: label.id }) });
    await setDaily({ done: true });
    if (other) await api(`/tasks/${daily.id}/assignees/bulk`, { method: 'PUT', body: JSON.stringify({ assignees: [{ id: me.id }, { id: other.id }] }) });
    // The template's sheet has a date and a repeat under "Comes round". Setting the date makes the template not done.
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${dailyRow} .body`, { timeout: 15000 });
    await page.waitForSelector('#d-comes-round');
    const due = minute(Date.now() - 3600e3);
    await page.fill('#d-due', local(due));
    await page.dispatchEvent('#d-due', 'change');
    await until('setting the date never made the template not done', async () => { const t = await api('/tasks/' + daily.id); return !t.done && sameTime(t.due_date, due.toISOString()); });
    await page.selectOption('#d-repeat', 'day');
    await until('the template never started repeating', async () => (await api('/tasks/' + daily.id)).repeat_after === 86400);
    if ((await api('/tasks/' + daily.id)).done) throw new Error('the template was done after its repeat was set');
    await page.waitForSelector('#d-comes-round:has-text("then every day")');             // describes what the date and repeat do
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    // Checklists shows when it is due. Today shows it with no tick, and tapping it opens Start.
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.waitForSelector(`${dailyRow} .cl-when:has-text("Due now, since"):has-text("then every day")`, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/today'; });
    const row = `#view .row:has(> .body .title:has-text("${DAILY}"))`;
    await page.waitForSelector(`${row} .title .sr:has-text("Checklist. Tap to start.")`, { state: 'attached', timeout: 15000 });
    if (await page.$(`${row} button.check`)) throw new Error('the template has a tick on Today');
    // When it is the only overdue item there is no Move all to today, because that would move nothing.
    const overdue = await page.$$eval('.sec.overdue ~ .list .row', els => els.length).catch(() => 0);
    if (overdue === 1 && await page.$('#btn-overdue-today')) throw new Error('"Move all to today" is offered with only a checklist overdue');
    await page.click(`${row} > .body`);
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
    const note = await page.textContent('#start-note');
    if (!/^This is the checklist due .*\. Starting it moves Daily .* to /.test(note)) throw new Error('the Start sheet note is wrong: ' + note);
    // The checklist is for the template's assignees.
    if (other) for (const u of [me.username, OTHER]) if (await page.getAttribute(`#start-for .chip[data-user="${u}"]`, 'aria-pressed') !== 'true') throw new Error(`the checklist is not for ${u}`);
    const before = new Set(((await api('/tasks/' + daily.id)).related_tasks?.copiedto || []).map(t => t.id));
    await page.click('#start-go');
    await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
    const id = (((await api('/tasks/' + daily.id)).related_tasks?.copiedto || []).find(t => !before.has(t.id)) || {}).id;
    const run = await api('/tasks/' + id), tpl = await api('/tasks/' + daily.id);
    // The checklist's title has no "TEMPLATE: " prefix. It is due when the template was due, is for the template's assignees, and has no repeat or reminders.
    if (!RUN_TITLE(DAILY).test(run.title)) throw new Error('the checklist title is wrong: ' + run.title);
    if (!sameTime(run.due_date, due.toISOString())) throw new Error('the checklist due date is wrong: ' + run.due_date);
    if (run.repeat_after || run.repeat_mode || (run.reminders || []).length) throw new Error(`the checklist repeats ${run.repeat_after}/${run.repeat_mode}, reminders ${run.reminders?.length}`);
    if (run.labels?.some(l => l.title === 'template') || run.done) throw new Error('the checklist is a template, or done');
    const want = other ? [me.id, other.id].sort((a, b) => a - b) : [me.id];
    if (JSON.stringify(run.assignees?.map(u => u.id).sort((a, b) => a - b)) !== JSON.stringify(want)) throw new Error('the checklist is for ' + JSON.stringify(run.assignees?.map(u => u.username)));
    // On Today, the card's heading looks like a task card's. It shows the name without the start date and, on the right, when it is due, marked late.
    await page.evaluate(() => { location.hash = '#/today'; });
    const runCard = page.locator(cardOf(dayless(run.title)));
    await expect(runCard.locator('.card-title')).toHaveText(dayless(run.title), { timeout: 15000 });
    const at = await page.evaluate(ms => new Date(ms).toDateString() === new Date().toDateString() && new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), +due);
    await expect(runCard.locator('.card-head .due.overdue')).toHaveText(at ? shortTime(at) : /\S/);   // the short time (like "9a") if it was due today
    // Vikunja moved the template on by a day, and it is still not done.
    if (tpl.done || !sameTime(tpl.due_date, new Date(+due + 864e5).toISOString())) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}`);
  });

  await step('a-start-before-its-day-leaves-it', async () => {
    const later = minute(Date.now() + 3 * 864e5);
    await setDaily({ due_date: later.toISOString() });
    const { run, tpl, note } = await startDaily();
    if (!/is next due .*\. Starting this checklist doesn't change that date/.test(note)) throw new Error('the Start sheet note is wrong: ' + note);
    if (tpl.done || !sameTime(tpl.due_date, later.toISOString())) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}`);
    if (run.due_date && !run.due_date.startsWith('0001')) throw new Error('the checklist has a due date: ' + run.due_date);
  });

  await step('a-lost-reply-to-the-tick-skips-once', async () => {
    const due = minute(Date.now() - 3600e3);
    await setDaily({ due_date: due.toISOString() });
    // The tick reaches Vikunja but the reply doesn't. The start waits, then continues without ticking the template again.
    let lost = false;
    const lose = async r => { if (lost || r.request().method() !== 'PATCH' || !/"done":true/.test(r.request().postData() || '')) return r.fallback(); lost = true; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route(`**/api/v2/tasks/${daily.id}`, lose);
    await toastGone().catch(() => {});
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${dailyRow} .cl-start`, { timeout: 15000 });
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
    await page.click('#start-go');
    await said('checklists', 'starts as soon as Pocket reaches Vikunja');
    await page.unroute(`**/api/v2/tasks/${daily.id}`, lose);
    if (!lost) throw new Error('the tick was never sent');
    await online();
    await page.waitForSelector('.cl .row.pending', { state: 'detached', timeout: 30000 });
    const tpl = await api('/tasks/' + daily.id);
    if (tpl.done || !sameTime(tpl.due_date, new Date(+due + 864e5).toISOString())) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}`);
  });

  await step('a-template-left-for-months-moves-past-now', async () => {
    // With a monthly repeat, Vikunja moves the date forward one month, which is still in the past. Pocket moves it on to the first month after now.
    const due = minute(Date.now() - 92 * 864e5), months = n => { const d = new Date(due); d.setUTCMonth(d.getUTCMonth() + n); return d; };
    let n = 1; while (months(n) <= Date.now()) n++;
    await setDaily({ due_date: due.toISOString(), repeat_after: 0, repeat_mode: 1 });
    const { tpl, note } = await startDaily();
    if (!note.includes('the checklist due')) throw new Error('the Start sheet note is wrong: ' + note);
    if (tpl.done || !sameTime(tpl.due_date, months(n).toISOString())) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}, wanted ${months(n).toISOString()}`);
  });

  await step('without-a-repeat-a-start-ends-it', async () => {
    await setDaily({ due_date: minute(Date.now() - 600e3).toISOString(), repeat_after: 0, repeat_mode: 0 });
    const { tpl, note } = await startDaily();
    if (!note.includes("doesn't repeat")) throw new Error('the Start sheet note is wrong: ' + note);
    if (!tpl.done || (tpl.due_date && !tpl.due_date.startsWith('0001'))) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}`);
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.waitForSelector(dailyRow, { timeout: 15000 });
    await loaded(page);                                                      // load fresh data, not the copy saved before the start
    if (await page.$(`${dailyRow} .cl-when`)) throw new Error('the row still shows when the template repeats');
  });

  await step('taking-its-date-off-leaves-it-done', async () => {
    const due = minute(Date.now() + 864e5);
    await setDaily({ done: false, due_date: due.toISOString(), repeat_after: 86400, repeat_mode: 0 });
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${dailyRow} .body`, { timeout: 15000 });
    await page.waitForSelector('#d-due-clear');
    await page.click('#d-due-clear');
    // The repeat is kept, so a date set again repeats as before.
    await until('removing the date never left the template done with its repeat', async () => { const t = await api('/tasks/' + daily.id); return t.done && t.repeat_after === 86400; }, 15000);
    const t = await api('/tasks/' + daily.id);
    if (t.due_date !== ZERO || t.repeat_mode) throw new Error(`due ${t.due_date}, repeats ${t.repeat_after}/${t.repeat_mode}`);
    if (await page.inputValue('#d-repeat') !== 'day') throw new Error('the Repeats field shows ' + await page.inputValue('#d-repeat'));
    if (await page.isVisible('#d-reminders')) throw new Error('reminders show for a template that doesn\'t repeat');
    await page.fill('#d-due', local(due));
    await until('setting the date again did not reopen the template with its repeat', async () => { const t = await api('/tasks/' + daily.id); return !t.done && sameTime(t.due_date, due.toISOString()) && t.repeat_after === 86400; }, 15000);
    await page.click('#d-due-clear');
    await until('removing the date again never left the template done', async () => (await api('/tasks/' + daily.id)).done, 15000);
    // Picking a repeat with no date gives the template a due date and shows a message naming it.
    await toastGone().catch(() => {});
    await page.selectOption('#d-repeat', 'week');
    await said('sheet:due', 'Pocket set the due date to');
    await until('a repeat with no date never reopened the template', async () => { const t = await api('/tasks/' + daily.id); return !t.done && t.repeat_after === 604800; }, 15000);
    await page.click('#d-due-clear');
    await until('removing the date once more never left the template done', async () => (await api('/tasks/' + daily.id)).done, 15000);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('make-a-template-with-a-due-date', async () => {
    // A task with a due date, made into a template, is due again at that date. It is not done and keeps its repeat.
    const due = minute(Date.now() + 2 * 864e5);
    const make = async (title, extra = {}) => api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title, ...extra }) });
    const t = await make(`Weekly clean ${stamp}`, { due_date: due.toISOString(), repeat_after: 604800 }), a = await make('Descale the kettle');
    await api(`/tasks/${t.id}/relations`, { method: 'POST', body: JSON.stringify({ other_task_id: a.id, relation_kind: 'subtask' }) });
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click(`${cardOf(`Weekly clean ${stamp}`)} > .card-head .card-open`, { timeout: 15000 });   // shown as a card because it has an open subtask
    await page.waitForSelector('#d-subtasks .row');
    await page.click('#d-more');
    await page.click('#d-make-template');
    await said('sheet:top', 'Template created. ');                        // the template has a due date, so the message continues with when it appears on Today and what starting it does
    await until('the task was never made a template', async () => { const x = await api('/tasks/' + t.id); return x.labels?.some(l => l.title === 'template') && x.title === `TEMPLATE: Weekly clean ${stamp}`; });
    const x = await api('/tasks/' + t.id);
    if (x.done || !sameTime(x.due_date, due.toISOString()) || x.repeat_after !== 604800) throw new Error(`done ${x.done}, due ${x.due_date}, repeats ${x.repeat_after}`);
    if (!(await api('/tasks/' + a.id)).done) throw new Error('its step isn\'t done');
    await page.waitForSelector('#d-comes-round', { timeout: 15000 });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('stop-using-for-checklists', async () => {
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click('#btn-project');
    await page.click('#p-stop-checklists');
    await said('sheet:top', 'This project is no longer used for checklists');
    if (/pocket:checklists/i.test((await api('/projects/' + project.id)).description)) throw new Error('the marker is still there');
    if (!checklistsBefore && await page.isVisible('nav.tabs a[data-tab=checklists]')) throw new Error('the Checklists tab is still there');
  });
  await step('new-project-for-checklists', async () => {
    if (await page.isVisible('#btn-sheet-close')) { await page.click('#btn-sheet-close'); await page.waitForSelector('#sheet', { state: 'hidden' }); }
    await page.click('nav.tabs a[data-tab=projects]');
    await page.click('#btn-new-project', { timeout: 15000 });
    await page.fill('#np-name', `Front of house ${stamp}`);
    await page.selectOption('#np-parent', String(project.id));
    await page.check('#np-checklists');
    await page.click('#np-create');
    // The new project opens on Checklists, where Getting started says what to do next: share the project in Vikunja's web app.
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
    let id;
    await until('the project was never made', async () => (id = (await api('/projects')).items.find(p => p.title === `Front of house ${stamp}`)?.id));
    const made = await api('/projects/' + id);
    try {
      if (made.parent_project_id !== project.id) throw new Error(`the project was made in ${made.parent_project_id}`);
      if (!/<p>pocket:checklists<\/p>/.test(made.description || '')) throw new Error('the project is not marked for checklists: ' + made.description);
      await page.waitForSelector('nav.tabs a[data-tab=checklists]');
      await page.waitForSelector(`#getting-started-${id} a[href$="/projects/${id}/settings/share"]`, { timeout: 15000 });
      await page.click(`#getting-started-${id} .gs-hide`);
      await page.waitForSelector(`#getting-started-${id}`, { state: 'detached' });
      await page.reload();
      await page.waitForSelector(`.cl[data-project="${id}"]`, { timeout: 15000 });
      if (await page.$(`#getting-started-${id}`)) throw new Error('Getting started came back after it was hidden');
      // The project's ⋯ menu shows the card again.
      await page.evaluate(pid => { location.hash = '#/project/' + pid; }, id);
      await page.click('#btn-project');
      await page.click('#p-show-started', { timeout: 15000 });
      await page.waitForSelector(`#getting-started-${id}`, { timeout: 15000 });
    } finally { await api('/projects/' + id, { method: 'DELETE' }).catch(() => {}); }
  });
  if (errors.length) { failed++; console.log('FAIL page errors:', errors); }
} finally {
  await synced(page, { timeout: 5000 }).catch(() => {});                  // first wait for anything Pocket is still sending
  await browser.close();
  // Delete the project and every task in it. Retry a few times, because Vikunja on SQLite can answer 500 "database is locked" while busy.
  if (project) for (let i = 0; i < 5; i++) { try { await api('/projects/' + project.id, { method: 'DELETE' }); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
