// Pocket's copy of Alpine (src/vendor/, its scheduler and its x-for patched) runs reactive updates in the same order as
// Alpine's own: both are given the same updates, queued and taken off the queue at random, before and during a flush,
// and must run them in the same order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Alpine 3.17.4's scheduler (MIT), as in its published dist/cdn.js, before Pocket patched it.
const OWN = `
  // packages/alpinejs/src/scheduler.js
  var flushPending = false;
  var flushing = false;
  var queue = [];
  var lastFlushedIndex = -1;
  var queueNeedsSort = false;
  var transactionActive = false;
  function scheduler(callback) {
    queueJob(callback);
  }
  function startTransaction() {
    transactionActive = true;
  }
  function commitTransaction() {
    transactionActive = false;
    queueFlush();
  }
  function queueJob(job) {
    if (!queue.includes(job)) {
      queue.push(job);
      if (job._x_schedulerPriority !== void 0)
        queueNeedsSort = true;
    }
    queueFlush();
  }
  function dequeueJob(job) {
    let index = queue.indexOf(job);
    if (index !== -1 && index > lastFlushedIndex)
      queue.splice(index, 1);
  }
  function queueFlush() {
    if (!flushing && !flushPending) {
      if (transactionActive)
        return;
      flushPending = true;
      queueMicrotask(flushJobs);
    }
  }
  function flushJobs() {
    flushPending = false;
    flushing = true;
    for (let i = 0; i < queue.length; i++) {
      if (queueNeedsSort)
        sortPendingJobs(i);
      queue[i]();
      lastFlushedIndex = i;
    }
    queue.length = 0;
    lastFlushedIndex = -1;
    queueNeedsSort = false;
    flushing = false;
  }
  function sortPendingJobs(start2) {
    let depths = /* @__PURE__ */ new Map();
    let sorted = queue.slice(start2).sort((a, b) => compareJobs(a, b, depths));
    for (let i = 0; i < sorted.length; i++) {
      queue[start2 + i] = sorted[i];
    }
    queueNeedsSort = false;
  }
  function compareJobs(a, b, depths) {
    if (!isStructural(a))
      return isStructural(b) ? 1 : 0;
    if (!isStructural(b))
      return -1;
    let depthDifference = getElementDepth(a._x_schedulerPriority.el, depths) - getElementDepth(b._x_schedulerPriority.el, depths);
    return depthDifference || a._x_schedulerPriority.order - b._x_schedulerPriority.order;
  }
  function isStructural(job) {
    return job._x_schedulerPriority !== void 0;
  }
  function getElementDepth(el, depths) {
    if (depths.has(el))
      return depths.get(el);
    let depth = 0;
    let owner = el;
    while (el) {
      depth++;
      if (el._x_teleportBack) {
        el = el._x_teleportBack;
      } else if (typeof ShadowRoot === "function" && el.parentNode instanceof ShadowRoot) {
        el = el.parentNode.host;
      } else {
        el = el.parentElement;
      }
    }
    depths.set(owner, depth);
    return depth;
  }
`;

const root = new URL('../../', import.meta.url), read = path => readFileSync(new URL(path, root), 'utf8');
const lib = read('src/index.html').match(/src="(alpine-[^"]+)-pocket\.\d+\.min\.js"/)[1], vendor = read(`src/vendor/${lib}.js`);
const PATCHED = vendor.slice(vendor.indexOf('  // packages/alpinejs/src/scheduler.js'), vendor.indexOf('  // packages/alpinejs/src/reactivity.js'));

// A scheduler from its code, with its microtask run when the test says.
const scheduler = code => {
  const tasks = [];
  const { queue, dequeue } = new Function('queueMicrotask', code + ';return {queue: queueJob, dequeue: dequeueJob}')(f => tasks.push(f));
  return { queue, dequeue, flush: () => { while (tasks.length) tasks.shift()(); } };
};

const random = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// One scenario on one scheduler: elements nested at random, updates (some an x-for/x-if's, on an element, in the order
// they were made), each of which, when it runs, queues or takes off others by a script fixed for its nth run.
const run = (code, seed) => {
  const r = random(seed), s = scheduler(code), log = [];
  const els = [];
  for (let i = 0; i < 40; i++) els.push({ parentElement: i && r() < 0.9 ? els[Math.floor(r() * i)] : null });
  const jobs = [], ran = [];
  for (let i = 0; i < 60; i++) {
    const job = () => {
      const n = ran[i] = (ran[i] || 0) + 1;
      log.push(i);
      if (n > 4) return;                                        // so that it ends
      const rr = random(seed * 1000 + i * 10 + n);
      for (let k = Math.floor(rr() * 4); k--;) {
        const other = Math.floor(rr() * jobs.length);
        if (other === i) continue;                              // Alpine never takes off the update running
        rr() < 0.7 ? s.queue(jobs[other]) : s.dequeue(jobs[other]);
      }
    };
    if (r() < 0.6) job._x_schedulerPriority = { el: els[Math.floor(r() * els.length)], order: i };
    jobs.push(job);
  }
  for (let round = 0; round < 6; round++) {
    for (let k = Math.floor(r() * 30); k--;) { const j = jobs[Math.floor(r() * jobs.length)]; r() < 0.75 ? s.queue(j) : s.dequeue(j); }
    s.flush();
    log.push('|');
  }
  return log;
};

test('updates run in the same order as in Alpine\'s own scheduler', () => {
  assert.ok(PATCHED.includes('Pocket:'), 'the patch is there');
  let ran = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const want = run(OWN, seed);
    assert.deepEqual(run(PATCHED, seed), want, 'seed ' + seed);
    ran += want.length;
  }
  assert.ok(ran > 10000, 'enough updates run: ' + ran);
});

/* Its x-for (patched too): a key that's a path into the item (`t.id`) is read off the item, and the items at the start
   of the list that are the same objects in the same places keep their key and scope from the last time, rather than
   being worked out again (a long list drawn a batch at a time went over every row drawn for each batch). Run here on a
   pretend DOM: after every change, each element in its place, with the scope of the item there, whatever moved. */
const XFOR = vendor.slice(vendor.indexOf('  // packages/alpinejs/src/directives/x-for.js'), vendor.indexOf('  // packages/alpinejs/src/directives/x-ref.js'));
class El {
  constructor(parent = null){ this.parent = parent; if (parent) parent.kids.push(this); }
  get nextElementSibling(){ const k = this.parent.kids; return k[k.indexOf(this) + 1] || null; }
  remove(){ const k = this.parent.kids; k.splice(k.indexOf(this), 1); this.parent = null; }
  after(el){ if (el.parent) el.remove(); const k = this.parent.kids; k.splice(k.indexOf(this) + 1, 0, el); el.parent = this.parent; }
  replaceWith(el){ if (el.parent) el.remove(); const k = this.parent.kids; k.splice(k.indexOf(this), 1, el); el.parent = this.parent; this.parent = null; }
}
// An x-for over `items`, keyed by `key`: set(list) draws it, rows() its elements in order, keyRuns how many times
// Alpine's own evaluation worked out a key.
const xfor = (expression, key) => {
  const box = { kids: [] }, tpl = new El(box), state = { items: [], keyRuns: 0 };
  tpl.content = { children: { length: 1 } }; tpl._x_keyExpression = key;
  let run, made;
  const evaluateLater = (el, expr) => (receiver, { scope = {} } = {}) => {
    if (expr === 'items') return receiver(state.items);
    state.keyRuns++;
    receiver(new Function(...Object.keys(scope), 'return (' + expr + ')')(...Object.values(scope)));
  };
  const stubs = { directive: (name, f) => { made = f; }, skipDuringClone: f => f, evaluateLater, mutateDom: f => f(), destroyTree(){}, initTree(){},
    addScopeToNode: (el, scope) => { el.scope = scope; }, reactive: x => x, warn(){}, document: { importNode: () => ({ firstElementChild: new El() }) } };
  new Function(...Object.keys(stubs), XFOR)(...Object.values(stubs));
  made(tpl, { expression }, { effect: f => { run = f; f(); }, cleanup(){} });
  return { state, set(list){ state.items = list; run(); }, rows: () => box.kids.slice(1) };
};
const drawn = (x, list, what) => {
  const rows = x.rows();
  assert.equal(rows.length, list.length, what + ': as many rows');
  rows.forEach((el, i) => { assert.equal(el.scope.t, list[i], `${what}: row ${i}'s item`); if ('i' in el.scope) assert.equal(el.scope.i, i, `${what}: row ${i}'s index`); });
};

test('x-for keyed by a path into the item: each row with its item, wherever it moved; keys read off the item', () => {
  assert.ok(XFOR.includes('Pocket:'), 'the patch is there');
  const a = { id: 1 }, b = { id: 2 }, c = { id: 3 }, d = { id: 4 }, x = xfor('(t, i) in items', 't.id');
  x.set([a, b]); drawn(x, [a, b], 'first');
  const first = x.rows()[0];
  x.set([a, b, c]); drawn(x, [a, b, c], 'one added at the end');
  assert.equal(x.rows()[0], first, 'the rows already drawn are kept');
  x.set([b, a, c]); drawn(x, [b, a, c], 'the same objects, moved');
  const b2 = { id: 2 };
  x.set([b2, a, c]); drawn(x, [b2, a, c], 'another object at the same place, with the same key');
  x.set([a, c]); drawn(x, [a, c], 'one taken off the front');
  x.set([d, a, c]); drawn(x, [d, a, c], 'one put at the front');
  x.set([d, a, c].slice()); drawn(x, [d, a, c], 'the same, in a new list');
  x.set([]); drawn(x, [], 'none');
  assert.equal(x.state.keyRuns, 0, 'no key worked out in Alpine\'s scope');
});

test('x-for keyed any other way, or with the list named, works out every key as Alpine does', () => {
  const a = { id: 1 }, b = { id: 2 };
  for (const [expression, key] of [['t in items', 't.id + 0'], ['(t, i, all) in items', 't.id']]) {
    const x = xfor(expression, key);
    x.set([a, b]); x.set([b, a]); drawn(x, [b, a], expression + ' by ' + key);
    assert.equal(x.state.keyRuns, 4, expression + ' by ' + key + ': each key, each time');
  }
});
