// Checklists, end to end: a project used for checklists, a template made from a task and its steps, runs started, worked
// through, finished and handed over, with and without a connection.
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... node tests/checklists.mjs
//   npm run test:local        (starts a local Vikunja with the plugin and runs everything against it)
//
// Creates a project of its own ("Pocket checklists <stamp>") and deletes it at the end, with everything in it. Leaves a
// "template" label behind, which later runs reuse, as Task Management tokens can't delete labels. The token needs
// Projects → Create and Update, and Reactions.
// Optional: OTHER_USER and OTHER_PASSWORD, a second account: the project is shared with them, a run is started for
// them, and their Today and Checklists tab are checked too.
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

// Vikunja on SQLite answers 500 "database is locked" now and then, when a request comes while it's still writing what
// the one before changed: the test's own requests try again, as Pocket's do.
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
// A task's steps in the order Pocket shows them, a template's or a run's: by the line "pocket:order …" in its
// description, then steps it doesn't list, by id.
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
await hintSeen(context);                         // the one-time hint: smoke.mjs
// The page's clock is Playwright's: it keeps the real time, and later() moves it on instead of waiting.
await context.clock.install();
const page = await context.newPage();
const errors = [];
/* Time passing on the page only, `ms` of it at once: its timers due meanwhile run (a toast going, a countdown's second),
   then its clock is put back on the real time, which Vikunja's dates are on. */
const later = async ms => { await page.clock.fastForward(Math.max(0, Math.round(ms))); await page.clock.setSystemTime(Date.now()); };
const pageNow = () => page.evaluate(() => Date.now());
page.on('console', m => m.type() === 'error' && !/status of (401|404)|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());

let failed = 0;
async function step(name, fn){
  const start = Date.now(), secs = () => ` (${((Date.now() - start) / 1000).toFixed(1)}s)`;   // each step's time, so a slow one is seen
  try { await fn(); console.log('PASS', name + secs()); }
  catch (e) {
    failed++; console.log('FAIL', name + secs(), '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/checklists-fail-${name}.png` }).catch(() => {});
    await context.setOffline(false); await page.unrouteAll();                // so one failure doesn't take the rest down with it
  }
}
const signIn = (p, token) => signInAt(p, APP, token);
// A card on Today (a run with steps still open), by its name.
const cardOf = t => `.day-card:has(> .card-head .card-title:has-text("${t}"))`;
// A run's name on its card on Today: without the day it was started ("Line 4 · run 1 · Oct 8": "Line 4 · run 1").
const dayless = t => t.split(' · ').slice(0, -1).join(' · ');
const toast = text => toastOn(page, text), toastGone = () => toastGoneOn(page);
// A message in its place (lines.js): "checklists", "step", "sheet:subtasks"…
const said = (where, text) => placeSays(page, where, text);
const online = () => page.evaluate(() => window.dispatchEvent(new Event('online')));
// A finger on a row, Chrome's own touch input, so the page scrolls under it as on a phone (`finger`, helpers.mjs).
const { touchDrag } = await finger(page);

const stamp = Date.now();
const TEMPLATE = `Startup ${stamp}`;
// The steps as written in New template, and as saved: times in words become T#, and the step one counts from gets a name.
const WRITTEN = ['Check the guards at 3pm', 'First article check 2 hours later', 'Warm up the press in 30 min'];
const STEPS = ['Check the guards at 3pm {#check-the-guards}', 'Warm up the press T#30m', 'First article check T#2h:check-the-guards'];
const GUARDS = '“Check the guards at 3pm”';
const tplRow = `.cl-tpl:has(.title:text-is("${TEMPLATE}"))`;
// A template's step shows its ↑ ↓ × once it's tapped: the button on the nth step, which is tapped first if it isn't open.
// A step's button, once it's tapped open: its × (Remove step), or Move up and Move down, in its ⋯.
const stepButton = async (n, label) => {
  const row = `#d-subtasks .row:nth-of-type(${n})`;
  if (!await page.$(`${row} .step-edit`)) await page.click(`${row} > button.body`);
  if (!/^Move/.test(label)) return `${row} [aria-label^="${label}"]`;
  if (!await page.$(`${row} .step-menu`)) await page.click(`${row} [aria-label^="More for step"]`);
  return `${row} .step-menu button:has-text("${label}")`;
};
// Hold a step's row, move it up or down past the first few pixels (so it's a move), on to the middle of step `to`'s
// row, and let go there.
async function dragStep(n, to){
  await page.locator('#d-subtasks').evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));   // clear of the edges, where it scrolls
  const row = page.locator(`#d-subtasks .row:nth-of-type(${n})`), box = await steady(row), x = box.x + box.width / 2, y0 = box.y + box.height / 2;
  const b = await page.locator(`#d-subtasks .row:nth-of-type(${to})`).boundingBox(), y = b.y + b.height / 2 + Math.sign(b.y - box.y) * 4;
  await page.mouse.move(x, y0); await page.mouse.down();
  await expect(row).toHaveClass(/held/);
  await page.mouse.move(x, y0 + Math.sign(y - y0) * 14, { steps: 3 });
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}
// Tapped, and the step closed again after, as tapping elsewhere would.
const tapStep = async (n, label) => { await page.click(await stepButton(n, label)); await page.press('#d-subtasks .step-box textarea', 'Escape'); };
let project, template, me, other, otherToken;
const runs = [];                                 // run ids, in the order started

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

  // With no project for checklists yet, Projects offers to set one up: a project "Checklists", with an example template,
  // then Checklists, with Getting started. (Skipped when the account has one already.)
  if (!checklistsBefore) await step('set-up-checklists', async () => {
    await page.click('nav.tabs a[data-tab=projects]');
    await page.click('#btn-setup-checklists', { timeout: 15000 });
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 30000 });
    await said('checklists', 'Set up Checklists, with an example template');
    const made = (await api('/projects')).items.filter(p => p.title === 'Checklists' && /pocket:checklists/i.test(p.description || '')).pop();
    try {
      if (!made) throw new Error('no project Checklists, for checklists');
      await page.waitForSelector(`.cl[data-project="${made.id}"] .cl-tpl .title:text-is("Example: Opening up")`, { timeout: 15000 });
      await page.waitForSelector(`#getting-started-${made.id} a[href$="/projects/${made.id}/settings/share"]`);
      const tpl = (await api(`/projects/${made.id}/tasks?filter=${encodeURIComponent('done = true')}`)).items.find(t => t.title === 'TEMPLATE: Example: Opening up');
      const steps = await Promise.all((await subtasks(tpl.id)).map(s => api('/tasks/' + s.id)));
      if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(['Turn on the espresso machine', 'Put the croissants in the oven', 'Take the croissants out T#18m', 'Wipe down the tables']))
        throw new Error('steps: ' + steps.map(s => s.title).join(' | '));
      if (!steps[0].assignees?.some(u => u.id === me.id)) throw new Error('the first step isn\'t for you');
      if (!steps.every(s => s.done) || !tpl.labels?.some(l => l.title === 'template')) throw new Error('not made a template');
      // Started, the Start sheet says who each step is for.
      await page.click(`.cl[data-project="${made.id}"] .cl-start`);
      await page.waitForSelector('#start-steps .prop:nth-of-type(1) .start-who:text-is("For you")', { timeout: 15000 });
      await page.click('#start-go');
      await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
      await page.waitForSelector('#step-title:text-is("Turn on the espresso machine")');
      await page.click('#step-done');
      await page.waitForSelector('#step-title:text-is("Put the croissants in the oven")');
      // Done: the next step in order is on screen, counting down its 18 minutes (parent-tasks-plan, part 2).
      await page.click('#step-done');
      await page.waitForSelector('#step-title:text-is("Take the croissants out")');
      await expect(page.locator('#step-card .step-due')).toHaveText(/^Due in 1[78]m$/);
      // The card is gone once there's a project for checklists.
      await page.click('nav.tabs a[data-tab=projects]');
      await page.waitForSelector('.tree');
      if (await page.$('#btn-setup-checklists')) throw new Error('Set up checklists is still offered');
    } finally {
      // The last tick's ✅ may still be on its way: deleting the project under it would leave it turned down, waiting
      // in the outbox, and the ticks after it would wait behind it.
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
    await said('sheet:top', 'Now for checklists');
    await page.waitForSelector('nav.tabs.icons a[data-tab=checklists]');
    if (!await page.$eval('nav.tabs a[data-tab=today] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('three tabs, but with their names showing');
    if (await page.$eval('nav.tabs a[aria-current=page] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('the tab you\'re on lost its name');
    if (!/<p>pocket:checklists<\/p>/.test((await api('/projects/' + project.id)).description)) throw new Error('no marker in the description');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('new-template', async () => {
    await page.click('nav.tabs a[data-tab=checklists]');
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.waitForFunction(() => document.activeElement?.id === 'nt-name');   // the sheet's own focus, before typing
    await page.fill('#nt-name', TEMPLATE);
    await page.press('#nt-name', 'Enter');
    // A row each, Enter for the next; a time in words gets a chip.
    const next = () => page.waitForFunction(() => document.activeElement?.classList.contains('draft-in') && !document.activeElement.value);
    for (const [i, text] of WRITTEN.entries()) { await next(); await page.keyboard.type(text); if (i < WRITTEN.length - 1) await page.keyboard.press('Enter'); }
    const row = i => page.locator('#new-steps > .draft-step').nth(i);
    await row(1).locator('.draft-time:has-text("2h after")').waitFor();
    // First article check counts from the guards; moved down, it still does.
    await row(1).locator('select').selectOption({ label: 'Check the guards at 3pm' });
    await row(1).locator('[aria-label^="Move down"]').click();
    if (await row(2).locator('.draft-in').inputValue() !== WRITTEN[1]) throw new Error('not moved down');
    if (await row(2).locator('select option:checked').textContent() !== 'Check the guards at 3pm') throw new Error('counts from ' + await row(2).locator('select option:checked').textContent());
    await row(0).locator('.draft-meta:has-text("Named “check-the-guards”")').waitFor();
    // The reply to its second step is lost: Make template again carries on with the same template, adding nothing twice.
    let posts = 0;
    const loseStep = async r => { if (r.request().method() !== 'POST' || ++posts !== 3) return r.fallback(); await r.fetch(); return r.abort('connectionreset'); };
    await page.route(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await page.click('#nt-create');
    await said('sheet:top', 'Tap Make template again');
    await page.unroute(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await page.click('#nt-create');
    await said('checklists', `Made ${TEMPLATE}`);
    const named = async title => (await api('/tasks?q=' + encodeURIComponent(title))).items.filter(t => t.title === title && t.project_id === project.id).length;
    // Its title says it's a template wherever Vikunja shows it; Pocket shows its name (tplRow).
    for (const title of [`TEMPLATE: ${TEMPLATE}`, ...STEPS]) if (await named(title) !== 1) throw new Error(`${await named(title)} tasks “${title}”`);
    await page.waitForSelector(tplRow, { timeout: 15000 });
    // Its row, and New template's, on a 375px phone too: the icon at the left, the words beside it, Start at the right, on
    // one line.
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
    // In the order they were made: Vikunja's own order of a task's subtasks can change as they're saved.
    const t = await api('/tasks/' + template.id), steps = (t.related_tasks?.subtask || []).sort((a, b) => a.id - b.id);
    if (!t.done || !t.labels?.some(l => l.title === 'template')) throw new Error(`done ${t.done}, labels ${JSON.stringify(t.labels?.map(l => l.title))}`);
    if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(STEPS)) throw new Error('steps: ' + steps.map(s => s.title).join(' | '));   // "at 3pm" stays
    if (!steps.every(s => s.done)) throw new Error('a step isn\'t done');
    // Its sheet shows when each step is due.
    await page.click(`${tplRow} .body`);
    await page.waitForSelector('#d-start');
    if (await page.inputValue('#d-title') !== TEMPLATE) throw new Error('its sheet is titled ' + await page.inputValue('#d-title'));
    const shown = await page.$$eval('#d-subtasks .row', els => els.map(e => e.querySelector('.title').textContent + '|' + (e.querySelector('.meta')?.textContent || '')));
    if (JSON.stringify(shown) !== JSON.stringify([`Check the guards at 3pm|Named “check-the-guards”`, `Warm up the press|Due 30m after ${GUARDS}`, `First article check|Due 2h after ${GUARDS}`]))
      throw new Error('sheet shows ' + JSON.stringify(shown));
    // Its steps are numbered plainly, as the start sheet has them: a square box is a step you tick, in a run. Its sheet
    // has what a run gets from it (its notes, its labels but "template", its people, when it comes round), and no
    // Comments: Vikunja's copy of a template, a run, doesn't take its comments.
    const n = page.locator('#d-subtasks .row .step-n').first();
    await expect(n).toHaveText('1');
    await expect(n).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('#d-comments')).toHaveCount(0);
    await expect(page.locator('#d-template-label')).toHaveText('Its runs get its labels, all but “template”, which is what makes it a template.');
    for (const id of ['#d-desc', '#d-due', '#d-repeat', '#d-assignees']) await expect(page.locator(id)).toBeVisible();
  });

  await step('a-step-it-counts-from-removed', async () => {
    // Counting from a step that's then removed, and is first now: pick one, the start; nothing is made.
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.waitForFunction(() => document.activeElement?.id === 'nt-name');   // the sheet's own focus, before typing
    await page.fill('#nt-name', 'Not made');
    const row = i => page.locator('#new-steps > .draft-step').nth(i);
    await row(0).locator('.draft-in').fill('Put the roast in');
    await page.click('#new-add-step');
    await row(1).locator('.draft-in').fill('Baste in 20 min');
    await row(1).locator('select').selectOption({ label: 'Put the roast in' });
    await row(0).locator('[aria-label^="Remove"]').click();
    await row(0).locator('.draft-meta .bad:has-text("pick one")').waitFor();
    if (await page.isEnabled('#nt-create')) throw new Error('can be made');
    await row(0).locator('select').selectOption({ label: 'the start' });
    await page.waitForSelector('#nt-create:not([disabled])');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click(`${tplRow} .body`);                                    // back to the template's sheet
    await page.waitForSelector('#d-start');
  });

  await step('reorder-steps', async () => {
    // Its steps by id, the order they were made in (Vikunja on Postgres gives them in no set order).
    const links = (await api('/tasks/' + template.id)).related_tasks.subtask.map(s => s.id).sort((a, b) => a - b);
    // Held and moved up, as a finger moves it: the third step to second.
    await dragStep(3, 2);
    await until('the step never moved up in Vikunja', async () => (await subtasks(template.id)).map(s => s.title)[1] === STEPS[2]);
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    // Only the order line is written: the steps are linked as they were, and the line isn't shown in the notes.
    const t = await api('/tasks/' + template.id);
    if (JSON.stringify(stepOrder(t.description)) !== JSON.stringify([links[0], links[2], links[1]])) throw new Error('description: ' + t.description);
    if (JSON.stringify(t.related_tasks.subtask.map(s => s.id).sort((a, b) => a - b)) !== JSON.stringify(links)) throw new Error('the steps were linked again');
    if (/pocket:order/.test(await page.textContent('#d-desc'))) throw new Error('the notes show the order line');
    // Tapped open, a step has no ↑ ↓ any more: its ⋯ has Move up and Move down.
    await page.click('#d-subtasks .row:nth-of-type(1) > button.body');
    await expect(page.locator('#d-subtasks .row:nth-of-type(1) [aria-label^="Remove step"]')).toBeVisible();
    await expect(page.locator('#d-subtasks [aria-label^="Move up"], #d-subtasks [aria-label^="Move down"]')).toHaveCount(0);
    await page.press('#d-subtasks .step-box textarea', 'Escape');
    // The order stays after a reload.
    await page.reload();
    await loaded(page);
    if (!await page.waitForSelector('#d-start', { timeout: 3000 }).catch(() => null)) { await page.evaluate(() => { location.hash = '#/checklists'; }); await page.click(`${tplRow} .body`, { timeout: 15000 }); }
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")', { timeout: 15000 });
    // Cut off mid-move: back as it was, and it says so.
    await page.route(`**/api/v2/tasks/${template.id}`, r => r.request().method() === 'PATCH' ? r.abort('internetdisconnected') : r.continue());
    await tapStep(2, 'Move down');
    await said('sheet:subtasks', 'Not moved');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    await page.unrouteAll(); await online(); await toastGone();
    if ((await subtasks(template.id)).map(s => s.title)[1] !== STEPS[2]) throw new Error('moved in Vikunja anyway');
    // Above the step it counts from: refused, before anything is sent.
    await page.waitForSelector(await stepButton(2, 'Move up') + ':not([disabled])');
    await tapStep(2, 'Move up');
    await said('sheet:subtasks', 'Not moved: step 2, “First article check”: its time counts from “check-the-guards”, which has to be an earlier step');
    if ((await subtasks(template.id)).map(s => s.title)[0] !== STEPS[0]) throw new Error('moved anyway');
    await page.waitForSelector(await stepButton(2, 'Move down') + ':not([disabled])');
    await tapStep(2, 'Move down');
    await until('the step never moved back', async () => JSON.stringify((await subtasks(template.id)).map(s => s.title)) === JSON.stringify(STEPS));
    await page.waitForSelector('#d-subtasks .row:nth-of-type(3) .title:text-is("First article check")');
    // Its reply lost on the way back: moved all the same, as Vikunja has it, and it doesn't say otherwise.
    const loseReply = async r => { if (r.request().method() !== 'PATCH') return r.fallback(); await r.fetch(); return r.abort('connectionreset'); };
    await page.route(`**/api/v2/tasks/${template.id}`, loseReply);
    await toastGone().catch(() => {});
    await tapStep(2, 'Move down');
    await until('the move never reached Vikunja', async () => (await subtasks(template.id)).map(s => s.title)[1] === STEPS[2]);
    await page.waitForSelector(await stepButton(3, 'Move up') + ':not([disabled])');   // done saving
    await page.unroute(`**/api/v2/tasks/${template.id}`, loseReply);
    if (await page.$('.place-line:has-text("Not moved")')) throw new Error('it says it wasn\'t moved');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    await tapStep(3, 'Move up');
    await until('the step never moved back again', async () => JSON.stringify((await subtasks(template.id)).map(s => s.title)) === JSON.stringify(STEPS));
    await page.waitForSelector('#d-subtasks .row:nth-of-type(3) .title:text-is("First article check")');
    await page.waitForSelector(await stepButton(2, 'Move up') + ':not([disabled])');
    // A move, or notes, saved here change only their part of what Vikunja has when they're sent: notes and a move saved
    // elsewhere (on the web, another phone) since the sheet opened stay.
    const ids = (await subtasks(template.id)).map(s => s.id), was = (await api('/tasks/' + template.id)).description;
    const elsewhere = () => api('/tasks/' + template.id, { method: 'PATCH', body: JSON.stringify({ description: `<p>Wear gloves for the press.</p><p>pocket:order ${ids[0]} ${ids[2]} ${ids[1]}</p>` }) });
    const order = async () => JSON.stringify(stepOrder((await api('/tasks/' + template.id)).description));
    await elsewhere();
    await tapStep(2, 'Move up');   // "Warm up the press", 3rd in Vikunja now
    await until('the move wasn\'t made to Vikunja\'s order: ' + await order(), async () => await order() === JSON.stringify(ids));
    if (!/Wear gloves/.test((await api('/tasks/' + template.id)).description)) throw new Error('the move deleted the notes');
    await page.waitForSelector('#d-desc:has-text("Wear gloves for the press")');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("Warm up the press")');
    await elsewhere();
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Wear gloves and goggles.');
    await page.click('#d-desc-save');
    await until('the notes were never saved', async () => /goggles/.test((await api('/tasks/' + template.id)).description));
    if (await order() !== JSON.stringify([ids[0], ids[2], ids[1]])) throw new Error('the notes put back an older order: ' + await order());
    await api('/tasks/' + template.id, { method: 'PATCH', body: JSON.stringify({ description: was }) });
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  const startRun = async (who) => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${tplRow} .cl-start`, { timeout: 15000 });
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
    // For you, to start with: someone else instead is picked, and you taken off.
    if (who) { await page.click(`#start-for .chip[data-user="${who}"]`); await page.click(`#start-for .chip[data-user="${me.username}"]`); }
    const before = new Set((await api('/tasks/' + template.id)).related_tasks?.copiedto?.map(t => t.id) || []);
    const started = Date.now();
    await page.click('#start-go');
    await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
    const id = +(await page.evaluate(() => location.hash)).split('/').pop();
    if (before.has(id)) throw new Error('opened an older run');
    runs.push(id);
    await page.waitForSelector('#step-title', { timeout: 15000 });
    return { id, started };
  };

  let first;
  await step('start-a-run', async () => {
    first = await startRun();
    const run = await api('/tasks/' + first.id), steps = await Promise.all((await subtasks(first.id)).map(s => api('/tasks/' + s.id)));
    if (!new RegExp(`^${TEMPLATE} · run \\d+ · `).test(run.title)) throw new Error('title: ' + run.title);
    if (run.done || run.labels?.some(l => l.title === 'template')) throw new Error(`done ${run.done}, labels ${JSON.stringify(run.labels?.map(l => l.title))}`);
    if (JSON.stringify(run.assignees?.map(u => u.id)) !== JSON.stringify([me.id])) throw new Error('assignees ' + JSON.stringify(run.assignees?.map(u => u.username)));
    if (run.related_tasks?.copiedfrom?.[0]?.id !== template.id) throw new Error('not linked to its template');
    if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(['Check the guards at 3pm', 'Warm up the press', 'First article check'])) throw new Error('steps: ' + steps.map(s => s.title).join(' | '));
    if (steps.some(s => s.done)) throw new Error('a step is done already');
    // The run has its own order line, its steps as copied: it never reads its template's again.
    if (JSON.stringify(stepOrder(run.description)) !== JSON.stringify(steps.map(s => s.id))) throw new Error('order line: ' + run.description);
    // Nothing is due yet: every timed step counts from a step being done, and the run has no due date of its own.
    const dated = [run, ...steps].filter(t => t.due_date && !t.due_date.startsWith('0001'));
    if (dated.length) throw new Error('due dates: ' + dated.map(t => `${t.title} ${t.due_date}`).join(', '));
    // A timed step has a reminder at its due time, for when it gets one; an untimed one has none.
    const rems = steps.map(s => (s.reminders || []).map(r => `${r.relative_to}${r.relative_period}`).join());
    if (JSON.stringify(rems) !== JSON.stringify(['', 'due_date0', 'due_date0'])) throw new Error('reminders: ' + JSON.stringify(rems));
    await page.waitForSelector(`#run-steps .row:nth-of-type(2) .meta:has-text("Due 30m after ${GUARDS}")`);
    await page.waitForSelector(`#run-steps .row:nth-of-type(3) .meta:has-text("Due 2h after ${GUARDS}")`);
    if (await page.textContent('#step-title') !== 'Check the guards at 3pm') throw new Error('on step ' + await page.textContent('#step-title'));
    // Who it's for is the slot on its own row, atop its screen (who started it is its history: its ⋯ says it).
    await expect(page.locator('#run-own .claim')).toHaveAttribute('aria-label', 'For you');
  });
  const runStep = async (run, i) => (await subtasks(run))[i];

  await step('a-template-changed-after-a-start-leaves-the-run', async () => {
    // A run keeps its steps' times from when it started: a template step given another time changes only runs after.
    const warm = (await subtasks(template.id)).find(s => s.title === STEPS[1]);
    await api('/tasks/' + warm.id, { method: 'PATCH', body: JSON.stringify({ title: 'Warm up the press T#45m' }) });
    try {
      await page.reload();
      await page.waitForSelector(`#run-steps .row:nth-of-type(2) .meta:has-text("Due 30m after ${GUARDS}")`, { timeout: 15000 });
      if (/pocket:/.test(await page.textContent('#run'))) throw new Error('a line of Pocket\'s shows on the run');
      const run = await api('/tasks/' + first.id), step2 = await api('/tasks/' + (await runStep(first.id, 1)).id);
      if (!/pocket:run/.test(run.description) || !step2.description.includes('pocket:step Warm up the press T#30m')) throw new Error(`run ${run.description}, step ${step2.description}`);
    } finally { await api('/tasks/' + warm.id, { method: 'PATCH', body: JSON.stringify({ title: STEPS[1] }) }); }
  });

  await step('tick-a-step', async () => {
    await page.click('#step-done');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    const id = (await runStep(first.id, 0)).id;
    // Done, then the ✅: sent one after the other, so wait for both.
    await until('the step was never done with a ✅ from you', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector('#run-steps .row:nth-of-type(1).done .did[aria-label^="Done by"][aria-label*=" at "]');   // and when
    // Both timed steps count down now: the next one on its card, the other pinned above it.
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (30|29)m$")');
    await page.waitForSelector('#run-timers .timer:has-text("First article check"):has-text("in 2h")');
    // Tapping a pinned countdown shows its step; then back to the one before.
    await page.click('#run-timers .timer:has-text("First article check")');
    await page.waitForSelector('#step-title:text-is("First article check")');
    await page.click('#run-steps .row:nth-of-type(2) .body');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    // Moved by hand in Vikunja after the tick (a second or more: one in the same second counts as before it).
    await new Promise(r => setTimeout(r, 1100));
    const warm = (await runStep(first.id, 1)).id;
    await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ due_date: new Date(Date.now() + 3 * 36e5).toISOString() }) });
    await page.reload();
    await page.waitForSelector('#step-card .step-due:text-is("Due in 3h")', { timeout: 15000 });
  });

  await step('countdown-alerts-at-zero', async () => {
    // A countdown on screen that reaches zero says so, once: not again after a reload. The page's clock is moved on to
    // its time (and a second over, for the Date header's whole seconds), not waited for.
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
      if (await page.$('#toast.show #toast-msg:has-text("is due now")')) throw new Error('it said so again');
    } finally { await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ due_date: back }) }); }
    await page.reload();
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (3h|2h 5[0-9]m)$")', { timeout: 15000 });
  });

  /* The run's step card has no strip (parent-tasks-plan, part 2): its steps, listed under it, say where the run is, and
     a tap on one puts it on the card, a done one too. And who's on that step, as its row says. */
  await step('the-step-card-and-the-steps-under-it', async () => {
    await expect(page.locator('#run-bar')).toHaveCount(0);
    await expect(page.locator('#step-card .card-strip, #step-card .card-n, #step-card .pg')).toHaveCount(0);
    await expect(page.locator('#run-steps .row.current .title')).toHaveText('Warm up the press');
    // A done step comes on it from its row, saying who did it, with no slot to claim it.
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await page.waitForSelector('#step-title:text-is("Check the guards at 3pm")');
    await expect(page.locator('#run-steps .row.current .title')).toHaveText('Check the guards at 3pm');
    await expect(page.locator('#step-who')).toContainText('Done by');
    await expect(page.locator('#step-card .claim')).toHaveCount(0);
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await page.waitForSelector('#step-title:text-is("First article check")');
    await page.click('#run-steps .row:nth-of-type(2) .body');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    // Who's on it: its row's slot, "+ me", on the card too; claimed there, it's yours on both.
    const id = (await runStep(first.id, 1)).id, people = async () => ((await task(id)).assignees || []).map(u => u.id);
    await page.click('#step-card .claim:has(.me)');
    await page.waitForSelector('#step-card .claim.mine .av');
    await page.waitForSelector('#run-steps .row:nth-of-type(2) .claim.mine .av');
    await until('claiming on the card never reached Vikunja', async () => JSON.stringify(await people()) === JSON.stringify([me.id]));
    await page.click('#step-card .claim');
    await page.waitForSelector('#step-card .claim .me');
    await until('never let go', async () => !(await people()).length);
    await synced(page);
  });

  await step('skip-with-a-reason', async () => {
    await page.fill('#step-note', 'Press 2 is down');
    await page.waitForSelector('#step-note-with:has-text("for Skip, as the reason")');           // Skip stays Skip, the same size
    if (await page.textContent('#step-skip') !== 'Skip') throw new Error('skip says ' + await page.textContent('#step-skip'));
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
    // Warm up the press, skipped, is shown by tapping its row; the open step's row goes back to it.
    await page.fill('#step-note', 'Only for this step');
    await page.click('#run-steps .row:nth-of-type(2) .body');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    if (await page.inputValue('#step-note') !== '') throw new Error('the note followed: ' + await page.inputValue('#step-note'));
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await page.waitForSelector('#step-title:text-is("First article check")');
    if (await page.inputValue('#step-note') !== 'Only for this step') throw new Error('the note is gone');
    await page.fill('#step-note', '');
    await page.reload();                                                     // back on the first step not done, as before
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
  });

  await step('done-with-a-note-sends-it', async () => {
    // Untick the first step, write a note on it, then Done: the note is saved on the step, with the tick.
    const id = (await runStep(first.id, 0)).id;
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('never undone', async () => !(await task(id)).done);
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await page.waitForSelector('#step-title:text-is("Check the guards at 3pm")');
    await page.fill('#step-note', 'Guard 3 tightened');
    await expect(page.locator('#step-note-with')).toHaveText('Done or Skip sends this comment with it: for Skip, as the reason.');
    await page.click('#step-done');
    await until('the note never reached the step', async () => { const t = await task(id); return t.done && (t.comments || []).some(c => c.comment.includes('Guard 3 tightened')); });
    await page.reload();
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
  });

  await step('note-on-a-step-and-the-run', async () => {
    // What's written on a run is a Vikunja comment, and called one, as in a task's sheet: "Notes" are a task's own.
    await page.getByRole('textbox', { name: 'Comment on this step' }).fill('Looks good');
    await page.locator('#step-note-form').getByRole('button', { name: 'Post comment' }).click();
    await page.waitForSelector('#step-extra .comment:has-text("Looks good")');
    await expect(page.locator('#run-steps .row:nth-of-type(3) .note-mark')).toHaveAttribute('aria-label', 'A comment');   // its row says it has one
    await expect(page.locator('#run .h3:has-text("Comments on this run")')).toBeVisible();
    await expect(page.locator('#run-note')).toHaveAttribute('placeholder', 'Comment for this run, and the next');
    await page.getByRole('textbox', { name: 'Comment on this run' }).fill('Line 2 ran slow today');
    await page.locator('#run-note-form').getByRole('button', { name: 'Post comment' }).click();
    await page.waitForSelector('#run-notes .comment:has-text("Line 2 ran slow today")');
    const step3 = await task((await runStep(first.id, 2)).id), run = await task(first.id);
    if ((step3.comments || []).filter(c => c.comment.includes('Looks good')).length !== 1) throw new Error('step comments: ' + JSON.stringify(step3.comments?.map(c => c.comment)));
    if (!(run.comments || []).some(c => c.comment.includes('Line 2 ran slow today'))) throw new Error('no note on the run');
  });

  await step('share-a-runs-progress', async () => {
    // From the run's ⋯: who did each step, who skipped one, and who's on the one left (you, claimed for this). Its
    // progress is its ring's, a skipped step done (parent-tasks-plan, part 5): 2 of 3, 67%, a segment per step.
    const run = await api('/tasks/' + first.id), my = (me.name || '').trim().split(/\s+/)[0] || me.username, row = '#run-steps .row:nth-of-type(3)';
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    await page.click('#btn-run-more');
    // A run has the text only: its record of who did each step can't come back as tasks, so it has no Markdown copy.
    await expect(page.locator('#r-sharing button')).toHaveText(['Share progress as a text']);
    await page.evaluate(() => { window.shared = []; navigator.share = async d => { window.shared.push(d); }; });
    await page.click('#r-share-text');
    await expect.poll(() => page.evaluate(() => window.shared)).toEqual([{ title: run.title, text: [`${run.title}  ▰▰▱ 67% · 1 skipped`,
      `✓ Check the guards at 3pm · ${my}`, `– Warm up the press · skipped by ${my}`, `○ First article check · ${my}`].join('\n') }]);
    await expect(page.locator('#r-open-vikunja')).toHaveAttribute('href', `${SERVER}/tasks/${first.id}`);
    await page.click('#btn-sheet-close');
    await page.click(`${row} .claim`);                                       // let go again
    await page.waitForSelector(`${row} .claim .me`);
    await synced(page);
  });

  await step('untick-and-tick-again', async () => {
    const id = (await runStep(first.id, 0)).id;
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('never undone', async () => { const t = await task(id); return !t.done && !t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector('#step-title:text-is("Check the guards at 3pm")');     // back on the first step not done
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('never done again', async () => (await task(id)).done);
    // The ✅ refused after the tick went through: it says what was saved, and shows the step done, as Vikunja has it.
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('never undone again', async () => !(await task(id)).done);
    const refuse = r => r.request().method() === 'POST' ? r.fulfill({ status: 403, contentType: 'application/json', body: '{}' }) : r.fallback();
    await page.route('**/api/v2/tasks/*/reactions', refuse);
    await toastGone().catch(() => {});
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await said('step', 'couldn\'t be saved in full (it\'s marked done)');
    await page.unroute('**/api/v2/tasks/*/reactions', refuse);
    await page.waitForSelector('#run-steps .row:nth-of-type(1).done', { timeout: 15000 });
    if (!(await task(id)).done) throw new Error('not done in Vikunja');
    // It's kept, to try again: the header says so. An untick meanwhile waits behind it, so it can't arrive first.
    await page.waitForSelector('#btn-refresh.trouble[aria-label="1 couldn\'t be sent"]');
    await toastGone().catch(() => {});
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await said('step', 'Waiting: something done before it');
    if (!(await task(id)).done) throw new Error('the untick went before the tick it waits on');
    await page.click('#btn-refresh');
    await page.waitForSelector('#outbox-rows .ob-row.failed:has-text("Done: Check the guards at 3pm"):has-text("Vikunja turned it down")');
    await page.click('#outbox-rows .ob-row.failed .ob-retry');
    await page.waitForSelector('#outbox-status:has-text("Everything has reached Vikunja")', { timeout: 15000 });
    await page.click('#btn-sheet-close');
    await until('the ✅ and then the untick never arrived', async () => { const t = await task(id); return !t.done && !t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector('#btn-refresh[aria-label="Refresh"]');
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('never done with a ✅', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    if (!other) return;
    // Skipped by someone else, then unticked and done here: done, not skipped, though their ⏭️ stays (only they can
    // take it back).
    const row1 = '#run-steps .row:nth-of-type(1)', as = (path, body, method = 'POST') => call(otherToken, path, { method, body: JSON.stringify(body) });
    await page.click(`${row1} .check`);
    await until('never undone for their skip', async () => !(await task(id)).done);
    await as('/tasks/' + id, { done: true }, 'PATCH');
    await as(`/tasks/${id}/reactions`, { value: '⏭️' });
    await as(`/tasks/${id}/comments`, { comment: '<p>Skipped: it was done already</p>' });
    try {
      await page.reload();
      await page.waitForSelector(`${row1} .did[aria-label^="Skipped by ${other.name || other.username} at "]`, { timeout: 15000 })
        .catch(async () => { throw new Error('not shown as skipped by them: ' + await page.$eval(`${row1} .did`, e => e.getAttribute('aria-label')).catch(() => 'no ✅ or ⏭️')); });
      await new Promise(r => setTimeout(r, 1100));                            // Vikunja's times have whole seconds
      await page.click(`${row1} .check`);
      await until('their skip never undone', async () => !(await task(id)).done);
      await page.click(`${row1} .check`);
      await until('never done after their skip', async () => (await task(id)).done);
      await page.reload();
      await page.waitForSelector(`${row1} .did[aria-label^="Done by"]`, { timeout: 15000 })
        .catch(async () => { const t = await task(id); throw new Error(`not shown as done: ${await page.$eval(`${row1} .did`, e => e.getAttribute('aria-label')).catch(() => 'no ✅ or ⏭️')}; done_at ${t.done_at}, notes ${JSON.stringify((t.comments || []).map(c => [c.created, c.comment]))}`); });
      if (await page.$(`${row1} .meta:has-text("Skipped")`)) throw new Error('still shows as skipped');
    } finally { await as(`/tasks/${id}/reactions/delete`, { value: '⏭️' }).catch(() => {}); }
  });

  await step('claim-a-step', async () => {
    // "+ me" on a step assigns it to you; your picture lets it go. A done step no one had shows nothing.
    const row = '#run-steps .row:nth-of-type(3)', id = (await runStep(first.id, 2)).id;
    const people = async () => ((await task(id)).assignees || []).map(u => u.id);
    if (await page.$('#run-steps .row:nth-of-type(1) .claim')) throw new Error('a done step with no one on it has a slot');
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    await until('never assigned', async () => JSON.stringify(await people()) === JSON.stringify([me.id]));
    await page.reload();
    await page.waitForSelector(`${row} .claim.mine .av`, { timeout: 15000 });
    await page.click(`${row} .claim`);
    await page.waitForSelector(`${row} .claim .me`);
    await until('never let go', async () => !(await people()).length);
    // Offline, it waits like a tick, and shows as yours meanwhile.
    await context.setOffline(true);
    await page.click(`${row} .claim:has(.me)`);
    await page.waitForSelector(`${row} .claim.mine .av`);
    await context.setOffline(false); await online();
    await until('the claim made offline never arrived', async () => JSON.stringify(await people()) === JSON.stringify([me.id]));
    await page.click(`${row} .claim`);
    await until('never let go', async () => !(await people()).length);
    if (!other) return;
    // Someone else's: shows who, and a tap does nothing. Done still works, with a ✅ from whoever taps it.
    await api(`/tasks/${id}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: other.id }) });
    try {
      await page.reload();
      await page.waitForSelector(`${row} .claim[aria-disabled=true] .av`, { timeout: 15000 });
      const said = await page.getAttribute(`${row} .claim`, 'aria-label');
      if (!said.startsWith(`${other.name || other.username} is doing`)) throw new Error('says ' + said);
      // (in the middle of the screen: forced, the tap lands on whatever is there, and the bottom box's Repeat could be)
      await page.locator(row).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.click(`${row} .claim`, { force: true });                       // Playwright won't tap an aria-disabled button
      await new Promise(r => setTimeout(r, 1000));
      if (JSON.stringify(await people()) !== JSON.stringify([other.id])) throw new Error('a tap on their picture changed it');
      await page.click(`${row} .check`);
      await until('Done on their step has no ✅ from you', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
      await page.click(`${row} .check`);
      await until('never undone', async () => !(await task(id)).done);
    } finally { await api(`/tasks/${id}/assignees/${other.id}`, { method: 'DELETE' }); }
    await page.reload();
    await page.waitForSelector(`${row} .claim .me`, { timeout: 15000 });
  });

  /* Progress swiped on a step no one is doing says you're doing it, once it's let go, as on a task's row
     (motion-and-rows-plan, section 3; parent-tasks-plan, 1b); swiped back to 0%, it stays yours, and someone else's stays
     theirs. A step's box is square. */
  await step('sliding-a-step-claims-it', async () => {
    const row = '#run-steps .row:nth-of-type(3)', id = (await runStep(first.id, 2)).id;
    const people = async () => ((await task(id)).assignees || []).map(u => u.id), pct = async () => Math.round((await task(id)).percent_done * 100);
    // Swiped to `to`% from `from`% (swipeRow, in the middle of the screen: clear of its edges, and of the box at its foot).
    const slide = (to, from = 0, check = null) => swipeRow(page, row, to, { start: from, check });
    await page.waitForSelector(`${row} .claim .me`, { timeout: 15000 });
    const radius = await page.$eval(`${row} > .check`, el => getComputedStyle(el).borderRadius);
    if (radius !== '7px') throw new Error("a step's box isn't square: " + radius);
    try {
      await toastGone().catch(() => {});
      await slide(25, 0, async () => { await expect(page.locator(`${row} .claim .me`)).toBeVisible(); });   // 25%: yours, once let go
      await page.waitForSelector(`${row} .claim.mine .av`);
      await until('sliding never claimed it', async () => JSON.stringify(await people()) === JSON.stringify([me.id]));
      await until('its progress never reached Vikunja', async () => await pct() === 25);
      await slide(0, 25);                                                    // back to 0%: still yours
      await until('sliding back never put it back', async () => await pct() === 0);
      if (JSON.stringify(await people()) !== JSON.stringify([me.id])) throw new Error('slid back to 0%, it was let go');
      await page.click(`${row} .claim`);                                     // letting go is a tap of its own
      await until('never let go', async () => !(await people()).length);
      await page.waitForSelector(`${row} .claim .me`);
      if (!other) return;
      // Someone else's: slid, its progress is set, and it stays theirs.
      await api(`/tasks/${id}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: other.id }) });
      await page.reload();
      await page.waitForSelector(`${row} .claim[aria-disabled=true] .av`, { timeout: 15000 });
      await toastGone().catch(() => {});
      await slide(25);
      await until('its progress never reached Vikunja', async () => await pct() === 25);
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

  /* "+ me" only where someone else could take it (one-concept-plan, part 4): a run in a project no one else can see has
     no slots, on its steps or its card, nor your picture on a step of yours, and a slide claims nothing. Who can see
     each project is loaded as Pocket's signed in, and kept. (Someone else's picture still showing there is smoke.mjs's:
     unsharing a project takes its people off its tasks.) */
  if (other) await step('a-run-only-you-can-see-has-no-slots', async () => {
    const row = '#run-steps .row:nth-of-type(3)', id = (await runStep(first.id, 2)).id;          // the open one, on the card
    const people = async () => ((await task(id)).assignees || []).map(u => u.id), assign = u => api(`/tasks/${id}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: u }) });
    await assign(me.id);
    await api(`/projects/${project.id}/users/${encodeURIComponent(OTHER)}`, { method: 'DELETE' });
    try {
      await page.reload();                                                   // signed in again: who can see it, loaded
      await page.waitForSelector(`${row}:not(.done)`, { timeout: 15000 });
      await expect(page.locator(`${row} .claim`), 'your picture shows, in a project only you can see').toHaveCount(0, { timeout: 20000 });
      await expect(page.locator('#step-card .claim'), 'the card has a slot').toHaveCount(0);
      // No one on it: no "+ me", and a slide sets its progress and claims nothing.
      await api(`/tasks/${id}/assignees/${me.id}`, { method: 'DELETE' });
      await page.reload();
      await page.waitForSelector(`${row}:not(.done)`, { timeout: 15000 });
      await expect(page.locator(`${row} .claim`), '"+ me" in a project only you can see').toHaveCount(0);
      await expect(page.locator('#step-card .claim')).toHaveCount(0);
      await swipeRow(page, row, 25, { check: async () => { if (await page.$(`${row} .claim`)) throw new Error('a swipe put someone on it'); } });
      if (await page.$(`${row} .claim`)) throw new Error('a swipe put someone on it');
      await until('its progress never reached Vikunja', async () => Math.round((await task(id)).percent_done * 100) > 0);
      await synced(page);
      if ((await people()).length) throw new Error('a slide claimed it: ' + JSON.stringify(await people()));
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
    // A card: the run's name and who it's for, over its next step, with that step's countdown; its steps aren't rows of
    // their own.
    const card = page.locator(cardOf(`${TEMPLATE} · run`));
    await expect(card.locator('.card-head .sr')).toContainText('For you', { timeout: 15000 });
    // Its heading reads as a task card's: its name, without the day it was started, and with no due date, nothing at
    // the right.
    await expect(card.locator('.card-title')).toHaveText(dayless((await api('/tasks/' + first.id)).title));
    await expect(card.locator('.card-head .due')).toHaveCount(0);
    await expect(card.locator('.step-line .title > span:not(.sr)')).toHaveText('First article check');
    await expect(card.locator('.step-line .when .due')).toHaveText(/^in \d+[hm]( \d+m)?$/);
    await expect(card.locator('.step-line > .check')).toHaveCSS('border-radius', '7px');   // a step's box: square
    await expect(page.locator('.item > .row .title:has-text("First article check")')).toHaveCount(0);
  });

  await step('today-run-has-no-tick-and-a-step-tick-says-who', async () => {
    const runCard = cardOf(`${TEMPLATE} · run`);
    await page.waitForSelector(`${runCard} > .card-head`, { timeout: 15000 });
    // A parent (parent-tasks-plan, part 3): its ring, not a tick, here and on its project's list, where it's an open card
    // with its open steps.
    await expect(page.locator(`${runCard} > .card-head > .check`)).toHaveCount(0);
    await expect(page.locator(`${runCard} > .card-head > .ring`)).toBeVisible();
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.waitForSelector(`#view ${runCard}.open > .card-head > .ring`, { timeout: 15000 });
    await expect(page.locator(`#view ${runCard} > .card-head > .check`)).toHaveCount(0);
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
    // A step ticked on its card is ticked as on the run's screen: with a ✅ from you. No message: it stays on the card,
    // done, until the batch clears, so ticking it again before then takes both back.
    const check = (await runStep(first.id, 2)).id, stepRow = `${runCard} .step-line:has(> .body .title:has-text("First article check"))`;
    await toastGone().catch(() => {});
    await page.click(`${stepRow} > .check`, { timeout: 15000 });
    await until('the tick from Today has no ✅', async () => { const t = await task(check); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector(`${stepRow}.done`);
    if (await page.$('#toast.show')) throw new Error('a step ticked on Today said: ' + await page.textContent('#toast-msg'));
    await page.click(`${stepRow} > .check`);
    await until('ticked again, the step stayed done', async () => { const t = await task(check); return !t.done && !t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector(`${stepRow}:not(.done)`, { timeout: 15000 });
    // The run's sheet, from its ⋯: a step there opens its own sheet, to hand it over with Assigned (no Repeats), and
    // that opens the run on that step.
    await page.click(`${runCard} > .card-head`);
    await page.waitForFunction(id => location.hash === '#/run/' + id, first.id, { timeout: 15000 });
    await page.waitForSelector('#step-title');
    await page.click('#btn-run-more');
    await page.click('#r-open-task');
    await page.waitForSelector('#d-subtasks .row');
    // A run's sheet has its Comments (its screen's "Comments on this run"); a step is added on its screen.
    await expect(page.locator('#d-comments')).toBeVisible();
    await expect(page.locator('#d-run-steps-note')).toHaveText("To add a step, use the box at the bottom of the run's screen: it's marked as added during the run.");
    await page.click('#d-subtasks .row:nth-of-type(2) .body');
    await page.waitForSelector('#d-assignees');
    if (await page.$('#d-repeat')) throw new Error('Repeats on a run\'s step');
    await page.click('#d-open-run');
    await page.waitForFunction(id => location.hash.startsWith(`#/run/${id}?step=`), first.id, { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("Warm up the press")', { timeout: 15000 });
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
  });

  await step('today-opens-the-run', async () => {
    // A run's card has its ring, its count of steps done (skipped too) inside it, 2 of 3, its arc the worked-out figure,
    // 67%; its top row its one open step, so no More; its name opens the run's screen, not its sheet; Back comes back to
    // Today.
    const runCard = cardOf(`${TEMPLATE} · run`), ring = page.locator(`${runCard} > .card-head > .ring`);
    await page.waitForSelector(runCard, { timeout: 15000 });
    await expect(ring.locator('.n')).toHaveText('2/3');
    await expect.poll(() => ring.evaluate(el => Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--ring')) * 100))).toBe(67);
    await expect(page.locator(`${runCard} .card-more`)).toHaveCount(0);
    await expect(page.locator(`${runCard} .step-line .title > span:not(.sr)`)).toHaveText('First article check');
    // Its header, then its top row, a plain row a level in, its tick under the header's title; no priority, so no bars.
    const stack = await page.$eval(runCard, el => ['.card-head', '.step-line'].map(s => { const r = el.querySelector(s).getBoundingClientRect(); return [r.top, r.bottom]; }));
    if (!(stack[0][1] <= stack[1][0] + 0.5)) throw new Error('its top row is not under its header: ' + JSON.stringify(stack));
    const under = await page.$eval(runCard, el => el.querySelector('.step-line > .check').getBoundingClientRect().left - el.querySelector('.card-title').getBoundingClientRect().left);
    if (Math.abs(under) > 0.5) throw new Error("its top row's tick is not under its header's title: " + under);
    await expect(page.locator(`${runCard} .card-head .bars`)).toHaveCount(0);
    await page.click(`${runCard} > .card-head .card-open`);
    await page.waitForFunction(id => location.hash === '#/run/' + id, first.id, { timeout: 15000 });
    if (await page.getAttribute('#btn-back', 'aria-label') !== 'Back to Today') throw new Error('back: ' + await page.getAttribute('#btn-back', 'aria-label'));
    if (await page.isVisible('#sheet')) throw new Error('the sheet opened');
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
    // A step opens the run on that step.
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
    if (JSON.stringify(run.assignees?.map(u => u.id)) !== JSON.stringify([other.id])) throw new Error('assignees ' + JSON.stringify(run.assignees?.map(u => u.username)));
    await expect(page.locator('#run-own .claim')).toHaveAttribute('aria-label', `For ${other.name || other.username}`);
    // Their Today has their run; theirs and yours are both under their Checklists tab, in progress.
    const theirs = await context.browser().newContext({ viewport: { width: 390, height: 844 } });
    await hintSeen(theirs);
    const p = await theirs.newPage();
    p.on('pageerror', e => errors.push('(other) ' + e));
    p.on('console', m => m.type() === 'error' && console.log('  (other) console:', m.text()));
    const rows = () => p.$$eval('.row .title, .card-title', els => els.map(x => x.textContent));
    // A step of your run they've claimed brings your run onto their Today, as a card opened on that step, though it has
    // no due date. (It's done by now: not done for this.)
    const guards = (await runStep(first.id, 0)).id;
    await api('/tasks/' + guards, { method: 'PATCH', body: JSON.stringify({ done: false }) });
    await call(otherToken, `/tasks/${guards}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: other.id }) });
    try {
      await signIn(p, otherToken);
      await p.waitForSelector(cardOf(dayless(run.title)), { timeout: 15000 });
      const mine = dayless((await api('/tasks/' + first.id)).title);
      await p.waitForSelector(`${cardOf(mine)} .step-line .title:has-text("Check the guards at 3pm")`, { timeout: 15000 }).catch(() => { throw new Error("their claimed step's run isn't on their Today, opened on it"); });
      // Your run's last step is due, and isn't theirs: not a row of its own there.
      if (await p.$('.item > .row .title:has-text("First article check")')) throw new Error('their Today: ' + JSON.stringify(await rows()));
      await p.click('nav.tabs a[data-tab=checklists]');
      await p.waitForSelector(`.cl-run .title:has-text("${mine}")`, { timeout: 15000 });
      await p.waitForSelector(`.cl-run .title:has-text("${run.title}")`, { timeout: 20000 }).catch(() => { throw new Error("their run isn't under Checklists"); });
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
    // Opened from Checklists, so finishing goes back there. Its row there is a project's: who it's for, and its ring (a
    // parent's: parent-tasks-plan, part 3), which says how far it is, so no count of its steps done nor the next under
    // its title, and no line.
    await page.evaluate(() => { location.hash = '#/checklists'; });
    const runRow = `.cl-run:has(.title:has-text("${(await api('/tasks/' + first.id)).title}"))`;
    await expect(page.locator(`${runRow} .claim`)).toHaveAttribute('aria-label', 'For you', { timeout: 15000 });
    await expect(page.locator(`${runRow} .meta`)).not.toHaveText(/Next:|\d+\/\d+/);
    await expect(page.locator(`${runRow} > .ring .n`)).toHaveText('2/3');
    if (await page.$eval(runRow, el => getComputedStyle(el, '::after').content) !== 'none') throw new Error('a line under the run\'s row');
    await page.click(`.cl-run .body:has(.title:has-text("${(await api('/tasks/' + first.id)).title}"))`, { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
    await page.click('#step-done');
    await page.waitForSelector('#finish-card');
    // A skip isn't counted as done.
    const card = await page.textContent('#finish-card');
    if (!card.includes('Every step done or skipped') || !card.includes('2 of 3 done · 1 skipped')) throw new Error('summary: ' + card);
    await page.click('#run-finish');
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
    await until('the run was never finished', async () => (await api('/tasks/' + first.id)).done);
    // Undo puts it back in progress, on its screen; then it's finished again.
    await page.click('#toast-act:has-text("Undo")');
    await until('Undo never reopened the run', async () => !(await api('/tasks/' + first.id)).done);
    await page.waitForFunction(id => location.hash === '#/run/' + id, first.id, { timeout: 15000 });
    await page.click('#run-finish', { timeout: 15000 });
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
    await until('the run was never finished again', async () => (await api('/tasks/' + first.id)).done);
    await page.waitForSelector(`.cl-done .title:text-is("${(await api('/tasks/' + first.id)).title}")`, { timeout: 15000 });
    if (await page.isVisible(`.cl-run:has(.title:has-text("${(await api('/tasks/' + first.id)).title}"))`)) throw new Error('still in progress');
  });

  let third;
  await step('last-time-and-undo-a-start', async () => {
    third = await startRun();
    await page.waitForSelector('#run-last .comment:has-text("Press 2 is down")', { timeout: 15000 });
    for (const note of ['Looks good', 'Line 2 ran slow today']) await page.waitForSelector(`#run-last .comment:has-text("${note}")`);
    // Its Undo is at the top of the run, until anything's done in it. The run's name is the header's: not said again.
    await expect(placeLine(page, 'run').locator('.what')).toHaveText('Started');
    await placeLine(page, 'run').getByRole('button', { name: 'Undo' }).click();
    await expect(page).toHaveURL(/#\/checklists$/, { timeout: 15000 });
    await synced(page);
    if (((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).some(t => t.id === third.id)) throw new Error('the run is still in Vikunja');
    runs.splice(runs.indexOf(third.id), 1);
  });

  const newRun = async () => {
    const id = ((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).map(t => t.id).filter(id => !runs.includes(id)).pop();
    runs.push(id);
    if ((await subtasks(id)).length !== 3) throw new Error('steps: ' + (await subtasks(id)).length);
    return id;
  };
  const openStart = async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${tplRow} .cl-start`, { timeout: 15000 });
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
  };

  await step('name-a-run-then-delete-it', async () => {
    // The name typed at the start takes the place of "run 3"; ⋯ → Delete run removes it and its steps.
    await openStart();
    if (!new RegExp(`Called “${TEMPLATE} · run \\d+ · `).test(await page.textContent('#start-title'))) throw new Error('shows ' + await page.textContent('#start-title'));
    await page.fill('#start-name', 'Night shift');
    if (!(await page.textContent('#start-title')).includes(`Called “${TEMPLATE} · Night shift · `)) throw new Error('shows ' + await page.textContent('#start-title'));
    await page.click('#start-go');
    await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
    const id = +(await page.evaluate(() => location.hash)).split('/').pop();
    await page.waitForSelector('#step-title', { timeout: 15000 });
    const run = await api('/tasks/' + id), steps = (run.related_tasks?.subtask || []).map(s => s.id);
    if (!run.title.startsWith(`${TEMPLATE} · Night shift · `)) throw new Error('title: ' + run.title);
    if (steps.length !== 3) throw new Error('steps: ' + steps.length);
    // ⋯: the name between the template's and the day, and who it's for.
    await toastGone();
    await page.click('#btn-run-more');
    if (await page.inputValue('#r-name') !== 'Night shift') throw new Error('name: ' + await page.inputValue('#r-name'));
    await page.fill('#r-name', 'Day shift');
    await page.press('#r-name', 'Enter');
    await until('never renamed', async () => (await api('/tasks/' + id)).title.startsWith(`${TEMPLATE} · Day shift · `));
    if (other) {
      // For them as well, then for them only.
      const forIds = async () => JSON.stringify((await api('/tasks/' + id)).assignees?.map(u => u.id).sort((a, b) => a - b));
      await page.click(`#r-for .chip[data-user="${OTHER}"]`);
      await until('never for them too', async () => await forIds() === JSON.stringify([me.id, other.id].sort((a, b) => a - b)));
      await page.click(`#r-for .chip[data-user="${me.username}"]`);
      await until('never reassigned', async () => await forIds() === JSON.stringify([other.id]));
    }
    await page.click('#btn-sheet-close');
    // Last time opens the run finished before: it can be looked at, not ticked, and reopened from its ⋯.
    await page.click('#run-last-open', { timeout: 15000 });
    await page.waitForFunction(fid => location.hash === '#/run/' + fid, first.id, { timeout: 15000 });
    await page.waitForSelector('#run-steps .row .check[disabled]', { timeout: 15000 });
    if (await page.isVisible('#step-done')) throw new Error('a finished run can be ticked');
    await expect(page.locator('#capture')).toBeHidden();                    // nor added to: no box at the bottom
    await page.click('#btn-run-more');
    await page.waitForSelector('#r-reopen');
    await page.click('#btn-sheet-close');
    await page.evaluate(rid => { location.hash = '#/run/' + rid; }, id);
    await page.waitForSelector('#step-title', { timeout: 15000 });
    await toastGone();
    await page.click('#btn-run-more');
    await expect(page.locator('#r-delete + .note')).toHaveText(/^Deletes the run and its \d+ steps, with their comments and photos, for everyone\.$/);
    await page.click('#r-delete');
    await toast('Run deleted');
    await expect(page).toHaveURL(/#\/checklists$/, { timeout: 15000 });
    await synced(page);
    const gone = async tid => { const r = await fetch(SERVER + '/api/v2/tasks/' + tid, { headers: { Authorization: 'Bearer ' + TOKEN } }); return r.status === 404 || r.status === 403; };
    if (!(await Promise.all([id, ...steps].map(gone))).every(Boolean)) throw new Error('the run or a step is still in Vikunja');
  });

  /* A run is one row on its project's list, as under Checklists (one-concept-plan, part 3): its steps aren't under it nor
     counted in Open, and its row says who it's for, not its steps done or the next. Templates, their steps and runs'
     steps stay out of its Done too. */
  await step('a-run-finished-from-its-ring-in-its-project', async () => {
    // On its project's list a run in progress is a card, open, its steps not done its rows (parent-tasks-plan, part 2).
    // Its ring asks first, naming them in a sentence, then finishes it as Finish run does, through the outbox, and leaves
    // its steps as they are: the card a gap with "Done" and Undo, which opens it again.
    const { id } = await startRun();
    const title = (await api('/tasks/' + id)).title, want = (await subtasks(id)).map(s => s.title);
    // The project's group headed `name`: its count, and its tasks' titles, rows' and cards' (a card's rows too).
    const group = name => page.evaluate(name => {
      const sec = [...document.querySelectorAll('#view .sec')].find(s => s.textContent.trim().startsWith(name)), g = sec.parentElement;
      const titles = [...g.querySelectorAll('.list :is(.row > .body .title > span:not(.sr), .card-head .card-title)')];
      return { head: sec.textContent.trim(), n: +(sec.querySelector('.n')?.textContent || 0), titles: titles.map(t => t.textContent.trim()) };
    }, name);
    try {
      await page.evaluate(pid => { location.hash = '#/project/' + pid; }, project.id);
      await loaded(page);
      await page.click('#btn-refresh');                                       // its rows from Vikunja, not the copy shown first
      await page.waitForSelector('#btn-refresh:not([disabled])');
      const card = page.locator(`#view ${cardOf(dayless(title))}`), ring = card.locator('.card-head > .ring');
      await expect(card).toHaveClass(/\bopen\b/, { timeout: 15000 });
      await expect(card.locator('.card-head .sr')).toContainText('For you');
      await expect(card.locator('.card-rows > .row .title > span:not(.sr)')).toHaveText(want);
      await expect(ring.locator('.n')).toHaveText('0/3');
      // Its steps are on its card, not rows of their own; Open counts every open task listed, a run and its steps.
      const open = await group('Open');
      if (open.n !== open.titles.length) throw new Error(`Open says ${open.n}, with ${open.titles.length} listed: ${open.titles.join(' | ')}`);
      await toastGone().catch(() => {});
      await ring.click();
      await expect(page.locator('#complete h2')).toHaveText('Finish this run with 3 steps not done?');
      await expect(page.locator('#complete-note')).toHaveText(`“${dayless(title)}” is finished, and its 3 steps not done stay that way: ${want[0]}, ${want[1]} and ${want[2]}.`);
      await expect(page.locator('#complete-open-run')).toBeVisible();
      await page.click('#complete-yes');
      await until('the run was never finished', async () => (await api('/tasks/' + id)).done);
      if ((await subtasks(id)).some(x => x.done)) throw new Error('a step was ticked with it');
      // Shown done where it is, a gap with Undo, until the batch clears: Undo opens it again.
      await expect(card).toHaveClass(/\bswept\b/);
      await card.getByRole('button', { name: 'Undo: ' + title }).click();
      await until('Undo never opened it', async () => !(await api('/tasks/' + id)).done);
      await expect(card).not.toHaveClass(/\bswept\b/);
      // Finished again, it goes with the batch, to Done, as a task does: its steps not done aren't on the list to stay
      // over.
      await synced(page);
      await ring.click();
      await page.click('#complete-yes');
      await until('the run was never finished again', async () => (await api('/tasks/' + id)).done);
      await later(3000);
      await expect(card).toHaveCount(0);
      /* Done isn't counted until it's opened: most of a project for checklists' done tasks are templates' and runs' steps,
         which it leaves out. Opened: the run, and not a template, nor a template's step (with its times written raw), nor
         a run's step, counted as it shows. */
      await expect(page.locator('#sec-done')).toHaveText('Done');
      await page.click('#sec-done');
      await page.waitForSelector(`#view .row.done:has(> .body .title:has-text("${title}"))`, { timeout: 15000 });
      await expect(page.locator('#sec-done')).toContainText(/Done \(\d+\)/);
      const done = await group('Done'), n = +done.head.match(/\((\d+)\)/)[1];
      const stray = done.titles.filter(t => t === TEMPLATE || /^TEMPLATE/i.test(t) || /T#|\{#/.test(t) || STEPS.includes(t) || want.includes(t));
      if (stray.length) throw new Error('in Done: ' + stray.join(' | '));
      if (n !== done.titles.length) throw new Error(`Done says ${n}, with ${done.titles.length} rows`);
      await page.click('#sec-done');                                          // folded again, as the next steps expect
    } finally {
      for (const x of await subtasks(id)) await api('/tasks/' + x.id, { method: 'DELETE' }).catch(() => {});
      await api('/tasks/' + id, { method: 'DELETE' }).catch(() => {});
    }
  });

  /* Templates and their steps stay out of search (one-concept-plan, part 3): they live on Checklists, and as Vikunja's
     tasks marked done they'd fill its Done, with their times written raw. A run's step found there has no 🔔: its
     reminder is Pocket's own, for the countdown its row shows. */
  await step('templates-out-of-search-and-no-bell-on-a-step', async () => {
    const { id } = await startRun();
    const runTitle = (await api('/tasks/' + id)).title, [guards, warm] = await subtasks(id);
    const titles = () => page.$$eval('#view :is(.row > .body .title, .card-title)', ts => ts.map(t => t.textContent.trim()));
    try {
      await api('/tasks/' + guards.id, { method: 'PATCH', body: JSON.stringify({ done: true }) });
      await until('the step after it never got its time and reminder', async () => ((await api('/tasks/' + warm.id)).reminders || []).some(r => Date.parse(r.reminder) > Date.now()));
      await page.click('#btn-search');
      // The template's name finds its runs (cards, with their steps not done), not the template.
      await page.fill('#in-search', TEMPLATE);
      await page.waitForSelector(`#view ${cardOf(dayless(runTitle))}`, { timeout: 15000 });
      if ((await titles()).includes(TEMPLATE)) throw new Error('the template is in search: ' + (await titles()).join(' | '));
      // A step's words find the runs' steps, not the template's, and the run's step counting down has no 🔔.
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
    const waiting = `.cl .row.pending:has-text("Starting ${TEMPLATE} · Never")`;
    await page.waitForSelector(`${waiting}:has-text("For you")`);
    await page.click(`${waiting} button[aria-label^="Don't start"]`);
    await page.waitForSelector(waiting, { state: 'detached' });
    await context.setOffline(false);
    await online();
    await page.waitForTimeout(2000);
    const after = ((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).length;
    if (after !== before) throw new Error(`runs: ${before} before, ${after} after`);
  });

  await step('cancel-a-start-whose-copy-was-made', async () => {
    // The run's copy reaches Vikunja but its reply doesn't, and the start is called off without a connection: once Pocket
    // reaches Vikunja, the copy is found and deleted, so no half-made run is left looking like a second template.
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
    const waiting = `.cl .row.pending:has-text("Starting ${TEMPLATE} · Called off")`;
    await page.click(`${waiting} button[aria-label^="Don't start"]`);
    await page.waitForSelector(waiting, { state: 'detached' });
    await page.unroute('**/api/v2/tasks/*/duplicate', lose);
    await context.setOffline(false);
    await online();
    await until('the copy is still in Vikunja', async () => await copies() === before, 40000);
  });

  await step('start-cut-off-is-not-copied-twice', async () => {
    // A step's copy reaches Vikunja but its reply doesn't. The start carries on later, without a second copy.
    const copies = async () => Promise.all((await subtasks(template.id)).map(async s => ((await api('/tasks/' + s.id)).related_tasks?.copiedto || []).length));
    const before = await copies();
    let cut = true, seen = 0;
    const lose = async r => { if (!cut || r.request().method() !== 'POST' || ++seen < 2) return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/tasks/*/duplicate', lose);                  // the run goes through; its first step's reply is lost
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
    // Ticked 8 seconds ago, as the page's clock has it, so Vikunja gets the tick well after it was made.
    await page.clock.setSystemTime(Date.now() - 8000);
    await page.click('#step-done');
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .check.wait');
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .did.waiting[aria-label$="waiting to send"]');
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (30|29)m$")');    // counting from the tick here
    await page.fill('#step-note', 'Written offline');
    await page.click('#step-note-form button');
    await page.waitForSelector('#step-extra .comment:has-text("Written offline"):has-text("Waiting to send")');
    await page.reload();                                                     // e.g. the phone closed the app
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .check.wait', { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    await page.clock.setSystemTime(Date.now());
    // Said, as the other steps do: after a reload offline, Chrome's offline emulation can leave the page thinking it's
    // online already, so it never hears the connection come back.
    await context.setOffline(false);
    await online();
    await page.waitForSelector('#run-steps .row:nth-of-type(1):not(:has(.check.wait))', { timeout: 20000 });
    const id = (await runStep(run, 0)).id, step2 = (await runStep(run, 1)).id;
    await until('the tick never reached Vikunja', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    // Sent, the steps timed from it still count from the tick here, not from when Vikunja got it.
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
    if (n !== 1) throw new Error(n + ' copies');
    await page.unroute('**/api/v2/tasks/*/comments', lose);
  });

  await step('insert-and-repeat-a-step', async () => {
    // The bottom box adds a step after the step on the card, the line above it saying so: a step typed there goes after
    // it, the next after that one, and Repeat adds a fresh copy of the card's step there. Neither changes the template.
    const { id } = await startRun(), tplSteps = (await subtasks(template.id)).length;
    const titles = async () => (await subtasks(id)).map(s => s.title).join(' | ');
    const box = '#in-capture', what = page.locator('#cap-target .what'), go = '#f-capture .go';
    const add = async text => { await page.fill(box, text); await page.press(box, 'Enter'); };
    await page.click('#step-done');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    // No › on the rows, their ticks at their left edge: the box is at the bottom, aimed at the card's step, and + is off
    // while it's empty.
    const [rowBox, tickBox] = await Promise.all(['', ' > .check'].map(s => page.locator('#run-steps .row:nth-of-type(1)' + s).boundingBox()));
    if (tickBox.x - rowBox.x > 24) throw new Error(`the tick is ${tickBox.x - rowBox.x}px in from the row's edge`);
    await expect(what).toHaveText('Add a step after “Warm up the press”');
    await expect(page.locator(box)).toHaveAttribute('placeholder', 'Add a step, or paste a list');
    await expect(page.locator(box)).toHaveAttribute('aria-label', 'New step after “Warm up the press”');
    if (!await page.isDisabled(go)) throw new Error('+ works with nothing in the box');
    // A done step's row puts it on the card, and the box aims there.
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await expect(what).toHaveText('Add a step after “Check the guards at 3pm”');
    await add('Wipe the oil off the floor');
    // In its place at once; the box empty, focused, and aimed after it, for the next.
    await page.waitForSelector('#run-steps .row:nth-of-type(2):has-text("Wipe the oil off the floor")');
    await expect(what).toHaveText('Add a step after “Wipe the oil off the floor”');
    await expect(page.locator(box)).toHaveValue('');
    await expect(page.locator(box)).toBeFocused();
    await expect(page.locator('#step-title')).toHaveText('Check the guards at 3pm');                // the card stays
    await until('not inserted before Warm up the press', async () => await titles() === 'Check the guards at 3pm | Wipe the oil off the floor | Warm up the press | First article check');
    const inserted = await api('/tasks/' + (await runStep(id, 1)).id);
    if (!/pocket:added/.test(inserted.description) || inserted.related_tasks?.copiedfrom?.length || inserted.done) throw new Error('inserted: ' + JSON.stringify(inserted.description));
    await page.click('#run-steps .row:nth-of-type(2) .body');
    await page.waitForSelector('#step-added:text-is("Inserted")', { timeout: 15000 });
    // The step after it still counts from the template's step before it.
    await page.waitForSelector('#run-steps .row:nth-of-type(3) .meta .due span:text-matches("^Due in (30|29)m$")');
    // Repeat, on the line: a copy of the card's step, not done, where the box aims, at once, with an Undo by the box.
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await page.getByRole('button', { name: 'Repeat “Check the guards at 3pm”' }).click();
    await page.waitForSelector('#run-steps .row:nth-of-type(2):has-text("Check the guards at 3pm")');
    await expect(what).toHaveText('Add a step after “Check the guards at 3pm”');
    await expect(placeLine(page, 'cap')).toContainText('Repeated “Check the guards at 3pm”');
    await until('not repeated after the first step', async () => await titles() === 'Check the guards at 3pm | Check the guards at 3pm | Wipe the oil off the floor | Warm up the press | First article check');
    const [orig, copy] = await Promise.all([0, 1].map(async i => task((await runStep(id, i)).id)));
    if (copy.done || copy.reactions?.['✅']?.length || copy.related_tasks?.copiedfrom?.[0]?.id === orig.id) throw new Error('the copy has the first one\'s history');
    if (!/pocket:added/.test(copy.description) || !copy.description.includes('pocket:step Check the guards at 3pm')) throw new Error('copy: ' + copy.description);
    if ((await subtasks(template.id)).length !== tplSteps) throw new Error('the template changed');
    // Again, then Undo: that copy goes, and the box aims after the first copy again.
    await toastGone().catch(() => {});
    await page.getByRole('button', { name: 'Repeat “Check the guards at 3pm”' }).click();
    await page.waitForSelector('#run-steps .row:nth-of-type(3):has-text("Check the guards at 3pm")');
    await placeLine(page, 'cap').getByRole('button', { name: 'Undo' }).click();
    await page.waitForSelector('#run-steps .row:nth-of-type(3):has-text("Wipe the oil off the floor")', { timeout: 15000 });
    await until('the repeat undone is still there', async () => (await titles()).split('Check the guards at 3pm').length === 3);
    await expect(what).toHaveText('Add a step after “Check the guards at 3pm”');
    // A step put on the card starts again from it.
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await expect(what).toHaveText('Add a step after “Wipe the oil off the floor”');
    // Its order stays after a reload, each marked.
    await page.reload();
    await page.waitForSelector('#run-steps .row:nth-of-type(2) .meta .added span:text-is("Repeated")', { timeout: 15000 });
    await page.waitForSelector('#run-steps .row:nth-of-type(3) .meta .added span:text-is("Inserted")');
    // One added by mistake is deleted, until it's done. Swiped left all the way, it's asked about before its row goes
    // anywhere (rows-and-sheet-fixes-plan, part 2), the question answered in the page: said no to, the row is back.
    const ins = '#run-steps .row:nth-of-type(3)';
    await page.locator(ins).evaluate(row => {
      window.__asked = []; window.__confirm = window.confirm;
      window.confirm = q => { window.__asked.push({ q, x: new DOMMatrix(getComputedStyle(row).transform).m41, w: row.clientWidth, moving: row.getAnimations().length }); return false; };
    });
    try {
      await swipeRow(page, ins, 'delete');
      await expect.poll(() => page.evaluate(() => window.__asked.length)).toBe(1);
      const a = (await page.evaluate(() => window.__asked))[0];
      if (!a.q.startsWith('Delete “Wipe the oil off the floor”?') || a.x > -a.w / 2 || a.moving) throw new Error('asked after its row had moved on: ' + JSON.stringify(a));
      await expect(page.locator(ins)).not.toHaveClass(/\bswip/);
      await expect(uncovered(page, '.row-red')).toHaveCount(0);
    } finally { await page.evaluate(() => { window.confirm = window.__confirm; }); }
    if (!(await titles()).includes('Wipe the oil')) throw new Error('said no to, the step was deleted');
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await page.click('#step-delete');
    await expect(page.locator('.place-line', { hasText: 'Step deleted' })).toBeVisible();   // in its sheet, or on the run
    await until('the inserted step is still there', async () => !(await titles()).includes('Wipe the oil'));
    // Its reply lost: inserted once.
    let cut = true;
    const lose = async r => { if (!cut || r.request().method() !== 'POST') return r.fallback(); cut = false; await r.fetch(); return r.abort('internetdisconnected'); };
    await page.route('**/api/v2/projects/*/tasks', lose);
    await page.click('#run-steps .row:nth-of-type(1) .body');
    await expect(what).toHaveText('Add a step after “Check the guards at 3pm”');
    await add('Sweep up');
    await online();
    await until('never inserted after its reply was lost', async () => (await titles()).includes('Sweep up'));
    await page.unroute('**/api/v2/projects/*/tasks', lose);
    if ((await titles()).split('Sweep up').length !== 2) throw new Error('inserted twice: ' + await titles());
    // Offline: shown in its place, after the one before it, waiting, and ticked meanwhile; both reach Vikunja once it's
    // back. (What's added goes where the box aims, not on the card: tapped, it is.)
    await page.waitForSelector('#run-steps .row:nth-of-type(2):has-text("Sweep up")', { timeout: 15000 });
    await expect(what).toHaveText('Add a step after “Sweep up”');
    await context.setOffline(true);
    await add('Offline step');
    await page.waitForSelector('#run-steps .row:nth-of-type(3):has-text("Offline step")');
    await page.click('#run-steps .row:has-text("Offline step") > .body');
    await page.waitForSelector('#step-added:text-is("Inserted · waiting to send")');
    await page.click('#step-done');
    await page.waitForSelector('#run-steps .row:has-text("Offline step") .check.wait');
    await context.setOffline(false);
    await online();
    await until('the step inserted offline never reached Vikunja, ticked', async () => {
      const s = (await subtasks(id)).find(x => x.title === 'Offline step');
      if (!s) return false;
      const t = await task(s.id);
      return t.done && t.reactions?.['✅']?.some(u => u.id === me.id);
    }, 30000);
    const order = (await titles()).split(' | ');
    if (order.indexOf('Offline step') !== order.indexOf('Sweep up') + 1) throw new Error('not where it was added: ' + order.join(' | '));
    // Called off from Waiting to send, though it was tried before the connection went: nothing of it is left, and the
    // box aims at the card's step again.
    await context.setOffline(true);
    await add('Not after all');
    await page.waitForSelector('#run-steps .row:has-text("Not after all")');
    await expect(what).toHaveText('Add a step after “Not after all”');
    await page.waitForSelector('#btn-refresh.waits', { timeout: 5000 });
    await page.click('#btn-refresh');
    await page.click('#outbox-rows .ob-row:has-text("Not after all") .ob-drop');
    await page.waitForSelector('#run-steps .row:has-text("Not after all")', { state: 'detached' });
    await page.click('#btn-sheet-close');
    await expect(what).toHaveText(`Add a step after “${await page.textContent('#step-title')}”`);
    await context.setOffline(false);
    await online();
    await synced(page);                                                      // nothing left waiting: the step called off too
    if ((await titles()).includes('Not after all')) throw new Error('inserted after all: ' + await titles());
    if ((await api('/tasks?q=' + encodeURIComponent('Not after all'))).items.some(t => t.title === 'Not after all')) throw new Error('left as a task of its own');
    // Quick add, as in the subtask box: its chips and marks, no date (a step's time is its template's), and a pasted
    // list is a step a line, in order.
    await page.fill(box, 'Mop up !3 tomorrow');
    await page.waitForSelector('#cap-chips .chip:has-text("Priority 3")');
    await page.waitForSelector('#capture .cap-marks mark[data-kind="priority"]', { state: 'attached' });
    if (await page.$('#cap-chips .chip[data-kind="due"]')) throw new Error('a date was read');
    await page.fill(box, 'Mop up !3 tomorrow\nRinse the mop');
    await page.waitForSelector('#cap-chips .chip:has-text("2 steps")');
    await page.press(box, 'Enter');
    await until('the pasted steps were never inserted', async () => (await titles()).includes('Mop up tomorrow | Rinse the mop'));
    const mop = (await subtasks(id)).find(s => s.title === 'Mop up tomorrow');
    if ((await api('/tasks/' + mop.id)).priority !== 3) throw new Error('its priority was not read');
    // A nudge on a step's row (a short, slow scroll that starts on it) puts it on the card, as a tap does, so the box
    // aims there; a longer one is only a scroll.
    const row = n => `#run-steps .row:nth-of-type(${n})`;
    await page.locator(row(2)).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await touchDrag(row(2), 30);
    await expect(page.locator('#step-title')).toHaveText('Sweep up');
    await expect(page.locator(row(2))).toHaveClass(/current/);
    await expect(what).toHaveText('Add a step after “Sweep up”');
    await touchDrag(row(1), 150, 30);                                        // further than a row: a scroll
    await expect(page.locator(row(2))).toHaveClass(/current/);
    await touchDrag(row(1), 30);
    await expect(page.locator(row(1))).toHaveClass(/current/);
    await expect(what).toHaveText('Add a step after “Check the guards at 3pm”');
  });

  await step('add-a-step-after-the-last', async () => {
    // Every step done, the run not finished: the box aims at the last step, and what's added goes at the end.
    const { id } = await startRun();
    for (const t of ['Warm up the press', 'First article check']) { await page.click('#step-done'); await page.waitForSelector(`#step-title:text-is("${t}")`); }
    await page.click('#step-done');
    await page.waitForSelector('#finish-card');
    await expect(page.locator('#cap-target .what')).toHaveText('Add a step after “First article check”');
    await page.fill('#in-capture', 'Lock the back door');
    await page.press('#in-capture', 'Enter');
    await page.waitForSelector('#step-title:text-is("Lock the back door")', { timeout: 15000 });
    await until('not added at the end', async () => (await subtasks(id)).map(s => s.title).pop() === 'Lock the back door');
  });

  await step('a-run-and-its-card-open-on-its-next-step-in-order', async () => {
    // Opened, a run's screen and its card on Today go by one rule (parent-tasks-plan, part 2: whereNext): the next open
    // step in order, even one counting down; a timed step whose time has come before it. The guards done, the press and
    // the check count down: the press is next, not the step added after them.
    const { id } = await startRun();
    await page.click('#step-done');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    await page.click('#run-steps .row:nth-of-type(3) .body');
    await expect(page.locator('#cap-target .what')).toHaveText('Add a step after “First article check”');
    await page.fill('#in-capture', 'Sweep the floor');
    await page.press('#in-capture', 'Enter');
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
    // The check's time come (moved back by hand): it comes first, on Today and on the run's screen.
    const check = (await runStep(id, 2)).id;
    await api('/tasks/' + check, { method: 'PATCH', body: JSON.stringify({ due_date: new Date(Date.now() - 60000).toISOString() }) });
    await page.click('#btn-refresh');
    await page.waitForSelector('#btn-refresh:not([disabled])');
    await expect(page.locator(`${card} .step-line .title > span:not(.sr)`)).toHaveText('First article check', { timeout: 15000 });
    await page.click(`${card} > .card-head .card-open`);
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
  });

  await step('swipe-a-step-to-set-its-progress', async () => {
    // As on a task's row: a plain swipe, in snaps of 25%. Sent like a tick; a full swipe is Done, with its ✅ and Undo.
    // Last time's notes answer late this time, after the run is on screen: a step's go on its card, above the steps, so
    // they're held back from the card on screen, and nothing under a finger moves as they come.
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
    // A step's row, and the run's own row atop the screen, tell the phone that sideways on them is a swipe, not a scroll
    // (as a task's rows do: smoke.mjs), so it never takes the touch away as the swipe starts.
    for (const sel of [row, '#run-own > .row']) await expect(page.locator(sel), sel).toHaveCSS('touch-action', 'pan-y pinch-zoom');
    // Swiped to `to`% from `from`% (swipeRow: in the middle of the screen, clear of its edges and of the box at its foot).
    const slide = (to, from, check) => swipeRow(page, row, to, { start: from, check });
    // Its tick shows it, as a task's does: its pie (--pct).
    const pie = () => page.$eval(row, el => getComputedStyle(el).getPropertyValue('--pct').trim());
    await toastGone().catch(() => {});
    await slide(25, 0, async () => { if (await pie() !== '0') throw new Error('its tick changed while it was held: ' + await pie()); });
    // On its tick only, as a task's: a screen reader hears it, and swiping back is the undo.
    await expect(page.locator('#said')).toHaveText('Progress of Warm up the press set to 25%');
    await noToast(page);
    await until('its progress never reached Vikunja', async () => Math.round((await api('/tasks/' + step2)).percent_done * 100) === 25);
    await expect.poll(pie).toBe('0.25');
    if (await page.textContent('#step-title') !== 'Check the guards at 3pm') throw new Error('letting go opened the step');
    await slide(0, 25);
    await until('swiping back never put it back', async () => !(await api('/tasks/' + step2)).percent_done);
    await expect.poll(pie).toBe('0');
    // With the bottom box focused, a step's row still swipes, and the box stays aimed at the card's step.
    await toastGone().catch(() => {});
    await page.focus('#in-capture');
    await slide(50, 0);
    await expect(page.locator('#said')).toHaveText('Progress of Warm up the press set to 50%');
    await until('its progress never reached Vikunja with the box focused', async () => Math.round((await api('/tasks/' + step2)).percent_done * 100) === 50);
    await expect(page.locator('#cap-target .what')).toHaveText('Add a step after “Check the guards at 3pm”');
    await page.locator('#in-capture').blur();
    await toastGone().catch(() => {});
    // Offline, Waiting to send says what it is.
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
    // Swiped all the way and held while the run's screen redraws (every second, for countdowns): still full; let go,
    // done with its ✅, the gap in its place, "Done" and Undo, which unticks it.
    await slide(100, 75, async () => {
      await page.waitForTimeout(1500);
      await expect(uncovered(page)).toHaveClass(/\bfull\b/);
      // The green is laid still under the step's row, in its list, and its box is a step's: square.
      const lies = await laidUnder(page, row);
      if (lies.inside || lies.off > .5 || lies.ring !== 10) throw new Error('what the step uncovers isn\'t laid still under it: ' + JSON.stringify(lies));
      await expect(uncovered(page)).toHaveClass(/\bsq\b/);
    });
    await until('a full swipe never made it done', async () => { const t = await task(step2); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    await expect(page.locator(row)).toHaveClass(/\bswept\b/);
    await expect(page.locator(`${row} > .del-gap`)).toContainText('Done');
    await page.locator(row).getByRole('button', { name: 'Undo: Warm up the press' }).click();
    await until('Undo never made it not done', async () => !(await task(step2)).done);
  });

  await step('a-time-after-a-step-named-in-words', async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.waitForFunction(() => document.activeElement?.id === 'nt-name');   // the sheet's own focus, before typing
    await page.fill('#nt-name', `Words ${stamp}`);
    await page.fill('#new-step-0', 'Start the hydraulics');
    await page.press('#new-step-0', 'Enter');
    await page.fill('#new-step-1', 'Wipe the bed');
    await page.press('#new-step-1', 'Enter');
    await page.fill('#new-step-2', 'Check the oil 30 minutes after Start the hydraulics');
    await page.click('#nt-create');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 20000 });
    let tpl;
    await until('the template never appeared', async () => (tpl = ((await api(`/projects/${project.id}/tasks?filter=${encodeURIComponent('done = true')}`)).items || []).find(t => t.title === `TEMPLATE: Words ${stamp}`)));
    const titles = (await subtasks(tpl.id)).map(s => s.title);
    if (JSON.stringify(titles) !== JSON.stringify(['Start the hydraulics {#start-the-hydraulics}', 'Wipe the bed', 'Check the oil T#30m:start-the-hydraulics'])) throw new Error('steps: ' + titles.join(' | '));
    for (const s of await subtasks(tpl.id)) await api('/tasks/' + s.id, { method: 'DELETE' });
    await api('/tasks/' + tpl.id, { method: 'DELETE' });
  });

  await step('back-from-a-project-opened-from-checklists', async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl[data-project="${project.id}"] .sec-act`, { timeout: 15000 });
    await page.waitForFunction(id => location.hash === '#/project/' + id, project.id, { timeout: 15000 });
    if (await page.getAttribute('#btn-back', 'aria-label') !== 'Back to checklists') throw new Error('back: ' + await page.getAttribute('#btn-back', 'aria-label'));
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
  });

  await step('change-remove-and-delete-a-template', async () => {
    // A template of its own, so the others' steps stay as they are: two steps, one changed in place, one removed, then
    // the template deleted with its steps. Its sheet has no tick: a template is never done or not done.
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
    // Tapped, the step is ready to type or speak into.
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, a.id, { timeout: 5000 });
    await page.fill(`#step-edit-${a.id}`, 'Stir in 2 min');
    await page.press(`#step-edit-${a.id}`, 'Enter');
    await until('the step never changed', async () => (await api('/tasks/' + a.id)).title === 'Stir T#2m');
    // Refused: what was typed stays in the box, to put right. (Typed once the box has the focus, as a finger would.)
    await page.click('#d-subtasks .row:nth-of-type(1) .body');
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, a.id, { timeout: 5000 });
    await page.fill(`#step-edit-${a.id}`, 'Stir T#2m:nope');
    await page.press(`#step-edit-${a.id}`, 'Enter');
    await said('sheet:subtasks', 'Not changed: step 1, “Stir”');
    if (await page.inputValue(`#step-edit-${a.id}`) !== 'Stir T#2m:nope') throw new Error('what was typed went');
    await page.press(`#step-edit-${a.id}`, 'Escape');
    await page.waitForSelector(`#step-edit-${a.id}`, { state: 'detached' });
    if ((await api('/tasks/' + a.id)).title !== 'Stir T#2m') throw new Error('changed anyway');
    // A step's notes and photos, in its own sheet: its name without its time, no tick or due date, and back again.
    await page.click('#d-subtasks .row:nth-of-type(1) > button.body');
    if (await page.$$eval('#d-subtasks .step-edit', els => els.length) !== 1) throw new Error('buttons on more than the step tapped');
    await page.click(`#step-notes-${a.id}`);
    await page.waitForSelector('#d-step-title:text-is("Stir")');
    await page.waitForSelector('#d-step-when:has-text("Step 1 of 2")');
    await expect(page.locator('#d-comments')).toHaveCount(0);                // a run's copy of the step doesn't get them
    if (await page.$('#d-done') || await page.$('#d-progress') || await page.isVisible('#d-due') || await page.isVisible('#d-subtasks')) throw new Error("a template's step has a tick, a date or subtasks");
    await page.click('#d-desc');
    await page.fill('#d-desc-in', 'Use the long spoon.\nNot the whisk.');
    await page.click('#d-desc-save');
    await until('the notes never reached the step', async () => /long spoon/.test((await api('/tasks/' + a.id)).description || ''));
    await page.click('#d-open-template');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(1) .step-note:text-is("Use the long spoon.")', { timeout: 10000 });
    await page.click(await stepButton(2, 'Remove step'));
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
    // A task with subtasks, in a checklist project: its ⋯ makes it a template. An ordinary task's sheet shows no card for it.
    const make = async (title) => api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title }) });
    const t = await make(`Deliveries ${stamp}`), a = await make('Check the delivery note'), b = await make('Put the milk in the fridge');
    for (const st of [a, b]) await api(`/tasks/${t.id}/relations`, { method: 'POST', body: JSON.stringify({ other_task_id: st.id, relation_kind: 'subtask' }) });
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click(`${cardOf(`Deliveries ${stamp}`)} > .card-head .card-open`, { timeout: 15000 });   // a card: it has open subtasks
    await page.waitForSelector('#d-subtasks .row');
    if (await page.$('#d-checklist')) throw new Error('a card for it shows on the task');
    await page.click('#d-more');
    await page.click('#d-make-template');
    await until('never made a template', async () => { const x = await api('/tasks/' + t.id); return x.done && x.labels?.some(l => l.title === 'template') && x.title === `TEMPLATE: Deliveries ${stamp}`; });
    await page.waitForSelector('#d-start', { timeout: 15000 });           // now its sheet is a template's
    await page.click('#d-more');
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 15000 });
  });

  await step('quick-add-in-a-template', async () => {
    // The name and each step are written in quick add's box: what it reads shows as chips, and goes to Vikunja. A step
    // changed in place is read the same way, its words without them.
    const name = `Quick ${stamp}`;
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.waitForFunction(() => document.activeElement?.id === 'nt-name');
    // Empty, each box says what it reads: in the name, @user is who its runs are for.
    await page.waitForSelector('.nt-name .box-chips .hint:has-text("who its runs are for")');
    // A date isn't read in the name, and a chip says so.
    await page.keyboard.type(`${name} every day at 7`);
    await page.waitForSelector('.nt-name .box-chips .chip.quiet:has-text("Dates stay in its name")');
    await page.fill('#nt-name', '');
    await page.keyboard.type(other ? `${name} @${OTHER}` : `${name} !2`);
    await page.waitForSelector(`.nt-name .box-chips .chip:has-text("${other ? '@' + OTHER : 'Priority 2'}")`);
    await page.focus('#new-step-0');
    await page.waitForSelector('#new-steps .draft-step:nth-of-type(1) .box-chips .hint:has-text("who does it")');
    await page.fill('#new-step-0', 'Unlock the door !3');
    await page.waitForSelector('#new-steps .draft-step:nth-of-type(1) .box-chips .chip:has-text("Priority 3")');
    await page.press('#new-step-0', 'Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'new-step-1');
    // Typed straight away, as a fast typist does: no letter is lost while the new row appears.
    await page.keyboard.type(`Turn the sign 5 min later${other ? ' @' + OTHER : ''}`);
    await page.waitForSelector('#new-steps .draft-step:nth-of-type(2) .cap-marks mark[data-kind="due"]:text-is("5 min later")', { state: 'attached' });
    await page.press('#new-step-1', 'Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'new-step-2');
    await page.keyboard.type('Count the till !4');                       // its priority tapped off: "!4" stays in its name
    await page.click('#new-steps .draft-step:nth-of-type(3) .box-chips .chip:has-text("Priority 4")');
    await page.click('#nt-create');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 20000 });
    let tpl;
    await until('the template never appeared', async () => (tpl = ((await api(`/projects/${project.id}/tasks?filter=${encodeURIComponent('done = true')}`)).items || []).find(t => t.title === `TEMPLATE: ${name}`)));
    tpl = await api('/tasks/' + tpl.id);
    if (other ? !tpl.assignees?.some(u => u.id === other.id) : tpl.priority !== 2) throw new Error(`template: assignees ${JSON.stringify(tpl.assignees?.map(u => u.username))}, priority ${tpl.priority}`);
    const steps = await Promise.all((await subtasks(tpl.id)).map(s => api('/tasks/' + s.id)));
    if (JSON.stringify(steps.map(s => [s.title, s.priority])) !== JSON.stringify([['Unlock the door', 3], ['Turn the sign T#5m', 0], ['Count the till !4', 0]])) throw new Error('steps: ' + JSON.stringify(steps.map(s => [s.title, s.priority])));
    // Changed in place: !1 sets its priority, and leaves its name as it was.
    await page.click(`.cl-tpl:has(.title:text-is("${name}")) .body`, { timeout: 15000 });
    await page.click('#d-subtasks .row:nth-of-type(1) > button.body');
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, steps[0].id, { timeout: 5000 });
    await page.fill(`#step-edit-${steps[0].id}`, 'Unlock the door !1');
    await page.waitForSelector('.step-in .box-chips .chip:has-text("Priority 1")');
    await page.press(`#step-edit-${steps[0].id}`, 'Enter');
    await until('its priority never changed', async () => (await api('/tasks/' + steps[0].id)).priority === 1);
    if ((await api('/tasks/' + steps[0].id)).title !== 'Unlock the door') throw new Error('title: ' + (await api('/tasks/' + steps[0].id)).title);
    // Words kept as words when it was written stay so when it's changed: "!4" isn't read as a priority now.
    await page.click('#d-subtasks .row:nth-of-type(3) > button.body');
    await page.waitForFunction(id => document.activeElement?.id === 'step-edit-' + id, steps[2].id, { timeout: 5000 });
    await page.fill(`#step-edit-${steps[2].id}`, 'Count the till !4 twice');
    await page.press(`#step-edit-${steps[2].id}`, 'Enter');
    await until('the step never changed', async () => (await api('/tasks/' + steps[2].id)).title === 'Count the till !4 twice');
    if ((await api('/tasks/' + steps[2].id)).priority) throw new Error('"!4" was read as a priority');
    // Who a step is for, tapped off it while it's changed.
    if (other) {
      await page.click('#d-subtasks .row:nth-of-type(2) > button.body');
      await page.click(`.step-in .box-chips .chip:has-text("@${OTHER}")`);
      await page.waitForSelector(`.step-in .box-chips .chip.off:has-text("@${OTHER}")`);
      await page.press(`#step-edit-${steps[1].id}`, 'Enter');
      await until('they were never taken off the step', async () => !(await api('/tasks/' + steps[1].id)).assignees?.length);
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
    const row = i => page.locator('#add-steps > .draft-step').nth(i);
    // Counting from a name no step has: not added.
    await page.click('#add-add-step');
    await page.waitForFunction(() => document.activeElement?.id === 'add-step-0', null, { timeout: 5000 });   // ready to type in
    await row(0).locator('.draft-in').fill('Pull a sample T#5m:nope');
    await row(0).locator('.draft-meta .bad:has-text("no step is named “nope”")').waitFor();
    if (await page.isEnabled('#add-steps-go')) throw new Error('can be added');
    // Its chip is still there, to pick a step it can count from.
    await row(0).locator('select').selectOption({ label: 'Warm up the press' });
    await page.waitForSelector('#add-steps-go:not([disabled])');
    // A pasted list becomes a row a line; one counts from a step already there, which gets a name.
    await row(0).locator('.draft-in').fill('');
    await row(0).locator('.draft-in').evaluate(el => { const dt = new DataTransfer(); dt.setData('text/plain', 'Pull a sample in 5 min\nLog the weights'); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    await row(1).locator('.draft-in').waitFor();
    await row(0).locator('select').selectOption({ label: 'Warm up the press' });
    // The reply to the first is lost: Add again finds it, rather than leaving a stray copy as a to-do.
    let posts = 0;
    const loseStep = async r => { if (r.request().method() !== 'POST' || ++posts !== 1) return r.fallback(); await r.fetch(); return r.abort('connectionreset'); };
    await page.route(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await toastGone().catch(() => {});
    await page.click('#add-steps-go:has-text("Add 2 steps")');
    await said('sheet:subtasks', 'Added 0 of 2');
    await page.unroute(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    // Vikunja on SQLite busy for a moment ("database is locked") as a step is put under the template: tried again.
    let locked = 0;
    const lock = r => r.request().method() === 'POST' && ++locked === 1 ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"database is locked"}' }) : r.fallback();
    await page.route('**/api/v2/tasks/*/relations', lock);
    await toastGone().catch(() => {});
    await page.click('#add-steps-go:has-text("Add 2 steps")');
    await until('the steps were never added', async () => (await subtasks(template.id)).length === 5);
    await page.unroute('**/api/v2/tasks/*/relations', lock);
    if (!locked) throw new Error('no step was put under the template');
    if (await page.isVisible('.place-line:has-text("Added")')) throw new Error('it said: ' + await page.textContent('.place-line'));
    const sample = (await api('/tasks?q=' + encodeURIComponent('Pull a sample'))).items.filter(t => t.project_id === project.id);
    if (sample.length !== 1) throw new Error(`${sample.length} tasks “Pull a sample”`);
    const titles = (await subtasks(template.id)).map(s => s.title);
    const want = [STEPS[0], 'Warm up the press T#30m {#warm-up}', STEPS[2], 'Pull a sample T#5m:warm-up', 'Log the weights'];
    if (JSON.stringify(titles) !== JSON.stringify(want)) throw new Error('steps: ' + titles.join(' | '));
    if (!(await subtasks(template.id)).every(s => s.done)) throw new Error('a new step isn\'t done');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(4) .meta:has-text("Due 5m after “Warm up the press”")');
    // Still busy after a few tries: the step made isn't left behind as a task of its own.
    const stray = `Stray step ${stamp}`, busy = r => r.request().method() === 'POST' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"database is locked"}' }) : r.fallback();
    await page.click('#add-add-step');
    await row(0).locator('.draft-in').fill(stray);
    await page.route('**/api/v2/tasks/*/relations', busy);
    await page.click('#add-steps-go:has-text("Add 1 step")');
    await said('sheet:subtasks', 'Added 0 of 1');
    await page.unroute('**/api/v2/tasks/*/relations', busy);
    await until('the step was left as a task of its own', async () => !(await api('/tasks?q=' + encodeURIComponent(stray))).items.some(t => t.title === stray));
    await row(0).locator('button[aria-label^="Remove"]').click();
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  /* A template that comes round: its date set in its sheet leaves it not done, a repeating task in Vikunja; on Today it
     has no tick and opens Start; a start ticks it, so Vikunja moves it on, unless it isn't due until later; a lost reply
     to the tick doesn't skip twice; one left for months moves to its next time after now; without a repeat a start
     ends it; and taking its date off leaves it done. A template of its own, with one step. */
  const ZERO = '0001-01-01T00:00:00Z';
  const minute = ms => new Date(Math.floor(ms / 60000) * 60000);
  const local = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
  const DAILY = `Daily ${stamp}`, dailyRow = `.cl-tpl:has(.title:text-is("${DAILY}"))`;
  let daily;
  const setDaily = fields => api('/tasks/' + daily.id, { method: 'PATCH', body: JSON.stringify(fields) });
  // Started from Today's row, or from Checklists: the run it made, and the template after.
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
    // Its sheet: a date and a repeat, under Comes round. The date leaves it not done.
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${dailyRow} .body`, { timeout: 15000 });
    await page.waitForSelector('#d-comes-round');
    const due = minute(Date.now() - 3600e3);
    await page.fill('#d-due', local(due));
    await page.dispatchEvent('#d-due', 'change');
    await until('its date never made it not done', async () => { const t = await api('/tasks/' + daily.id); return !t.done && sameTime(t.due_date, due.toISOString()); });
    await page.selectOption('#d-repeat', 'day');
    await until('never repeats', async () => (await api('/tasks/' + daily.id)).repeat_after === 86400);
    if ((await api('/tasks/' + daily.id)).done) throw new Error('done after its repeat was set');
    await page.waitForSelector('#d-comes-round:has-text("then every day")');             // what its date and repeat do
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    // Under Checklists, when it's due; on Today, with no tick, and tapping it opens Start.
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.waitForSelector(`${dailyRow} .cl-when:has-text("Due now, since"):has-text("then every day")`, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/today'; });
    const row = `#view .row:has(> .body .title:has-text("${DAILY}"))`;
    await page.waitForSelector(`${row} .title .sr:has-text("Checklist: tap to start")`, { state: 'attached', timeout: 15000 });
    if (await page.$(`${row} button.check`)) throw new Error('it has a tick on Today');
    // With only it overdue, there's no Move all to today: it would move nothing.
    const overdue = await page.$$eval('.sec.overdue ~ .list .row', els => els.length).catch(() => 0);
    if (overdue === 1 && await page.$('#btn-overdue-today')) throw new Error('Move all to today, with only a checklist overdue');
    await page.click(`${row} > .body`);
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
    const note = await page.textContent('#start-note');
    if (!/^This is the .*: starting it moves Daily .* on to /.test(note)) throw new Error('note: ' + note);
    // For its assignees.
    if (other) for (const u of [me.username, OTHER]) if (await page.getAttribute(`#start-for .chip[data-user="${u}"]`, 'aria-pressed') !== 'true') throw new Error(`not for ${u}`);
    const before = new Set(((await api('/tasks/' + daily.id)).related_tasks?.copiedto || []).map(t => t.id));
    await page.click('#start-go');
    await page.waitForFunction(() => /^#\/run\/\d+$/.test(location.hash), null, { timeout: 30000 });
    const id = (((await api('/tasks/' + daily.id)).related_tasks?.copiedto || []).find(t => !before.has(t.id)) || {}).id;
    const run = await api('/tasks/' + id), tpl = await api('/tasks/' + daily.id);
    // The run: named without "TEMPLATE: ", due when the template was, for its assignees, with nothing that repeats or reminds.
    if (!run.title.startsWith(`${DAILY} · run `)) throw new Error('run title: ' + run.title);
    if (!sameTime(run.due_date, due.toISOString())) throw new Error('run due ' + run.due_date);
    if (run.repeat_after || run.repeat_mode || (run.reminders || []).length) throw new Error(`run repeats ${run.repeat_after}/${run.repeat_mode}, reminders ${run.reminders?.length}`);
    if (run.labels?.some(l => l.title === 'template') || run.done) throw new Error('the run is a template, or done');
    const want = other ? [me.id, other.id].sort((a, b) => a - b) : [me.id];
    if (JSON.stringify(run.assignees?.map(u => u.id).sort((a, b) => a - b)) !== JSON.stringify(want)) throw new Error('run for ' + JSON.stringify(run.assignees?.map(u => u.username)));
    // On Today, its card's heading is a task card's: its name without its day, and when it's due at the right, late.
    await page.evaluate(() => { location.hash = '#/today'; });
    const runCard = page.locator(cardOf(dayless(run.title)));
    await expect(runCard.locator('.card-title')).toHaveText(dayless(run.title), { timeout: 15000 });
    const at = await page.evaluate(ms => new Date(ms).toDateString() === new Date().toDateString() && new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), +due);
    await expect(runCard.locator('.card-head .due.overdue')).toHaveText(at ? shortTime(at) : /\S/);   // its time, short ("9a"), if it was today
    // The template, moved on a day by Vikunja, and still not done.
    if (tpl.done || !sameTime(tpl.due_date, new Date(+due + 864e5).toISOString())) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}`);
  });

  await step('a-start-before-its-day-leaves-it', async () => {
    const later = minute(Date.now() + 3 * 864e5);
    await setDaily({ due_date: later.toISOString() });
    const { run, tpl, note } = await startDaily();
    if (!/is next due .*: this run doesn't move it on/.test(note)) throw new Error('note: ' + note);
    if (tpl.done || !sameTime(tpl.due_date, later.toISOString())) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}`);
    if (run.due_date && !run.due_date.startsWith('0001')) throw new Error('run due ' + run.due_date);
  });

  await step('a-lost-reply-to-the-tick-skips-once', async () => {
    const due = minute(Date.now() - 3600e3);
    await setDaily({ due_date: due.toISOString() });
    // The tick reaches Vikunja, its reply doesn't: the start waits, and carries on without ticking it again.
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
    // Every month: Vikunja moves it one month, still late; Pocket moves it on to the first month after now.
    const due = minute(Date.now() - 92 * 864e5), months = n => { const d = new Date(due); d.setUTCMonth(d.getUTCMonth() + n); return d; };
    let n = 1; while (months(n) <= Date.now()) n++;
    await setDaily({ due_date: due.toISOString(), repeat_after: 0, repeat_mode: 1 });
    const { tpl, note } = await startDaily();
    if (!note.includes('the one due')) throw new Error('note: ' + note);
    if (tpl.done || !sameTime(tpl.due_date, months(n).toISOString())) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}, wanted ${months(n).toISOString()}`);
  });

  await step('without-a-repeat-a-start-ends-it', async () => {
    await setDaily({ due_date: minute(Date.now() - 600e3).toISOString(), repeat_after: 0, repeat_mode: 0 });
    const { tpl, note } = await startDaily();
    if (!note.includes("doesn't come round again")) throw new Error('note: ' + note);
    if (!tpl.done || (tpl.due_date && !tpl.due_date.startsWith('0001'))) throw new Error(`template done ${tpl.done}, due ${tpl.due_date}`);
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.waitForSelector(dailyRow, { timeout: 15000 });
    await loaded(page);                                                      // not the copy kept from before the start
    if (await page.$(`${dailyRow} .cl-when`)) throw new Error('it still says when it comes round');
  });

  await step('taking-its-date-off-leaves-it-done', async () => {
    const due = minute(Date.now() + 864e5);
    await setDaily({ done: false, due_date: due.toISOString(), repeat_after: 86400, repeat_mode: 0 });
    await page.evaluate(() => { location.hash = '#/today'; });
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${dailyRow} .body`, { timeout: 15000 });
    await page.waitForSelector('#d-due-clear');
    await page.click('#d-due-clear');
    // Its repeat is kept, so a date given again comes round as it did.
    await until('never done, with its repeat', async () => { const t = await api('/tasks/' + daily.id); return t.done && t.repeat_after === 86400; }, 15000);
    const t = await api('/tasks/' + daily.id);
    if (t.due_date !== ZERO || t.repeat_mode) throw new Error(`due ${t.due_date}, repeats ${t.repeat_after}/${t.repeat_mode}`);
    if (await page.inputValue('#d-repeat') !== 'day') throw new Error('Repeats: ' + await page.inputValue('#d-repeat'));
    if (await page.isVisible('#d-reminders')) throw new Error('reminders shown for a template that doesn\'t come round');
    await page.fill('#d-due', local(due));
    await until('not coming round again', async () => { const t = await api('/tasks/' + daily.id); return !t.done && sameTime(t.due_date, due.toISOString()) && t.repeat_after === 86400; }, 15000);
    await page.click('#d-due-clear');
    await until('never done again', async () => (await api('/tasks/' + daily.id)).done, 15000);
    // Repeats picked with no date gives it one, and says which.
    await toastGone().catch(() => {});
    await page.selectOption('#d-repeat', 'week');
    await said('sheet:due', 'It repeats from');
    await until('a repeat with no date never came round', async () => { const t = await api('/tasks/' + daily.id); return !t.done && t.repeat_after === 604800; }, 15000);
    await page.click('#d-due-clear');
    await until('never done once more', async () => (await api('/tasks/' + daily.id)).done, 15000);
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('make-a-template-with-a-due-date', async () => {
    // A task with a due date made a template comes round then: not done, its repeat kept.
    const due = minute(Date.now() + 2 * 864e5);
    const make = async (title, extra = {}) => api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title, ...extra }) });
    const t = await make(`Weekly clean ${stamp}`, { due_date: due.toISOString(), repeat_after: 604800 }), a = await make('Descale the kettle');
    await api(`/tasks/${t.id}/relations`, { method: 'POST', body: JSON.stringify({ other_task_id: a.id, relation_kind: 'subtask' }) });
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click(`${cardOf(`Weekly clean ${stamp}`)} > .card-head .card-open`, { timeout: 15000 });   // a card: it has an open subtask
    await page.waitForSelector('#d-subtasks .row');
    await page.click('#d-more');
    await page.click('#d-make-template');
    await said('sheet:top', 'Made a checklist template that comes round');
    await until('never made a template', async () => { const x = await api('/tasks/' + t.id); return x.labels?.some(l => l.title === 'template') && x.title === `TEMPLATE: Weekly clean ${stamp}`; });
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
    await said('sheet:top', 'No longer for checklists');
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
    // It opens on Checklists, where Getting started says what's next: sharing it, in Vikunja's web app.
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
    let id;
    await until('the project was never made', async () => (id = (await api('/projects')).items.find(p => p.title === `Front of house ${stamp}`)?.id));
    const made = await api('/projects/' + id);
    try {
      if (made.parent_project_id !== project.id) throw new Error(`made in ${made.parent_project_id}`);
      if (!/<p>pocket:checklists<\/p>/.test(made.description || '')) throw new Error('not for checklists: ' + made.description);
      await page.waitForSelector('nav.tabs a[data-tab=checklists]');
      await page.waitForSelector(`#getting-started-${id} a[href$="/projects/${id}/settings/share"]`, { timeout: 15000 });
      await page.click(`#getting-started-${id} .gs-hide`);
      await page.waitForSelector(`#getting-started-${id}`, { state: 'detached' });
      await page.reload();
      await page.waitForSelector(`.cl[data-project="${id}"]`, { timeout: 15000 });
      if (await page.$(`#getting-started-${id}`)) throw new Error('Getting started came back after it was hidden');
      // The project's ⋯ shows it again.
      await page.evaluate(pid => { location.hash = '#/project/' + pid; }, id);
      await page.click('#btn-project');
      await page.click('#p-show-started', { timeout: 15000 });
      await page.waitForSelector(`#getting-started-${id}`, { timeout: 15000 });
    } finally { await api('/projects/' + id, { method: 'DELETE' }).catch(() => {}); }
  });
  if (errors.length) { failed++; console.log('FAIL page errors:', errors); }
} finally {
  await synced(page, { timeout: 5000 }).catch(() => {});                  // what Pocket was still sending, first
  await browser.close();
  // The project, with every task in it. A few tries: a Vikunja on SQLite can answer 500 "database is locked" while busy.
  if (project) for (let i = 0; i < 5; i++) { try { await api('/projects/' + project.id, { method: 'DELETE' }); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
