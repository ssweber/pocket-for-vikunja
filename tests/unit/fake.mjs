// A pretend Vikunja behind fetch(), and a pretend Alpine component, for running the app's methods (actions.js,
// tasks.js) in Node: api() is Pocket's own, so it signs, sends and reads replies as it does in the browser.
import './browser.mjs';
import { setApp, cache } from '../../src/js/util.js';
import { vikunjaNext } from '../../src/js/checklists.js';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/* Tasks by id, which GET, PATCH and DELETE /tasks/:id read and change, as Vikunja does: a repeating task marked done
   moves on to its next date instead (where Pocket thinks Vikunja moves it, vikunjaNext). Every request is kept in
   `requests`. `trouble(request)` can make one go wrong: 'offline' (it never reaches Vikunja), 'lost' (it does, and the
   reply is lost on the way back), or an HTTP status to answer with. */
export function fakeVikunja(tasks = []){
  const v = { tasks: new Map(tasks.map(t => [t.id, structuredClone(t)])), requests: [], trouble: () => null };
  v.task = id => v.tasks.get(id);
  globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
    const req = { method, path: new URL(url).pathname.replace(/^\/api\/v2/, ''), body: body ? JSON.parse(body) : undefined };
    v.requests.push(req);
    const trouble = v.trouble(req);
    if (trouble === 'offline') throw new TypeError('Failed to fetch');
    if (typeof trouble === 'number') return reply({ message: `HTTP ${trouble} from the fake` }, trouble);
    const id = +(req.path.match(/^\/tasks\/(\d+)$/) || [])[1], t = v.tasks.get(id);
    let res;
    if (!id) res = reply({ message: `the fake has no ${method} ${req.path}` }, 404);
    else if (!t) res = reply({ message: 'The task does not exist.' }, 404);
    else if (method === 'GET') res = reply(t);
    else if (method === 'DELETE') { v.tasks.delete(id); res = reply({ message: 'Successfully deleted.' }); }
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

/* The component, with the parts of the app given (their methods, as component.js puts them together), what they use
   from the rest made simple: toasts are kept in `toasts`, and nothing is a run. Signed in with an API token, so a
   change isn't checked against the shared session first. */
export function component(...parts){
  const c = {
    server: 'http://vikunja.test', mode: 'token', token: 'tk_test', signedIn: true, offline: false, writing: 0,
    tasks: {}, view: { groups: [] }, sheet: { task: null }, route: { name: 'today' }, toasts: [],
    notify(msg, action){ this.toasts.push({ msg, action }); },
    get toast(){ return this.toasts.at(-1); },
    render(){}, flush(){}, stepRun(){ return null; }, isRunTask(){ return false; }, viewWantsDone(){ return false; },
  };
  for (const part of parts) Object.defineProperties(c, Object.getOwnPropertyDescriptors(part));
  cache.clear();
  setApp(c);
  return c;
}
