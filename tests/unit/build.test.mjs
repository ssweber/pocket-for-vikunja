// The build writes a compressed copy of the page (compressed in scripts/build.mjs). main.go sends it to browsers that accept it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { compressed, include, lean, onlyParts, shared } from '../../scripts/build.mjs';

test('a part marked "only" is kept where the include names one of its words, and left out everywhere else', () => {
  const row =
    '<div class="row">\n  <!-- only step -->\n  <span class="n"></span>\n  <!-- /only -->\n  <button></button>\n  <!-- only run sheet -->\n  <i></i>\n  <!-- /only -->\n</div>\n';
  assert.equal(
    onlyParts(row),
    '<div class="row">\n  <button></button>\n</div>\n',
    'an include with no name keeps neither part',
  );
  assert.equal(
    onlyParts(row, ['step']),
    '<div class="row">\n  <span class="n"></span>\n  <button></button>\n</div>\n',
    'an include with the name keeps that part, without its markers',
  );
  assert.equal(
    onlyParts(row, ['sheet', 'step']),
    '<div class="row">\n  <span class="n"></span>\n  <button></button>\n  <i></i>\n</div>\n',
    'an include with two names keeps each part that has either',
  );
  assert.equal(
    onlyParts(row, ['list']),
    '<div class="row">\n  <button></button>\n</div>\n',
    'an include with a name no part has keeps neither',
  );
});

test("the row must be included with its kind of list, and gets only that kind's parts", () => {
  const row = fileURLToPath(new URL('../../src/markup/task-row.html', import.meta.url));
  assert.throws(() => include(row), /include it with the kind of list/);
  assert.match(
    include(row, [], ['run']),
    /class="did"/,
    "a checklist's screen gets the part that shows who did a step",
  );
  assert.doesNotMatch(
    include(row, [], ['list']),
    /class="did"|id="d-title"|<!-- \/?only/,
    'a list of tasks gets neither that part nor the title editor',
  );
});

test('the page is built without its comments and indentation, and keeps white space that shows', () => {
  assert.equal(
    lean('<div class="row">\n  <!-- why -->\n  <b>a</b> <i>b</i>\n  <span>one\n    two</span>\n</div>\n'),
    '<div class="row"><b>a</b> <i>b</i><span>one\n    two</span></div>',
  );
  assert.equal(
    lean('<p\n   :class="{a: x > 1,\n            b: y}"   hidden>'),
    '<p :class="{a: x > 1,\n            b: y}" hidden>',
    'white space between attributes becomes one space, and inside an attribute it stays',
  );
  assert.equal(lean('<p x-text="\'<!-- kept -->\'"></p>'), '<p x-text="\'<!-- kept -->\'"></p>');
});

test('an x-if or x-for template inside another template names a template that holds its content, one for each different content', () => {
  const row =
    '<template x-for="t in rows"><div><template x-if="t.a"><b>a</b></template><template x-if="t.b"><b>a</b></template>' +
    '<template x-if="t.c"><i><template x-for="u in t.d"><u></u></template></i></template><template x-teleport="body"><p></p></template></div></template>';
  assert.equal(
    shared('<body>' + row + '<script></script></body>'),
    '<body><template x-for="t in rows"><div><template x-if="t.a" data-from="part-1"></template><template x-if="t.b" data-from="part-1"></template>' +
      '<template x-if="t.c" data-from="part-3"></template><template x-teleport="body"><p></p></template></div></template>' +
      '<template id="part-1"><b>a</b></template><template id="part-2"><u></u></template><template id="part-3"><i><template x-for="u in t.d" data-from="part-2"></template></i></template><script></script></body>',
  );
  assert.equal(
    shared('<template x-if="a"><b></b></template>'),
    '<template x-if="a"><b></b></template>',
    'a template that is inside no other keeps its content',
  );
  assert.throws(() => shared('<template x-if="a"><b></b>'), /not closed/);
});

test('the page is written as .br and .gz files that decode to it, with no time or operating system in the gzip header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-build-')),
    file = join(dir, 'index.html'),
    page = '<!doctype html><p>Café ✓</p>\n'.repeat(50);
  try {
    compressed(file, page);
    assert.equal(brotliDecompressSync(readFileSync(file + '.br')).toString(), page);
    assert.equal(gunzipSync(readFileSync(file + '.gz')).toString(), page);
    assert.deepEqual(
      [...readFileSync(file + '.gz').subarray(4, 10)],
      [0, 0, 0, 0, 2, 255],
      'the header has time 0, best compression and an "unknown" operating system',
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a compressed copy that already decodes to the page is left alone, and one that does not is written again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-build-')),
    file = join(dir, 'index.html');
  try {
    compressed(file, 'one');
    const br = statSync(file + '.br').mtimeMs;
    writeFileSync(file + '.gz', 'not gzip');
    compressed(file, 'one');
    assert.equal(statSync(file + '.br').mtimeMs, br, 'the .br file is not changed');
    assert.equal(gunzipSync(readFileSync(file + '.gz')).toString(), 'one');
    compressed(file, 'two');
    assert.equal(brotliDecompressSync(readFileSync(file + '.br')).toString(), 'two');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("the committed page's compressed copies decode to the committed page", () => {
  const page = readFileSync('pocket/app/index.html');
  assert.ok(
    brotliDecompressSync(readFileSync('pocket/app/index.html.br')).equals(page),
    'index.html.br: run npm run build',
  );
  assert.ok(gunzipSync(readFileSync('pocket/app/index.html.gz')).equals(page), 'index.html.gz: run npm run build');
});
