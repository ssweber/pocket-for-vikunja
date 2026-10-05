// Task notes and comments: HTML from Vikunja, made safe to show, and plain text.
import {esc} from './util.js';

// Task notes and comments are HTML written by anyone who shares the project, so only a small set of
// formatting tags survives. Alpine runs directives found in x-html content, so attributes are stripped too.
const XHTML = 'http://www.w3.org/1999/xhtml';
const ALLOWED = new Set(['p','br','b','strong','i','em','u','s','del','ul','ol','li','a','code','pre','blockquote','h1','h2','h3','h4','h5','h6','span','div','mark','hr','table','thead','tbody','tr','td','th']);
const DROPPED = new Set(['script','style','iframe','frame','frameset','object','embed','template','form','input','label','textarea','select','button','noscript','link','meta','base','title']);
// Parse in an inert document: nothing loads or runs, and <frameset> can't replace the body.
export function parseFragment(html){
  const root = document.implementation.createHTMLDocument('').createElement('div');
  root.innerHTML = html || '';
  return root;
}
// Only absolute http(s) and mailto links, written back in normalized form.
function safeHref(v){
  try { const u = new URL((v || '').trim()); return /^(https?|mailto):$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
}
export function sanitize(html){
  const root = parseFragment(html);
  (function clean(el){
    let n = el.firstChild;
    while (n) {
      if (n.nodeType === 3) { n = n.nextSibling; continue; }
      const tag = n.nodeType === 1 && n.namespaceURI === XHTML ? n.localName : '';   // SVG/MathML count as unknown
      if (!ALLOWED.has(tag)) {
        if (tag === 'img') { const t = n.ownerDocument.createTextNode('[image]'); n.replaceWith(t); n = t.nextSibling; continue; }
        if (!tag || DROPPED.has(tag)) { const next = n.nextSibling; n.remove(); n = next; continue; }
        // Unknown HTML tag: keep its contents in place and carry on from the first of them.
        const next = n.firstChild || n.nextSibling; n.replaceWith(...n.childNodes); n = next; continue;
      }
      for (const a of [...n.attributes]) {
        const keep = (tag === 'a' && a.name === 'href' && safeHref(a.value))
          || (a.name === 'data-type' && a.value === 'taskList') || (a.name === 'data-checked' && /^(true|false)$/.test(a.value));
        if (!keep) n.removeAttribute(a.name);
      }
      if (tag === 'a') {
        if (n.hasAttribute('href')) n.setAttribute('href', safeHref(n.getAttribute('href')));
        n.setAttribute('target','_blank'); n.setAttribute('rel','noopener noreferrer');
      }
      clean(n);
      n = n.nextSibling;
    }
  })(root);
  return root.innerHTML;
}
export function htmlToText(html){
  const root = parseFragment(html); let out = '';
  (function walk(el, depth){
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (/^(SCRIPT|STYLE|TEMPLATE|IFRAME|OBJECT|SVG)$/.test(t)) continue;
      if (t === 'BR') { out += '\n'; continue; }
      if (t === 'LI') { out += '- ' + (n.getAttribute('data-checked') === 'true' ? '[x] ' : n.hasAttribute('data-checked') ? '[ ] ' : ''); walk(n, depth+1); out = out.replace(/\n*$/,'') + '\n'; continue; }
      walk(n, depth+1);
      if (/^(P|DIV|H[1-6]|BLOCKQUOTE|PRE|UL|OL|TR)$/.test(t)) out = out.replace(/\n*$/,'') + '\n\n';
    }
  })(root, 0);
  return out.replace(/\u00a0/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
export const RICH = /<(ul|ol|a |table|pre|code|h[1-6]|blockquote|img|strong|em|b>|i>)/i;
export function textToHtml(text){
  return text.trim().split(/\n{2,}/).map(p => '<p>' + esc(p).replace(/\n/g,'<br>') + '</p>').join('');
}
