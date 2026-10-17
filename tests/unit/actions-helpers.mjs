// Helpers that actions.test.mjs, ticks.test.mjs and reschedule.test.mjs share: a day in seconds, the patches that
// reached the fake Vikunja, and a task opened in the sheet.
import './browser.mjs';
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
