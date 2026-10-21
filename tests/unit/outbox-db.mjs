/* The outbox's database in memory, as much of IndexedDB as sync.js uses. A value is copied as it is stored and as it
   is read, as IndexedDB copies it, so no tab holds the database's own object. Events come in an order a browser can
   give. Each request's success and each transaction's complete runs in a task of its own. A transaction waits for
   every earlier one on the same stores, unless both only read. Import it before anything from src/, because sync.js
   opens the database as it loads. */
export const stores = new Map();
// How many tasks the database has run, so a test can tell when the app has stopped working.
export const used = { tasks: 0 };
const task = fn => {
  used.tasks++;
  setImmediate(fn);
};
class Request {
  result = undefined;
  onsuccess = null;
}
globalThis.IDBRequest = Request;
// The transactions not yet finished, oldest first.
const live = [];
const blocked = t =>
  live
    .slice(0, live.indexOf(t))
    .some(u => (u.mode === 'readwrite' || t.mode === 'readwrite') && u.scope.some(n => t.scope.includes(n)));
const startWaiting = () => {
  for (const t of live) if (!t.started && !blocked(t)) t.start();
};
const database = {
  objectStoreNames: { contains: name => stores.has(name) },
  createObjectStore(name) {
    stores.set(name, new Map());
  },
  deleteObjectStore(name) {
    stores.delete(name);
  },
  transaction(scope, mode = 'readonly') {
    const waiting = [];
    const t = {
      scope: [scope].flat(),
      mode,
      started: false,
      abort() {
        t.aborted = true;
        finish();
      },
      start() {
        t.started = true;
        task(next);
      },
    };
    const finish = () => {
      if (live.includes(t)) live.splice(live.indexOf(t), 1);
      startWaiting();
    };
    // A transaction runs its requests one at a time, and commits once the last one's success asked for no more.
    const next = () => {
      if (t.aborted) return;
      const r = waiting.shift();
      if (!r)
        return task(() => {
          if (t.aborted) return;
          finish();
          t.oncomplete?.();
        });
      r.result = r.run();
      r.onsuccess?.({ target: r });
      task(next);
    };
    const request = run => {
      const r = Object.assign(new Request(), { run });
      waiting.push(r);
      return r;
    };
    t.objectStore = name => {
      const s = stores.get(name);
      return {
        put: (v, k = v.id) =>
          request(() => {
            s.set(k, structuredClone(v));
          }),
        get: k => request(() => structuredClone(s.get(k))),
        getAll: () => request(() => [...s.values()].map(v => structuredClone(v))),
        delete: k =>
          request(() => {
            s.delete(k);
          }),
      };
    };
    live.push(t);
    startWaiting();
    return t;
  },
};
globalThis.indexedDB = {
  open() {
    const r = new Request();
    task(() => {
      r.result = database;
      if (!stores.size) r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  },
};
