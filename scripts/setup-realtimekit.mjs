// 初始化专用 RealtimeKit 应用与最小权限角色，不部署 Worker、不修改计费套餐。
// 示例：cp .dev.vars.example .dev.vars，填写账号 ID 和 API Token 后执行
// node --env-file=.dev.vars scripts/setup-realtimekit.mjs
// 已有应用时填写 REALTIMEKIT_APP_ID，脚本只检查/创建 feedie-call 角色。

// Cloudflare preset 要求完整配置；只允许自己的音视频，不开放录制、转录或管理其他参与者。
const preset = {
  name: 'feedie-call',
  config: {
    max_screenshare_count: 0,
    max_video_streams: { desktop: 2, mobile: 2 },
    media: {
      screenshare: { frame_rate: 5, quality: 'hd' },
      video: { frame_rate: 24, quality: 'hd', simulcast: false },
    },
    view_type: 'GROUP_CALL',
  },
  permissions: {
    accept_waiting_requests: false, can_accept_production_requests: false,
    can_change_participant_permissions: false, can_edit_display_name: false,
    can_livestream: false, can_record: false, can_spotlight: false,
    chat: {
      private: { can_receive: false, can_send: false, files: false, text: false },
      public: { can_send: false, files: false, text: false },
    },
    connected_meetings: {
      can_alter_connected_meetings: false, can_switch_connected_meetings: false,
      can_switch_to_parent_meeting: false,
    },
    disable_participant_audio: false, disable_participant_screensharing: false,
    disable_participant_video: false, hidden_participant: false, kick_participant: false,
    media: {
      audio: { can_produce: 'ALLOWED' }, video: { can_produce: 'ALLOWED' },
      screenshare: { can_produce: 'NOT_ALLOWED' },
    },
    pin_participant: false,
    plugins: { can_close: false, can_edit_config: false, can_start: false, config: {} },
    polls: { can_create: false, can_view: false, can_vote: false },
    recorder_type: 'NONE', show_participant_list: false, waiting_room_type: 'SKIP',
    transcription_enabled: false,
  },
  ui: {
    design_tokens: {
      border_radius: 'rounded', border_width: 'thin', spacing_base: 4, theme: 'dark',
      colors: {
        background: { '600': '#30333a', '700': '#272a30', '800': '#1c1f25', '900': '#14171c', '1000': '#0b0d11' },
        brand: { '300': '#93b4ff', '400': '#6d99ff', '500': '#3976ff', '600': '#2359d9', '700': '#1942a6' },
        danger: '#ef6666', success: '#78c79b', text: '#f5f4ef', text_on_brand: '#ffffff',
        video_bg: '#111318', warning: '#e4b565',
      },
    },
  },
};

// 仅输出安全的状态与应用 ID，API 密钥和 participant token 不进入终端输出。
async function configure() {
  const { REALTIMEKIT_ACCOUNT_ID: account, REALTIMEKIT_API_TOKEN: token } = process.env;
  let app = process.env.REALTIMEKIT_APP_ID;
  if (!account || !token) throw new Error('请先在 .dev.vars 填写 REALTIMEKIT_ACCOUNT_ID 和 REALTIMEKIT_API_TOKEN');
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/realtime/kit`;

  // 所有失败立即停止，避免配置未生效时仍提示接入成功。
  async function api(path, body, method = 'POST') {
    const response = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`RealtimeKit 配置请求失败（${response.status}）：${path}`);
    const result = await response.json();
    if (result.success !== true || !result.data) throw new Error(`RealtimeKit 配置响应无效：${path}`);
    return result.data;
  }

  if (!app) {
    const result = await api('/apps', { name: 'Feedie' });
    if (typeof result.app?.id !== 'string') throw new Error('创建应用未返回有效 ID');
    app = result.app.id;
    console.log(`已创建应用。请将以下非敏感配置写入 .dev.vars：\nREALTIMEKIT_APP_ID=${app}`);
  }
  const presets = await api(`/${encodeURIComponent(app)}/presets`, undefined, 'GET');
  if (!Array.isArray(presets)) throw new Error('角色列表响应格式不正确');
  const existing = presets.find(item => item.name === preset.name);
  if (existing) {
    // 已存在的同名角色也校准为最小权限，避免沿用录制或主持人权限。
    await api(`/${encodeURIComponent(app)}/presets/${encodeURIComponent(existing.id)}`, preset, 'PATCH');
  } else await api(`/${encodeURIComponent(app)}/presets`, preset);
  console.log('feedie-call 角色已配置完成。尚未部署 Worker。');
}

await configure().catch(error => { console.error(error.message); process.exitCode = 1; });
