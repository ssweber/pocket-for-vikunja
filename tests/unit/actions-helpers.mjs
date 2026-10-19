// Helpers that actions.test.mjs, ticks.test.mjs and reschedule.test.mjs share: a day in seconds, the patches that
// reached the fake Vikunja, a task opened in the sheet, fingers on the page, and garbage collection.
import './browser.mjs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { started, TASK } from '../../src/js/app/tasks.js';

export const DAY = 86400;
// The patches Vikunja received. A request the relay answered from what it kept never reached Vikunja.
export const patches = v =>
  v.requests.filter(r => r.method === 'PATCH' && !r.replayed).map(r => [+r.path.split('/')[2], r.body]);
// Open task `t` in the sheet, as openTask does once it has Vikunja's copy. The sheet holds the id and reads the row.
export const opened = (app, t, more = {}) => {
  app.change(w => w.read([structuredClone(t)], TASK, started()));
  app.row(structuredClone(t));
  app.sheet = { ...more, id: t.id };
  return app.sheetTask;
};
// Collect garbage, and let the callbacks of a FinalizationRegistry run for what was collected.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
export const collected = async () => {
  gc();
  for (let i = 0; i < 3; i++) await new Promise(ok => setImmediate(ok));
};
/* Fingers on the page, as the batch listens for them (initBatch). The returned function puts a finger down
   ('pointerdown') or lifts it ('pointerup'). The rows that leave find no elements to fold here. */
export const fingers = (t, app) => {
  const on = {},
    was = document.querySelectorAll;
  document.addEventListener = (type, fn) => (on[type] ||= []).push(fn);
  globalThis.addEventListener = (type, fn) => (on[type] ||= []).push(fn);
  document.querySelectorAll = () => [];
  t.after(() => {
    delete document.addEventListener;
    delete globalThis.addEventListener;
    if (was) document.querySelectorAll = was;
    else delete document.querySelectorAll;
  });
  app.initBatch();
  return type => on[type].forEach(fn => fn({ pointerId: 1 }));
};
