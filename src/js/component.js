// The Alpine component, `pocket`, and the helpers its markup uses by name. main.js registers them for Pocket's page;
// the specimen page (scripts/specimen/) makes a component of its own from them, with made-up tasks.
import {andList, colorOf, fmtSize, grow, PRIOS, taskDrafts, ZERO} from './util.js';
import {INSTALLED} from './api.js';
import {dueInfo, fromLocalInput, isSet, toLocalInput} from './dates.js';
import {RICH, sanitize} from './html.js';
import {addedText, durText} from './checklists.js';
import {runTitle} from './sync.js';
import {rowGestures} from './lists.js';
import core from './app/core.js';
import auth from './app/auth.js';
import views from './app/views.js';
import tasks from './app/tasks.js';
import actions from './app/actions.js';
import progress from './app/progress.js';
import quickadd from './app/quickadd.js';
import sending from './app/sending.js';
import checklists from './app/checklists.js';
import runs from './app/runs.js';
import claims from './app/claims.js';
import alerts from './app/alerts.js';
import sheet from './app/sheet.js';
import toast from './app/toast.js';
import outbox from './app/outbox.js';
import lines from './app/lines.js';
import leaving from './app/leaving.js';
import sharing from './app/sharing.js';
import cards from './app/cards.js';


// The markup's Alpine expressions use these by name, so they have to be globals (main.js makes them so).
export const globals = {addedText, andList, colorOf, durText, dueInfo, fmtSize, fromLocalInput, grow, INSTALLED, isSet, PRIOS, RICH, rowGestures, runTitle, sanitize,
  taskDrafts, toLocalInput, ZERO};

/* x-style="{'--pct': .5, paddingLeft: '18px'}": what :style does with an object, without the timer Alpine starts each
   time it works one out (to drop a style attribute left empty). A list's rows are worked out again on every change to
   it, so that was hundreds of timers at once: nothing to a browser, but seconds under the tests' clock, which runs
   timers one at a time. npm run lint keeps :style to strings. */
export const directives = Alpine => Alpine.directive('style', (el, {expression}, {evaluateLater, effect}) => {
  const get = evaluateLater(expression);
  effect(() => get(o => { for (const [k, v] of Object.entries(o || {})) el.style.setProperty(k.startsWith('--') ? k : k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v); }));
});

// Alpine's component is one object: the data from core.js, with the methods of each part of the app. Getters are
// copied as getters (a spread, {...auth}, would read each one once and keep the value), so they still work out what
// they show each time they're read.
const parts = [auth, views, tasks, actions, progress, quickadd, sending, checklists, runs, claims, alerts, sheet, toast, outbox, lines, leaving, sharing, cards];
export const pocket = () => {
  const component = core();
  for (const part of parts) Object.defineProperties(component, Object.getOwnPropertyDescriptors(part));
  return component;
};
