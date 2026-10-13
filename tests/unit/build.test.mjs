// The build writes a compressed copy of the page (compressed in scripts/build.mjs). main.go sends it to browsers that accept it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { compressed, onlyParts } from '../../scripts/build.mjs';

test('a part marked "only" is kept where the include names it, and left out everywhere else', () => {
  const row = '<div class="row">\n  <!-- only step -->\n  <span class="n"></span>\n  <!-- /only -->\n  <button></button>\n  <!-- only other -->\n  <i></i>\n  <!-- /only -->\n</div>\n';
  assert.equal(onlyParts(row), '<div class="row">\n  <button></button>\n</div>\n', 'an include with no name keeps neither part');
  assert.equal(onlyParts(row, ['step']), '<div class="row">\n  <span class="n"></span>\n  <button></button>\n</div>\n', 'an include with the name keeps that part, without its markers');
});

test('the page is written as .br and .gz files that decode to it, with no time or operating system in the gzip header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-build-')), file = join(dir, 'index.html'), page = '<!doctype html><p>Café ✓</p>\n'.repeat(50);
  try {
    compressed(file, page);
    assert.equal(brotliDecompressSync(readFileSync(file + '.br')).toString(), page);
    assert.equal(gunzipSync(readFileSync(file + '.gz')).toString(), page);
    assert.deepEqual([...readFileSync(file + '.gz').subarray(4, 10)], [0, 0, 0, 0, 2, 255], 'the header has time 0, best compression and an "unknown" operating system');
  } finally { rmSync(dir, { recursive: true }); }
});

test('a compressed copy that already decodes to the page is left alone, and one that does not is written again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-build-')), file = join(dir, 'index.html');
  try {
    compressed(file, 'one');
    const br = statSync(file + '.br').mtimeMs;
    writeFileSync(file + '.gz', 'not gzip');
    compressed(file, 'one');
    assert.equal(statSync(file + '.br').mtimeMs, br, 'the .br file is not changed');
    assert.equal(gunzipSync(readFileSync(file + '.gz')).toString(), 'one');
    compressed(file, 'two');
    assert.equal(brotliDecompressSync(readFileSync(file + '.br')).toString(), 'two');
  } finally { rmSync(dir, { recursive: true }); }
});

test('the committed page\'s compressed copies decode to the committed page', () => {
  const page = readFileSync('pocket/app/index.html');
  assert.ok(brotliDecompressSync(readFileSync('pocket/app/index.html.br')).equals(page), 'index.html.br: run npm run build');
  assert.ok(gunzipSync(readFileSync('pocket/app/index.html.gz')).equals(page), 'index.html.gz: run npm run build');
});
