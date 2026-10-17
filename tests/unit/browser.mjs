// A minimal fake browser, just enough for Pocket's modules to load in Node and run the unit tests. Each test file
// imports it first, before anything from src/, because api.js and sync.js read these globals as they load.
//
// There is no DOM. Parsing HTML (a task's notes or a comment) is covered by the browser tests (tests/parse.mjs), so a
// task's description must be empty here. Any other HTML throws an error, so a test can't silently read it as empty.

globalThis.self = {}; // no BroadcastChannel, because an open one keeps Node running
globalThis.matchMedia = () => ({ matches: false });
globalThis.location = { origin: 'http://pocket.test', hash: '' };
globalThis.NodeFilter = { SHOW_TEXT: 4 };

const empty = () => ({
  childNodes: [],
  ownerDocument: {
    createTreeWalker: () => ({ nextNode: () => null }),
    createElement: () => {
      throw new Error('unit tests have no DOM');
    },
  },
  get innerHTML() {
    return '';
  },
  set innerHTML(html) {
    if (html) throw new Error(`unit tests have no DOM to read HTML in: ${html} (test it in tests/parse.mjs)`);
  },
});
globalThis.document = {
  lastModified: '',
  visibilityState: 'visible',
  querySelector: () => null,
  implementation: { createHTMLDocument: () => ({ createElement: empty }) },
};

// localStorage in memory. Pocket keeps its drafts, saved lists and settings there.
const kept = new Map();
globalThis.localStorage = {
  getItem: k => (kept.has(k) ? kept.get(k) : null),
  setItem: (k, v) => {
    kept.set(k, String(v));
  },
  removeItem: k => {
    kept.delete(k);
  },
  clear: () => kept.clear(),
};
