// node --test scripts/readme-clips/lib.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConcatList, normSuffix, rateGate } from './lib.mjs';

test('buildConcatList holds each frame until the next and the last until the end', () => {
  const text = buildConcatList([{ file: 'a.jpg', t: 0 }, { file: 'b.jpg', t: 2500 }], 10000);
  assert.equal(text, [
    'ffconcat version 1.0',
    "file 'a.jpg'", 'duration 2.500',
    "file 'b.jpg'", 'duration 7.500',
    "file 'b.jpg'", '',
  ].join('\n'));
});

test('rateGate keeps at most maxFps frames per second', () => {
  const gate = rateGate(30);
  assert.deepEqual([0, 10, 20, 34, 40, 70].map(gate), [true, false, false, true, false, true]);
});

test('normSuffix accepts the suffix with or without its dash', () => {
  assert.equal(normSuffix('readme1'), '-readme1');
  assert.equal(normSuffix('-readme1'), '-readme1');
});
