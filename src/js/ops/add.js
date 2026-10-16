/* Adding a task: one line typed in an add box, or a step's title from the template editor. Each line is its own op.
   The lines typed together share `batch`, and a line under another line names it as `under: 'pending-<entry>'`. The
   entry also keeps how far each stage got, so a try that is cut off carries on where it stopped. Every write is sent
   with a key, and the relay answers a request Vikunja already made from what it stored, so nothing is made twice. The
   relay refuses a key sent again with a different body, so what a stage reads to build a body is read once and kept.

   A label or a person that Vikunja refuses is reported as a problem, and the next stage starts. A lost connection, a
   busy Vikunja or a key the relay can't vouch for stops the line. */
import {passing} from '../api.js';
import {patiently} from '../checklists.js';
import {OP_WORDS} from '../messages.js';
import {removeAssignee} from '../quickadd.js';
import {ALREADY, sync, unpackParsed, uuid7} from '../sync.js';
import {ZERO} from '../util.js';
import {opsId} from '../app/tasks.js';
import {figureOf} from './stages.js';

const settle = (e, problem) => {
  if (passing(e) || e.status === 401 || e.code === 'unknown') throw e;
  problem(e.message);
};
const ids = list => (list || []).map(x => x.id);
const problems = a => a.problems ||= [];
// The task id a 'pending-<entry>' id stands for once Vikunja has made it, or null.
const real = id => typeof id === 'string' ? sync.taskOf(id.replace(/^pending-/, '')) : id;

/* Work out the task's body once, and keep it. A user who can see the project is assigned, and their @username is
   removed from the title, as in Vikunja. A user who can't see it stays in the title and is reported. If Vikunja refuses
   the search, Pocket assigns the user anyway, and Vikunja decides. Each person's id is looked up here, so a retry never
   reads it again. */
async function prepare(a, c){
  if (a.body) return;
  const app = c.app, parsed = unpackParsed(a.p), to = parsed.project?.id || a.pid, body = {title: parsed.title}, people = [], says = [];
  for (const name of parsed.assignees) {
    const seen = await app.canSee(to, name);
    if (seen === false) says.push(await app.userExists(name).catch(() => true) ? `@${name} can't see ${app.projById.get(to)?.title || 'that project'}` : `no user @${name}`);
    else {
      let u = null;
      try { u = await patiently(() => app.findUser(name)); if (!u) says.push(`no user @${name}`); } catch (e) { settle(e, m => says.push(`@${name}: ${m}`)); }
      if (u) people.push({name, id: u.id});
    }
    if (seen === true) body.title = removeAssignee(body.title, app.prefixes.assignee, name);
  }
  if (parsed.due) body.due_date = parsed.due.toISOString();
  if (parsed.due && parsed.remind) body.reminders = [{relative_to: 'due_date', relative_period: 0}];   // the 🔔 chip sets a reminder at the due time
  if (parsed.priority) body.priority = parsed.priority;
  if (parsed.position) body.position = parsed.position;                   // its position in its project's List view
  if (parsed.repeat) { body.repeat_after = parsed.repeat.after; body.repeat_mode = parsed.repeat.mode; }
  problems(a).push(...says);
  Object.assign(a, {to, body, people, labels: [...parsed.labels]});
}
// Make the task. `c.made` puts it on screen at once.
async function made(a, c){
  if (a.taskId) return;
  const t = await c.send(`/projects/${a.to}/tasks`, {method: 'POST', body: a.body});
  sync.claim(t.id, a.id || a.key);
  Object.assign(a, {taskId: t.id, projectId: t.project_id, had: {labels: ids(t.labels), assignees: ids(t.assignees)}});
  c.task = t; c.made?.(t);
}
// The labels and people the task has in Vikunja before the line's are added. They are read once and kept, so a set sent
// again after a lost reply has the same body. A task the line made has what Vikunja's answer gave it.
async function had(a, c){
  if (!a.had) { const t = await c.read('/tasks/' + a.taskId); a.had = {labels: ids(t.labels), assignees: ids(t.assignees)}; await c.save(); }
  return a.had;
}
/* Set the task's labels or people (`kind`) in one request: what it had, and `items`. Vikunja refuses the whole set when
   one item is bad, such as a label deleted in the web app or a person who can't see the project. Then each item is
   added on its own, as the parts after the set's, so only the bad ones are reported. The relay keeps a refusal and
   gives it again, so a retry takes the same path with the same keys. Returns the problems, in the words `says` gives. */
async function setAll(a, c, kind, items, one, already, says){
  const path = `/tasks/${a.taskId}/${kind}`, out = [], report = xs => e => settle(e, m => out.push(...xs.map(x => says(x, m))));
  let was;
  try { was = (await had(a, c))[kind]; } catch (e) { report(items)(e); return out; }
  try { await c.send(path + '/bulk', {method: 'PUT', body: {[kind]: [...new Set([...was, ...items.map(x => x.id)])].map(id => ({id}))}}); }
  catch (e) {
    if (!(e.status < 500) || passing(e) || e.status === 401 || e.code === 'unknown') { report(items)(e); return out; }
    for (const x of items) await c.send(path, {method: 'POST', body: one(x)}).catch(e => { if (e.code !== already) report([x])(e); });
  }
  return out;
}
const findLabel = all => name => all.find(l => l.title.toLowerCase() === name.toLowerCase());
/* Each label Vikunja doesn't have yet is created, one part each, and its id is kept as soon as it is answered. Then the
   task's labels are set (setAll): the labels it had, and the line's. Which labels exist is read from Vikunja when the
   line is sent, not from Pocket's copy. So a label an earlier line created is found, and a label deleted in the web app
   is made again instead of being sent with its old id. */
async function label(a, c){
  if (!a.labels.length || a.labeled) return;
  const says = (l, m) => `label ${l.name}: ${m}`, report = ls => e => settle(e, m => problems(a).push(...ls.map(l => says(l, m))));
  if (!a.tags) {
    try {
      const all = await patiently(() => c.app.loadLabels(true));
      a.tags = a.labels.map(name => { const id = findLabel(all)(name)?.id; return id ? {name, id} : {name, id: null, create: true}; });
    } catch (e) { report(a.labels.map(name => ({name})))(e); a.labeled = true; return; }
    await c.save();
  }
  for (const l of a.tags.filter(l => l.create)) {
    // A label made on an earlier try isn't sent again. Its part is still counted, so the requests after it keep their keys.
    if (l.id || l.refused) { c.skip(); continue; }
    try { const got = await c.send('/labels', {method: 'POST', body: {title: l.name}}); l.id = got.id; c.app.labels?.push(got); }
    catch (e) { report([l])(e); l.refused = true; }
    await c.save();
  }
  const on = a.tags.filter(l => l.id);
  if (on.length) problems(a).push(...await setAll(a, c, 'labels', on, l => ({label_id: l.id}), ALREADY.label, says));
  a.labeled = true;
}
// The task's people are set the same way. A person Vikunja refuses (no access to the project, say) is reported, and the
// task is kept.
async function assignee(a, c){
  if (!a.people?.length || a.assigned) return;
  problems(a).push(...await setAll(a, c, 'assignees', a.people, u => ({user_id: u.id}), ALREADY.assignee, (u, m) => `@${u.name}: ${m}`));
  a.assigned = true;
}
// Link the task under its parent: the line it goes under in a pasted list, or the task whose sheet it was added from. A
// refusal here stops the line, because the list can't be put together without the link.
async function link(a, c){
  if (a.under == null || a.linked) return;
  try { await c.app.linkSubtask(a.under, a.taskId, c.send); } catch (e) { if (e.code !== ALREADY.link) throw e; }
  a.linked = true;
}
/* A line that said it was done, or how far along it is, is first made like any task. Then it is marked the way a tick
   or a swipe marks it (100% is done). So a repeating task moves on to its next date, and its parent's progress counts
   it. This stage comes once the task is under its parent.

   The mark is sent with a key, so a repeating task whose reply was lost is ticked once, not twice. `c.arrived` gives
   the row Vikunja's copy afterwards (`now`) and whether the task was marked done. */
async function arrive(a, c){
  const p = a.p;
  if (a.arrived || !(p.done || p.pct > 0)) return;
  const done = !!p.done || p.pct >= 100, path = '/tasks/' + a.taskId;
  const t = await c.send(path, {method: 'PATCH', body: done ? {done: true} : {percent_done: p.pct / 100}}) || await c.read(path);
  a.arrived = true;
  c.arrived = {now: t, done};
  c.arrive?.(c.arrived);
}
/* Write the progress of the parents whose subtasks this line finishes (`ups`), deepest first, because each counts in
   the one above it. A task's progress drops when subtasks are added to it, and changes when a line under a line arrives
   done or with progress. The last line under a parent writes it, once the parent's subtasks are all made. Each parent
   has its own part, so a parent skipped on one try leaves the others their keys. */
async function figures(a, c){
  for (const [i, up] of (a.ups || []).entries()) await figureOf(c.start(i), real(up), 'figure' + i);
}

// The stages a task is made in. The template editor, a step's new title and an inserted step run these themselves
// (createTask, app/sending.js).
export const LINE = [prepare, made, label, assignee, link, arrive];
export const madeStage = LINE.indexOf(made);
const pending = a => 'pending-' + a.id;
/* A line shows as a waiting row of its own until its task is made, so it changes no task's row. A line that fails
   holds back the lines under it (`pending`) and the ops on its task. A line waits only for a failed line it goes under,
   never for another op on its parent. */
export const add = {apply: t => ({...t}), on: () => [], stages: [...LINE, figures], refusal: 'lines', cancel: 'lines', ...OP_WORDS.add,
  // `parent` is the task whose subtask box the line was typed in. A refused line goes back to that box.
  asks: ['batch', 'raw', 'p', 'pid', 'under', 'ups', 'above'], saw: ['label', 'over', 'parent'],
  holds: a => [pending(a), ...a.taskId ? [a.taskId] : []],
  waitsOn: a => typeof a.under === 'string' ? [a.under] : [],
  // The line's waiting row, shaped like a task. Its parent is the line it goes under, by that line's waiting-row id
  // until that line is sent and by its task id after, or the task whose subtask box it was added from.
  row(a){
    if (a.taskId) return null;
    const p = a.p;
    return {id: pending(a), pending: true, entry: a.id, sent: !!a.sent, child: a.under != null, parent: opsId(a.under) ?? null, title: p.title,
      done: !!p.done || p.pct >= 100, percent_done: (p.pct || 0) / 100, priority: p.priority || 0, position: p.position || 0, due_date: p.due || ZERO, project_id: p.project?.id || a.pid,
      labels: [], assignees: [], repeat_after: p.repeat?.after || 0, repeat_mode: p.repeat?.mode || 0, waiting: (a.files || []).filter(f => !f.sent).length};
  },
  // Once the line's task is made, its photos still waiting move to an entry of their own (filesOut, app/acts.js).
  files: a => a.taskId ? (a.files || []).filter(f => !f.sent) : [],
  keepReads: null, invert: null, merge: null, waiting: null, sheetPlace: null, answered: null, deletes: null};

/* The lines under waiting id `name` among the outbox's `entries`, in the order they were typed: only those right under
   it, or with `deep` those at every level. */
export function linesUnder(name, entries, deep = false){
  const names = new Set([name]), out = [];
  for (const x of entries) if (x.op === 'add' && names.has(x.under)) { if (deep) names.add(pending(x)); out.push(x); }
  return out;
}
// Remove the lines under waiting id `name`, at every level, and return them. Runs inside the outbox's lock.
export async function dropUnder(name, user){
  const out = linesUnder(name, sync.all(user), true);
  for (const x of out) await sync.remove(x.id);
  return out;
}
// The photos waiting on `lines`, read before the lines leave the outbox and their bytes with them.
export async function photosOf(lines){ return (await Promise.all(lines.flatMap(e => (e.files || []).filter(f => !f.sent).map(f => sync.file(f.key))))).filter(Boolean); }
/* A refused line, and the lines typed after it that are not sent yet, leave the outbox. Each of them goes under it or
   was meant to come after it. Returns their text for the box they were typed in (`unsent`), the photos added with
   them, and the task the box added to (`parent`). Runs inside the outbox's lock. */
export async function refuseLines(a){
  const rest = sync.all(a.user).filter(e => e.op === a.op && e.batch === a.batch && (e.id === a.id || (!e.sent && (e.n || 0) > (a.n || 0))));
  const photos = await photosOf(rest);
  for (const e of rest) await sync.remove(e.id, e.taskId ?? null);
  return {unsent: rest.filter(e => !e.taskId).map(e => e.raw), photos, parent: a.parent || null};
}
/* Line `e` leaves the outbox unsent, and the lines in `gone` leave with it. The parents' progress they were to write
   goes to the line before `e` in its batch, or else the line after it, so it is still written. Runs inside the
   outbox's lock. */
export async function passUps(e, gone = []){
  const out = new Set([e, ...gone].map(x => x.id)), ups = [...new Set([e, ...gone].flatMap(x => x.ups || []))].filter(u => !out.has(String(u).replace(/^pending-/, '')));
  const batch = sync.all(e.user).filter(x => x.batch === e.batch && !out.has(x.id) && x.stage < add.stages.length - 1), before = batch.filter(x => x.n < e.n).at(-1), after = batch.find(x => x.n > e.n);
  if (ups.length && (before || after)) await sync.save(before ? Object.assign(before, {ups: [...before.ups || [], ...ups]}) : Object.assign(after, {ups: [...ups, ...after.ups || []]}));
}

/* The lines typed together in an add box (itemsOf, sync.js), as the fields of one add op each. A line goes to the
   project it names, or else to the project of the line it is under, or else to `pid`. In a subtask box (`parent`),
   every line goes to the parent's project unless it names one. `over` is the title of what the line goes under, for
   the Outbox and the waiting row's Cancel button. `ups` are the parents whose progress the line writes (figures). The
   task the box adds to always gets its progress written, and a line only when a line under it arrives done or with
   progress. `above` are the parents above the line whose progress the batch writes. A line sent by Try again writes
   them all (retryAct), because the batch may have written them before the line was made. */
export function addLines(items, {pid = null, parent = null}){
  const id = items.map(() => uuid7()), to = [], ups = items.map(() => []), n = items.length;
  const out = items.map((x, i) => {
    const u = x.under, home = parent ? parent.project_id : u !== null ? to[u] : pid;
    to[i] = x.p.project?.id || home;
    return {id: id[i], op: 'add', batch: id[0], raw: x.raw, p: x.p, pid: home, under: u !== null ? 'pending-' + id[u] : parent?.id ?? null,
      over: u !== null ? items[u].p.title : parent?.title ?? null, parent, label: x.p.title, run: null, problems: [], ups: ups[i]};
  });
  const inside = (j, i) => { for (let k = items[j].under; k !== null; k = items[k].under) if (k === i) return true; return false; };
  const needs = [];
  for (let i = n - 1; i >= 0; i--) {
    needs[i] = items.some((k, j) => k.under === i && (k.p.done || k.p.pct > 0 || needs[j]));
    let last = i;
    for (let j = i + 1; j < n; j++) if (inside(j, i)) last = j;
    if (needs[i]) ups[last].push('pending-' + id[i]);
  }
  if (parent && n) ups[n - 1].push(parent.id);
  out.forEach((o, i) => { o.above = []; for (let k = items[i].under; k !== null; k = items[k].under) if (needs[k]) o.above.push('pending-' + id[k]); if (parent) o.above.push(parent.id); });
  return out;
}
