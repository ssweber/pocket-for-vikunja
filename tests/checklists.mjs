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

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN;
const OUT = process.env.OUT || 'test-results';
const OTHER = process.env.OTHER_USER, OTHER_PASSWORD = process.env.OTHER_PASSWORD;
if (!SERVER || !TOKEN) { console.error('Set VIKUNJA_URL and VIKUNJA_TOKEN'); process.exit(2); }
const APP = process.env.POCKET_URL || SERVER + '/api/v1/plugins/pocket/';

const call = async (token, path, init = {}) => {
  const r = await fetch(SERVER + '/api/v2' + path, { ...init, headers: { Authorization: 'Bearer ' + token, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path}: HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
};
const api = (path, init) => call(TOKEN, path, init);
const task = id => api(`/tasks/${id}?expand=reactions&expand=comments`);
// A task's steps in the order Pocket shows them: a template's by the line "pocket:order …" in its description (steps it
// doesn't list after, by id), a run's by id.
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
const page = await context.newPage();
const errors = [];
page.on('console', m => m.type() === 'error' && !/status of (401|404)|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());

let failed = 0;
async function step(name, fn){
  try { await fn(); console.log('PASS', name); }
  catch (e) {
    failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/checklists-fail-${name}.png` }).catch(() => {});
    await context.setOffline(false); await page.unrouteAll();                // so one failure doesn't take the rest down with it
  }
}
const signIn = async (p, token) => {
  await p.goto(APP);
  await p.waitForSelector('#auth-step:not([hidden])', { timeout: 10000 });
  if (await p.isVisible('.seg button[data-mode=token]')) await p.click('.seg button[data-mode=token]');
  await p.fill('#in-token', token);
  await p.click('#f-token button[type=submit]');
  await p.waitForSelector('#app:not([hidden])');
  await p.waitForSelector('#view .loading', { state: 'detached', timeout: 15000 });
};
// A hidden toast keeps its words, only see-through: so only one showing counts.
const toast = text => page.waitForSelector(`#toast.show #toast-msg:has-text("${text}")`, { timeout: 20000 });
const toastGone = () => page.waitForSelector('#toast.show', { state: 'detached', timeout: 10000 });   // so the next one is new
const online = () => page.evaluate(() => window.dispatchEvent(new Event('online')));

const stamp = Date.now();
const TEMPLATE = `Startup ${stamp}`;
// The steps as written in New template, and as saved: times in words become T#, and the step one counts from gets a name.
const WRITTEN = ['Check the guards at 3pm', 'First article check 2 hours later', 'Warm up the press in 30 min'];
const STEPS = ['Check the guards at 3pm {#check-the-guards}', 'Warm up the press T#30m', 'First article check T#2h:check-the-guards'];
const GUARDS = '“Check the guards at 3pm”';
const tplRow = `.cl-tpl:has(.title:text-is("${TEMPLATE}"))`;
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

  await step('use-for-checklists', async () => {
    if (!checklistsBefore && await page.isVisible('nav.tabs a[data-tab=checklists]')) throw new Error('a Checklists tab without any checklist project');
    if (!checklistsBefore && await page.$eval('nav.tabs a[data-tab=today] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('the tab names are hidden');
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click('#btn-project');
    await page.click('#p-use-checklists');
    await toast('Now for checklists');
    await page.waitForSelector('nav.tabs.icons a[data-tab=checklists]');
    if (!await page.$eval('nav.tabs a[data-tab=today] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('three tabs, but with their names showing');
    if (!/<p>pocket:checklists<\/p>/.test((await api('/projects/' + project.id)).description)) throw new Error('no marker in the description');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('new-template', async () => {
    await page.click('nav.tabs a[data-tab=checklists]');
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
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
    await toast('Tap Make template again');
    await page.unroute(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await toastGone();
    await page.click('#nt-create');
    await toast(`Made ${TEMPLATE}`);
    const named = async title => (await api('/tasks?q=' + encodeURIComponent(title))).items.filter(t => t.title === title && t.project_id === project.id).length;
    for (const title of [TEMPLATE, ...STEPS]) if (await named(title) !== 1) throw new Error(`${await named(title)} tasks “${title}”`);
    await page.waitForSelector(tplRow, { timeout: 15000 });
    template = (await api('/tasks?q=' + encodeURIComponent(TEMPLATE))).items.find(t => t.title === TEMPLATE);
    const t = await api('/tasks/' + template.id), steps = t.related_tasks?.subtask || [];
    if (!t.done || !t.labels?.some(l => l.title === 'template')) throw new Error(`done ${t.done}, labels ${JSON.stringify(t.labels?.map(l => l.title))}`);
    if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(STEPS)) throw new Error('steps: ' + steps.map(s => s.title).join(' | '));   // "at 3pm" stays
    if (!steps.every(s => s.done)) throw new Error('a step isn\'t done');
    // Its sheet shows when each step is due.
    await page.click(`${tplRow} .body`);
    await page.waitForSelector('#d-start');
    const shown = await page.$$eval('#d-subtasks .row', els => els.map(e => e.querySelector('.title').textContent + '|' + (e.querySelector('.meta')?.textContent || '')));
    if (JSON.stringify(shown) !== JSON.stringify([`Check the guards at 3pm|Named “check-the-guards”`, `Warm up the press|Due 30m after ${GUARDS}`, `First article check|Due 2h after ${GUARDS}`]))
      throw new Error('sheet shows ' + JSON.stringify(shown));
  });

  await step('a-step-it-counts-from-removed', async () => {
    // Counting from a step that's then removed, and is first now: pick one, the start; nothing is made.
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
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
    const links = (await api('/tasks/' + template.id)).related_tasks.subtask.map(s => s.id);
    await page.click('#d-subtasks .row:nth-of-type(3) [aria-label^="Move up"]');
    await until('the step never moved up in Vikunja', async () => (await subtasks(template.id)).map(s => s.title)[1] === STEPS[2]);
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    // Only the order line is written: the steps are linked as they were, and the line isn't shown in the notes.
    const t = await api('/tasks/' + template.id);
    if (JSON.stringify(stepOrder(t.description)) !== JSON.stringify([links[0], links[2], links[1]])) throw new Error('description: ' + t.description);
    if (JSON.stringify(t.related_tasks.subtask.map(s => s.id)) !== JSON.stringify(links)) throw new Error('the steps were linked again');
    if (/pocket:order/.test(await page.textContent('#d-desc'))) throw new Error('the notes show the order line');
    // The order stays after a reload.
    await page.reload();
    await page.waitForSelector('#view .loading', { state: 'detached', timeout: 15000 });
    if (!await page.waitForSelector('#d-start', { timeout: 3000 }).catch(() => null)) { await page.evaluate(() => { location.hash = '#/checklists'; }); await page.click(`${tplRow} .body`, { timeout: 15000 }); }
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")', { timeout: 15000 });
    // Cut off mid-move: back as it was, and it says so.
    await page.route(`**/api/v2/tasks/${template.id}`, r => r.request().method() === 'PATCH' ? r.abort('internetdisconnected') : r.continue());
    await page.click('#d-subtasks .row:nth-of-type(2) [aria-label^="Move down"]');
    await toast('Not moved');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    await page.unrouteAll(); await online(); await toastGone();
    if ((await subtasks(template.id)).map(s => s.title)[1] !== STEPS[2]) throw new Error('moved in Vikunja anyway');
    // Above the step it counts from: refused, before anything is sent.
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) [aria-label^="Move up"]:not([disabled])');
    await page.click('#d-subtasks .row:nth-of-type(2) [aria-label^="Move up"]');
    await toast('Not moved: step 2, “First article check”: its time counts from “check-the-guards”, which has to be an earlier step');
    if ((await subtasks(template.id)).map(s => s.title)[0] !== STEPS[0]) throw new Error('moved anyway');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) [aria-label^="Move down"]:not([disabled])');
    await page.click('#d-subtasks .row:nth-of-type(2) [aria-label^="Move down"]');
    await until('the step never moved back', async () => JSON.stringify((await subtasks(template.id)).map(s => s.title)) === JSON.stringify(STEPS));
    await page.waitForSelector('#d-subtasks .row:nth-of-type(3) .title:text-is("First article check")');
    // Its reply lost on the way back: moved all the same, as Vikunja has it, and it doesn't say otherwise.
    const loseReply = async r => { if (r.request().method() !== 'PATCH') return r.fallback(); await r.fetch(); return r.abort('connectionreset'); };
    await page.route(`**/api/v2/tasks/${template.id}`, loseReply);
    await toastGone().catch(() => {});
    await page.click('#d-subtasks .row:nth-of-type(2) [aria-label^="Move down"]');
    await until('the move never reached Vikunja', async () => (await subtasks(template.id)).map(s => s.title)[1] === STEPS[2]);
    await page.waitForSelector('#d-subtasks .row:nth-of-type(3) [aria-label^="Move up"]:not([disabled])');   // done saving
    await page.unroute(`**/api/v2/tasks/${template.id}`, loseReply);
    if (await page.$('#toast.show #toast-msg:has-text("Not moved")')) throw new Error('it says it wasn\'t moved');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    await page.click('#d-subtasks .row:nth-of-type(3) [aria-label^="Move up"]');
    await until('the step never moved back again', async () => JSON.stringify((await subtasks(template.id)).map(s => s.title)) === JSON.stringify(STEPS));
    await page.waitForSelector('#d-subtasks .row:nth-of-type(3) .title:text-is("First article check")');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) [aria-label^="Move up"]:not([disabled])');
    // A move, or notes, saved here change only their part of what Vikunja has when they're sent: notes and a move saved
    // elsewhere (on the web, another phone) since the sheet opened stay.
    const ids = (await subtasks(template.id)).map(s => s.id), was = (await api('/tasks/' + template.id)).description;
    const elsewhere = () => api('/tasks/' + template.id, { method: 'PATCH', body: JSON.stringify({ description: `<p>Wear gloves for the press.</p><p>pocket:order ${ids[0]} ${ids[2]} ${ids[1]}</p>` }) });
    const order = async () => JSON.stringify(stepOrder((await api('/tasks/' + template.id)).description));
    await elsewhere();
    await page.click('#d-subtasks .row:nth-of-type(2) [aria-label^="Move up"]');   // "Warm up the press", 3rd in Vikunja now
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
    if (who) await page.click(`#start-for .chip[data-user="${who}"]`);
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
    // Nothing is due yet: every timed step counts from a step being done, and the run has no due date of its own.
    const dated = [run, ...steps].filter(t => t.due_date && !t.due_date.startsWith('0001'));
    if (dated.length) throw new Error('due dates: ' + dated.map(t => `${t.title} ${t.due_date}`).join(', '));
    // A timed step has a reminder at its due time, for when it gets one; an untimed one has none.
    const rems = steps.map(s => (s.reminders || []).map(r => `${r.relative_to}${r.relative_period}`).join());
    if (JSON.stringify(rems) !== JSON.stringify(['', 'due_date0', 'due_date0'])) throw new Error('reminders: ' + JSON.stringify(rems));
    await page.waitForSelector(`#run-steps .row:nth-of-type(2) .meta:has-text("Due 30m after ${GUARDS}")`);
    await page.waitForSelector(`#run-steps .row:nth-of-type(3) .meta:has-text("Due 2h after ${GUARDS}")`);
    if (await page.textContent('#step-title') !== 'Check the guards at 3pm') throw new Error('on step ' + await page.textContent('#step-title'));
    if (!(await page.textContent('#run-for')).startsWith('For you · started by you')) throw new Error('shows ' + await page.textContent('#run-for'));
  });
  const runStep = async (run, i) => (await subtasks(run))[i];

  await step('tick-a-step', async () => {
    await page.click('#step-done');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    const id = (await runStep(first.id, 0)).id;
    // Done, then the ✅: sent one after the other, so wait for both.
    await until('the step was never done with a ✅ from you', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector('#run-steps .row:nth-of-type(1).done .meta:has-text("Done by")');
    if (await page.textContent('#run-count') !== '1 of 3 done') throw new Error('count: ' + await page.textContent('#run-count'));
    // Both timed steps count down now: the next one on its card, the other pinned above it.
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (30|29)m$")');
    await page.waitForSelector('#run-timers .timer:has-text("First article check"):has-text("in 2h")');
    // Tapping a pinned countdown shows its step; then back to the one before.
    await page.click('#run-timers .timer:has-text("First article check")');
    await page.waitForSelector('#step-title:text-is("First article check")');
    await page.click('#step-prev');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    // Moved by hand in Vikunja after the tick (a second or more: one in the same second counts as before it).
    await new Promise(r => setTimeout(r, 1100));
    const warm = (await runStep(first.id, 1)).id;
    await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ due_date: new Date(Date.now() + 3 * 36e5).toISOString() }) });
    await page.reload();
    await page.waitForSelector('#step-card .step-due:text-is("Due in 3h")', { timeout: 15000 });
  });

  await step('countdown-alerts-at-zero', async () => {
    // A countdown on screen that reaches zero says so, once: not again after a reload.
    const warm = (await runStep(first.id, 1)).id, back = (await task(warm)).due_date;
    await toastGone().catch(() => {});
    await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ due_date: new Date(Date.now() + 5000).toISOString() }) });
    try {
      await page.reload();
      await page.waitForSelector('#step-title:text-is("Warm up the press")', { timeout: 15000 });
      await toast('“Warm up the press” is due now');
      await toastGone();
      await page.reload();
      await page.waitForSelector('#step-title:text-is("Warm up the press")', { timeout: 15000 });
      await page.waitForTimeout(3000);
      if (await page.$('#toast.show #toast-msg:has-text("is due now")')) throw new Error('it said so again');
    } finally { await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ due_date: back }) }); }
    await page.reload();
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (3h|2h 5[0-9]m)$")', { timeout: 15000 });
  });

  await step('skip-with-a-reason', async () => {
    await page.fill('#step-note', 'Press 2 is down');
    if (await page.textContent('#step-skip') !== 'Skip with the note') throw new Error('skip says ' + await page.textContent('#step-skip'));
    await page.click('#step-skip');
    await page.waitForSelector('#step-title:text-is("First article check")');
    const id = (await runStep(first.id, 1)).id;
    await until('the skip never reached Vikunja', async () => {
      const t = await task(id);
      return t.done && t.reactions?.['⏭️']?.some(u => u.id === me.id) && (t.comments || []).some(c => c.comment.includes('Skipped: Press 2 is down'));
    });
    await page.waitForSelector('#run-steps .row:nth-of-type(2) .skipped:has-text("Skipped by")');
  });

  await step('a-note-being-written-stays-with-its-step', async () => {
    await page.fill('#step-note', 'Only for this step');
    await page.click('#step-prev');
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    if (await page.inputValue('#step-note') !== '') throw new Error('the note followed: ' + await page.inputValue('#step-note'));
    await page.click('#step-next');
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
    await page.waitForSelector('#step-done:has-text("Done, with the note")');
    await page.click('#step-done');
    await until('the note never reached the step', async () => { const t = await task(id); return t.done && (t.comments || []).some(c => c.comment.includes('Guard 3 tightened')); });
    await page.reload();
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
  });

  await step('note-on-a-step-and-the-run', async () => {
    await page.fill('#step-note', 'Looks good');
    await page.click('#step-note-form button');
    await page.waitForSelector('#step-extra .comment:has-text("Looks good")');
    await page.fill('#run-note', 'Line 2 ran slow today');
    await page.click('#run-note-form button');
    await page.waitForSelector('#run-notes .comment:has-text("Line 2 ran slow today")');
    const step3 = await task((await runStep(first.id, 2)).id), run = await task(first.id);
    if ((step3.comments || []).filter(c => c.comment.includes('Looks good')).length !== 1) throw new Error('step comments: ' + JSON.stringify(step3.comments?.map(c => c.comment)));
    if (!(run.comments || []).some(c => c.comment.includes('Line 2 ran slow today'))) throw new Error('no note on the run');
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
    await toast('couldn\'t be saved in full (it\'s marked done)');
    await page.unroute('**/api/v2/tasks/*/reactions', refuse);
    await page.waitForSelector('#run-steps .row:nth-of-type(1).done', { timeout: 15000 });
    if (!(await task(id)).done) throw new Error('not done in Vikunja');
    await page.click('#run-steps .row:nth-of-type(1) .check');                 // as it was: done, with the ✅
    await until('never undone a third time', async () => !(await task(id)).done);
    await page.click('#run-steps .row:nth-of-type(1) .check');
    await until('never done with a ✅', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
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

  await step('today-shows-your-run', async () => {
    await page.click('nav.tabs a[data-tab=today]');
    // The run, without a due date of its own, and its open step, by its due date.
    await page.waitForSelector(`.sec:has-text("Checklist runs") + .list .row:has(.title:has-text("${TEMPLATE} · run"))`, { timeout: 15000 });
    await page.waitForSelector('.row .title:has-text("First article check")');
  });

  await step('today-run-has-no-tick-and-a-step-tick-says-who', async () => {
    const runRow = `.row:has(> .body .title:has-text("${TEMPLATE} · run"))`;
    await page.waitForSelector(`${runRow} > .check.no-tick`, { timeout: 15000 });
    if (await page.$(`${runRow} > button.check`)) throw new Error('the run can be ticked on Today');
    // In its project's own list it's an ordinary task, with a tick.
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.waitForSelector(`${runRow} > button.check`, { timeout: 15000 });
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
    // A step ticked on Today is ticked as on the run's screen: with a ✅ from you. Undo takes both back.
    const check = (await runStep(first.id, 2)).id;
    await page.click('.row:has(> .body .title:has-text("First article check")) > .check', { timeout: 15000 });
    await until('the tick from Today has no ✅', async () => { const t = await task(check); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.click('#toast-act:has-text("Undo")');
    await until('Undo left the step done', async () => { const t = await task(check); return !t.done && !t.reactions?.['✅']?.some(u => u.id === me.id); });
    await page.waitForSelector('.row .title:has-text("First article check")', { timeout: 15000 });
    // The run's sheet, from its ⋯: a step there opens the run on that step.
    await page.click(`${runRow} > .body`);
    await page.waitForFunction(id => location.hash === '#/run/' + id, first.id, { timeout: 15000 });
    await page.waitForSelector('#step-title');
    await page.click('#btn-run-more');
    await page.click('#r-open-task');
    await page.waitForSelector('#d-subtasks .row');
    await page.click('#d-subtasks .row:nth-of-type(2) .body');
    await page.waitForFunction(id => location.hash.startsWith(`#/run/${id}?step=`), first.id, { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("Warm up the press")', { timeout: 15000 });
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
  });

  await step('today-opens-the-run', async () => {
    // A run's row fills by its steps done (2 of 3), and opens the run's screen, not its sheet; Back comes back to Today.
    const runRow = `.row:has(> .body .title:has-text("${TEMPLATE} · run"))`;
    await page.waitForSelector(runRow, { timeout: 15000 });
    const pct = await page.$eval(runRow, el => el.style.getPropertyValue('--pct'));
    if (pct !== '0.67') throw new Error('--pct ' + pct);
    await page.click(`${runRow} > .body`);
    await page.waitForFunction(id => location.hash === '#/run/' + id, first.id, { timeout: 15000 });
    if (await page.getAttribute('#btn-back', 'aria-label') !== 'Back to Today') throw new Error('back: ' + await page.getAttribute('#btn-back', 'aria-label'));
    if (await page.isVisible('#sheet')) throw new Error('the sheet opened');
    await page.click('#btn-back');
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 15000 });
    // A step opens the run on that step.
    await page.click('.row .body:has(.title:has-text("First article check"))', { timeout: 15000 });
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
    if (!(await page.textContent('#run-for')).startsWith(`For ${other.name || other.username} · started by you`)) throw new Error('shows ' + await page.textContent('#run-for'));
    // Their Today has their run and not yours; their Checklists tab has both in progress.
    const theirs = await context.browser().newContext({ viewport: { width: 390, height: 844 } }), p = await theirs.newPage();
    p.on('pageerror', e => errors.push('(other) ' + e));
    p.on('console', m => m.type() === 'error' && console.log('  (other) console:', m.text()));
    const rows = () => p.$$eval('.row .title', els => els.map(x => x.textContent));
    // A step of your run they've claimed is on their Today, even without a due date. (It's done by now: not done for this.)
    const warm = (await runStep(first.id, 1)).id, warmDue = (await task(warm)).due_date;
    await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ done: false, due_date: '0001-01-01T00:00:00Z' }) });
    await call(otherToken, `/tasks/${warm}/assignees`, { method: 'POST', body: JSON.stringify({ user_id: other.id }) });
    try {
      await signIn(p, otherToken);
      await p.waitForSelector(`.row .title:has-text("${run.title}")`, { timeout: 15000 });
      await p.waitForSelector('.row .title:has-text("Warm up the press")', { timeout: 15000 }).catch(() => { throw new Error("their claimed step isn't on their Today"); });
      const mine = (await api('/tasks/' + first.id)).title, seen = await rows();
      if (seen.includes(mine)) throw new Error('your run is in their Today');
      // Your run's last step is due, and isn't theirs; theirs has no due date yet.
      if (seen.some(t => t.endsWith('First article check'))) throw new Error('their Today: ' + JSON.stringify(seen));
      await p.click('nav.tabs a[data-tab=checklists]');
      await p.waitForSelector(`.cl-run .title:text-is("${mine}")`, { timeout: 15000 });
      await p.waitForSelector(`.cl-run .title:text-is("${run.title}")`, { timeout: 20000 }).catch(() => { throw new Error("their run isn't under Checklists"); });
    } catch (e) {
      await p.screenshot({ path: `${OUT}/checklists-fail-other.png` });
      throw new Error(`${e.message.split('\n')[0]}; looking for "${run.title}", their rows: ${JSON.stringify(await rows())}`, { cause: e });
    } finally {
      await theirs.close();
      await api(`/tasks/${warm}/assignees/${other.id}`, { method: 'DELETE' }).catch(() => {});
      await api('/tasks/' + warm, { method: 'PATCH', body: JSON.stringify({ done: true, due_date: warmDue }) });
    }
  });

  await step('finish-a-run', async () => {
    // Opened from Checklists, so finishing goes back there.
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl-run .body:has(.title:text-is("${(await api('/tasks/' + first.id)).title}"))`, { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
    await page.click('#step-done');
    await page.waitForSelector('#finish-card');
    if (!(await page.textContent('#finish-card')).includes('3 steps · 1 skipped')) throw new Error('summary: ' + await page.textContent('#finish-card'));
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
    await page.click('#toast-act:has-text("Undo")');
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
    await until('the run is still in Vikunja', async () => !((await api('/tasks/' + template.id)).related_tasks?.copiedto || []).some(t => t.id === third.id));
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
      await page.click(`#r-for .chip[data-user="${OTHER}"]`);
      await until('never reassigned', async () => JSON.stringify((await api('/tasks/' + id)).assignees?.map(u => u.id)) === JSON.stringify([other.id]));
    }
    await page.click('#btn-sheet-close');
    // Last time opens the run finished before: it can be looked at, not ticked, and reopened from its ⋯.
    await page.click('#run-last-open', { timeout: 15000 });
    await page.waitForFunction(fid => location.hash === '#/run/' + fid, first.id, { timeout: 15000 });
    await page.waitForSelector('#run-steps .row .check[disabled]', { timeout: 15000 });
    if (await page.isVisible('#step-done')) throw new Error('a finished run can be ticked');
    await page.click('#btn-run-more');
    await page.waitForSelector('#r-reopen');
    await page.click('#btn-sheet-close');
    await page.evaluate(rid => { location.hash = '#/run/' + rid; }, id);
    await page.waitForSelector('#step-title', { timeout: 15000 });
    await toastGone();
    await page.click('#btn-run-more');
    await page.click('#r-delete');
    await toast('Run deleted');
    await page.waitForFunction(() => location.hash === '#/checklists', null, { timeout: 15000 });
    const gone = async tid => { const r = await fetch(SERVER + '/api/v2/tasks/' + tid, { headers: { Authorization: 'Bearer ' + TOKEN } }); return r.status === 404 || r.status === 403; };
    await until('the run or a step is still in Vikunja', async () => (await Promise.all([id, ...steps].map(gone))).every(Boolean));
  });

  await step('start-offline-waits', async () => {
    await openStart();
    await context.setOffline(true);
    await page.click('#start-go');
    await toast('starts as soon as Pocket reaches Vikunja');
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
    await toast('starts as soon as Pocket reaches Vikunja');
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
    await toast('starts as soon as Pocket reaches Vikunja');
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
    await toast('starts as soon as Pocket reaches Vikunja');
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
    await page.click('#step-done');
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .check.wait');
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .meta:has-text("waiting to send")');
    await page.waitForSelector('#step-card .step-due:text-matches("^Due in (30|29)m$")');    // counting from the tick here
    await page.fill('#step-note', 'Written offline');
    await page.click('#step-note-form button');
    await page.waitForSelector('#step-extra .comment:has-text("Written offline"):has-text("Waiting to send")');
    await page.reload();                                                     // e.g. the phone closed the app
    await page.waitForSelector('#run-steps .row:nth-of-type(1) .check.wait', { timeout: 15000 });
    await page.waitForSelector('#step-title:text-is("Warm up the press")');
    await context.setOffline(false);
    await page.waitForSelector('#run-steps .row:nth-of-type(1):not(:has(.check.wait))', { timeout: 20000 });
    const id = (await runStep(run, 0)).id, step2 = (await runStep(run, 1)).id;
    await until('the tick never reached Vikunja', async () => { const t = await task(id); return t.done && t.reactions?.['✅']?.some(u => u.id === me.id); });
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

  await step('a-time-after-a-step-named-in-words', async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`.cl[data-project="${project.id}"] .cl-new .body`, { timeout: 15000 });
    await page.fill('#nt-name', `Words ${stamp}`);
    await page.fill('#new-step-0', 'Start the hydraulics');
    await page.press('#new-step-0', 'Enter');
    await page.fill('#new-step-1', 'Wipe the bed');
    await page.press('#new-step-1', 'Enter');
    await page.fill('#new-step-2', 'Check the oil 30 minutes after Start the hydraulics');
    await page.click('#nt-create');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 20000 });
    let tpl;
    await until('the template never appeared', async () => (tpl = ((await api(`/projects/${project.id}/tasks?filter=${encodeURIComponent('done = true')}`)).items || []).find(t => t.title === `Words ${stamp}`)));
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
    await page.fill(`#step-edit-${a.id}`, 'Stir in 2 min');
    await page.press(`#step-edit-${a.id}`, 'Enter');
    await until('the step never changed', async () => (await api('/tasks/' + a.id)).title === 'Stir T#2m');
    // Refused: what was typed stays in the box, to put right.
    await page.click('#d-subtasks .row:nth-of-type(1) .body');
    await page.fill(`#step-edit-${a.id}`, 'Stir T#2m:nope');
    await page.press(`#step-edit-${a.id}`, 'Enter');
    await toast('Not changed: step 1, “Stir”');
    if (await page.inputValue(`#step-edit-${a.id}`) !== 'Stir T#2m:nope') throw new Error('what was typed went');
    await page.press(`#step-edit-${a.id}`, 'Escape');
    await page.waitForSelector(`#step-edit-${a.id}`, { state: 'detached' });
    if ((await api('/tasks/' + a.id)).title !== 'Stir T#2m') throw new Error('changed anyway');
    await page.click(`#d-subtasks .row:nth-of-type(2) [aria-label^="Remove step"]`);
    await until('the step was never removed', async () => (await subtasks(tpl.id)).length === 1);
    await page.click('#d-more');
    await page.waitForSelector('#d-delete:text-is("Delete template and its 1 step")', { timeout: 10000 });
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 15000 });
    const gone = async tid => { const r = await fetch(SERVER + '/api/v2/tasks/' + tid, { headers: { Authorization: 'Bearer ' + TOKEN } }); return r.status === 404 || r.status === 403; };
    await until('the template or a step is still there', async () => (await Promise.all([tpl.id, a.id, b.id].map(gone))).every(Boolean));
  });

  await step('make-a-template-from-the-menu', async () => {
    // A task with subtasks, in a checklist project: its ⋯ makes it a template. An ordinary task's sheet shows no card for it.
    const make = async (title) => api(`/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title }) });
    const t = await make(`Deliveries ${stamp}`), a = await make('Check the delivery note'), b = await make('Put the milk in the fridge');
    for (const st of [a, b]) await api(`/tasks/${t.id}/relations`, { method: 'POST', body: JSON.stringify({ other_task_id: st.id, relation_kind: 'subtask' }) });
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click(`.row .body:has(.title:has-text("Deliveries ${stamp}"))`, { timeout: 15000 });
    await page.waitForSelector('#d-subtasks .row');
    if (await page.$('#d-checklist')) throw new Error('a card for it shows on the task');
    await page.click('#d-more');
    await page.click('#d-make-template');
    await until('never made a template', async () => { const x = await api('/tasks/' + t.id); return x.done && x.labels?.some(l => l.title === 'template'); });
    await page.waitForSelector('#d-start', { timeout: 15000 });           // now its sheet is a template's
    await page.click('#d-more');
    await page.click('#d-delete');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 15000 });
  });

  await step('add-steps-to-a-template', async () => {
    await page.evaluate(() => { location.hash = '#/checklists'; });
    await page.click(`${tplRow} .body`, { timeout: 15000 });
    await page.waitForSelector('#d-start');
    const row = i => page.locator('#add-steps > .draft-step').nth(i);
    // Counting from a name no step has: not added.
    await page.click('#add-add-step');
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
    await toast('Added 0 of 2');
    await page.unroute(`**/api/v2/projects/${project.id}/tasks`, loseStep);
    await page.click('#add-steps-go:has-text("Add 2 steps")');
    await until('the steps were never added', async () => (await subtasks(template.id)).length === 5);
    const sample = (await api('/tasks?q=' + encodeURIComponent('Pull a sample'))).items.filter(t => t.project_id === project.id);
    if (sample.length !== 1) throw new Error(`${sample.length} tasks “Pull a sample”`);
    const titles = (await subtasks(template.id)).map(s => s.title);
    const want = [STEPS[0], 'Warm up the press T#30m {#warm-up}', STEPS[2], 'Pull a sample T#5m:warm-up', 'Log the weights'];
    if (JSON.stringify(titles) !== JSON.stringify(want)) throw new Error('steps: ' + titles.join(' | '));
    if (!(await subtasks(template.id)).every(s => s.done)) throw new Error('a new step isn\'t done');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(4) .meta:has-text("Due 5m after “Warm up the press”")');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('stop-using-for-checklists', async () => {
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click('#btn-project');
    await page.click('#p-stop-checklists');
    await toast('No longer for checklists');
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
    await page.waitForFunction(() => /^#\/project\/\d+$/.test(location.hash), null, { timeout: 15000 });
    const id = +(await page.evaluate(() => location.hash)).split('/').pop(), made = await api('/projects/' + id);
    try {
      if (made.title !== `Front of house ${stamp}` || made.parent_project_id !== project.id) throw new Error(`made ${made.title} in ${made.parent_project_id}`);
      if (!/<p>pocket:checklists<\/p>/.test(made.description || '')) throw new Error('not for checklists: ' + made.description);
      await page.waitForSelector('nav.tabs a[data-tab=checklists]');
    } finally { await api('/projects/' + id, { method: 'DELETE' }).catch(() => {}); }
  });
  if (errors.length) { failed++; console.log('FAIL page errors:', errors); }
} finally {
  await browser.close();
  // The project, with every task in it. A few tries: a Vikunja on SQLite can answer 500 "database is locked" while busy.
  if (project) for (let i = 0; i < 5; i++) { try { await api('/projects/' + project.id, { method: 'DELETE' }); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
