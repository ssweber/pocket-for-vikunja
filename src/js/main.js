// Where Pocket's code starts: the build bundles this file, and everything it imports, into the page.
import {andList, colorOf, fmtSize, grow, PRIOS, taskDrafts, ZERO} from './util.js';
import {INSTALLED} from './api.js';
import {dueInfo, fromLocalInput, isSet, toLocalInput} from './dates.js';
import {RICH, sanitize} from './html.js';
import {addedText, durText} from './checklists.js';
import {runTitle} from './sync.js';
import core from './app/core.js';
import auth from './app/auth.js';
import views from './app/views.js';
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

// The markup's Alpine expressions use these by name, so they have to be globals.
Object.assign(window, {addedText, andList, colorOf, durText, dueInfo, fmtSize, fromLocalInput, grow, INSTALLED, isSet, PRIOS, RICH, runTitle, sanitize, taskDrafts,
  toLocalInput, ZERO});

// Alpine's component is one object: the data from core.js, with the methods of each part of the app. Getters are
// copied as getters (a spread, {...auth}, would read each one once and keep the value), so they still work out what
// they show each time they're read.
const parts = [auth, views, actions, progress, quickadd, sending, checklists, runs, claims, alerts, sheet, toast, outbox];
document.addEventListener('alpine:init', () => Alpine.data('pocket', () => {
  const component = core();
  for (const part of parts) Object.defineProperties(component, Object.getOwnPropertyDescriptors(part));
  return component;
}));
