// Pocket patches the scheduler and x-for in its copy of Alpine (src/vendor/). The patched scheduler must run updates in
// the same order as Alpine's original. Both get the same random updates, queued and removed from the queue before and
// during a flush.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { watching } from './reactive.mjs';
import { memo } from '../../src/js/util.js';

// Alpine 3.17.4's scheduler (MIT), copied from its published dist/cdn.js, before Pocket patched it.
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

// Builds a scheduler from its source. Microtasks wait until the test calls `flush`.
const scheduler = code => {
  const tasks = [];
  const { queue, dequeue } = new Function('queueMicrotask', code + ';return {queue: queueJob, dequeue: dequeueJob}')(f => tasks.push(f));
  return { queue, dequeue, flush: () => { while (tasks.length) tasks.shift()(); } };
};

const random = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// Runs one random scenario on one scheduler and returns the order the updates ran in. Elements are nested at random,
// and some updates belong to an element (as x-for and x-if updates do). Each update queues or removes other updates
// when it runs, following a script fixed by its run count.
const run = (code, seed) => {
  const r = random(seed), s = scheduler(code), log = [];
  const els = [];
  for (let i = 0; i < 40; i++) els.push({ parentElement: i && r() < 0.9 ? els[Math.floor(r() * i)] : null });
  const jobs = [], ran = [];
  for (let i = 0; i < 60; i++) {
    const job = () => {
      const n = ran[i] = (ran[i] || 0) + 1;
      log.push(i);
      if (n > 4) return;                                        // stops the scenario from looping forever
      const rr = random(seed * 1000 + i * 10 + n);
      for (let k = Math.floor(rr() * 4); k--;) {
        const other = Math.floor(rr() * jobs.length);
        if (other === i) continue;                              // Alpine never removes the update that is running
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

/* The patched x-for. A key that is a path into the item (`t.id`) is read straight from the item. Items at the start of
   the list that are the same objects in the same positions keep the key and scope from the last render, so they are
   not worked out again. Without this, a long list drawn a batch at a time went over every row already drawn for each
   batch. The tests run it on a fake DOM and check, after every change, that each element is in its place with the
   scope of its item. */
const XFOR = vendor.slice(vendor.indexOf('  // packages/alpinejs/src/directives/x-for.js'), vendor.indexOf('  // packages/alpinejs/src/directives/x-ref.js'));
class El {
  constructor(parent = null){ this.parent = parent; if (parent) parent.kids.push(this); }
  get nextElementSibling(){ const k = this.parent.kids; return k[k.indexOf(this) + 1] || null; }
  remove(){ const k = this.parent.kids; k.splice(k.indexOf(this), 1); this.parent = null; }
  after(el){ if (el.parent) el.remove(); const k = this.parent.kids; k.splice(k.indexOf(this) + 1, 0, el); el.parent = this.parent; }
  replaceWith(el){ if (el.parent) el.remove(); const k = this.parent.kids; k.splice(k.indexOf(this), 1, el); el.parent = this.parent; this.parent = null; }
}
// An x-for over `items`, keyed by `key`. `set(list)` renders it, `rows()` returns its elements in order, and `keyRuns`
// counts how many times Alpine's own evaluation worked out a key.
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

/* memo (util.js) works a value out once per change to the data it reads. It uses the reactivity in Pocket's copy of
   Alpine (reactive.mjs) and sets a scheduler on its effect, which Alpine's public API doesn't offer. An Alpine upgrade
   that moves that code fails here. */
test('a memo is worked out once per change to what it reads, at once after a change, and tells what read it to read it again', c => {
  const { Alpine, flush } = watching(c);
  const data = Alpine.reactive({ steps: [{ id: 1, done: false }, { id: 2, done: false }], other: 0 }), self = { data };
  let worked = 0, drawn = 0, seen = null;
  const open = memo(function(){ worked++; return { n: this.data.steps.filter(s => !s.done).length }; });
  const first = open.call(self);
  assert.deepEqual([first.n, worked], [2, 1]);
  assert.equal(open.call(self), first, 'read again with nothing changed: the same object');
  data.other++;
  assert.deepEqual([open.call(self), worked], [first, 1], 'something it doesn\'t read changed: still the same, not worked out again');
  // An effect that renders the value runs once, then again only after the value goes stale.
  Alpine.effect(() => { drawn++; seen = open.call(self).n; });
  assert.deepEqual([drawn, seen, worked], [1, 2, 1]);
  data.steps[0].done = true;                                                // a change deep inside the data the memo read
  assert.deepEqual([open.call(self).n, worked], [1, 2], 'read straight after a change, before Alpine has run anything: worked out afresh');
  assert.equal(drawn, 1, 'what showed it hasn\'t run yet');
  flush();
  assert.deepEqual([drawn, seen, worked], [2, 1, 2], 'then it runs, once, and the value isn\'t worked out a third time');
  data.steps[1].done = true; data.steps.push({ id: 3, done: false }); data.steps[2].done = true;
  flush();
  assert.deepEqual([drawn, seen, worked], [3, 0, 3], 'three changes before anything read it: worked out once');
  flush();
  assert.equal(drawn, 3, 'and nothing left to run');
});

test('a memo whose working out throws is worked out again the next time it\'s read', c => {
  watching(c);
  let n = 0;
  const m = memo(() => { if (!n++) throw new Error('not yet'); return n; });
  assert.throws(() => m(), /not yet/);
  assert.equal(m(), 2);
  assert.equal(m(), 2);
});

test('without Alpine (the unit tests), a memo is worked out each time it\'s read', () => {
  let n = 0;
  const m = memo(() => ++n);
  assert.deepEqual([m(), m()], [1, 2]);
});
