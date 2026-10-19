// The outbox's database in memory, as much of IndexedDB as sync.js uses. A value is copied as it is stored and as it
// is read, as IndexedDB copies it, so no tab holds the database's own object. Import it before anything from src/,
// because sync.js opens the database as it loads.
export const stores = new Map();
// How many requests the database has had, so a test can tell when the app has stopped working.
export const used = { requests: 0 };
class Request {
  result = undefined;
  onsuccess = null;
}
globalThis.IDBRequest = Request;
const database = {
  objectStoreNames: { contains: name => stores.has(name) },
  createObjectStore(name) {
    stores.set(name, new Map());
  },
  deleteObjectStore(name) {
    stores.delete(name);
  },
  transaction() {
    const t = {
      abort() {
        t.aborted = true;
      },
    };
    let open = 0;
    const done = () => {
      if (!open && !t.aborted) t.oncomplete?.();
    };
    const request = run => {
      const r = new Request();
      used.requests++;
      open++;
      queueMicrotask(() => {
        if (!t.aborted) {
          r.result = run();
          r.onsuccess?.({ target: r });
        }
        open--;
        done();
      });
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
    queueMicrotask(done); // a transaction with no requests
    return t;
  },
};
globalThis.indexedDB = {
  open() {
    const r = new Request();
    queueMicrotask(() => {
      r.result = database;
      if (!stores.size) r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  },
};
