/* Errors in Pocket's own code. Without this, a tap that hits one does nothing, and nothing says why. Pocket says so
   with Reload, and keeps the last few on the phone so the account sheet can copy them. Nothing is sent anywhere. */
import { saved } from '../lists.js';
import { BROKE, COPIED } from '../messages.js';

const KEEP = 10, // errors kept
  AGE = 7 * 86400000, // how long an error is kept
  QUIET_MS = 10000; // the shortest time between two messages, so a run of errors says so once
let saidAt = 0;

// The errors saved on the phone that are recent enough to keep.
export const keptErrors = (list = saved.get('errors')) =>
  (Array.isArray(list) ? list : []).filter(x => Date.now() - x.at < AGE).slice(-KEEP);

/* The Error in an `error` or `unhandledrejection` event, if Pocket's code threw it. A browser extension's script is
   another file, and the browser's own reports (a ResizeObserver loop) name no file and carry no Error. */
export function ownError(e) {
  if (e.type === 'unhandledrejection') return e.reason instanceof Error ? e.reason : null;
  return e.error instanceof Error && e.filename?.startsWith(location.origin) ? e.error : null;
}

export default {
  watchErrors() {
    const heard = e => {
      const err = ownError(e);
      try {
        if (err) this.noteError(err);
      } catch {} // a failure here must not raise another error event
    };
    window.addEventListener('error', heard);
    window.addEventListener('unhandledrejection', heard);
  },
  noteError(err) {
    const now = Date.now();
    this.errors = keptErrors([
      ...this.errors,
      { at: now, where: location.hash, msg: String(err), stack: String(err.stack || '').slice(0, 1500) },
    ]);
    saved.set('errors', this.errors);
    if (now - saidAt < QUIET_MS) return;
    saidAt = now;
    this.notify(BROKE.msg, { label: BROKE.reload, fn: () => location.reload() });
  },
  // The saved errors as text to paste into a bug report, with the version, the build and the browser.
  errorsText() {
    const build = document.querySelector('meta[name="pocket-build"]')?.content || '?';
    return [
      `Pocket ${this.info?.version || '?'}, build ${build}`,
      navigator.userAgent,
      ...this.errors.map(x => `\n${new Date(x.at).toISOString()} ${x.where}\n${x.msg}\n${x.stack}`),
    ].join('\n');
  },
  copyErrors() {
    return this.copyOut(this.errorsText(), 'sheet:top', COPIED.errors);
  },
};
