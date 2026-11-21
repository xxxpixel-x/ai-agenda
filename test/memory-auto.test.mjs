import assert from 'node:assert/strict';
import test from 'node:test';
import { Space } from '../src/space.mjs';

test('空间默认自动整理，也可以关闭', (t) => {
  assert.equal(Space.memoryAuto, true);
  t.after(() => { Space.memoryAuto = true; });
  Space.memoryAuto = false;
  assert.equal(Space.memoryAuto, false);
});
