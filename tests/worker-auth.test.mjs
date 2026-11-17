import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

// 模拟生产 Workers 对单次 PBKDF2 调用的上限，本地 workerd 默认没有此限制。
const subtle = new Proxy(webcrypto.subtle, { get(target, name) {
  if (name === 'deriveBits') return (algorithm, ...args) => {
    if (algorithm.name === 'PBKDF2' && algorithm.iterations > 100000) throw new DOMException('PBKDF2 iteration limit', 'NotSupportedError');
    return target.deriveBits(algorithm, ...args);
  };
  const value = target[name];
  return typeof value === 'function' ? value.bind(target) : value;
} });
Object.defineProperty(globalThis, 'crypto', { value: { subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID: webcrypto.randomUUID.bind(webcrypto) }, configurable: true });
const worker = (await import('../worker/api.js')).default;

// 使用真实 SQLite 执行 Worker 的 SQL，覆盖注册、登录和原有哈希格式。
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_sync.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) {
    return { bind(...values) {
      return {
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
        sql, values,
      };
    } };
  }, batch: async statements => {
    sqlite.exec('BEGIN');
    try { for (const statement of statements) sqlite.prepare(statement.sql).run(...statement.values); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

// 注册后同一账号应能登录，错误密码应明确返回 401。
test('registration and login respect the production PBKDF2 limit', async () => {
  const db = database();
  const send = (path, password) => worker.fetch(new Request(`https://example.test/api/${path}`, { method: 'POST', headers: { Origin:'https://example.test', 'Content-Type':'application/json', 'CF-Connecting-IP':'127.0.0.1' }, body: JSON.stringify({ email:'test@example.test', password }) }), { DB: db });
  const register = await send('register', 'example-password');
  assert.equal(register.status, 200, await register.text());
  const login = await send('login', 'example-password');
  assert.equal(login.status, 200, await login.text());
  const wrong = await send('login', 'incorrect-password');
  assert.equal(wrong.status, 401, await wrong.text());
  db.sqlite.close();
});
