// A fake Vikunja behind fetch(), and a fake Alpine component. Together they run the app's methods (actions.js,
// tasks.js) in Node. api() is Pocket's real one, so it signs, sends and reads replies as it does in the browser.
import './browser.mjs';
import { setApp, cache } from '../../src/js/util.js';
import { vikunjaNext } from '../../src/js/checklists.js';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/* The fake keeps tasks by id and behaves as Vikunja does. GET, PATCH and DELETE /tasks/:id read and change a task. A
   repeating task marked done moves to its next date instead (vikunjaNext, which is where Pocket expects Vikunja to
   move it). A task that is read lists its current subtasks, without any that were deleted (related_tasks).
   POST /projects/:id/tasks creates a task with the next id. POST /tasks/:id/relations makes one task a subtask of
   another, and DELETE /tasks/:id/relations/subtask/:other removes the relation from both tasks, as Vikunja does.
   GET /tasks?q= finds a task by its title, which the outbox uses for a line (LINE_STEPS). Every request is recorded in
   `requests`. `trouble(request)` makes a request fail: 'offline' (it never reaches Vikunja), 'lost' (it reaches Vikunja
   but the reply is lost on the way back), or an HTTP status to answer with. */
export function fakeVikunja(tasks = []){
  const v = { tasks: new Map(tasks.map(t => [t.id, structuredClone(t)])), requests: [], trouble: () => null }, gone = new Set();
  const withSubtasks = t => {
    const subs = t.related_tasks?.subtask;
    if (!subs) return t;
    t.related_tasks.subtask = subs.filter(s => !gone.has(s.id)).map(s => v.tasks.has(s.id) ? { ...v.tasks.get(s.id), related_tasks: undefined } : s);
    return t;
  };
  v.task = id => v.tasks.get(id);
  globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
    const req = { method, path: new URL(url).pathname.replace(/^\/api\/v2/, ''), body: body ? JSON.parse(body) : undefined };
    v.requests.push(req);
    const trouble = v.trouble(req);
    if (trouble === 'offline') throw new TypeError('Failed to fetch');
    if (typeof trouble === 'number') return reply({ message: `HTTP ${trouble} from the fake` }, trouble);
    const id = +(req.path.match(/^\/tasks\/(\d+)$/) || [])[1], t = v.tasks.get(id);
    const into = +(req.path.match(/^\/projects\/(\d+)\/tasks$/) || [])[1], over = v.tasks.get(+(req.path.match(/^\/tasks\/(\d+)\/relations$/) || [])[1]);
    const cut = req.path.match(/^\/tasks\/(\d+)\/relations\/(\w+)\/(\d+)$/), react = req.path.match(/^\/tasks\/(\d+)\/reactions(\/delete)?$/);
    let res;
    if (into && method === 'POST') {
      const made = { id: Math.max(100, ...v.tasks.keys()) + 1, done: false, percent_done: 0, due_date: '0001-01-01T00:00:00Z', ...req.body, project_id: into,
        created: new Date().toISOString(), created_by: { id: 1 }, related_tasks: {} };
      v.tasks.set(made.id, made);
      res = reply(made);
    } else if (over && method === 'POST') {
      const sub = v.tasks.get(req.body.other_task_id);
      ((over.related_tasks ||= {}).subtask ||= []).push({ id: sub.id });
      ((sub.related_tasks ||= {}).parenttask ||= []).push({ id: over.id });
      res = reply(req.body);
    } else if (cut && method === 'DELETE') {
      const [, a, kind, b] = cut, back = { subtask: 'parenttask', parenttask: 'subtask' }[kind];
      const drop = (x, k, id) => { const r = v.tasks.get(x)?.related_tasks; if (r?.[k]) r[k] = r[k].filter(s => s.id !== id); };
      if (!v.tasks.get(+a)?.related_tasks?.[kind]?.some(s => s.id === +b)) res = reply({ message: 'The task relation does not exist.' }, 404);
      else { drop(+a, kind, +b); drop(+b, back, +a); res = reply({ message: 'Successfully deleted.' }); }
    } else if (react && method === 'POST' && v.tasks.has(+react[1])) {
      // Reactions by the signed-in user, id 1, as {value: [users]}
      const rs = v.tasks.get(+react[1]).reactions ||= {}, by = (rs[req.body.value] || []).filter(u => u.id !== 1);
      rs[req.body.value] = react[2] ? by : [...by, { id: 1, username: 'me' }];
      res = reply(req.body);
    } else if (req.path === '/tasks' && method === 'GET') res = reply({ items: [...v.tasks.values()].filter(x => x.title === new URL(url).searchParams.get('q')) });
    else if (!id) res = reply({ message: `the fake has no ${method} ${req.path}` }, 404);
    else if (!t) res = reply({ message: 'The task does not exist.' }, 404);
    else if (method === 'GET') res = reply(withSubtasks(t));
    else if (method === 'DELETE') { v.tasks.delete(id); gone.add(id); res = reply({ message: 'Successfully deleted.' }); }
    else if (method === 'PATCH') {
      const next = req.body.done && !t.done && vikunjaNext(t);
      Object.assign(t, req.body, next ? { done: false, due_date: new Date(next).toISOString() } : {}, { updated: new Date().toISOString() });
      res = reply(t);
    } else res = reply({ message: `the fake has no ${method} ${req.path}` }, 405);
    if (trouble === 'lost') throw new TypeError('network error');
    return res;
  };
  return v;
}

/* A fake component made from the parts of the app that are passed in (their methods, as component.js combines them).
   The rest of the app is stubbed. Messages are recorded in `toasts`, with the `row` and `place` each was shown at.
   There is no screen, so these are just the values the caller asked for. No task counts as a checklist. Rows marked
   done or deleted (leaving.js) are in `leaving`, when that part is passed in. The component is signed in with an API
   token, so a change is not checked against the shared session first. */
export function component(...parts){
  const c = {
    server: 'http://vikunja.test', mode: 'token', token: 'tk_test', signedIn: true, offline: false, writing: 0,
    tasks: {}, view: { groups: [] }, sheet: { task: null }, route: { name: 'today' }, toasts: [], leaving: {},
    waiting: { claims: {}, files: {} }, slideClaim: {}, dropping: [],
    notify(msg, action){ this.toasts.push({ msg, action }); },
    say(msg, { row = null, place = null, action = null, cls = '' } = {}){ this.toasts.push({ msg, action, row, place, cls: row?.cls || cls }); return 'toast'; },
    said: '', places: {}, rowEl(){ return null; }, unsay(){},
    get toast(){ return this.toasts.at(-1); },
    render(){}, flush(){}, regroupToday(){}, stepRun(){ return null; }, isRunTask(){ return false; }, bothWays: false,
  };
  for (const part of parts) Object.defineProperties(c, Object.getOwnPropertyDescriptors(part));
  cache.clear();
  setApp(c);
  return c;
}
