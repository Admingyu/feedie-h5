import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { mergeSnapshots, syncData, trackChanges } from '../src/sync.ts';

// 不同标签页独立保存快照时，新记录不应被旧页面误认为删除。
test('merges changes from separate tabs without deleting unseen records', () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  const empty = { records: {}, settings: {} };
  const first = { id: 'first', at: '2026-11-15T00:00:00.000Z', ml: 120 };
  const second = { id: 'second', at: '2026-11-15T01:00:00.000Z', ml: 90 };
  const tabA = trackChanges([first], { interval: 180 }, empty);
  const tabB = trackChanges([second], { interval: 180 }, empty);
  const merged = mergeSnapshots(tabA, tabB);
  assert.deepEqual(merged.records.first.value, first);
  assert.deepEqual(merged.records.second.value, second);
});

// 定时拉取没有变化的快照时不能触发写入，避免不必要的版本冲突。
test('does not write an unchanged cloud snapshot', async () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const cloud = { records: {}, settings: { interval: { version: '1', value: 180 } } };
  const originalFetch = globalThis.fetch;
  let puts = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'PUT') puts++;
    return Response.json({ revision: 3, data: cloud });
  };
  try {
    assert.deepEqual(await syncData({ id: 'user', email: 'test@example.test' }, cloud), cloud);
    assert.equal(puts, 0);
    assert.equal(storage.get('feedie.sync.owner'), 'user');
  } finally { globalThis.fetch = originalFetch; }
});
