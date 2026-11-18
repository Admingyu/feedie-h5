// 所有 RealtimeKit 管理接口仅在服务端调用；令牌权限为目标账号的 Realtime Admin。
// 本地配置示例见 .dev.vars.example，初始化命令：node --env-file=.dev.vars scripts/setup-realtimekit.mjs。
export async function realtimeRequest(env, path, body, method = 'POST') {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.REALTIMEKIT_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch { throw new Error('视频服务连接失败，请稍后重试'); }
  if (!response.ok) throw new Error(`视频服务请求失败（${response.status}），请检查服务配置`);
  let result;
  try { result = await response.json(); }
  catch { throw new Error('视频服务返回了无效数据'); }
  if (result?.success !== true || !result.data) throw new Error('视频服务返回了无效数据');
  return result.data;
}

// 一个账号对应一个 SQLite Durable Object；只协调该账号设备的来电，不转发媒体。
// WebSocket attachment 和 storage 可在休眠后恢复，待机期间不加入 RealtimeKit 会议。
export class CallRoom {
  // Durable Objects 构造函数由 Workers 注入状态和绑定。
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  // 由鉴权后的 Worker 进入；内部身份头会被 Worker 覆写，浏览器不能选择账号房间。
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (new URL(request.url).pathname === '/logout') {
        const hash = request.headers.get('X-Feedie-Session');
        const sockets = this.ctx.getWebSockets().filter(ws => ws.deserializeAttachment().session === hash);
        try {
          const call = await this.ctx.storage.get('call');
          if (call && sockets.some(ws => [call.from, call.to].includes(ws.deserializeAttachment().id))) await this.endCall('设备已退出登录');
        } finally {
          for (const ws of sockets) ws.close(4001, '会话已结束');
        }
        return new Response(null, { status: 204 });
      }
      const url = new URL(request.url);
      const id = url.searchParams.get('device');
      const name = url.searchParams.get('name')?.trim();
      if (!/^[a-f0-9-]{36}$/.test(id ?? '') || !name || name.length > 48) return Response.json({ error: '设备信息不正确' }, { status: 400 });
      // 同一标签页重新连接时先结束旧会话，防止旧连接的关闭事件误伤新通话。
      for (const ws of this.ctx.getWebSockets()) {
        if (ws.deserializeAttachment().id !== id) continue;
        const call = await this.ctx.storage.get('call');
        if (call && [call.from, call.to].includes(id)) await this.endCall('设备重新连接，请重新呼叫');
        ws.serializeAttachment({ ...ws.deserializeAttachment(), replaced: true });
        ws.close(4000, '设备重新连接');
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ id, name, session: request.headers.get('X-Feedie-Session'), expires: Number(request.headers.get('X-Feedie-Expires')), seen: Date.now() });
      await this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  // 只把未过期且有近期心跳的连接作为可呼叫设备；令牌等私密字段不出现在设备列表。
  devices() {
    return this.ctx.getWebSockets().filter(ws => {
      const device = ws.deserializeAttachment();
      return ws.readyState === 1 && device.expires > Date.now() && device.seen > Date.now() - 75000;
    });
  }

  // 向账号内设备广播最小在线状态；每个前端自行排除本机。
  async broadcastPresence() {
    const call = await this.ctx.storage.get('call');
    const devices = this.devices().map(ws => {
      const { id, name } = ws.deserializeAttachment();
      return { id, name, busy: Boolean(call && [call.from, call.to].includes(id)) };
    });
    for (const ws of this.devices()) ws.send(JSON.stringify({ type: 'devices', devices }));
  }

  // 所有状态转换串行执行，避免同时呼叫、重复接听和外部 API await 引起重复建会。
  async webSocketMessage(ws, raw) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const device = ws.deserializeAttachment();
        if (device.expires <= Date.now()) { ws.close(4001, '登录已过期'); return; }
        if (typeof raw !== 'string' || raw.length > 1024) throw new Error('通话消息格式错误');
        const message = JSON.parse(raw);
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('通话消息格式错误');
        device.seen = Date.now();
        ws.serializeAttachment(device);
        if (message.type === 'heartbeat') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        const sockets = this.devices();
        let call = await this.ctx.storage.get('call');
        if (message.type === 'call') {
          if (call) throw new Error('当前账号已有通话，请结束后重试');
          const target = sockets.find(socket => socket.deserializeAttachment().id === message.target);
          if (!target || message.target === device.id) throw new Error('对方设备不在线，请刷新后重试');
          call = { id: crypto.randomUUID(), from: device.id, to: message.target, phase: 'ringing', deadline: Date.now() + 45000 };
          await this.ctx.storage.put('call', call);
          await this.ctx.storage.setAlarm(call.deadline);
          ws.send(JSON.stringify({ type: 'ringing', id: call.id, peer: target.deserializeAttachment().name }));
          target.send(JSON.stringify({ type: 'incoming', id: call.id, peer: device.name }));
          await this.broadcastPresence();
          return;
        }
        if (!call || message.id !== call.id || ![call.from, call.to].includes(device.id)) throw new Error('这次通话已结束');
        if (message.type === 'end') { await this.endCall(message.reason === 'reject' ? '对方已拒绝通话' : '通话已结束'); return; }
        if (message.type === 'joined') {
          if (!['connecting', 'active'].includes(call.phase)) throw new Error('当前无法加入通话');
          call.joined = [...new Set([...call.joined, device.id])];
          if (call.joined.length === 2) { call.phase = 'active'; call.deadline = null; }
          await this.ctx.storage.put('call', call);
          return;
        }
        if (message.type !== 'accept' || device.id !== call.to || call.phase !== 'ringing' || call.deadline <= Date.now()) throw new Error('这次来电已失效');
        // 只有被叫明确接受后才创建会议并签发两个参与者令牌。
        call.phase = 'connecting';
        call.joined = [];
        call.deadline = Date.now() + 60000;
        await this.ctx.storage.put('call', call);
        await this.ctx.storage.setAlarm(Date.now() + 30000);
        try {
          const meeting = await realtimeRequest(this.env, '/meetings', { title: 'Feedie 视频通话', record_on_start: false, transcribe_on_end: false, summarize_on_end: false });
          if (typeof meeting.id !== 'string' || !/^[a-f0-9-]{36}$/.test(meeting.id)) throw new Error('视频服务未返回有效会议');
          call.meeting = meeting.id;
          // 先保存会议 ID；签发令牌失败或实例恢复时仍可关闭已创建的会议。
          await this.ctx.storage.put('call', call);
          const participants = await Promise.all([call.from, call.to].map(async id => {
            const socket = sockets.find(item => item.deserializeAttachment().id === id);
            if (!socket) throw new Error('对方设备已经离线');
            const participant = await realtimeRequest(this.env, `/meetings/${call.meeting}/participants`, {
              name: socket.deserializeAttachment().name, preset_name: 'feedie-call', custom_participant_id: id,
              token: { expires_on: new Date(Date.now() + 300000).toISOString() },
            });
            if (typeof participant.token !== 'string' || !participant.token) throw new Error('视频服务未返回有效通话令牌');
            return { socket, token: participant.token };
          }));
          for (const { socket, token } of participants) {
            const peer = participants.find(item => item.socket !== socket).socket.deserializeAttachment().name;
            socket.send(JSON.stringify({ type: 'join', id: call.id, token, peer }));
          }
        } catch (error) {
          await this.endCall('视频连接失败，请重新呼叫');
          throw error;
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: error instanceof SyntaxError ? '通话消息格式错误' : error.message }));
      }
    });
  }

  // 先通知两端离会，再停用会议，阻止旧 token 重入；关闭失败保留状态并由 alarm 重试。
  async endCall(reason) {
    const call = await this.ctx.storage.get('call');
    if (!call) return;
    call.phase = 'ending';
    await this.ctx.storage.put('call', call);
    for (const ws of this.ctx.getWebSockets()) {
      if ([call.from, call.to].includes(ws.deserializeAttachment().id) && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ended', id: call.id, reason }));
    }
    try {
      if (call.meeting) await realtimeRequest(this.env, `/meetings/${call.meeting}`, { status: 'INACTIVE' }, 'PATCH');
      await this.ctx.storage.delete('call');
      await this.ctx.storage.deleteAlarm();
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 15000);
      throw new Error('通话已退出，服务端正在重试关闭会议');
    } finally { await this.broadcastPresence(); }
  }

  // 页面关闭、掉线或退出登录时及时回收会议；客户端同时主动停止自己的媒体。
  async webSocketClose(ws, code, reason) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const { id, replaced } = ws.deserializeAttachment();
      const call = await this.ctx.storage.get('call');
      try { if (!replaced && call && [call.from, call.to].includes(id)) await this.endCall('对方设备已断开连接'); }
      finally { ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason); await this.broadcastPresence(); }
    });
  }

  // WebSocket 错误执行与断开相同的资源回收。
  async webSocketError(ws) { await this.webSocketClose(ws, 1011, '连接异常'); }

  // 未接听、连接超时和网络消失都会关闭会议，避免孤立参与者长期产生费用。
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const call = await this.ctx.storage.get('call');
      if (!call) return;
      const online = this.devices().map(ws => ws.deserializeAttachment().id);
      if (call.phase === 'ending' || (call.deadline && call.deadline <= Date.now()) || ![call.from, call.to].every(id => online.includes(id))) {
        try { await this.endCall(call.phase === 'ringing' ? '对方暂未接听' : '连接超时，通话已结束'); }
        catch (error) { console.error('RealtimeKit cleanup:', error.message); }
      } else await this.ctx.storage.setAlarm(Date.now() + 30000);
    });
  }
}
