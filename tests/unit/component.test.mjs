// The Alpine component is core.js's data plus the methods of each part in src/js/app/, merged into one object
// (component.js). A name defined in two parts would silently replace the first, so each name has one part.
import './browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { parts } from '../../src/js/component.js';

test('no two parts of the component define the same name', async () => {
  const files = readdirSync('src/js/app').filter(f => f.endsWith('.js')),
    where = new Map(),
    twice = [];
  for (const f of files) {
    const part = (await import('../../src/js/app/' + f)).default,
      own = f === 'core.js' ? part() : part;
    if (!part) continue; // a helper of the parts, such as seat.js
    if (f !== 'core.js') assert.ok(parts.includes(part), `component.js merges ${f}`);
    for (const k of Object.keys(Object.getOwnPropertyDescriptors(own))) {
      if (where.has(k)) twice.push(`${k} in ${where.get(k)} and ${f}`);
      else where.set(k, f);
    }
  }
  assert.deepEqual(twice, []);
});
