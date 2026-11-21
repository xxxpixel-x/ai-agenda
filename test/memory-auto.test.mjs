import assert from 'node:assert/strict';
import test from 'node:test';
import { Space } from '../src/space.mjs';

test('默认不自动整理记忆库（等成员能用上记忆库时再打开）', () => {
  assert.equal(Space.memoryAuto, false);
});
