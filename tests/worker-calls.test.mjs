import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

// 使用 Wrangler 自带的 Miniflare/workerd，验证真实 D1、Durable Objects 和 WebSocket 行为。
// 执行示例：node --test tests/worker-calls.test.mjs；外部 RealtimeKit API 由测试隔离替身处理。
const { Miniflare, Response, convertV4MiniflareOptions } = createRequire(import.meta.resolve('wrangler'))('miniflare');
const tokens = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
const apiCalls = [];
let failParticipants = false;
let failCloseOnce = false;
let runtime;

before(async () => {
  // Miniflare 5 使用统一 Worker 配置，官方转换器接收这里的 Wrangler 风格配置。
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: ['api.js', 'index.js', 'calls.js'].map(file => ({ type: 'ESModule', path: `worker/${file}` })), compatibilityDate: '2026-10-01',
    durableObjects: { CALL_ROOMS: { className: 'CallRoom', useSQLite: true } },
    d1Databases: { DB: 'calls-test' },
    bindings: { REALTIMEKIT_ACCOUNT_ID: 'test-account', REALTIMEKIT_APP_ID: 'test-app', REALTIMEKIT_API_TOKEN: 'server-only-secret' },
    // 仅替换外部供应商 API；鉴权、状态转换、并发和回收使用真实 Worker 代码。
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://api.cloudflare.com');
      assert.equal(request.headers.get('Authorization'), 'Bearer server-only-secret');
      const body = await request.json();
      apiCalls.push({ path: url.pathname, method: request.method, body });
      if (url.pathname.endsWith('/participants')) {
        if (failParticipants) return Response.json({ success: false }, { status: 403 });
        return Response.json({ success: true, data: { token: `participant-${body.custom_participant_id}` } });
      }
      if (request.method === 'PATCH') {
        if (failCloseOnce) { failCloseOnce = false; return Response.json({ success: false }, { status: 503 }); }
        return Response.json({ success: true, data: { status: 'INACTIVE' } });
      }
      assert.ok(url.pathname.endsWith('/meetings'));
      return Response.json({ success: true, data: { id: randomUUID() } });
    },
  }));
  const db = await runtime.getD1Database('DB');
  const migration = await readFile(new URL('../migrations/0001_sync.sql', import.meta.url), 'utf8');
  await db.exec(migration.split('\n').filter(line => line.trim() && !line.startsWith('--')).join('\n'));
  for (const [index, token] of tokens.entries()) {
    const id = `user-${index === 1 ? 1 : 0}`;
    if (index < 2) await db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').bind(id, `${index}@example.test`, 'salt', 'unused', Date.now()).run();
    await db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(createHash('sha256').update(token).digest('hex'), id, Date.now() + 86400000).run();
  }
});
after(async () => { await runtime?.dispose(); });

/** 建立真实账号 WebSocket 并保存已收到消息，避免注册监听时漏掉初始设备列表。 */
async function connect(account = 0) {
  const id = randomUUID();
  const response = await runtime.dispatchFetch(`https://feedie.test/api/calls/connect?device=${id}&name=Device-${id.slice(0, 4)}`, {
    headers: { Cookie: `feedie_session=${tokens[account]}`, Origin: 'https://feedie.test', Upgrade: 'websocket' },
  });
  assert.equal(response.status, 101, response.status === 101 ? '' : await response.text());
  const ws = response.webSocket;
  const messages = [];
  ws.addEventListener('message', event => messages.push(JSON.parse(event.data)));
  ws.accept();
  return { id, ws, messages };
}

/** 有界等待真实异步事件；超时显示期望与已收到的消息类型，不输出参与者令牌。 */
async function receive(client, type, matches = () => true, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const index = client.messages.findIndex(message => message.type === type && matches(message));
    if (index >= 0) return client.messages.splice(index, 1)[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`等待 ${type} 超时，已有：${client.messages.map(item => item.type).join(', ')}`);
}

test('requires a logged-in same-origin WebSocket and never returns service credentials', async () => {
  const unauthorized = await runtime.dispatchFetch('https://feedie.test/api/calls/config');
  assert.equal(unauthorized.status, 401);
  const crossOrigin = await runtime.dispatchFetch(`https://feedie.test/api/calls/connect?device=${randomUUID()}&name=Test`, {
    headers: { Cookie: `feedie_session=${tokens[0]}`, Origin: 'https://evil.test', Upgrade: 'websocket' },
  });
  assert.equal(crossOrigin.status, 403);
  const config = await runtime.dispatchFetch('https://feedie.test/api/calls/config', { headers: { Cookie: `feedie_session=${tokens[0]}` } });
  assert.deepEqual(await config.json(), { enabled: true });
});

test('isolates device lists by account and rejecting a call never creates a meeting', async () => {
  const a = await connect(), b = await connect(), outsider = await connect(1);
  try {
    const devices = await receive(outsider, 'devices');
    assert.deepEqual(devices.devices.map(item => item.id), [outsider.id]);
    a.ws.send(JSON.stringify({ type: 'call', target: outsider.id }));
    assert.match((await receive(a, 'error')).message, /不在线/);
    const before = apiCalls.length;
    a.ws.send(JSON.stringify({ type: 'call', target: b.id }));
    const incoming = await receive(b, 'incoming');
    assert.equal(apiCalls.length, before);
    b.ws.send(JSON.stringify({ type: 'end', id: incoming.id, reason: 'reject' }));
    assert.match((await receive(a, 'ended')).reason, /拒绝/);
    assert.equal(apiCalls.length, before);
  } finally { a.ws.close(); b.ws.close(); outsider.ws.close(); }
});

test('accepts once, creates separate participant tokens and permanently deactivates on hangup', async () => {
  const a = await connect(), b = await connect(), third = await connect();
  try {
    const before = apiCalls.length;
    a.ws.send(JSON.stringify({ type: 'call', target: b.id }));
    const incoming = await receive(b, 'incoming');
    third.ws.send(JSON.stringify({ type: 'accept', id: incoming.id }));
    assert.match((await receive(third, 'error')).message, /已结束/);
    b.ws.send(JSON.stringify({ type: 'accept', id: incoming.id }));
    b.ws.send(JSON.stringify({ type: 'accept', id: incoming.id }));
    const local = await receive(a, 'join'), remote = await receive(b, 'join');
    a.ws.send(JSON.stringify({ type: 'joined', id: incoming.id }));
    b.ws.send(JSON.stringify({ type: 'joined', id: incoming.id }));
    assert.notEqual(local.token, remote.token);
    assert.equal(third.messages.some(item => item.type === 'join'), false);
    assert.equal(apiCalls.slice(before).filter(item => item.method === 'POST' && item.path.endsWith('/meetings')).length, 1);
    for (const item of apiCalls.slice(before).filter(item => item.path.endsWith('/participants'))) {
      assert.equal(item.body.preset_name, 'feedie-call');
      assert.equal(typeof item.body.token.expires_on, 'string');
      assert.ok(Date.parse(item.body.token.expires_on) > Date.now());
    }
    a.ws.send(JSON.stringify({ type: 'end', id: incoming.id }));
    await receive(b, 'ended');
    // 结束通知先发给客户端，随后异步停用；下一次呼叫须等状态提交后才能开始。
    const deadline = Date.now() + 3000;
    while (!apiCalls.slice(before).some(item => item.method === 'PATCH') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(apiCalls.at(-1).body, { status: 'INACTIVE' });
  } finally { a.ws.close(); b.ws.close(); third.ws.close(); }
});

test('provider errors close the newly created meeting and report failure instead of joining', async () => {
  const a = await connect(), b = await connect();
  try {
    failParticipants = true;
    a.ws.send(JSON.stringify({ type: 'call', target: b.id }));
    const incoming = await receive(b, 'incoming');
    b.ws.send(JSON.stringify({ type: 'accept', id: incoming.id }));
    await receive(a, 'ended');
    assert.match((await receive(b, 'error')).message, /403/);
    assert.equal(a.messages.some(item => item.type === 'join'), false);
    assert.deepEqual(apiCalls.at(-1).body, { status: 'INACTIVE' });
  } finally { failParticipants = false; a.ws.close(); b.ws.close(); }
});

test('closing a device connection ends its active meeting', async () => {
  const a = await connect(), b = await connect();
  try {
    a.ws.send(JSON.stringify({ type: 'call', target: b.id }));
    const incoming = await receive(b, 'incoming');
    b.ws.send(JSON.stringify({ type: 'accept', id: incoming.id }));
    await receive(a, 'join'); await receive(b, 'join');
    a.ws.close(1000, 'page closed');
    assert.match((await receive(b, 'ended')).reason, /断开/);
  } finally { if (a.ws.readyState === 1) a.ws.close(); b.ws.close(); }
});

test('failed cloud cleanup stays busy and retries deactivation through a durable alarm', async () => {
  const a = await connect(), b = await connect();
  try {
    a.ws.send(JSON.stringify({ type: 'call', target: b.id }));
    const incoming = await receive(b, 'incoming');
    b.ws.send(JSON.stringify({ type: 'accept', id: incoming.id }));
    await receive(a, 'join'); await receive(b, 'join');
    a.messages.length = 0;
    failCloseOnce = true;
    a.ws.send(JSON.stringify({ type: 'end', id: incoming.id }));
    assert.match((await receive(a, 'error')).message, /重试关闭/);
    a.ws.send(JSON.stringify({ type: 'call', target: b.id }));
    assert.match((await receive(a, 'error')).message, /已有通话/);
    await receive(a, 'devices', message => message.devices.every(device => !device.busy), 18000);
    assert.deepEqual(apiCalls.at(-1).body, { status: 'INACTIVE' });
  } finally { failCloseOnce = false; a.ws.close(); b.ws.close(); }
});

test('logging out revokes only the current session and ends its call', async () => {
  const a = await connect(), b = await connect(2);
  try {
    a.ws.send(JSON.stringify({ type: 'call', target: b.id }));
    const incoming = await receive(b, 'incoming');
    b.ws.send(JSON.stringify({ type: 'accept', id: incoming.id }));
    await receive(a, 'join'); await receive(b, 'join');
    const response = await runtime.dispatchFetch('https://feedie.test/api/logout', {
      method: 'POST', headers: { Cookie: `feedie_session=${tokens[0]}`, Origin: 'https://feedie.test' },
    });
    assert.equal(response.status, 200);
    assert.match((await receive(b, 'ended')).reason, /退出登录/);
    const session = await runtime.dispatchFetch('https://feedie.test/api/session', { headers: { Cookie: `feedie_session=${tokens[2]}` } });
    assert.equal(session.status, 200);
    assert.equal(b.ws.readyState, 1);
  } finally { if (a.ws.readyState === 1) a.ws.close(); b.ws.close(); }
});
