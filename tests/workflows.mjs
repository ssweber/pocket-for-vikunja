// Workflows, end to end: a project made a workflow, a template made from a task and its steps, runs started, worked
// through, finished and handed over, with and without a connection.
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... node tests/workflows.mjs
//   npm run test:local        (starts a local Vikunja with the plugin and runs everything against it)
//
// Creates a project of its own ("Pocket workflow <stamp>") and deletes it at the end, with everything in it. Leaves a
// "template" label behind, which later runs reuse, as Task Management tokens can't delete labels. The token needs
// Projects → Create and Update, and Reactions.
// Optional: OTHER_USER and OTHER_PASSWORD, a second account: the project is shared with them, a run is started for
// them, and their Today and Workflows tab are checked too.
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
const subtasks = async id => (await api('/tasks/' + id)).related_tasks?.subtask || [];
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
    failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/workflows-fail-${name}.png` }).catch(() => {});
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
const STEPS = ['Check the guards at 3pm {#guards}', 'Warm up the press T#30m', 'First article check T#2h:guards'];
const GUARDS = '“Check the guards at 3pm”';
const tplRow = `.wf-tpl:has(.title:text-is("${TEMPLATE}"))`;
let project, template, me, other, otherToken;
const runs = [];                                 // run ids, in the order started

try {
  me = await api('/user');
  project = await api('/projects', { method: 'POST', body: JSON.stringify({ title: `Pocket workflow ${stamp}` }) });
  if (OTHER && OTHER_PASSWORD) {
    otherToken = (await (await fetch(SERVER + '/api/v2/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: OTHER, password: OTHER_PASSWORD }) })).json()).token;
    other = await call(otherToken, '/user');
    await api(`/projects/${project.id}/users`, { method: 'POST', body: JSON.stringify({ username: OTHER, permission: 1 }) });
  }
  const workflowsBefore = (await api('/projects')).items.filter(p => /pocket:workflow/i.test(p.description || '')).length;

  await step('sign-in', () => signIn(page, TOKEN));

  await step('use-as-workflow', async () => {
    if (!workflowsBefore && await page.isVisible('nav.tabs a[data-tab=workflows]')) throw new Error('a Workflows tab without any workflow');
    if (!workflowsBefore && await page.$eval('nav.tabs a[data-tab=today] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('the tab names are hidden');
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click('#btn-project');
    await page.click('#p-use-workflow');
    await toast('Now a workflow');
    await page.waitForSelector('nav.tabs.icons a[data-tab=workflows]');
    if (!await page.$eval('nav.tabs a[data-tab=today] .lbl', el => el.getBoundingClientRect().width < 2)) throw new Error('three tabs, but with their names showing');
    if (!/<p>pocket:workflow<\/p>/.test((await api('/projects/' + project.id)).description)) throw new Error('no marker in the description');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  await step('make-template', async () => {
    await page.fill('#in-capture', TEMPLATE);                                 // lands in the project on screen
    await page.click('#f-capture .go');
    await page.click(`.row .body:has-text("${TEMPLATE}")`, { timeout: 15000 });
    await page.waitForSelector('#d-make-template');
    await page.fill('#d-subin', STEPS.join('\n'));
    await page.press('#d-subin', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#d-subtasks .row').length === 3, null, { timeout: 15000 });
    await page.click('#d-make-template');
    await page.waitForSelector('#d-start', { timeout: 15000 });
    template = (await api('/tasks?q=' + encodeURIComponent(TEMPLATE))).items.find(t => t.title === TEMPLATE);
    const t = await api('/tasks/' + template.id), steps = t.related_tasks?.subtask || [];
    if (!t.done || !t.labels?.some(l => l.title === 'template')) throw new Error(`done ${t.done}, labels ${JSON.stringify(t.labels?.map(l => l.title))}`);
    if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(STEPS)) throw new Error('steps: ' + steps.map(s => s.title).join(' | '));   // "at 3pm" stays
    if (!steps.every(s => s.done)) throw new Error('a step isn\'t done');
    const shown = await page.$$eval('#d-subtasks .row', els => els.map(e => e.querySelector('.title').textContent + '|' + (e.querySelector('.meta')?.textContent || '')));
    if (JSON.stringify(shown) !== JSON.stringify([`Check the guards at 3pm|Named “guards”`, `Warm up the press|Due 30m after ${GUARDS}`, `First article check|Due 2h after ${GUARDS}`]))
      throw new Error('sheet shows ' + JSON.stringify(shown));
  });

  await step('reorder-steps', async () => {
    await page.click('#d-subtasks .row:nth-of-type(3) [aria-label^="Move up"]');
    await until('the step never moved up in Vikunja', async () => (await subtasks(template.id)).map(s => s.title)[1] === STEPS[2]);
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) .title:text-is("First article check")');
    // Above the step it counts from: refused, before anything is sent.
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) [aria-label^="Move up"]:not([disabled])');
    await page.click('#d-subtasks .row:nth-of-type(2) [aria-label^="Move up"]');
    await toast('Not moved: step 1, “First article check”: its time counts from “guards”, which has to be an earlier step');
    if ((await subtasks(template.id)).map(s => s.title)[0] !== STEPS[0]) throw new Error('moved anyway');
    await page.waitForSelector('#d-subtasks .row:nth-of-type(2) [aria-label^="Move down"]:not([disabled])');
    await page.click('#d-subtasks .row:nth-of-type(2) [aria-label^="Move down"]');
    await until('the step never moved back', async () => JSON.stringify((await subtasks(template.id)).map(s => s.title)) === JSON.stringify(STEPS));
    await page.waitForSelector('#d-subtasks .row:nth-of-type(3) .title:text-is("First article check")');
    // A step counting from a name no step has: not added.
    await toastGone();
    await page.fill('#d-subin', 'Pull a sample T#5m:nope');
    await page.press('#d-subin', 'Enter');
    await toast('Not added: step 4, “Pull a sample”: no step is named “nope”');
    if ((await subtasks(template.id)).length !== 3) throw new Error('added anyway');
    await page.fill('#d-subin', '');
    await page.click('#btn-sheet-close');
    await page.waitForSelector('#sheet', { state: 'hidden' });
  });

  const startRun = async (who) => {
    await page.evaluate(() => { location.hash = '#/workflows'; });
    await page.click(`${tplRow} .wf-start`, { timeout: 15000 });
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
    const run = await api('/tasks/' + first.id), steps = await Promise.all((run.related_tasks?.subtask || []).map(s => api('/tasks/' + s.id)));
    if (!new RegExp(`^${TEMPLATE} · run \\d+ · `).test(run.title)) throw new Error('title: ' + run.title);
    if (run.done || run.labels?.some(l => l.title === 'template')) throw new Error(`done ${run.done}, labels ${JSON.stringify(run.labels?.map(l => l.title))}`);
    if (JSON.stringify(run.assignees?.map(u => u.id)) !== JSON.stringify([me.id])) throw new Error('assignees ' + JSON.stringify(run.assignees?.map(u => u.username)));
    if (run.related_tasks?.copiedfrom?.[0]?.id !== template.id) throw new Error('not linked to its template');
    if (JSON.stringify(steps.map(s => s.title)) !== JSON.stringify(['Check the guards at 3pm', 'Warm up the press', 'First article check'])) throw new Error('steps: ' + steps.map(s => s.title).join(' | '));
    if (steps.some(s => s.done)) throw new Error('a step is done already');
    // Nothing is due yet: every timed step counts from a step being done, and the run has no due date of its own.
    const dated = [run, ...steps].filter(t => t.due_date && !t.due_date.startsWith('0001'));
    if (dated.length) throw new Error('due dates: ' + dated.map(t => `${t.title} ${t.due_date}`).join(', '));
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
  });

  await step('skip-with-a-reason', async () => {
    await page.fill('#step-note', 'Press 2 is down');
    await page.click('#step-skip');
    await page.waitForSelector('#step-title:text-is("First article check")');
    const id = (await runStep(first.id, 1)).id;
    await until('the skip never reached Vikunja', async () => {
      const t = await task(id);
      return t.done && t.reactions?.['⏭️']?.some(u => u.id === me.id) && (t.comments || []).some(c => c.comment.includes('Skipped: Press 2 is down'));
    });
    await page.waitForSelector('#run-steps .row:nth-of-type(2) .skipped:has-text("Skipped by")');
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
  });

  await step('today-shows-your-run', async () => {
    await page.click('nav.tabs a[data-tab=today]');
    // The run, without a due date of its own, and its open step, by its due date.
    await page.waitForSelector(`.sec:has-text("Workflow runs") + .list .row:has(.title:has-text("${TEMPLATE} · run"))`, { timeout: 15000 });
    await page.waitForSelector('.row .title:has-text("First article check")');
  });

  let forOther;
  if (other) await step('a-run-for-someone-else', async () => {
    forOther = await startRun(OTHER);
    const run = await api('/tasks/' + forOther.id);
    if (JSON.stringify(run.assignees?.map(u => u.id)) !== JSON.stringify([other.id])) throw new Error('assignees ' + JSON.stringify(run.assignees?.map(u => u.username)));
    if (!(await page.textContent('#run-for')).startsWith(`For ${other.name || other.username} · started by you`)) throw new Error('shows ' + await page.textContent('#run-for'));
    // Their Today has their run and not yours; their Workflows tab has both in progress.
    const theirs = await context.browser().newContext({ viewport: { width: 390, height: 844 } }), p = await theirs.newPage();
    p.on('pageerror', e => errors.push('(other) ' + e));
    p.on('console', m => m.type() === 'error' && console.log('  (other) console:', m.text()));
    const rows = () => p.$$eval('.row .title', els => els.map(x => x.textContent));
    try {
      await signIn(p, otherToken);
      await p.waitForSelector(`.row .title:has-text("${run.title}")`, { timeout: 15000 });
      const mine = (await api('/tasks/' + first.id)).title, seen = await rows();
      if (seen.includes(mine)) throw new Error('your run is in their Today');
      // Your run's last step is due, and isn't theirs; theirs has no due date yet.
      if (seen.some(t => t.endsWith('First article check'))) throw new Error('their Today: ' + JSON.stringify(seen));
      await p.click('nav.tabs a[data-tab=workflows]');
      await p.waitForSelector(`.wf-run .title:text-is("${mine}")`, { timeout: 15000 });
      await p.waitForSelector(`.wf-run .title:text-is("${run.title}")`);
    } catch (e) {
      await p.screenshot({ path: `${OUT}/workflows-fail-other.png` });
      throw new Error(`${e.message.split('\n')[0]}; looking for "${run.title}", their rows: ${JSON.stringify(await rows())}`);
    } finally { await theirs.close(); }
  });

  await step('finish-a-run', async () => {
    await page.evaluate(id => { location.hash = '#/run/' + id; }, first.id);
    await page.waitForSelector('#step-title:text-is("First article check")', { timeout: 15000 });
    await page.click('#step-done');
    await page.waitForSelector('#finish-card');
    if (!(await page.textContent('#finish-card')).includes('3 steps · 1 skipped')) throw new Error('summary: ' + await page.textContent('#finish-card'));
    await page.click('#run-finish');
    await page.waitForFunction(() => location.hash === '#/workflows', null, { timeout: 15000 });
    await until('the run was never finished', async () => (await api('/tasks/' + first.id)).done);
    if (await page.isVisible(`.wf-run:has(.title:has-text("${(await api('/tasks/' + first.id)).title}"))`)) throw new Error('still in progress');
  });

  let third;
  await step('last-time-and-undo-a-start', async () => {
    third = await startRun();
    await page.waitForSelector('#run-last .comment:has-text("Press 2 is down")', { timeout: 15000 });
    for (const note of ['Looks good', 'Line 2 ran slow today']) await page.waitForSelector(`#run-last .comment:has-text("${note}")`);
    await page.click('#toast-act:has-text("Undo")');
    await page.waitForFunction(() => location.hash === '#/workflows', null, { timeout: 15000 });
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
    await page.evaluate(() => { location.hash = '#/workflows'; });
    await page.click(`${tplRow} .wf-start`, { timeout: 15000 });
    await page.waitForSelector('#start-go:not([disabled])', { timeout: 15000 });
  };

  await step('start-offline-waits', async () => {
    await openStart();
    await context.setOffline(true);
    await page.click('#start-go');
    await toast('starts as soon as Pocket reaches Vikunja');
    await page.waitForSelector(`.wf .row.pending:has-text("Starting ${TEMPLATE}"):has-text("Waiting for a connection")`);
    await context.setOffline(false);
    await page.waitForSelector('.wf .row.pending', { state: 'detached', timeout: 30000 });
    await newRun();
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
    await page.waitForSelector('.wf .row.pending', { state: 'detached', timeout: 30000 });
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

  await step('stop-using-as-workflow', async () => {
    await page.evaluate(id => { location.hash = '#/project/' + id; }, project.id);
    await page.click('#btn-project');
    await page.click('#p-stop-workflow');
    await toast('No longer a workflow');
    if (/pocket:workflow/i.test((await api('/projects/' + project.id)).description)) throw new Error('the marker is still there');
    if (!workflowsBefore && await page.isVisible('nav.tabs a[data-tab=workflows]')) throw new Error('the Workflows tab is still there');
  });
  if (errors.length) { failed++; console.log('FAIL page errors:', errors); }
} finally {
  await browser.close();
  // The project, with every task in it. A few tries: a Vikunja on SQLite can answer 500 "database is locked" while busy.
  if (project) for (let i = 0; i < 5; i++) { try { await api('/projects/' + project.id, { method: 'DELETE' }); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
