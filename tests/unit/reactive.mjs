// Alpine's reactivity for a unit test: the part of Pocket's own copy of Alpine (src/vendor/) that watches data, run
// as it is, behind a pretend `Alpine` with what Pocket's code asks of the real one (reactive, effect, release, raw).
// An effect whose data changed runs when the test says (flush()), as Alpine runs them a moment later, together.
//
//   const { Alpine, flush } = watching(c);        // from now until the test ends, globalThis.Alpine is this one
//   const data = Alpine.reactive({ n: 1 });
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url), read = path => readFileSync(new URL(path, root), 'utf8');
const lib = read('src/index.html').match(/src="(alpine-[^"]+)-pocket\.\d+\.min\.js"/)[1], vendor = read(`src/vendor/${lib}.js`);
const from = vendor.indexOf('  // node_modules/@vue/shared/dist/shared.esm-bundler.js'), to = vendor.indexOf('  // packages/alpinejs/src/magics/$nextTick.js');
if (from < 0 || to < from) throw new Error('Alpine has changed: its reactivity is no longer where reactive.mjs looks for it');
const engine = new Function(vendor.slice(from, to) + '; return {reactive: reactive2, effect: effect2, stop, toRaw};')();

export function watching(c){
  const queued = new Set();
  // As Alpine sets its engine up (setReactivityEngine, and the wrapper its cdn build gives it): an effect whose data
  // changed is queued, not run.
  const effect = callback => { const runner = engine.effect(callback, { scheduler: () => { if (runner) queued.add(runner); } }); return runner; };
  const Alpine = { reactive: engine.reactive, effect, release: runner => { queued.delete(runner); engine.stop(runner); }, raw: engine.toRaw };
  globalThis.Alpine = Alpine;
  c.after(() => { delete globalThis.Alpine; });
  return { Alpine, flush(){ while (queued.size) { const run = [...queued]; queued.clear(); for (const r of run) r(); } } };
}
