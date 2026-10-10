// Small helpers used all over Pocket, and what it keeps on the phone in localStorage.

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
// Vikunja's upload limit as it states it in /info ("20MB"), in bytes; null if it doesn't say.
export function sizeLimit(text){
  const m = String(text || '').trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?)B?$/i);
  return m ? +m[1] * {'': 1, K: 1024, M: 1048576, G: 1073741824}[m[2].toUpperCase()] : null;
}
export const fmtSize = n => !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(0) + ' KB' : (n/1048576).toFixed(1) + ' MB';
// Words in a list as a sentence has them: "you", "you and Jo", "you, Jo and Priya".
export const andList = words => words.length < 2 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
export const PRIOS = [{n:0,label:'No priority'},{n:1,label:'Low'},{n:2,label:'Medium'},{n:3,label:'High'},{n:4,label:'Urgent'},{n:5,label:'Do now'}];
/* Fit a text box to its text: as tall as what's in it and its borders, which scrollHeight leaves out, so nothing is
   left to scroll inside it. A hidden box measures 0, so leave its height alone until it can be measured. It's measured
   at its least height first, which, for long notes in a sheet, is far shorter: the sheet would lose its place (its
   end pulled up past where it was scrolled to), so it's put back where it was. */
export const grow = ta => {
  const sc = ta.closest('#sheet .scroll'), top = sc?.scrollTop;
  ta.style.height = 'auto';
  if (ta.scrollHeight) ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + 'px';
  if (sc && sc.scrollTop !== top) sc.scrollTop = top;
};
export const cache = new Map();                       // task id -> latest task from the server
/* What was being written and not sent yet, kept on the phone so closing Pocket doesn't lose it: 'comment:<task id>',
   'sub:<task id>', 'desc:<task id>' (notes not saved yet), 'run' (notes on runs and steps, by task id), 'newtpl:<project
   id>' and 'addsteps:<task id>' (steps being written). Cleared on a sign-out you choose, and kept through a session
   that ends for when the same person is back. */
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
// An object Alpine watches, as it is: read without Alpine noting each read (in Node's tests, there's no Alpine).
export const raw = x => globalThis.Alpine?.raw(x) ?? x;
export let app;                                       // the Alpine component, set in init()
export const setApp = a => { app = a; };
/* Collapse a list row before it's removed, so ticked-off tasks slide away instead of vanishing. */
export async function collapse(el){
  if (!el || !el.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.style.overflow = 'hidden';
  await el.animate([{height: el.offsetHeight + 'px', opacity: 1}, {height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px'}],
    {duration: 220, easing: 'ease-in', fill: 'forwards'}).finished.catch(() => {});
}
/* Rows gone from a list loaded afresh (settle) fold away as ticked rows do, but only a few, on the screen: with more
   than FOLD_FEW there at once, or off it, they simply go. Every row is measured before any is changed, so the page is
   laid out once, not once a row (3.5 s for 2,000 rows). */
export const FOLD_FEW = 8;
export async function collapseRows(els){
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const shown = els.filter(el => el.isConnected).map(el => ({el, r: el.getBoundingClientRect(), h: el.offsetHeight}))
    .filter(({r}) => r.height && r.bottom > 0 && r.top < innerHeight);
  if (shown.length > FOLD_FEW) return;
  await Promise.all(shown.map(({el, h}) => {
    el.style.overflow = 'hidden';
    return el.animate([{height: h + 'px', opacity: 1}, {height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px'}],
      {duration: 220, easing: 'ease-in', fill: 'forwards'}).finished.catch(() => {});
  }));
}
