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
export const PRIOS = [{n:0,label:'No priority'},{n:1,label:'Low'},{n:2,label:'Medium'},{n:3,label:'High'},{n:4,label:'Urgent'},{n:5,label:'Do now'}];
// Fit a text box to its text. A hidden box measures 0, so leave its height alone until it can be measured.
export const grow = ta => { ta.style.height = 'auto'; if (ta.scrollHeight) ta.style.height = ta.scrollHeight + 'px'; };
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
export let app;                                       // the Alpine component, set in init()
export const setApp = a => { app = a; };
/* Collapse a list row before it's removed, so ticked-off tasks slide away instead of vanishing. */
export async function collapse(el){
  if (!el || !el.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.style.overflow = 'hidden';
  await el.animate([{height: el.offsetHeight + 'px', opacity: 1}, {height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px'}],
    {duration: 220, easing: 'ease-in', fill: 'forwards'}).finished.catch(() => {});
}
