// A minimal fake browser, just enough for Pocket's modules to load in Node and run the unit tests. Each test file
// imports it first, before anything from src/, because api.js and sync.js read these globals as they load.
//
// The DOM is dom.mjs, which reads only the paragraphs, line breaks and text Pocket writes in notes. Other HTML throws.

import { doc } from './dom.mjs';

globalThis.self = {}; // no BroadcastChannel, because an open one keeps Node running
globalThis.matchMedia = () => ({ matches: false });
globalThis.location = { origin: 'http://pocket.test', hash: '' };
globalThis.NodeFilter = { SHOW_TEXT: 4 };

globalThis.document = {
  lastModified: '',
  visibilityState: 'visible',
  querySelector: () => null,
  implementation: { createHTMLDocument: () => doc },
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
