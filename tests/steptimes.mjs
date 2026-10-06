// Step times, through Vikunja's API only: with the plugin's step times on, marking a step of a checklist run done sets
// the due dates of the steps timed from it, and nothing else. Needs a Vikunja with step times on (see pocket/main.go).
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_TOKEN=tk_... node tests/steptimes.mjs
//   npm run test:local        (starts a local Vikunja with the plugin and step times on, and runs everything against it)
//
// Creates a project of its own ("Pocket step times <stamp>"), sets up a template and two runs of it the way Pocket
// does, and deletes the project at the end. Leaves a "template" label behind, as checklists.mjs does.

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN;
if (!SERVER || !TOKEN) { console.error('Set VIKUNJA_URL and VIKUNJA_TOKEN'); process.exit(2); }

const ZERO = '0001-01-01T00:00:00Z';
async function api(path, { method = 'GET', body, v = 'v2' } = {}){
  for (let i = 0; ; i++) {
    const r = await fetch(`${SERVER}/api/${v}${path}`, { method, headers: { Authorization: 'Bearer ' + TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
    if (r.status >= 500 && i < 4) { await new Promise(res => setTimeout(res, 500)); continue; }   // SQLite busy
    if (!r.ok && r.status !== 304) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
    return r.status === 204 || r.status === 304 ? null : r.json();
  }
}
const get = id => api('/tasks/' + id);
let me;
const patch = (id, body) => api('/tasks/' + id, { method: 'PATCH', body });
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 10000){
  for (const end = Date.now() + ms; ; await wait(250)) { if (await fn()) return; if (Date.now() > end) throw new Error(what); }
}
const isSet = d => d && !d.startsWith('0001');
// Minutes between a due date and a done time, or null without a due date.
const after = (due, doneAt) => isSet(due) ? Math.round((new Date(due) - new Date(doneAt)) / 6000) / 10 : null;

let failed = 0;
async function step(name, fn){
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); }
}

const stamp = Date.now();
const STEPS = ['Put the roast in {#roast}', 'Peel the potatoes T#20m', 'Baste the roast T#40m:roast', 'Take the roast out T#1h:roast', 'Carve\u00a0T#10m', 'Wash up'];
const TITLES = ['Put the roast in', 'Peel the potatoes', 'Baste the roast', 'Take the roast out', 'Carve', 'Wash up'];
let project;

// A run, set up as Pocket does: a copy of the template without its label, and a copy of each step under it, a timed one
// with a reminder at its due time. `backwards` links the copies last to first.
async function startRun(template, tplSteps, label, backwards = false){
  const run = (await api(`/tasks/${template}/duplicate`, { method: 'POST' })).duplicated_task;
  await api(`/tasks/${run.id}/labels/${label}`, { method: 'DELETE' });
  await patch(run.id, { title: `Sunday roast · run · ${stamp}`, done: false, due_date: ZERO });
  const ids = [];
  for (const [i, s] of tplSteps.entries()) {
    const c = (await api(`/tasks/${s}/duplicate`, { method: 'POST' })).duplicated_task;
    if (!backwards) await api(`/tasks/${run.id}/relations`, { method: 'POST', body: { other_task_id: c.id, relation_kind: 'subtask' } });
    await patch(c.id, { title: TITLES[i], done: false, due_date: ZERO, ...STEPS[i].includes('T#') && { reminders: [{ relative_to: 'due_date', relative_period: 0 }] } });
    ids.push(c.id);
  }
  if (backwards) for (const id of [...ids].reverse()) await api(`/tasks/${run.id}/relations`, { method: 'POST', body: { other_task_id: id, relation_kind: 'subtask' } });
  return { id: run.id, steps: ids };
}

try {
  me = await api('/user');
  project = await api('/projects', { method: 'POST', body: { title: `Pocket step times ${stamp}` } });
  const mk = title => api(`/projects/${project.id}/tasks`, { method: 'POST', body: { title } });

  // The template: labelled, its steps done, then itself done, as Make template does.
  const template = await mk('Sunday roast ' + stamp), tplSteps = [];
  for (const t of STEPS) {
    const s = await mk(t);
    await api(`/tasks/${template.id}/relations`, { method: 'POST', body: { other_task_id: s.id, relation_kind: 'subtask' } });
    tplSteps.push(s.id);
  }
  const label = ((await api('/labels?per_page=200')).items || []).find(l => l.title === 'template') || await api('/labels', { method: 'POST', body: { title: 'template' } });
  await api(`/tasks/${template.id}/labels`, { method: 'POST', body: { label_id: label.id } });

  await step('a-template-marked-done-sets-nothing', async () => {
    for (const s of tplSteps) await patch(s, { done: true });
    await patch(template.id, { done: true });
    await wait(1500);
    const dues = (await Promise.all(tplSteps.map(get))).map(t => t.due_date);
    if (dues.some(isSet)) throw new Error('template steps got due dates: ' + JSON.stringify(dues));
  });

  const a = await startRun(template.id, tplSteps, label.id), b = await startRun(template.id, tplSteps, label.id);
  const dues = async run => (await Promise.all(run.steps.map(get))).map(t => t.due_date);

  let tick0, updatedBefore;
  await step('chain-and-fan-out-from-a-tick', async () => {
    updatedBefore = (await get(a.steps[1])).updated;
    await wait(1100);                                                         // so a write to "updated" would show
    tick0 = await patch(a.steps[0], { done: true });
    await until('no due dates were set', async () => isSet((await get(a.steps[3])).due_date));
    const d = await dues(a), mins = d.map(x => after(x, tick0.done_at));
    if (JSON.stringify(mins) !== JSON.stringify([null, 20, 40, 60, null, null])) throw new Error('minutes after the tick: ' + JSON.stringify(mins));
    // Only due_date, and the reminder at it: not when the task was last changed.
    const t = await get(a.steps[1]);
    if (t.updated !== updatedBefore) throw new Error(`"updated" went from ${updatedBefore} to ${t.updated}`);
    for (const id of a.steps.slice(1, 4)) {
      const s = await get(id), at = s.reminders?.[0]?.reminder;
      if (!at || new Date(at).getTime() !== new Date(s.due_date).getTime()) throw new Error(`${s.title}: due ${s.due_date}, reminder ${at}`);
    }
  });

  await step('the-other-run-is-untouched', async () => {
    const d = await dues(b);
    if (d.some(isSet)) throw new Error('run B: ' + JSON.stringify(d));
  });

  await step('fan-out-steps-dont-shift-each-other', async () => {
    const before = await dues(a);
    await patch(a.steps[1], { done: true });                                  // Peel the potatoes: nothing counts from it
    await patch(a.steps[2], { done: true });                                  // Baste the roast: nor from it
    await wait(1500);
    const now = await dues(a);
    if (now[3] !== before[3]) throw new Error(`Take the roast out moved from ${before[3]} to ${now[3]}`);
  });

  await step('a-late-step-counts-from-when-it-was-done', async () => {
    // Take the roast out is due an hour after it went in; done now, it's early, and Carve counts from now, not from its due date.
    const done = await patch(a.steps[3], { done: true });
    await until('Carve got no due date', async () => isSet((await get(a.steps[4])).due_date));
    const m = after((await get(a.steps[4])).due_date, done.done_at);
    if (m !== 10) throw new Error(`Carve is due ${m} minutes after the roast came out`);
    if (isSet((await get(a.steps[5])).due_date)) throw new Error('Wash up, without a time, got a due date');
  });

  await step('re-saving-a-done-step-sets-nothing', async () => {
    const mine = '2031-01-01T10:00:00Z';
    await patch(a.steps[4], { due_date: mine });                              // someone moved Carve's due date by hand
    // Then, straight away, the roast's step is saved again, labelled and assigned: each sends Vikunja's task.updated.
    await patch(a.steps[3], { priority: 3 });
    await api(`/tasks/${a.steps[3]}/labels`, { method: 'POST', body: { label_id: label.id } }).catch(() => {});
    await api(`/tasks/${a.steps[3]}/assignees`, { method: 'POST', body: { user_id: me.id } }).catch(() => {});
    await wait(1500);
    const due = (await get(a.steps[4])).due_date;
    if (new Date(due).getTime() !== new Date(mine).getTime()) throw new Error('Carve is due ' + due);
  });

  await step('undo-leaves-done-steps-and-a-new-tick-sets-them-again', async () => {
    const before = await dues(a);
    await patch(a.steps[0], { done: false });                                  // the steps timed from it are done
    await wait(1500);
    if (JSON.stringify(await dues(a)) !== JSON.stringify(before)) throw new Error('undoing changed due dates');
    await patch(a.steps[1], { done: false });                                 // Peel the potatoes isn't done any more, so it can move
    await wait(1100);
    const again = await patch(a.steps[0], { done: true });
    await until('Peel the potatoes never moved', async () => after((await get(a.steps[1])).due_date, again.done_at) === 20);
    const d = await dues(a);
    if (d[2] !== before[2] || d[3] !== before[3]) throw new Error('done steps were changed: ' + JSON.stringify([before[2], d[2], before[3], d[3]]));
  });

  await step('undo-takes-the-due-date-off-a-step-waiting-on-it', async () => {
    // Peel the potatoes isn't done and waits on the roast going in: unticked, it has no due date until the roast is in
    // again, and its reminder won't go off.
    await patch(a.steps[0], { done: false });
    await until('Peel the potatoes kept its due date', async () => !isSet((await get(a.steps[1])).due_date));
    const peel = await get(a.steps[1]);
    if ((peel.reminders || []).some(r => isSet(r.reminder))) throw new Error('its reminder is still set: ' + JSON.stringify(peel.reminders));
    const again = await patch(a.steps[0], { done: true });
    await until('Peel the potatoes never got a due date again', async () => after((await get(a.steps[1])).due_date, again.done_at) === 20);
  });

  await step('a-tick-from-the-web-app-and-done-steps-left-alone', async () => {
    await patch(b.steps[2], { done: true });                                  // Baste the roast, done before it went in
    await wait(1100);
    const t = await api('/tasks/' + b.steps[0], { v: 'v1' });
    const done = await api('/tasks/' + b.steps[0], { method: 'POST', v: 'v1', body: { ...t, done: true } });   // as the web app saves
    await until('no due dates were set', async () => isSet((await get(b.steps[3])).due_date));
    const mins = (await dues(b)).map(x => after(x, done.done_at));
    if (JSON.stringify(mins) !== JSON.stringify([null, 20, null, 60, null, null])) throw new Error('minutes after the tick: ' + JSON.stringify(mins));
  });
  await step('a-runs-steps-go-in-the-order-they-were-copied', async () => {
    // Pocket copies a run's steps in its template's order and shows them by id, whatever order Vikunja links them in.
    const c = await startRun(template.id, tplSteps, label.id, true);
    const done = await patch(c.steps[0], { done: true });
    await until('no due dates were set', async () => isSet((await get(c.steps[3])).due_date));
    const mins = (await dues(c)).map(x => after(x, done.done_at));
    if (JSON.stringify(mins) !== JSON.stringify([null, 20, 40, 60, null, null])) throw new Error('minutes after the tick: ' + JSON.stringify(mins));
  });
  await step('a-task-that-isnt-a-run-sets-nothing', async () => {
    // Anyone who can edit a task can link it to tasks they can only see. A parent copied from something that isn't a
    // template, with a step "copied from" a timed template step: not a run, so nothing is written.
    const other = await mk('Not a template ' + stamp), parent = await mk('Looks like a run ' + stamp);
    await api(`/tasks/${parent.id}/relations`, { method: 'POST', body: { other_task_id: other.id, relation_kind: 'copiedfrom' } });
    const x = await mk('First'), y = await mk('Second');
    for (const t of [x, y]) await api(`/tasks/${parent.id}/relations`, { method: 'POST', body: { other_task_id: t.id, relation_kind: 'subtask' } });
    await api(`/tasks/${tplSteps[1]}/relations`, { method: 'POST', body: { other_task_id: y.id, relation_kind: 'copiedto' } });   // Peel the potatoes T#20m
    await patch(x.id, { done: true });
    await wait(1500);
    if (isSet((await get(y.id)).due_date)) throw new Error('got a due date: ' + (await get(y.id)).due_date);
  });
} finally {
  if (project) for (let i = 0; i < 5; i++) { try { await api('/projects/' + project.id, { method: 'DELETE' }); break; } catch { await wait(500); } }
}
console.log(failed ? `${failed} failed` : 'All passed');
process.exitCode = failed ? 1 : 0;
