// The outbox: everything waiting to go to Vikunja, kept on the phone. The requests of each change are its op's stages
// (src/js/ops/).
import { app, store } from './util.js';

/* The rows show the ops waiting in the outbox (keyOps, app/tasks.js), so each change to it in this tab tells them,
   once for all the changes made together. Deletes held for Restore change what the rows show too. */
let telling = false;
const tell = () => {
  if (telling) return;
  telling = true;
  queueMicrotask(() => {
    telling = false;
    app?.keyOutbox?.();
  });
};
class Told extends Set {
  add(v) {
    tell();
    return super.add(v);
  }
  delete(v) {
    tell();
    return super.delete(v);
  }
}
/* The copies of the entries in localStorage (see below), one key for each, so two tabs never write over each other's.
   When a copy doesn't fit, the older copy is deleted, and the entry shows once the database opens. */
const COPY = 'outbox.';
const copy = e => store.set(COPY + e.id, JSON.stringify(e)) || uncopy(e.id);
const uncopy = id => store.del(COPY + id);
function copied() {
  try {
    return Object.keys(localStorage)
      .filter(k => k.startsWith('pocket.' + COPY))
      .map(k => JSON.parse(localStorage.getItem(k)));
  } catch {
    return [];
  }
}

/* An entry is one of:
   - an op (`kind: 'act'`, `op`), sent through its stages. A line typed in an add box is an `add` op (ops/add.js):
     {id, kind, op: 'add', batch, raw, p, pid, under, over, parent, ups, files, ...its stages}. `p` is the line as parsed
     when it was typed, so "tomorrow" keeps meaning the day after it was typed. The photos added with a list are on its
     first line until its task is made.
   - files for a task: {id, user, at, taskId, files: [{key, name, size, type, ...}]}, added from its sheet, or with the
     line that made it.
   An entry with `items` and no `kind` or `taskId` is a capture an older Pocket saved. The sender removes it.

   Entries, file bytes and the tasks Pocket has added live in IndexedDB. An entry and its files are saved together or
   not at all. The screen reads a copy in memory (`entries`). Sending always starts from the database's copy, so two
   tabs never work from a stale one. If the database can't be used or the phone is out of space, the entry waits in
   memory only, and Pocket tells the user to keep it open.

   Each entry the database has is copied to localStorage too (`copy`), so a new page shows what is waiting before the
   database opens, which a slow phone or another tab can hold up for seconds. Only the screen reads the copies. */
export const sync = {
  entries: new Map(), // id -> entry, what the screen shows
  volatile: new Set(), // ids of entries kept in memory only
  adding: new Map(), // id -> the save of an entry this tab is adding (add)
  bytes: new Map(), // key -> File, for files kept in memory only
  claimed: new Map(), // task id -> {key, at}, see claim()
  held: new Told(), // ids of deletions in this tab that can still be restored, not sent yet
  db: null,
  asked: false,
  channel: 'BroadcastChannel' in self ? new BroadcastChannel('pocket-sync') : null,

  open() {
    return (this.db ||= new Promise((ok, no) => {
      const r = indexedDB.open('pocket', 3);
      // Version 3 changed the format of an entry. The upgrade starts every store empty, and keeps nothing older.
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const [name, how] of [['files'], ['outbox', { keyPath: 'id' }], ['claims', { keyPath: 'id' }]]) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
          db.createObjectStore(name, how);
        }
      };
      // A newer Pocket in another tab may need to upgrade the database. Closing it here keeps that tab from waiting.
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        ok(r.result);
      };
      r.onerror = () => no(r.error);
    }));
  },
  // Run `fn` in one transaction over `stores`. Resolves with what `fn` returned once the transaction commits, and
  // rejects if it doesn't.
  async tx(stores, mode, fn) {
    const db = await this.open();
    return new Promise((ok, no) => {
      const t = db.transaction(stores, mode),
        get = n => t.objectStore(n);
      let out;
      t.oncomplete = () => ok(out instanceof IDBRequest ? out.result : out);
      t.onerror = t.onabort = () => no(t.error || new DOMException('aborted', 'AbortError'));
      try {
        out = fn(get);
      } catch (e) {
        try {
          t.abort();
        } catch {}
        no(e);
      }
    });
  },
  // Load the entries that are waiting, and the record of which task was added for which line.
  async start() {
    const copies = copied();
    for (const e of copies) this.entries.set(e.id, e);
    try {
      await this.reload();
      // A copy read before the database was read, of an entry the database doesn't have, is of an entry sent since.
      for (const e of copies) if (!this.entries.has(e.id)) uncopy(e.id);
      // A claim lasts a day, or while an entry still waits for its task: a line under a line, or an op on a new step.
      const day = Date.now() - 86400000,
        named = new Set(
          [...this.entries.values()]
            .flatMap(e => [e.task, e.under, e.after, ...(e.ups || []), ...(e.above || [])])
            .filter(k => typeof k === 'string')
            .map(k => k.replace(/^pending-/, '')),
        );
      const claims = await this.tx(['claims'], 'readonly', s => s('claims').getAll()),
        kept = c => c.at > day || named.has(c.key);
      for (const c of claims) if (kept(c)) this.claimed.set(c.id, c);
      this.tx(['claims'], 'readwrite', s => {
        for (const c of claims) if (!kept(c)) s('claims').delete(c.id);
      }).catch(() => {});
    } catch {}
    this.channel?.addEventListener('message', async () => {
      await this.reload().catch(() => {});
      app?.refreshPending();
    });
  },
  /* Reload the entries from the database, and keep those that exist in memory only. Keep those this tab is still adding
     too. A read that started before their save doesn't find them, and nothing would send them until the next read. */
  async reload() {
    const list = await this.tx(['outbox'], 'readonly', s => s('outbox').getAll());
    const keep = [...this.volatile, ...this.adding.keys()].map(id => this.entries.get(id)).filter(Boolean);
    this.entries = new Map([...list, ...keep].map(e => [e.id, e]));
  },
  changed() {
    this.channel?.postMessage('changed');
  },
  // This user's entries, oldest first, so changes are sent in the order they were made (a tick, then its untick).
  all(user) {
    return [...this.entries.values()].filter(e => e.user === user).sort(older);
  },

  // Save a new entry and its files together. Returns {kept}, whether it reached the database.
  add(entry, files) {
    const saving = this.put(entry, files).finally(() => this.adding.delete(entry.id));
    this.adding.set(entry.id, saving);
    return saving;
  },
  async put(entry, files) {
    this.entries.set(entry.id, entry);
    tell();
    try {
      const data = await Promise.all(
        files.map(async f => ({ name: f.name, type: f.type, data: await f.arrayBuffer() })),
      );
      const put = await this.tx(['files', 'outbox'], 'readwrite', s => {
        data.forEach((d, i) => s('files').put(d, entry.files[i].key));
        return [putEntry(s, entry)];
      });
      put.forEach(copy);
      this.changed();
      return { kept: true };
    } catch {
      this.volatile.add(entry.id);
      files.forEach((f, i) => this.bytes.set(entry.files[i].key, f));
      return { kept: false };
    }
  },
  // Save an entry's progress and any new entries it made (`more`), and delete the bytes of files it has finished with
  // (`drop`), in one transaction.
  async save(entry, drop = [], more = []) {
    const all = [entry, ...more];
    for (const e of all) this.entries.set(e.id, e);
    tell();
    for (const k of drop) this.bytes.delete(k);
    if (this.volatile.has(entry.id)) {
      for (const e of more) this.volatile.add(e.id);
      return;
    }
    try {
      const put = await this.tx(['files', 'outbox'], 'readwrite', s => {
        for (const k of drop) s('files').delete(k);
        return all.map(e => putEntry(s, e));
      });
      put.forEach(copy);
      this.changed();
    } catch {
      for (const e of all) this.volatile.add(e.id);
    } // no space now, so keep it in memory
  },
  /* Remove an entry. For a line whose task is made, the task's id (`task`) takes the place of the line's waiting id in
     every entry that names it, in the same transaction. So a line under it keeps its parent in every tab. */
  async remove(id, task = null) {
    const e = this.entries.get(id),
      keys = (e?.files || []).map(f => f.key),
      name = 'pending-' + id;
    this.entries.delete(id);
    this.volatile.delete(id);
    tell();
    for (const k of keys) this.bytes.delete(k);
    if (task != null) for (const x of this.entries.values()) named(x, name, task);
    try {
      const renamed = [];
      await this.tx(['files', 'outbox'], 'readwrite', s => {
        for (const k of keys) s('files').delete(k);
        s('outbox').delete(id);
        if (task != null)
          s('outbox').getAll().onsuccess = r => {
            for (const x of r.target.result) if (named(x, name, task)) renamed.push(putEntry(s, x));
          };
      });
      uncopy(id);
      renamed.forEach(copy);
      this.changed();
    } catch {}
  },
  async drop(fn) {
    for (const e of [...this.entries.values()]) if (fn(e)) await this.remove(e.id);
  },
  // The entry to send from. It is the database's copy, which another tab may have changed. Null if that tab sent it.
  async fresh(id) {
    // An entry this tab is still adding isn't in the database yet, and would read as sent by another tab.
    await this.adding.get(id);
    if (this.volatile.has(id)) return this.entries.get(id) || null;
    try {
      const e = await this.tx(['outbox'], 'readonly', s => s('outbox').get(id));
      if (e) this.entries.set(id, e);
      else this.entries.delete(id);
      tell();
      return e || null;
    } catch {
      return this.entries.get(id) || null;
    }
  },
  async file(key) {
    if (this.bytes.has(key)) return this.bytes.get(key);
    try {
      const v = await this.tx(['files'], 'readonly', s => s('files').get(key));
      return v ? new File([v.data], v.name, { type: v.type }) : null;
    } catch {
      return null;
    }
  },
  // Record which entry made each task Pocket added, so taskOf can turn a waiting id into the task's id.
  claim(id, key) {
    const c = { id, key, at: Date.now() };
    this.claimed.set(id, c);
    this.tx(['claims'], 'readwrite', s => s('claims').put(c)).catch(() => {});
  },
  // The id of the task entry `key` made first. Null until the task is in Vikunja.
  taskOf(key) {
    for (const [id, c] of this.claimed) if (c.key === key) return id;
    return null;
  },
  // Once an entry has to wait, ask the browser not to clear the database when the phone runs low on space.
  keep() {
    if (!this.asked) {
      this.asked = true;
      navigator.storage?.persist?.().catch(() => {});
    }
  },
  // Only one tab sends at a time, even with Pocket open in two tabs.
  lock(fn) {
    return navigator.locks ? navigator.locks.request('pocket-outbox', fn) : fn();
  },
};
sync.ready = sync.start();
// A copy of an entry that the database can store. Parts of an entry can be Alpine's reactive proxies, which it can't.
const plain = o => JSON.parse(JSON.stringify(o));
// Put entry `e` in the outbox store of a transaction's stores `s`. Returns what was stored, to copy once it commits.
const putEntry = (s, e) => {
  const p = plain(e);
  s('outbox').put(p);
  return p;
};
// Put task id `id` where entry `e` names waiting id `name`. Returns whether anything changed.
function named(e, name, id) {
  let changed = false;
  for (const k of ['task', 'under', 'after'])
    if (e[k] === name) {
      e[k] = id;
      changed = true;
    }
  for (const k of ['ups', 'above'])
    if (e[k]?.includes(name)) {
      e[k] = e[k].map(x => (x === name ? id : x));
      changed = true;
    }
  return changed;
}
// The order entries are sent in (all).
export const older = (a, b) => a.at.localeCompare(b.at) || (a.n || 0) - (b.n || 0);
// What an op's merge returns when the new op cancels the earlier one, as an untick cancels a tick. Both leave the outbox.
export const CANCEL = 'cancel';
export const packParsed = p => ({
  title: p.title,
  due: p.due ? p.due.toISOString() : null,
  priority: p.priority,
  repeat: p.repeat,
  labels: p.labels,
  assignees: p.assignees,
  ...(p.mid?.length && { mid: p.mid }),
  project: p.project ? { id: p.project.id, title: p.project.title } : null,
  remind: !!p.remind,
  done: !!p.done,
  pct: p.pct || 0,
});
export const unpackParsed = p => ({ ...p, due: p.due ? new Date(p.due) : null });
export const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
// A UUIDv7. Its first 48 bits are the time in milliseconds, which the plugin's relay reads to tell how old a key is.
export const uuid7 = () => {
  const b = crypto.getRandomValues(new Uint8Array(16)),
    ms = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const fileEntry = f => ({
  key: randomId(),
  name: f.name,
  size: f.size,
  type: f.type,
  sent: false,
});
/* Turn the lines typed in a box into the lines an add op is made from (addLines, ops/add.js). `lines` is [{raw, p,
   under}], with `p` the parsed line and `under` the index of the line it goes under. A line with no title left (a
   date alone, say) is dropped, and the lines under it go under its parent. `more(k, under)` adds fields to kept line `k`. */
export function itemsOf(lines, more = () => null) {
  const kept = lines.map(x => !!x.p.title),
    at = [];
  for (const ok of kept) at.push(ok ? at.filter(k => k >= 0).length : -1);
  const up = i => {
    let u = lines[i].under ?? null;
    while (u !== null && !kept[u]) u = lines[u].under ?? null;
    return u === null ? null : at[u];
  };
  return lines.flatMap((x, i) =>
    kept[i] ? [{ raw: x.raw, p: { ...packParsed(x.p), ...more(at[i], up(i)) }, under: up(i) }] : [],
  );
}
// Vikunja's codes for a label, a person or a link the task already has.
export const ALREADY = { label: 8001, assignee: 4021, link: 4008 };
export const runTitle = (template, name, day) =>
  `${template} · ${day.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${name}`;
/* Whether a deletion can still be restored. In the tab that made it, that lasts until its rows or its message leave
   the screen (sync.held). In another tab, or after a reload, it lasts until `until`. */
export const held = e => sync.held.has(e.id) || e.until > Date.now();
/* The value of <html data-sync>, which the tests wait on. It is 'sending' while a change is on its way. It is
   'waiting' while an entry is kept that can't be sent now (no connection, a restorable deletion, a refusal, Vikunja
   busy), or while the outbox isn't read yet (`unsent` is null). Otherwise it is 'idle'. */
export const sendState = ({ busy, unsent }) => (busy ? 'sending' : unsent === 0 ? 'idle' : 'waiting');
/* A change shows on screen at once. It looks like it is waiting (dotted, "waiting to send") only after WAIT_MS without
   an answer, or at once without a connection. Most changes are answered well within WAIT_MS, so a row doesn't flicker.
   Returns the ids of the entries that look waiting at `now`, and the time the next entry will look waiting (null for
   none). */
export const WAIT_MS = 2500;
export function slowness(entries, now, offline) {
  const slow = [],
    later = [];
  for (const e of entries) {
    const at = Date.parse(e.at) + WAIT_MS;
    if (offline || !(at > now)) slow.push(e.id);
    else later.push(at);
  }
  return { slow, next: later.length ? Math.min(...later) : null };
}
