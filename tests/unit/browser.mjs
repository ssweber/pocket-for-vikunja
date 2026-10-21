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
  visibilityState: 'visible',
  querySelector: () => null,
  implementation: { createHTMLDocument: () => doc },
};

// localStorage in memory. Pocket keeps its drafts, saved lists and settings there. Object.keys lists the keys kept, as
// in a browser.
const kept = new Map();
globalThis.localStorage = new Proxy(
  {
    getItem: k => (kept.has(k) ? kept.get(k) : null),
    setItem: (k, v) => {
      kept.set(k, String(v));
    },
    removeItem: k => {
      kept.delete(k);
    },
    clear: () => kept.clear(),
  },
  {
    ownKeys: () => [...kept.keys()],
    getOwnPropertyDescriptor: (_, k) =>
      kept.has(k) ? { value: kept.get(k), enumerable: true, configurable: true } : undefined,
  },
);

/* Web Locks, as a browser grants them: one holder of a name at a time, in the order asked, each called in a task of its
   own. Node 22 has none. Node 24's calls a free lock's holder before request() returns, which a browser never does. */
const locks = new Map(); // name -> the last holder's end
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: {
    request(name, fn) {
      const turn = (locks.get(name) || Promise.resolve()).then(() => new Promise(ok => setImmediate(ok))).then(fn);
      locks.set(
        name,
        turn.catch(() => {}),
      );
      return turn;
    },
  },
});
