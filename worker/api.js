import assetsWorker from './index.js';
export { CallRoom } from './calls.js';

// 同源 Cookie 会话使用随机令牌；数据库中只保存令牌摘要。
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const random = bytes => hex(crypto.getRandomValues(new Uint8Array(bytes)));
// 新账号的哈希参数记录在数据库中；未标记的旧格式使用 310000 次迭代。
const passwordIterations = 100000;
const passwordHashPrefix = `pbkdf2-sha256$${passwordIterations}$`;
// PBKDF2 逐用户加盐；Cloudflare Workers 生产环境单次调用最多支持 100000 次迭代。
async function passwordHash(password, salt, iterations = passwordIterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations }, key, 256));
}
// 比较固定长度摘要，避免直接使用普通字符串比较。
function equalHash(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const cookie = (value, maxAge) => `feedie_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
// 所有写请求校验 Origin，避免第三方站点借用用户 Cookie 发起操作。
function sameOrigin(request) { return request.headers.get('Origin') === new URL(request.url).origin; }
// 根据 Cookie 找到仍然有效的会话。
async function session(request, db) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)feedie_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  return db.prepare('SELECT users.id, users.email, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').bind(await digest(token), Date.now()).first();
}
// 固定窗口同时限制来源 IP 和账号，减轻注册及密码猜测攻击。
async function limit(db, key, limitCount) {
  const window = Math.floor(Date.now() / 900000);
  const row = await db.prepare('INSERT INTO auth_attempts (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END, window = excluded.window RETURNING count').bind(key, window).first();
  return row.count <= limitCount;
}
// API 使用版本号进行乐观并发控制，防止两个设备同时同步时覆盖对方。
async function api(request, env) {
  const url = new URL(request.url), path = url.pathname, db = env.DB;
  if (!db) return json({ error: '服务尚未配置数据库' }, 503);
  if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: '请求来源不正确' }, 403);
  if (request.method === 'POST' && (path === '/api/register' || path === '/api/login')) {
    let body;
    try { body = await request.json(); } catch { return json({ error: '请求格式错误' }, 400); }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = body.password;
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || typeof password !== 'string' || password.length < 8 || password.length > 128) return json({ error: '请输入有效邮箱和 8–128 位密码' }, 400);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!await limit(db, `ip:${ip}`, 50) || !await limit(db, `email:${await digest(email)}`, 10)) return json({ error: '尝试次数过多，请 15 分钟后再试' }, 429);
    let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (path === '/api/register') {
      if (user) return json({ error: '该邮箱已注册' }, 409);
      const id = crypto.randomUUID(), salt = random(16), hash = passwordHashPrefix + await passwordHash(password, salt);
      try { await db.batch([db.prepare('INSERT INTO users (id,email,salt,password_hash,created_at) VALUES (?,?,?,?,?)').bind(id,email,salt,hash,Date.now()), db.prepare('INSERT INTO snapshots (user_id) VALUES (?)').bind(id)]); }
      catch (e) { if (String(e).includes('UNIQUE constraint failed')) return json({ error: '该邮箱已注册' }, 409); throw e; }
      user = { id, email };
    } else {
      const stored = user?.password_hash;
      const legacy = typeof stored === 'string' && /^[a-f0-9]{64}$/.test(stored);
      if (stored && !legacy && !stored.startsWith(passwordHashPrefix)) throw new Error('Unsupported password hash format');
      const calculated = await passwordHash(password, user?.salt || '00000000000000000000000000000000', legacy ? 310000 : passwordIterations);
      const expected = legacy ? stored : stored?.slice(passwordHashPrefix.length);
      if (!user || !expected || !equalHash(calculated, expected)) return json({ error: '邮箱或密码不正确' }, 401);
    }
    const token = random(32), age = 30 * 86400;
    await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await digest(token), user.id, Date.now() + age * 1000).run();
    return json({ id: user.id, email: user.email }, 200, { 'Set-Cookie': cookie(token, age) });
  }
  const user = await session(request, db);
  if (!user) return json({ error: '请先登录' }, 401);
  if (path === '/api/session' && request.method === 'GET') return json({ id: user.id, email: user.email });
  if (path === '/api/calls/config' || path === '/api/calls/connect') {
    if (!env.CALL_ROOMS || !env.REALTIMEKIT_ACCOUNT_ID || !env.REALTIMEKIT_APP_ID || !env.REALTIMEKIT_API_TOKEN) return json({ error: '视频通话尚未启用，请先完成服务配置' }, 503);
    if (request.method !== 'GET') return json({ error: '请求方法不正确' }, 405);
    if (path === '/api/calls/config') return json({ enabled: true });
    // WebSocket 也校验 Origin，防止第三方网页借用登录 Cookie 呼叫其他设备。
    if (!sameOrigin(request)) return json({ error: '请求来源不正确' }, 403);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: '需要实时连接' }, 426);
    const headers = new Headers(request.headers);
    const token = request.headers.get('Cookie').match(/(?:^|;\s*)feedie_session=([a-f0-9]{64})(?:;|$)/)[1];
    headers.set('X-Feedie-Session', await digest(token));
    headers.set('X-Feedie-Expires', String(user.expires_at));
    return env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(user.id)).fetch(new Request(request, { headers }));
  }
  if (path === '/api/logout' && request.method === 'POST') {
    const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)feedie_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (token) {
      const hash = await digest(token);
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
      if (env.CALL_ROOMS) await env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(user.id)).fetch(new Request('https://calls.internal/logout', { method: 'POST', headers: { 'X-Feedie-Session': hash } }));
    }
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (path === '/api/sync' && request.method === 'GET') {
    const row = await db.prepare('SELECT revision,data FROM snapshots WHERE user_id = ?').bind(user.id).first();
    return json({ revision: row.revision, data: JSON.parse(row.data) });
  }
  if (path === '/api/sync' && request.method === 'PUT') {
    if (Number(request.headers.get('Content-Length') || 0) > 1000000) return json({ error: '同步数据过大' }, 413);
    const text = await request.text();
    if (text.length > 1000000) return json({ error: '同步数据过大' }, 413);
    let body; try { body = JSON.parse(text); } catch { return json({ error: '请求格式错误' }, 400); }
    if (!Number.isSafeInteger(body.revision) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return json({ error: '同步数据格式错误' }, 400);
    const result = await db.prepare('UPDATE snapshots SET data = ?, revision = revision + 1 WHERE user_id = ? AND revision = ?').bind(JSON.stringify(body.data), user.id, body.revision).run();
    if (!result.meta.changes) return json({ error: '云端数据已更新，请重试同步' }, 409);
    return json({ revision: body.revision + 1 });
  }
  return json({ error: '接口不存在' }, 404);
}
// 示例部署：先创建并绑定 D1，再执行 npx wrangler deploy。
export default { async fetch(request, env) {
  if (new URL(request.url).pathname.startsWith('/api/')) {
    try { return await api(request, env); } catch (error) { console.error('API error', error); return json({ error: '服务暂时不可用，请稍后重试' }, 500); }
  }
  return assetsWorker.fetch(request, env);
} };
