// Helpers that ops.test.mjs, sender.test.mjs and ops-dates.test.mjs share: a component that sends ops to a fake
// Vikunja behind the plugin's relay, a lost reply or connection, what reached Vikunja, and the last message.
import './browser.mjs';
import { fakeVikunja, component } from './fake.mjs';
import acts from '../../src/js/app/acts.js';
import tasks from '../../src/js/app/tasks.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import { sync } from '../../src/js/sync.js';

/* The sender with a fake outbox. Each act is queued with act() and sent at once. Messages are read from `toasts`, since
   `toast` here is the component's own toast, which act() reads. */
export const sender = (t, list) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = fakeVikunja(list),
    app = component(tasks, acts, sending, outbox, runs);
  Object.assign(app, {
    user: { id: 1 },
    pending: [],
    failed: [],
    slow: [],
    flushing: false,
    cap: {},
    sheet: { id: null, sub: {} },
    view: { groups: [], shownRun: null },
    places: {},
    endPlace() {},
    aimSent() {},
    positionSent() {},
  });
  Object.defineProperty(app, 'toast', { value: {} });
  return { v, app };
};
// The requests that reached Vikunja. The relay answers a request sent again with its key from what it kept.
export const reached = (v, method, re) => v.requests.filter(r => r.method === method && re.test(r.path) && !r.replayed);
export const lostOnce = (v, method, re) => {
  let n = 0;
  v.trouble = r => (r.method === method && re.test(r.path) && !n++ ? 'lost' : null);
};
// The act starts flush, whose read fails here, as it would with no connection.
export const noConnection = (app, v) => {
  app.offline = true;
  v.trouble = q => (q.path === '/user' ? 'offline' : null);
};
// Fire the flush an act started (setTimeout is mocked here), and let its requests settle.
export const settle = async (t, done = () => false) => {
  t.mock.timers.tick(1);
  for (let i = 0; i < 200 && !done(); i++) await new Promise(ok => setImmediate(ok));
};
/* Cancel in the Outbox asks nothing. The change leaves the outbox at once, and the message says what Vikunja keeps.
   Its Undo puts the same entry back, with its key and in its place, and it is sent once. */
export const offlineSender = t => {
  t.after(async () => {
    for (const x of sync.all(1)) await sync.remove(x.id);
  });
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const r = sender(t, [
    { id: 7, title: 'Wipe the till' },
    { id: 8, title: 'Pay the rent', due_date: today.toISOString() },
    { id: 9, title: 'Lock up' },
  ]);
  noConnection(r.app, r.v);
  const confirm = globalThis.confirm;
  globalThis.confirm = () => {
    throw new Error('Cancel asked');
  };
  t.after(() => {
    globalThis.confirm = confirm;
  });
  return r;
};
export const lastSaid = app => app.toasts.at(-1);
