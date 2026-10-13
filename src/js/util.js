// Small helpers used all over Pocket, and what Pocket keeps on the phone in localStorage.

export const store = {
  get(k){ try{ return localStorage.getItem('pocket.'+k) }catch{ return null } },
  set(k,v){ try{ localStorage.setItem('pocket.'+k,v) }catch{} },
  del(k){ try{ localStorage.removeItem('pocket.'+k) }catch{} },
};
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const ZERO = '0001-01-01T00:00:00Z';
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const colorOf = hex => /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex || '') ? '#' + hex.replace('#','') : 'var(--muted)';
export const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/;
export const mimeOf = t => String(t || '').split(';')[0].trim().toLowerCase();
// Vikunja's upload limit as /info states it ("20MB"), in bytes. Null if it doesn't say.
export function sizeLimit(text){
  const m = String(text || '').trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?)B?$/i);
  return m ? +m[1] * {'': 1, K: 1024, M: 1048576, G: 1073741824}[m[2].toUpperCase()] : null;
}
export const fmtSize = n => !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(0) + ' KB' : (n/1048576).toFixed(1) + ' MB';
// Join words as a sentence, with commas between items and "and" before the last.
export const andList = words => words.length < 2 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
export const PRIOS = [{n:0,label:'No priority'},{n:1,label:'Low'},{n:2,label:'Medium'},{n:3,label:'High'},{n:4,label:'Urgent'},{n:5,label:'Do now'}];
/* Fit a text box to its text, so nothing scrolls inside it: scrollHeight plus the borders, which scrollHeight leaves
   out. A hidden box measures 0, so its height is left alone. Measuring shrinks the box to its least height first,
   which for long notes in a sheet is far shorter, and the sheet would lose its scroll position, so that position is
   put back. The page's position is put back too, for a box in the page: a checklist's box at the foot of its steps is
   where the page ends, so each letter typed past the first line pulled the page down and the text went under the
   keyboard (in Safari, which doesn't hold the page still itself). */
export const grow = ta => {
  const sc = ta.closest('#sheet .scroll'), top = sc ? sc.scrollTop : typeof scrollY === 'number' ? scrollY : null;
  ta.style.height = 'auto';
  if (ta.scrollHeight) ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + 'px';
  if (sc) { if (sc.scrollTop !== top) sc.scrollTop = top; } else if (top !== null && scrollY !== top) scrollTo(scrollX, top);
};
export const cache = new Map();                       // task id -> latest task from the server
/* Text written and not yet sent, kept on the phone so closing Pocket doesn't lose it. Keys: 'comment:<task id>',
   'sub:<task id>', 'desc:<task id>' (notes not saved yet), 'run' (notes on runs and steps, by task id),
   'newtpl:<project id>' and 'addsteps:<task id>' (steps being written). Cleared on a chosen sign-out, kept through a
   session that expires for when the same person is back. */
export const taskDrafts = {
  all(){ try { return JSON.parse(store.get('drafts')) || {}; } catch { return {}; } },
  get(k){ return this.all()[k]; },
  set(k, v){
    const a = this.all(), empty = v == null || (typeof v === 'string' ? !v.trim() : typeof v === 'object' && !Object.values(v).some(x => typeof x === 'string' ? x.trim() : x));
    if (empty) delete a[k]; else a[k] = v;
    store.set('drafts', JSON.stringify(a));
  },
  delete(k){ this.set(k, null); },
  clear(){ store.del('drafts'); },
};
export const userCache = new Map();                   // lowercased username -> user
// The plain object behind one Alpine watches, so reads of it aren't tracked. Without Alpine (the unit tests), the
// object itself.
export const raw = x => globalThis.Alpine?.raw(x) ?? x;
/* Cache a getter's value until something it read changes. For a getter that many bindings read and that costs
   something (a run's screen reads runView about 45 times per draw). `fn` runs inside an Alpine effect, which records
   what it reads. When any of that changes the value goes stale at once, not a moment later when Alpine runs its
   effects, so whatever reads it straight after a change gets a fresh one. Earlier readers are told to read again
   through `rev`. That needs the effect's own scheduler, which Alpine's `effect` doesn't expose:
   tests/unit/alpine.test.mjs checks it against Pocket's copy of Alpine, so an upgrade that changes it fails there.
   Without Alpine (the unit tests), the getter runs each time. */
export function memo(fn){
  let old = true, value, run = null, rev = null;
  return function(){
    const A = globalThis.Alpine;
    if (!A) return fn.call(this);
    if (old) {
      if (run) A.release(run);
      rev ||= A.reactive({n: 0});
      old = false;
      try { run = A.effect(() => { value = fn.call(this); }); }
      catch (e) { old = true; run = null; throw e; }
      run.effect.scheduler = () => { if (!old) { old = true; rev.n++; } };
    }
    void rev.n;                                        // read here, so this reader runs again once the value is stale
    return value;
  };
}
export let app;                                       // the Alpine component, set in init()
export const setApp = a => { app = a; };
/* Whether things may animate. False when the phone asks for less motion (prefers-reduced-motion): then a change is
   shown with no slide, fold or fade. Every animation from code asks here. The stylesheet has its own @media rule. */
export const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
// Collapse a list row before it's removed, so a ticked task slides away instead of vanishing.
export async function collapse(el){
  if (!el || !el.isConnected || !motion()) return;
  el.style.overflow = 'hidden';
  await el.animate([{height: el.offsetHeight + 'px', opacity: 1}, {height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px'}],
    {duration: 220, easing: 'ease-in', fill: 'forwards'}).finished.catch(() => {});
}
/* Rows gone from a freshly loaded list fold away like ticked rows, but only when few are on screen. More than FOLD_FEW
   at once, or rows off screen, simply go. Every row is measured before any is changed, so the page is laid out once,
   not once per row (3.5 s for 2,000 rows). */
export const FOLD_FEW = 8;
export async function collapseRows(els){
  if (!motion()) return;
  const shown = els.filter(el => el.isConnected).map(el => ({el, r: el.getBoundingClientRect(), h: el.offsetHeight}))
    .filter(({r}) => r.height && r.bottom > 0 && r.top < innerHeight);
  if (shown.length > FOLD_FEW) return;
  await Promise.all(shown.map(({el, h}) => {
    el.style.overflow = 'hidden';
    return el.animate([{height: h + 'px', opacity: 1}, {height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px'}],
      {duration: 220, easing: 'ease-in', fill: 'forwards'}).finished.catch(() => {});
  }));
}
