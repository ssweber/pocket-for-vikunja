/* Just enough of a DOM to read and write the notes Pocket writes itself: paragraphs, line breaks and text. Its HTML is
   what Chrome's innerHTML gives for the same nodes. Any other tag or entity throws, so a test can't silently read HTML
   it doesn't understand. Notes from Vikunja's editor are read in the browser tests (tests/parse.mjs). */
const TAGS = new Set(['div', 'p', 'br']),
  EMPTY = new Set(['br']),
  ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' };

class Node {
  parentNode = null;
  get parentElement() {
    return this.parentNode;
  }
  get nextSibling() {
    const list = this.parentNode?.childNodes;
    return list?.[list.indexOf(this) + 1] ?? null;
  }
  get previousSibling() {
    const list = this.parentNode?.childNodes;
    return list?.[list.indexOf(this) - 1] ?? null;
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
}
class Text extends Node {
  nodeType = 3;
  nodeName = '#text';
  constructor(value, doc) {
    super();
    this.nodeValue = value;
    this.ownerDocument = doc;
  }
  get textContent() {
    return this.nodeValue;
  }
}
class Element extends Node {
  nodeType = 1;
  childNodes = [];
  constructor(tag, doc) {
    super();
    if (!TAGS.has(tag)) throw new Error(`the unit tests' DOM has no <${tag}> (test it in tests/parse.mjs)`);
    Object.assign(this, {
      localName: tag,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      ownerDocument: doc,
    });
  }
  get children() {
    return this.childNodes.filter(n => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  append(...nodes) {
    for (const n of nodes) {
      n.remove();
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  get textContent() {
    return this.childNodes.map(n => n.textContent).join('');
  }
  set textContent(text) {
    for (const n of [...this.childNodes]) n.remove();
    if (text) this.append(new Text(text, this.ownerDocument));
  }
  // Only a tag name, or a list of them, is understood as a selector.
  closest(sel) {
    const tags = sel.split(',').map(s => s.trim());
    for (let n = this; n; n = n.parentNode) if (tags.includes(n.localName)) return n;
    return null;
  }
  querySelector(sel) {
    const tags = sel.split(',').map(s => s.trim()),
      find = el => el.children.find(c => tags.includes(c.localName)) ?? el.children.map(find).find(Boolean) ?? null;
    return find(this);
  }
  getAttribute() {
    return null;
  }
  hasAttribute() {
    return false;
  }
  get innerHTML() {
    const out = n =>
      n.nodeType === 3
        ? n.nodeValue.replace(/[&<>\u00a0]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\u00a0': '&nbsp;' })[c])
        : EMPTY.has(n.localName)
          ? `<${n.localName}>`
          : `<${n.localName}>${n.innerHTML}</${n.localName}>`;
    return this.childNodes.map(out).join('');
  }
  set innerHTML(html) {
    for (const n of [...this.childNodes]) n.remove();
    const open = [this],
      doc = this.ownerDocument;
    for (const part of (html || '').split(/(<[^>]*>)/).filter(Boolean)) {
      if (!part.startsWith('<')) {
        const bad = part.match(/&(?!(amp|lt|gt|quot|#39|nbsp);)\S*/);
        if (bad) throw new Error(`the unit tests' DOM can't read ${bad[0]}`);
        open.at(-1).append(
          new Text(
            part.replace(/&([a-z]+|#39);/g, (m, e) => ENTITIES[e]),
            doc,
          ),
        );
        continue;
      }
      const [, close, tag] = part.match(/^<(\/?)([a-z0-9]+)\s*\/?>$/i) || [];
      if (!tag) throw new Error(`the unit tests' DOM can't read ${part}`);
      if (close) {
        if (open.at(-1).localName !== tag.toLowerCase()) throw new Error(`</${tag}> closes nothing open in ${html}`);
        open.pop();
      } else {
        const el = new Element(tag.toLowerCase(), doc);
        open.at(-1).append(el);
        if (!EMPTY.has(el.localName)) open.push(el);
      }
    }
    if (open.length > 1) throw new Error('an unclosed tag in ' + html);
  }
}

export const doc = {
  createElement: tag => new Element(tag, doc),
  createTextNode: text => new Text(text, doc),
  // The text nodes under `root`, in order, as a walker over NodeFilter.SHOW_TEXT gives them.
  createTreeWalker(root) {
    const texts = [],
      walk = el => el.childNodes.forEach(n => (n.nodeType === 3 ? texts.push(n) : walk(n)));
    walk(root);
    let i = 0;
    return { nextNode: () => texts[i++] ?? null };
  },
};
