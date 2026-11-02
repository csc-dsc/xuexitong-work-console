'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { translationByteChunks, nativeProgressPercent, nativeTranslationStatusLabel } = require('./chaoxing-unified.user.js');

function check(text) {
  const chunks = translationByteChunks(text);
  assert.equal(chunks.join(''), text, 'Segmentation must preserve source text');
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 450, 'Every query must stay below the 500 byte API limit');
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), 'Do not split UTF-16 surrogate pairs');
  }
  return chunks;
}

test('Long English paragraphs are split even without blank lines', () => {
  const text = 'Oxford University has a long history of teaching and learning. '.repeat(80);
  const chunks = check(text);
  assert.ok(chunks.length > 5);
});

test('UTF-8 bytes are counted for Chinese, accents, emoji and line breaks', () => {
  check('翻译课程正文：café déjà vu — 😀\n'.repeat(50));
});

test('Unbroken strings and extremely long words cannot exceed the limit', () => {
  check('a'.repeat(1700));
  check('😀'.repeat(250));
});

test('Empty text makes no requests and a short sentence stays intact', () => {
  assert.deepEqual(translationByteChunks(''), []);
  assert.deepEqual(translationByteChunks('A short English sentence.'), ['A short English sentence.']);
});

test('Byte boundary and malformed caller limits are handled explicitly', () => {
  assert.deepEqual(translationByteChunks('a'.repeat(450)), ['a'.repeat(450)]);
  assert.equal(translationByteChunks('a'.repeat(451)).length, 2);
  for (const limit of [0, 3, 4.5, NaN]) assert.throws(() => translationByteChunks('test', limit), RangeError);
});

test('Native progress is normalized safely and status labels are user readable', () => {
  assert.equal(nativeProgressPercent(0, 1), 0);
  assert.equal(nativeProgressPercent(0.5, 1), 50);
  assert.equal(nativeProgressPercent(2, 1), 100);
  assert.equal(nativeProgressPercent(1, 0), null);
  assert.match(nativeTranslationStatusLabel('downloadable'), /本地模型/);
  assert.match(nativeTranslationStatusLabel('downloading', 30), /30%/);
  assert.match(nativeTranslationStatusLabel('available'), /就绪/);
});
