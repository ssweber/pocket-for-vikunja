/* Every op in OPS goes through the same lifecycle and passes the same checks. Each op is queued and brought to each
   state an outbox entry can be in (STATES). The user then does each thing that state allows (ACTIONS), the connection
   comes back, and every open tab sends what is waiting. RULES are checked after each. Each op gives a sample in
   SAMPLES (samples.mjs), and an op without one fails its test.

   Each tab is its own copy of the app's modules, as a browser tab is. The tabs share the fake Vikunja, the outbox's
   database, the outbox's lock and the messages between tabs. */
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './browser.mjs';
import { stores } from './outbox-db.mjs';
import { ME, SAMPLES } from './samples.mjs';

// The tabs tell each other that the outbox changed, as a BroadcastChannel does.
const channels = [];
globalThis.BroadcastChannel = self.BroadcastChannel = class {
  constructor() {
    this.heard = [];
    channels.push(this);
  }
  addEventListener(type, fn) {
    this.heard.push(fn);
  }
  postMessage() {
    for (const c of channels) if (c !== this) for (const fn of c.heard) setImmediate(fn);
  }
};

// A module imported with ?tab=<name> imports the app's modules with it too, so each tab gets its own copy of them.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context),
      tab = context.parentURL && new URL(context.parentURL).searchParams.get('tab');
    return tab && r.url.includes('/src/js/') && !r.url.includes('?') ? { ...r, url: `${r.url}?tab=${tab}` } : r;
  },
});
const tab = async name => {
  const from = path => import(new URL(`${path}?tab=${name}`, import.meta.url));
  const [fake, tasks, acts, sending, outbox, runs, actions, sync, ops, messages, dates, checklists, util, fields] =
    await Promise.all(
      [
        './fake.mjs',
        ...[
          'app/tasks',
          'app/acts',
          'app/sending',
          'app/outbox',
          'app/runs',
          'app/actions',
          'sync',
          'ops/index',
          'messages',
          'dates',
          'checklists',
          'util',
          'tasks',
        ].map(p => `../../src/js/${p}.js`),
      ].map(from),
    );
  // A delete is held for Restore and sent as the app sends it (holdDelete, sendHeld), or sent at once (deleteNow).
  const deletes = Object.fromEntries(
    ['holdDelete', 'sendHeld', 'deleteNow', 'deleteOf', 'parentIdOf'].map(k => [k, actions.default[k]]),
  );
  return {
    fake,
    tasks,
    sync: sync.sync,
    uuid7: sync.uuid7,
    ops,
    messages,
    dates,
    checklists,
    util,
    fields,
    parts: [tasks, acts, sending, outbox, runs].map(m => m.default).concat(deletes),
  };
};
/* A reload opens tab R, whose modules hold nothing of the scenario, as a new page holds nothing of the page before it.
   Only the database, the lock and the messages between tabs carry over. */
const A = await tab('a'),
  B = await tab('b'),
  R = await tab('r');
const { cancelOf, OPS, opOf, refusalOf } = A.ops;
const { dayWord } = A.messages;
// What Cancel says may still be in Vikunja after an unknown answer, as in “Mop” may still be done in Vikunja.
const MAYBE = / may (?:still|already|no longer) .* in Vikunja./;
const { dayName, isSet } = A.dates;
const { PRIOS } = A.util;
const named = title => A.checklists.parseStep(title).title;

const deferred = () => {
  let resolve;
  return Object.assign(
    new Promise(ok => {
      resolve = ok;
    }),
    { resolve: v => resolve(v) },
  );
};
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise(ok => setImmediate(ok));
};
const reply = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/* What becomes of the request a state picks (x.one). Vikunja refuses it, and the relay keeps the refusal. The relay
   can't say whether Vikunja made it (unknown), though Vikunja did (arrived). The connection drops as it is sent (cut),
   or once Vikunja has made it (lost), and stays down. Or it waits until finish lets it go (held), and arrives, or
   arrives with its reply lost. */
const unknown = () =>
  reply(
    409,
    { message: 'the first request with this Idempotency-Key never finished' },
    { 'Idempotency-Unknown': 'true' },
  );
const TROUBLE = {
  refused: () => reply(403, { message: 'Forbidden' }),
  unknown,
  async arrived(send) {
    await send();
    return unknown();
  },
  cut(send, x) {
    x.down = true;
    throw new TypeError('Failed to fetch');
  },
  async lost(send, x) {
    await send();
    x.down = true;
    throw new TypeError('network error');
  },
  async held(send, x) {
    x.held.resolve();
    if ((await x.released) === 'lost') {
      await send();
      throw new TypeError('network error');
    }
    return send();
  },
};

/* Open `tab` on the outbox as the database has it, with nothing in memory, as a tab opens or reloads. Its rows come
   from Vikunja, as a screen reads them. */
async function open(tab, x) {
  const s = tab.sync,
    app = tab.fake.component(...tab.parts);
  Object.assign(app, {
    user: ME,
    pending: [],
    failed: [],
    slow: [],
    flushing: false,
    cap: { text: '' },
    capPhotos: [],
    sheet: { id: null, sub: { text: '' } },
    view: { groups: [], shownRun: null },
    places: {},
    endPlace() {},
    aimSent() {},
    aimCancelled() {},
    positionSent() {},
    positionRefused() {},
    notesRefused() {},
  });
  Object.defineProperty(app, 'toast', { value: {} });
  // The outbox is read once the component is made, since making it empties sync.entries.
  s.volatile.clear();
  s.bytes.clear();
  s.held.clear();
  s.claimed.clear();
  await s.reload();
  for (const c of await s.tx(['claims'], 'readonly', st => st('claims').getAll())) s.claimed.set(c.id, c);
  // A read lists only the subtasks that still exist, as Vikunja's does.
  const list = [...x.v.tasks.values()].map(t =>
    structuredClone({
      ...t,
      ...(t.related_tasks && {
        related_tasks: Object.fromEntries(
          Object.entries(t.related_tasks).map(([kind, ts]) => [kind, ts.filter(s => x.v.tasks.has(s.id))]),
        ),
      }),
    }),
  );
  app.change(w => w.read(list, tab.fields.TASK_REACTIONS_COMMENTS, tab.tasks.started()));
  for (const t of list) app.row(t);
  app.refreshPending();
  x.tabs.push(app);
  return app;
}

/* A scenario's world: the fake Vikunja with the sample's tasks and labels, an empty outbox, and tab A open (x.app). Every request
   fails while the connection is down (x.down). The first write of the op tried whose key x.one picks gets the TROUBLE
   x.one names, and the relay answers that key the same way from then on. */
async function world(sample) {
  for (const s of stores.values()) s.clear();
  const v = A.fake.fakeVikunja(sample.tasks.map(t => structuredClone(t))),
    send = globalThis.fetch,
    stuck = new Map();
  v.labels.push(...structuredClone(sample.labels || []));
  const x = { v, sample, tabs: [], later: [], down: false, one: null, before: vikunja(v) };
  globalThis.fetch = async (url, opts = {}) => {
    const key = opts.headers?.['Idempotency-Key']?.replaceAll('"', ''),
      what = key && x.one?.(key);
    if (x.down) throw new TypeError('Failed to fetch');
    if (stuck.has(key)) return stuck.get(key)();
    if (!what) return send(url, opts);
    x.one = null;
    if (['refused', 'unknown', 'arrived'].includes(what))
      stuck.set(key, TROUBLE[what === 'arrived' ? 'unknown' : what]);
    return TROUBLE[what](() => send(url, opts), x);
  };
  const fields = [typeof sample.fields === 'function' ? sample.fields(A.ops) : sample.fields].flat(),
    before = fields.slice(0, -1);
  x.fields = { id: A.uuid7(), ...fields.at(-1) };
  x.queue = () => (sample.queue ? sample.queue(x.app, x.fields) : x.app.actAll([...before, x.fields]));
  x.app = await open(A, x);
  return x;
}
// Pick the first write of the op tried (x.fields) sent in stage `at` (any stage when null) for `what`.
const first =
  (x, what, at = null) =>
  key => {
    const [id, stage] = key.split(':');
    return id === x.fields.id && (at === null || stage === String(at)) && what;
  };

/* The connection comes back, and every open tab sends what is waiting, at the same time, until nothing more is sent.
   `end` is what Vikunja has then. */
async function finish(x) {
  x.down = false;
  x.one = null;
  x.released?.resolve('answered');
  await x.sending;
  await Promise.all(x.later);
  for (let round = 0; round < 3; round++) {
    const open = [x.app, x.other].filter(Boolean);
    for (const app of open) app.offline = false;
    await Promise.all(open.map(app => app.flush()));
    await settle();
  }
  x.end = vikunja(x.v);
  x.answered = !x.cancelWords && !x.givenBack && !outbox().some(e => e.failed);
}

/* The states an op can be in when the user acts. Each sample's partly done states are made from the stages its
   requests are sent in (statesOf). `not` names the actions the user wouldn't take there. */
const troubled = (what, at) => async x => {
  x.one = first(x, what, at);
  await x.queue();
  x.one = null;
};
const STATES = [
  {
    name: 'unsent',
    async reach(x) {
      x.down = true;
      x.app.offline = true;
      await x.queue();
    },
  },
  {
    name: 'sending',
    async reach(x) {
      x.held = deferred();
      x.released = deferred();
      x.one = first(x, 'held');
      x.sending = x.queue();
      await x.held;
    },
  },
  { name: 'answered', reach: x => x.queue() },
  { name: 'refused', reach: troubled('refused') },
  { name: 'unknown', reach: troubled('unknown') },
  // Vikunja made it, and the change waits to be sent again.
  { name: 'reply lost', reach: troubled('lost') },
  // The user checks Vikunja, finds the change there, and doesn't tap Try again.
  { name: 'unknown, but made', reach: troubled('arrived'), not: ['Try again'] },
];
// A stage after the first that sends a request. Vikunja refuses that request, or the connection drops as it is sent.
const partly = at => [
  { name: `partly done, refused at stage ${at}`, reach: troubled('refused', at) },
  { name: `partly done, cut off at stage ${at}`, reach: troubled('cut', at) },
];
/* A stage after the first whose answer is unknown, though Vikunja made it or not. An op that makes tasks can still be
   cancelled then, and its Cancel takes back what that stage may have made. */
const unsure = at => [
  { name: `unknown at stage ${at}`, reach: troubled('unknown', at) },
  { name: `unknown, but made, at stage ${at}`, reach: troubled('arrived', at), not: ['Try again'] },
];
const statesOf = (name, sample, stages) => [
  ...STATES,
  ...(sample.cannot?.includes('partly done') ? [] : stages.slice(1).flatMap(partly)),
  ...(cancelOf({ op: sample.op ?? name }) === 'unmade' ? stages.slice(1).flatMap(unsure) : []),
];

// The Outbox's row for the op, which offers Cancel (`drop`) and Try again (`retry`) when the state allows them.
const row = x => {
  x.app.refreshPending();
  return x.app.outboxRows.find(r => r.key === x.fields.id);
};
/* Cancel records what its message says, and what Vikunja has as it is tapped. Ops queued before the op tried may
   still be waiting then, and are sent after it, so Vikunja is recorded only when nothing else waits. */
const cancel = async x => {
  const [how, ...args] = row(x).drop,
    alone = outbox().every(e => e.id === x.fields.id);
  await x.app[how](...args);
  const said = x.app.toasts.at(-1)?.msg;
  if (/^Cancelled\./.test(said)) Object.assign(x, { cancelWords: said, cancelled: alone ? vikunja(x.v) : null });
};
/* What the user does in a state, when `can` says the state offers it. `run` returns false when what it needs isn't
   there after all. */
const ACTIONS = [
  { name: 'nothing', run() {} },
  {
    name: 'Undo',
    // An op offers Undo when its invert gives one for the fields it was queued with.
    can: x => !!opOf(x.fields).invert?.(x.fields),
    run(x) {
      x.later.push(
        x.app.undoOps([x.fields]).left.then(n => {
          x.undone = n;
        }),
      );
    },
  },
  /* The user taps Undo while the op's request is on its way, and the Undo can't be sent yet. Vikunja's reply to the op
     then reaches a copy the Undo is applied over, as Replicache rebases a pending change on the server's state. */
  {
    name: 'Undo, then the reply',
    can: x => x.state === 'sending' && !!opOf(x.fields).invert?.(x.fields),
    async run(x) {
      // The fields each row shows changed while the op waits, which its apply guesses.
      const ids = Object.keys(x.before).map(Number),
        shown = new Map(
          ids.map(id => {
            const r = x.app.tasks[id] && shape(x.app.tasks[id]);
            return [id, r ? Object.keys(r).filter(k => !same(r[k], x.before[id]?.[k])) : []];
          }),
        );
      x.one = key => !key.startsWith(x.fields.id + ':') && 'cut';
      const left = x.app.undoOps([x.fields]).left;
      x.released.resolve('answered');
      await x.sending;
      x.undone = await left;
      if (!outbox().some(e => e.undo === x.fields.id)) return;
      x.midway = ids
        .flatMap(id => {
          const r = x.app.tasks[id] && shape(x.app.tasks[id]);
          return shown
            .get(id)
            .filter(k => r && !x.sample.unseen?.includes(k) && !same(r[k], x.before[id]?.[k]))
            .map(k => `${id}'s row has ${k} ${JSON.stringify(r[k])}, not ${JSON.stringify(x.before[id]?.[k])}`);
        })
        .join('; ');
    },
  },
  { name: 'Cancel', can: x => !!row(x)?.drop, run: cancel },
  {
    name: 'Cancel, then its Undo',
    can: x => !!row(x)?.drop,
    async run(x) {
      await cancel(x);
      const undo = x.app.toasts.at(-1)?.action;
      if (undo?.label !== 'Undo') return false;
      x.cancelWords = x.cancelled = null;
      await undo.fn();
    },
  },
  { name: 'Try again', can: x => !!row(x)?.retry, run: x => x.app.retryAct(x.fields.id) },
  // A reload while a request is on its way loses its reply, though Vikunja gets it.
  {
    name: 'a reload',
    async run(x) {
      x.released?.resolve('lost');
      await x.sending;
      x.app = await open(R, x);
    },
  },
  {
    name: 'a second tab',
    async run(x) {
      x.other = await open(B, x);
    },
  },
];

/* Vikunja's tasks by id, with only what a change can differ in: no times Vikunja sets itself, and the people,
   reactions, comments and related tasks as their ids or text, without a kind of relation that lists none. A row is
   compared the same way (shape). */
const shape = (t, exists = () => true) =>
  t &&
  Object.fromEntries(
    Object.entries(t)
      .filter(([k]) => !['updated', 'created', 'created_by', 'done_at'].includes(k))
      .map(([k, v]) => [
        k,
        k === 'comments'
          ? (v || []).map(c => c.comment)
          : k === 'assignees' || k === 'labels'
            ? (v || []).map(u => u.id)
            : k === 'reactions'
              ? Object.fromEntries(
                  Object.entries(v || {})
                    .filter(([, us]) => us.length)
                    .map(([m, us]) => [m, us.map(u => u.id)]),
                )
              : k === 'related_tasks'
                ? Object.fromEntries(
                    Object.entries(v || {})
                      .map(([kind, list]) => [kind, (list || []).map(s => s.id).filter(exists)])
                      .filter(([, ids]) => ids.length),
                  )
                : v,
      ]),
  );
const vikunja = v => Object.fromEntries([...v.tasks].map(([id, t]) => [id, shape(t, id => v.tasks.has(id))]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diff = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(id => !same(a[id], b[id]))
    .map(id => `${id}: ${JSON.stringify(b[id])}`)
    .join('; ');
const outbox = () => [...stores.get('outbox').values()];
// The fields of task `id` that the op changes, from the sample's run with nothing in the way.
const changes = (x, id) =>
  !x.ref.made[id] ? null : Object.keys(x.ref.made[id]).filter(k => !same(x.ref.made[id][k], x.before[id]?.[k]));
const PROBLEM = /couldn't|may not have|refused|Not sent|Not undone/;
// How a task repeats, as the sheet's Repeats list names it.
const every = t =>
  t.repeat_mode === 1
    ? 'every month'
    : ({ 86400: 'every day', 604800: 'every week', 1209600: 'every 2 weeks' }[t.repeat_after] ??
      `every ${t.repeat_after / 86400} days`);
// The names in a list such as "you and bob".
const names = list => list.split(/, | and /);
/* What Cancel's words say of a task after its title, such as "progress stays 40%", and whether Vikunja's task `t` has
   it. Words not listed here name no value of Vikunja's. */
const CLAIMS = [
  [/^title stays “(.*)”$/, (t, m) => named(t.title) === m[1]],
  [/^priority stays (.+)$/, (t, m) => PRIOS[t.priority]?.label === m[1]],
  [/^stays without a priority$/, t => !t.priority],
  [/^progress (?:stays|is) (\d+)%$/, (t, m) => Math.round(t.percent_done * 100) === +m[1]],
  [/^due date stays (.+)$/, (t, m) => isSet(t.due_date) && dayWord(dayName(t.due_date)) === m[1]],
  [/^stays without a due date$/, t => !isSet(t.due_date)],
  [/^repeat (?:stays|is) (.+)$/, (t, m) => every(t) === m[1]],
  [/^(?:stays without a|has no) repeat$/, t => !t.repeat_after && t.repeat_mode !== 1],
  [/^(?:stays|is) (done|not done)$/, (t, m) => t.done === (m[1] === 'done')],
  [/^(?:stays|is) (finished|open)$/, (t, m) => t.done === (m[1] === 'finished')],
  [/^stays unassigned$/, t => !t.assignees.length],
  [
    /^stays assigned to (.+)$/,
    (t, m) => names(m[1]).length === t.assignees.length && names(m[1]).includes('you') === t.assignees.includes(ME.id),
  ],
  [/^labels stay (.+)$/, (t, m) => names(m[1]).length === t.labels.length],
  [/^has no labels$/, t => !t.labels.length],
  [/^stays in Vikunja$/, t => !!t],
  [/^is deleted$/, t => !t],
  [/^(?:stays|is) a subtask of “(.+)”$/, (t, m, id) => t.related_tasks?.parenttask?.includes(id(m[1]))],
  [/^(?:isn't|is no longer) a subtask of “(.+)”$/, (t, m, id) => !t.related_tasks?.parenttask?.includes(id(m[1]))],
];

/* The rules every scenario keeps. Each returns what broke it, or nothing. */
const RULES = [
  [
    'each request reaches Vikunja at most once for each key',
    x => {
      const n = new Map();
      for (const r of x.v.requests) if (r.key && !r.replayed) n.set(r.key, (n.get(r.key) || 0) + 1);
      return [...n]
        .filter(([, k]) => k > 1)
        .map(([key]) => `sent twice: ${key}`)
        .join('; ');
    },
  ],
  [
    "a change the user didn't take back is made exactly once, or waits in the Outbox",
    x => {
      if (
        x.cancelWords ||
        x.undone !== undefined ||
        x.givenBack ||
        same(x.end, x.ref.made) ||
        outbox().some(e => e.failed)
      )
        return;
      return `Vikunja has ${diff(x.ref.made, x.end) || 'it'}, not what the op makes, and the Outbox has ${outbox().length} entries`;
    },
  ],
  [
    'Cancel sends nothing more',
    x => x.cancelled && !same(x.end, x.cancelled) && `Vikunja has ${diff(x.cancelled, x.end)}`,
  ],
  /* x.ref.nothingKept is what Cancel says of the op before anything is sent. Cancel may say it only when Vikunja has
     none of the change, and must say it then, unless it says what may still be in Vikunja. */
  [
    'Cancel leaves Vikunja as it was before the op, unless its words say what Vikunja keeps',
    x =>
      x.cancelWords === x.ref.nothingKept &&
      !same(x.end, x.before) &&
      `Cancel said “${x.cancelWords}”, and Vikunja has ${diff(x.before, x.end)}`,
  ],
  [
    "Cancel's words say what Vikunja keeps",
    x =>
      x.cancelWords &&
      x.cancelWords !== x.ref.nothingKept &&
      !MAYBE.test(x.cancelWords) &&
      same(x.end, x.before) &&
      `Cancel said “${x.cancelWords}”, and Vikunja has none of the change`,
  ],
  /* Each value Cancel's words name, as Vikunja has it when Cancel is tapped. Only checked when nothing else waits, so
     that Vikunja then is known (x.cancelled). A task is found by its title. */
  [
    "Cancel's words name the values Vikunja has",
    x => {
      if (!x.cancelled) return;
      const id = title => x.sample.tasks.find(t => named(t.title) === title)?.id,
        wrong = [];
      for (const [said, title, rest] of x.cancelWords.matchAll(/“([^”]+)” ([^.]+)\./g)) {
        const claim = CLAIMS.find(([re]) => re.test(rest));
        if (!claim || id(title) === undefined) continue;
        const t = x.cancelled[id(title)];
        if (!(t ? claim[1](t, rest.match(claim[0]), id) : rest === 'is deleted'))
          wrong.push(`said ${said} Vikunja has ${JSON.stringify(t)}`);
      }
      return wrong.join('; ');
    },
  ],
  ['a reply that arrives after its Undo shows the task as before the op while the Undo waits', x => x.midway],
  [
    'Undo puts back what the op changed',
    x =>
      x.undone !== undefined &&
      (x.undone || !same(x.end, x.before)) &&
      `${x.undone} left alone, and Vikunja has ${diff(x.before, x.end) || 'what it had'}`,
  ],
  [
    "each row is Vikunja's copy with the waiting ops",
    x => {
      const out = [],
        open = [x.app, x.other].filter(Boolean);
      for (const app of open)
        for (const id of Object.keys(x.before).map(Number)) {
          const waiting = outbox()
              .filter(e => e.kind === 'act' && !e.failed && !(e.until > Date.now()) && opOf(e).on(e).includes(id))
              .map(e => e.id),
            r = app.tasks[id];
          if (
            !same(
              app.opsOf(id).map(e => e.id),
              waiting,
            )
          )
            out.push(`${id} shows ${app.opsOf(id).length} ops, and ${waiting.length} wait`);
          if (r && !same(shape(r), { ...shape(r), ...shape(app.shownAs(id)) }))
            out.push(`${id}'s row is not its copy with its ops`);
          /* Only the tab that sent the op has Vikunja's answer to every request. Another tab, and a tab whose op Vikunja
         refused partway or may not have, reads Vikunja's copy later. */
          if (x.other || waiting.length || !x.answered) continue;
          const ks = changes(x, id)?.filter(k => !x.sample.unseen?.includes(k));
          if (!x.end[id] && r) out.push(`${id} is deleted, and its row stays`);
          else if (r && ks)
            for (const k of ks.filter(k => !same(shape(r)[k], x.end[id][k])))
              out.push(
                `${id}'s row has ${k} ${JSON.stringify(shape(r)[k])}, and Vikunja ${JSON.stringify(x.end[id][k])}`,
              );
        }
      return out.join('; ');
    },
  ],
  [
    'a message about a problem offers a way forward, unless nothing is left to do',
    x => {
      if (!outbox().some(e => e.failed)) return;
      const bad = x.tabs
        .flatMap(app => app.toasts)
        .filter(
          m =>
            (m.cls === 'failed' || PROBLEM.test(m.msg)) && !['Outbox', 'Try again', 'Undo'].includes(m.action?.label),
        );
      return bad.map(m => `“${m.msg}”`).join('; ');
    },
  ],
  [
    'nothing stays in the Outbox without being marked failed',
    x =>
      outbox()
        .filter(e => !e.failed && !(e.until > Date.now()))
        .map(e => `${e.op || 'files'} at stage ${e.stage}`)
        .join('; '),
  ],
];

/* The sample's op sent with nothing in the way: what Vikunja has then (`made`), and the stages that sent a request. And
   what Cancel says of the op before anything is sent (`nothingKept`), and what Vikunja has once the ops queued before
   it are sent without it (`before`). */
async function reference(sample) {
  const x = await world(sample);
  await x.queue();
  await finish(x);
  assert.ok(sample.made(x.v), `the sample makes its change: ${diff(x.before, x.end)}`);
  assert.deepEqual(outbox(), [], 'the outbox is empty once it is sent');
  const keys = x.v.requests.filter(r => r.key?.startsWith(x.fields.id + ':')).map(r => +r.key.split(':')[1]);
  const y = await world(sample);
  await STATES[0].reach(y);
  await cancel(y);
  assert.ok(y.cancelWords, 'Cancel takes back the op before anything is sent');
  await finish(y);
  return { made: x.end, stages: [...new Set(keys)], nothingKept: y.cancelWords, before: y.end };
}

test('every op in OPS has a sample', () => {
  const tried = new Set(Object.entries(SAMPLES).map(([name, s]) => s.op ?? name));
  assert.deepEqual(
    Object.keys(OPS).filter(name => !tried.has(name)),
    [],
    'a new op needs a sample in SAMPLES',
  );
});

/* Bugs this test found whose fix would change what the user sees or need new words, listed until that is decided. Each
   entry excuses one rule (`rule`, its name in RULES) for the sample named `sample`, in the states that `state` matches,
   after `action` (any action when left out). t.diagnostic names each scenario it excuses. An entry that no scenario
   needs any more fails the test, so it is removed once the bug is fixed. */
const KNOWN = [
  {
    sample: 'startRun',
    rule: 'Undo puts back what the op changed',
    state: /^unknown, but made(, at stage [25])?$/,
    action: 'Undo',
    why: "the relay can't say whether Vikunja made a copy, of the template or of a step, so the start's Undo can't find the copy to delete it",
  },
];

for (const [name, sample] of Object.entries(SAMPLES))
  test(`${name} passes the lifecycle checks`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ref = await reference(sample),
      several = ref.stages.length > 1;
    assert.equal(
      !sample.cannot?.includes('partly done'),
      several,
      several
        ? `${name} sends requests in several stages, so it can be partly done`
        : `${name} sends its requests in one stage, so its sample says it can't be partly done`,
    );
    const failures = [],
      known = KNOWN.filter(k => k.sample === name),
      seen = new Set();
    for (const state of statesOf(name, sample, ref.stages))
      for (const action of ACTIONS) {
        if (state.not?.includes(action.name)) continue;
        const x = await world(sample);
        Object.assign(x, { ref, before: ref.before, state: state.name });
        await state.reach(x);
        x.givenBack = state.name === 'refused' && refusalOf(x.fields) !== 'kept';
        if ((action.can && !action.can(x)) || (await action.run(x)) === false) {
          await finish(x);
          continue;
        }
        await finish(x);
        for (const [rule, check] of RULES) {
          const broke = check(x);
          if (!broke) continue;
          const said = `${state.name}, then ${action.name}: ${rule}. ${broke}`,
            k = known.find(k => k.rule === rule && k.state.test(state.name) && (!k.action || k.action === action.name));
          if (!k) failures.push(said);
          else {
            seen.add(k);
            t.diagnostic(`known: ${said} (${k.why})`);
          }
        }
      }
    for (const k of known)
      if (!seen.has(k))
        failures.push(`no scenario breaks "${k.rule}" any more for the KNOWN bug "${k.why}". Remove it from KNOWN.`);
    assert.deepEqual(failures, []);
  });
