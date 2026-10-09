// Pocket's copy of Alpine (src/vendor/, its scheduler patched) runs reactive updates in the same order as Alpine's own:
// both are given the same updates, queued and taken off the queue at random, before and during a flush, and must run
// them in the same order.
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
