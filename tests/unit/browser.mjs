// What Pocket's modules expect of a browser, as little of it as they need to load in Node and run what the unit tests
// call. Imported first by each test file, before anything from src/, since api.js and sync.js look at these as they load.
//
// There's no DOM: reading HTML (a task's notes, for Pocket's lines in them, or a comment) is left to the browser tests
// (tests/parse.mjs), so here a task's description has to be empty. Anything else throws, saying so, rather than reading
// as nothing.

globalThis.self = {};                                    // no BroadcastChannel, which would keep Node running
globalThis.matchMedia = () => ({ matches: false });
globalThis.location = { origin: 'http://pocket.test', hash: '' };
globalThis.NodeFilter = { SHOW_TEXT: 4 };

const empty = () => ({
  childNodes: [],
  ownerDocument: { createTreeWalker: () => ({ nextNode: () => null }), createElement: () => { throw new Error('unit tests have no DOM'); } },
  get innerHTML(){ return ''; },
  set innerHTML(html){ if (html) throw new Error(`unit tests have no DOM to read HTML in: ${html} (test it in tests/parse.mjs)`); },
});
globalThis.document = { lastModified: '', visibilityState: 'visible', implementation: { createHTMLDocument: () => ({ createElement: empty }) } };

// localStorage, in memory: Pocket's drafts, saved lists and settings.
const kept = new Map();
globalThis.localStorage = {
  getItem: k => kept.has(k) ? kept.get(k) : null,
  setItem: (k, v) => { kept.set(k, String(v)); },
  removeItem: k => { kept.delete(k); },
  clear: () => kept.clear(),
};
