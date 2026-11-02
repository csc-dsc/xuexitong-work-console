'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { floatingRect, resizedFloatingRect, floatingShortcut } = require('./chaoxing-unified.user.js');
const viewport = [1478, 820];
const box = { x: 200, y: 120, width: 420, height: 560 };

test('An oversized old panel becomes movable vertically inside the viewport', () => {
  const rect = floatingRect({ x: 900, y: 90, width: 420, height: 560 }, ...viewport);
  assert.equal(rect.height, 560);
  assert.equal(rect.y, 90);
  const lower = floatingRect({ ...rect, y: 190 }, ...viewport);
  assert.equal(lower.y, 190);
});

test('All four sides and corners resize with the opposite edge anchored', () => {
  for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const result = resizedFloatingRect(box, direction, 35, 25, ...viewport);
    if (direction.includes('e')) assert.equal(result.width, box.width + 35, direction);
    if (direction.includes('w')) assert.equal(result.x + result.width, box.x + box.width, direction);
    if (direction.includes('n')) assert.equal(result.y + result.height, box.y + box.height, direction);
    if (direction.includes('s')) assert.equal(result.height, box.height + 25, direction);
    if (!/[ew]/.test(direction)) assert.equal(result.width, box.width, direction);
    if (!/[ns]/.test(direction)) assert.equal(result.height, box.height, direction);
  }
});

test('Dragging north-west past the minimum preserves the bottom and right', () => {
  const result = resizedFloatingRect(box, 'nw', 999, 999, ...viewport);
  assert.equal(result.width, 300);
  assert.equal(result.height, 240);
  assert.equal(result.x + result.width, box.x + box.width);
  assert.equal(result.y + result.height, box.y + box.height);
});

test('Every resize direction stops at the viewport edge', () => {
  for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const result = resizedFloatingRect(box, direction,
      direction.includes('w') ? -9999 : 9999, direction.includes('n') ? -9999 : 9999, ...viewport);
    assert.ok(result.x >= 8 && result.y >= 8, direction);
    assert.ok(result.x + result.width <= viewport[0] - 8, direction);
    assert.ok(result.y + result.height <= viewport[1] - 8, direction);
  }
});

test('Small viewports take precedence over minimum window dimensions', () => {
  const result = floatingRect({ x: -500, y: 900, width: 420, height: 560 }, 260, 200);
  assert.deepEqual(result, { x: 8, y: 8, width: 244, height: 184 });
});

test('Both shifted plus and Alt+equals grow, including the number pad', () => {
  assert.equal(floatingShortcut({ altKey: true, shiftKey: true, key: '+', code: 'Equal' }), 'grow');
  assert.equal(floatingShortcut({ altKey: true, shiftKey: false, key: '=', code: 'Equal' }), 'grow');
  assert.equal(floatingShortcut({ altKey: true, code: 'NumpadAdd' }), 'grow');
  assert.equal(floatingShortcut({ altKey: true, key: '-', code: 'Minus' }), 'shrink');
  assert.equal(floatingShortcut({ altKey: true, code: 'NumpadSubtract' }), 'shrink');
});

test('Visibility shortcut remains distinct and normal browser shortcuts are untouched', () => {
  assert.equal(floatingShortcut({ altKey: true, shiftKey: true, code: 'KeyC' }), 'visibility');
  for (const event of [
    { key: '+', code: 'Equal' },
    { ctrlKey: true, key: '+', code: 'Equal' },
    { altKey: true, ctrlKey: true, key: '+', code: 'Equal' },
    { altKey: true, metaKey: true, key: '-', code: 'Minus' },
    { altKey: true, code: 'KeyC' },
    { altKey: true, shiftKey: true, key: '_', code: 'Minus' },
  ]) assert.equal(floatingShortcut(event), null);
});
