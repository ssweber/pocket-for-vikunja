// A fake Vikunja behind fetch(), and a fake Alpine component. Together they run the app's methods (actions.js,
// tasks.js) in Node. api() is Pocket's real one, so it signs, sends and reads replies as it does in the browser.
import './browser.mjs';
import { setApp } from '../../src/js/util.js';
import tasks, { dropCopies } from '../../src/js/app/tasks.js';
import sheet from '../../src/js/app/sheet.js';
import { vikunjaNext } from '../../src/js/checklists.js';
import { setSeenToken, sharedToken } from '../../src/js/api.js';
import { sync, uuid7 } from '../../src/js/sync.js';
import { stageContext } from '../../src/js/app/acts.js';
import { noneWaiting, stagesOf, stageView } from '../../src/js/ops/index.js';

// Each kind of relation, and the kind Vikunja gives the other task.
const BACK = { subtask: 'parenttask', parenttask: 'subtask', copiedfrom: 'copiedto', copiedto: 'copiedfrom' };
const reply = (body, status = 200, more = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...more } });
const lost = () => new TypeError('network error');

/* The fake keeps tasks by id and behaves as Vikunja does. GET, PATCH and DELETE /tasks/:id read and change a task. A
   repeating task marked done moves to its next date instead (vikunjaNext, which is where Pocket expects Vikunja to
   move it). A task that is read, or a PATCH's reply, lists no deleted task among its related tasks (related_tasks),
   and a read lists each subtask as the subtask is now. A task marked done gets the time in done_at, and a task opened
   again loses it.
   POST /projects/:id/tasks creates a task with the next id, never one a deleted task had, and POST /tasks/:id/duplicate
   copies a task, with a "copied from" and "copied to" relation between the two. POST /tasks/:id/relations
   relates two tasks, a subtask to its parent or a copy to what it was copied from, or answers 4008 when they are
   related so already, and DELETE /tasks/:id/relations/:kind/:other removes the relation from both tasks, as Vikunja
   does. GET /tasks lists the tasks a filter picks, `updated > '<time>'` or `id in <ids>`, a page at a time, and leaves
   out the tasks of an archived project (`archived`, by project id), as Vikunja does. A task changed by a PATCH or a
   comment gets the time in `updated`. A task's comments, assignees, position and files (POST /tasks/:id/attachments)
   can be added to, and an assignee removed. GET and POST /labels list and create labels (`labels`), POST /tasks/:id/labels adds
   one to a task, and DELETE /tasks/:id/labels/:label removes it. PUT /tasks/:id/labels/bulk and /assignees/bulk set a task's labels and people. As in Vikunja, a label
   that doesn't exist or a person who can't see the project (`strangers`, by id) is refused, and a set with one of them
   is refused whole. A label on any task exists, as one a teammate made and put on a shared task does.

   A write to the plugin's relay (/api/v1/plugins/pocket/v2/<path>, with an Idempotency-Key) is answered as
   /api/v2/<path> would be, and the answer is kept by key, as relay.go keeps it. The same key again gets that answer,
   with Idempotent-Replayed, and changes nothing. With a different request it gets 422.

   Every request is recorded in `requests`, with its `key`, and `replayed` when the relay answered it from what it
   kept. `trouble(request)` makes a request fail: 'offline' (it never reaches Vikunja), 'lost' (it reaches Vikunja but
   the reply is lost on the way back), 'unknown' (the relay's 409 with Idempotency-Unknown), 'arrived' (it reaches
   Vikunja, and the relay answers it and its key from then on as unknown), or an HTTP status to answer with. An answer from `trouble` comes from in front of the relay, so the relay keeps none of them.
   `refuses(request)` gives an HTTP status for Vikunja itself to refuse a request with, which the relay keeps. */
export function fakeVikunja(tasks = []) {
  const v = {
      tasks: new Map(tasks.map(t => [t.id, structuredClone(t)])),
      labels: [],
      strangers: new Set(),
      archived: new Set(),
      requests: [],
      relayed: new Map(),
      unknown: new Set(),
      trouble: () => null,
      refuses: () => null,
    },
    gone = new Set();
  const pruned = t => {
    for (const [kind, list] of Object.entries(t.related_tasks || {}))
      if (list) t.related_tasks[kind] = list.filter(s => !gone.has(s.id));
    return t;
  };
  const withSubtasks = t => {
    const subs = pruned(t).related_tasks?.subtask;
    if (!subs) return t;
    t.related_tasks.subtask = subs.map(s =>
      v.tasks.has(s.id) ? { ...v.tasks.get(s.id), related_tasks: undefined } : s,
    );
    return t;
  };
  v.task = id => v.tasks.get(id);
  globalThis.fetch = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const key = headers['Idempotency-Key']?.replace(/^"|"$/g, ''),
      // A file's body as the relay compares it, byte for byte.
      bytes = body instanceof Blob ? Buffer.from(await body.arrayBuffer()).toString('latin1') : body;
    const req = {
      method,
      path: new URL(url).pathname.replace(/^\/api\/(v2|v1\/plugins\/pocket\/v2)/, ''),
      query: new URL(url).searchParams,
      body: typeof body === 'string' ? JSON.parse(body) : body,
      key,
    };
    v.requests.push(req);
    const trouble = v.trouble(req);
    if (trouble === 'offline') throw new TypeError('Failed to fetch');
    const unknown = () =>
      reply({ message: 'the first request with this Idempotency-Key never finished' }, 409, {
        'Idempotency-Unknown': 'true',
      });
    if (trouble === 'unknown' || v.unknown.has(key)) return unknown();
    if (typeof trouble === 'number') return reply({ message: `HTTP ${trouble} from the fake` }, trouble);
    const fp = `${method} ${req.path}\n${bytes ?? ''}`,
      kept = key && v.relayed.get(key);
    if (kept && kept.fp !== fp) return reply({ message: 'this Idempotency-Key was used for a different request' }, 422);
    if (kept) {
      req.replayed = true;
      if (trouble === 'lost') throw lost();
      return new Response(kept.text, {
        status: kept.status,
        headers: { 'Content-Type': 'application/json', 'Idempotent-Replayed': 'true' },
      });
    }
    const id = +(req.path.match(/^\/tasks\/(\d+)$/) || [])[1],
      t = v.tasks.get(id);
    const into = +(req.path.match(/^\/projects\/(\d+)\/tasks$/) || [])[1],
      over = v.tasks.get(+(req.path.match(/^\/tasks\/(\d+)\/relations$/) || [])[1]);
    const cut = req.path.match(/^\/tasks\/(\d+)\/relations\/(\w+)\/(\d+)$/),
      react = req.path.match(/^\/tasks\/(\d+)\/reactions(\/delete)?$/);
    const talk = v.tasks.get(+(req.path.match(/^\/tasks\/(\d+)\/comments$/) || [])[1]),
      placed = v.tasks.get(+(req.path.match(/^\/tasks\/(\d+)\/position$/) || [])[1]);
    const who = req.path.match(/^\/tasks\/(\d+)\/assignees(?:\/(\d+))?$/),
      people = who && v.tasks.get(+who[1]);
    const bulk = req.path.match(/^\/tasks\/(\d+)\/(labels|assignees)\/bulk$/),
      set = bulk && v.tasks.get(+bulk[1]);
    const tag = v.tasks.get(+(req.path.match(/^\/tasks\/(\d+)\/labels$/) || [])[1]),
      untag = req.path.match(/^\/tasks\/(\d+)\/labels\/(\d+)$/),
      // A label on a task counts as one Vikunja has, as Vikunja lets anyone who can see the task use it.
      label = id =>
        v.labels.find(l => l.id === id) ?? [...v.tasks.values()].flatMap(t => t.labels || []).find(l => l.id === id);
    const attach = v.tasks.get(+(req.path.match(/^\/tasks\/(\d+)\/attachments$/) || [])[1]),
      source = req.path.match(/^\/tasks\/(\d+)\/duplicate$/);
    const noLabel = () => reply({ message: 'The label does not exist.' }, 404),
      noAccess = () => reply({ message: 'The user does not have access to the project.' }, 403);
    let res;
    const no = v.refuses(req);
    if (no) res = reply({ message: `HTTP ${no} from Vikunja` }, no);
    else if (req.path === '/labels' && method === 'GET') res = reply({ items: v.labels, total_pages: 1 });
    else if (req.path === '/labels' && method === 'POST') {
      const l = { id: 500 + v.labels.length, title: req.body.title };
      v.labels.push(l);
      res = reply(l);
    } else if (bulk && method === 'PUT' && !set) res = reply({ message: 'The task does not exist.' }, 404);
    else if (set && method === 'PUT' && bulk[2] === 'labels') {
      if (!req.body.labels.every(({ id }) => label(id))) res = noLabel();
      else {
        set.labels = req.body.labels.map(({ id }) => label(id));
        res = reply(req.body);
      }
    } else if (set && method === 'PUT') {
      if (req.body.assignees.some(({ id }) => v.strangers.has(id))) res = noAccess();
      else {
        set.assignees = req.body.assignees.map(({ id }) => ({ id, username: 'user' + id }));
        res = reply(req.body);
      }
    } else if (tag && method === 'POST') {
      const l = label(req.body.label_id),
        list = (tag.labels ||= []);
      if (!l) res = noLabel();
      else if (list.some(x => x.id === l.id))
        res = reply({ code: 8001, message: 'This label already exists on the task.' }, 400);
      else {
        list.push(l);
        res = reply(req.body);
      }
    } else if (untag && method === 'DELETE' && v.tasks.has(+untag[1])) {
      const t = v.tasks.get(+untag[1]);
      if (!t.labels?.some(l => l.id === +untag[2])) res = reply({ message: 'The label is not on that task.' }, 404);
      else {
        t.labels = t.labels.filter(l => l.id !== +untag[2]);
        res = reply({ message: 'Successfully deleted.' });
      }
    } else if (attach && method === 'POST') {
      // One file in a multipart body (fileBody, api.js): the boundary, the part's headers, and the file's bytes.
      const [, , name, data] = bytes.match(/^--([^\r]+)\r\n[^]*?filename="([^"]*)"[^]*?\r\n\r\n([^]*)\r\n--\1--\r\n$/),
        a = { id: 2000 + v.requests.length, file: { name, size: data.length }, created: new Date().toISOString() };
      (attach.attachments ||= []).push(a);
      res = reply({ success: [a], errors: null });
    } else if (talk && method === 'POST') {
      const c = {
        id: 1000 + v.requests.length,
        comment: req.body.comment,
        author: { id: 1, username: 'me' },
        created: new Date().toISOString(),
      };
      (talk.comments ||= []).push(c);
      talk.updated = c.created;
      res = reply(c);
    } else if (placed && method === 'PUT') {
      placed.position = req.body.position;
      res = reply({ task_id: placed.id, project_view_id: req.body.project_view_id, position: req.body.position });
    } else if (people && method === 'POST') {
      const uid = req.body.user_id,
        list = (people.assignees ||= []);
      if (v.strangers.has(uid)) res = noAccess();
      else if (list.some(u => u.id === uid))
        res = reply({ code: 4021, message: 'This user is already assigned to that task.' }, 400);
      else {
        list.push({ id: uid, username: 'user' + uid });
        res = reply(req.body);
      }
    } else if (people && method === 'DELETE') {
      const list = people.assignees || [];
      if (!list.some(u => u.id === +who[2])) res = reply({ message: 'This user is not assigned to that task.' }, 404);
      else {
        people.assignees = list.filter(u => u.id !== +who[2]);
        res = reply({ message: 'Successfully deleted.' });
      }
    } else if (into && method === 'POST') {
      const made = {
        id: Math.max(100, ...v.tasks.keys(), ...gone) + 1,
        description: '',
        done: false,
        done_at: '0001-01-01T00:00:00Z',
        percent_done: 0,
        due_date: '0001-01-01T00:00:00Z',
        repeat_after: 0,
        repeat_mode: 0,
        priority: 0,
        assignees: null,
        labels: null,
        reminders: null,
        ...req.body,
        project_id: into,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        created_by: { id: 1 },
        related_tasks: {},
      };
      v.tasks.set(made.id, made);
      res = reply(made);
    } else if (source && method === 'POST') {
      const from = v.tasks.get(+source[1]);
      if (!from) res = reply({ message: 'The task does not exist.' }, 404);
      else {
        const copy = {
          ...structuredClone(from),
          id: Math.max(100, ...v.tasks.keys(), ...gone) + 1,
          created: new Date().toISOString(),
          related_tasks: { copiedfrom: [{ id: from.id }] },
        };
        v.tasks.set(copy.id, copy);
        ((from.related_tasks ||= {}).copiedto ||= []).push({ id: copy.id });
        res = reply({ duplicated_task: copy });
      }
    } else if (over && method === 'POST') {
      const sub = v.tasks.get(req.body.other_task_id),
        kind = req.body.relation_kind;
      if (!sub) res = reply({ message: 'The task does not exist.' }, 404);
      else if (over.related_tasks?.[kind]?.some(s => s.id === sub.id))
        res = reply({ code: 4008, message: 'The task relation already exists.' }, 409);
      else {
        ((over.related_tasks ||= {})[kind] ||= []).push({ id: sub.id });
        ((sub.related_tasks ||= {})[BACK[kind]] ||= []).push({ id: over.id });
        res = reply(req.body);
      }
    } else if (cut && method === 'DELETE') {
      const [, a, kind, b] = cut,
        back = BACK[kind];
      const drop = (x, k, id) => {
        const r = v.tasks.get(x)?.related_tasks;
        if (r?.[k]) r[k] = r[k].filter(s => s.id !== id);
      };
      if (!v.tasks.get(+a)?.related_tasks?.[kind]?.some(s => s.id === +b))
        res = reply({ message: 'The task relation does not exist.' }, 404);
      else {
        drop(+a, kind, +b);
        drop(+b, back, +a);
        res = reply({ message: 'Successfully deleted.' });
      }
    } else if (react && method === 'POST' && v.tasks.has(+react[1])) {
      // Reactions by the signed-in user, id 1, as {value: [users]}
      const rs = (v.tasks.get(+react[1]).reactions ||= {}),
        by = (rs[req.body.value] || []).filter(u => u.id !== 1);
      rs[req.body.value] = react[2] ? by : [...by, { id: 1, username: 'me' }];
      res = reply(req.body);
    } else if (req.path === '/tasks' && method === 'GET') {
      const q = new URL(url).searchParams,
        f = q.get('filter') || '',
        after = f.match(/^updated > '(.+)'$/),
        ids = f
          .match(/^id in ([\d, ]+)$/)?.[1]
          .split(',')
          .map(Number),
        per = +q.get('per_page') || 50,
        page = +q.get('page') || 1,
        list = [...v.tasks.values()].filter(
          t =>
            !v.archived.has(t.project_id) &&
            (after ? Date.parse(t.updated) > Date.parse(after[1]) : ids ? ids.includes(t.id) : true),
        );
      res = reply({
        items: list.slice((page - 1) * per, page * per).map(t => withSubtasks(structuredClone(t))),
        total: list.length,
        total_pages: Math.max(1, Math.ceil(list.length / per)),
      });
    } else if (!id) res = reply({ message: `the fake has no ${method} ${req.path}` }, 404);
    else if (!t) res = reply({ message: 'The task does not exist.' }, 404);
    else if (method === 'GET') res = reply(withSubtasks(t));
    else if (method === 'DELETE') {
      v.tasks.delete(id);
      gone.add(id);
      res = reply({ message: 'Successfully deleted.' });
    } else if (method === 'PATCH') {
      const next = req.body.done && !t.done && vikunjaNext(t),
        was = !!t.done,
        now = new Date().toISOString();
      Object.assign(t, req.body, next ? { done: false, due_date: new Date(next).toISOString() } : {}, {
        updated: now,
      });
      if (t.done !== was) t.done_at = t.done ? now : '0001-01-01T00:00:00Z';
      res = reply(pruned(t));
    } else res = reply({ message: `the fake has no ${method} ${req.path}` }, 405);
    if (trouble === 'arrived') {
      v.unknown.add(key);
      return unknown();
    }
    if (key && res.status < 500) v.relayed.set(key, { fp, status: res.status, text: await res.clone().text() });
    if (trouble === 'lost') throw lost();
    return res;
  };
  return v;
}

/* A fake component made from the parts of the app that are passed in (their methods, as component.js combines them).
   The rest of the app is stubbed. Messages are recorded in `toasts`, with the `row` and `place` each was shown at, and
   its `ms` when the caller gave one.
   There is no screen, so these are just the values the caller asked for. No task has a role in Checklists. Rows marked
   done or deleted (leaving.js) are in `leaving`, when that part is passed in. The component is signed in with the
   shared session's token, already confirmed as the user's, so a change is sent without asking Vikunja who it is. The
   sheet and a checklist's screen read their tasks by id, as tasks.js does (sheetTask, runTask). */
export function component(...parts) {
  sharedToken.set('tk_test');
  setSeenToken('tk_test');
  const c = {
    server: 'http://vikunja.test',
    signedIn: true,
    offline: false,
    writing: 0,
    tasks: {},
    view: { groups: [] },
    sheet: { id: null },
    route: { name: 'today' },
    toasts: [],
    leaving: {},
    movedGaps: {},
    waiting: noneWaiting(),
    opsOn: {},
    slideClaim: {},
    dropping: [],
    failed: [],
    notify(msg, action) {
      this.toasts.push({ msg, action });
    },
    say(msg, { row = null, place = null, action = null, cls = '', gone, ms } = {}) {
      this.toasts.push({
        msg,
        action,
        row,
        place,
        cls: row?.cls || cls,
        ...(gone && { gone }),
        ...(ms !== undefined && { ms }),
      });
      return 'toast';
    },
    said: '',
    places: {},
    rowEl() {
      return null;
    },
    unsay() {},
    get toast() {
      return this.toasts.at(-1);
    },
    render() {},
    flush() {},
    // Where rows move as the batch clears (views.js), for tests without the screens.
    regroupPlan() {
      return [];
    },
    regroup() {},
    regroupSoon() {},
    listedIds() {
      return new Set();
    },
    moves() {
      return false;
    },
    flash() {},
    setBadge() {},
    untouched() {
      return null;
    },
    role() {
      return null;
    },
    inToday() {
      return true;
    },
    withoutTemplates(list) {
      return list;
    },
    stepRun() {
      return null;
    },
    isRunTask() {
      return false;
    },
  };
  const byId = Object.getOwnPropertyDescriptors(tasks);
  // What every part reads from the store, and change(), the one way to write it.
  Object.defineProperties(c, {
    sheetTask: byId.sheetTask,
    runTask: byId.runTask,
    subRow: byId.subRow,
    withOps: byId.withOps,
    opsOf: byId.opsOf,
    tickedByMe: byId.tickedByMe,
    beingDeleted: byId.beingDeleted,
    change: byId.change,
    shownAs: byId.shownAs,
    removeRow: byId.removeRow,
    hiddenRows: byId.hiddenRows,
    sheetShows: Object.getOwnPropertyDescriptor(sheet, 'sheetShows'),
  });
  for (const part of parts) Object.defineProperties(c, Object.getOwnPropertyDescriptors(part));
  dropCopies();
  setApp(c);
  // The outbox the last test left in memory isn't this app's (outboxOf).
  sync.entries = new Map();
  return c;
}

/* The outbox holding the entries in `list`, in that order, as keyOps reads it, and each task's rows showing them. An
   entry is the signed-in user's, made at QUEUED, unless it says otherwise. */
export const QUEUED = '2026-10-17T09:00:00.000Z';
export function outboxOf(app, list) {
  app.user ||= { id: 1 };
  sync.entries = new Map(list.map((e, n) => [e.id, Object.assign(e, { user: app.user.id, at: QUEUED, n, ...e })]));
  app.change(w => w.keyOps());
}
// Send an op's stages one after another, as app/acts.js does, without the outbox around them.
export async function sendStages(app, a) {
  a.id ||= uuid7();
  for (a.stage = 0; a.stage < stagesOf(a).length; a.stage++)
    await stagesOf(a)[a.stage](stageView(a), stageContext(a, app).start());
}
