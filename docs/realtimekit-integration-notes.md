# RealtimeKit 接入核对

查证日期：2026-11-18。以下为官方 REST 文档与 npm 发布包核对结果；真实账号 API 和双设备通话尚未在本调研中验证。

## 凭据与 REST

Worker 后端使用 `REALTIMEKIT_ACCOUNT_ID`、`REALTIMEKIT_API_TOKEN`、`REALTIMEKIT_APP_ID`。API Token 仅保存在后端，权限为 `Realtime Admin` 或接口允许的 `Realtime`；浏览器只拿自己在本次通话中的 participant token。当前 URL **需要 app ID**。[快速开始](https://developers.cloudflare.com/realtime/realtimekit/quickstart/)、[Token FAQ](https://developers.cloudflare.com/realtime/realtimekit/faq/)

所有下列路径都加前缀 `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/realtime/kit`，使用 `Authorization: Bearer <API_TOKEN>`，JSON 请求加 `Content-Type: application/json`。

| 操作 | 方法和路径 | 关键请求/响应字段 |
| --- | --- | --- |
| 初始化应用 | `POST /apps` | 请求 `{"name":"Feedie"}`；从响应 `data.app.id` 保存 app ID |
| 创建通话 meeting | `POST /{APP_ID}/meetings` | 请求 `{"title":"Feedie call","record_on_start":false,"transcribe_on_end":false,"summarize_on_end":false}`；响应 `{success:true,data:{id,...}}` |
| 创建参与者 | `POST /{APP_ID}/meetings/{MEETING_ID}/participants` | 请求 `{custom_participant_id,preset_name,name,token?:{not_before,expires_on}}`；响应 `{success:true,data:{id,token,...}}`，**字段是 `data.token`，SDK 参数才叫 `authToken`** |
| 创建专用角色 | `POST /{APP_ID}/presets` | 请求完整 `{name,config,permissions,ui}`；响应 `{success:true,data:{id,name,config,permissions,ui,...}}` |
| 结束当前 session | `POST /{APP_ID}/meetings/{MEETING_ID}/active-session/kick-all` | 无请求 body；响应 `{success:true,data:{action,kicked_participants_count}}`；meeting 仍可重新加入 |
| 永久关闭本次 meeting | `PATCH /{APP_ID}/meetings/{MEETING_ID}` | 请求 `{"status":"INACTIVE"}`；会移除活跃参与者并阻止继续加入 |

接口来源：[创建应用](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/apps/methods/post/)、[创建 meeting](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/meetings/methods/create/)、[创建 participant](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/meetings/methods/add_participant/)、[创建 preset](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/presets/methods/create/)、[kick-all](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/active-session/methods/kick_all_participants/)、[关闭 meeting](https://developers.cloudflare.com/realtime/realtimekit/humans/core/end-a-session/)。

为避免旧 token 在挂断后重新入会，建议一通电话创建一个 meeting，结束时后端直接设为 `INACTIVE`。token 可设短有效期，但 token 到期**不会踢掉已经加入的参与者**，不能代替关闭 meeting。[Token FAQ](https://developers.cloudflare.com/realtime/realtimekit/faq/)

参与者 `token.expires_on` 是带时区的 RFC 3339 字符串，不是 Unix 秒数；当前实现签发 5 分钟内可入会的令牌。[参与者 API](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/meetings/methods/add_participant/)

## 专用 feedie-call preset

Dashboard 创建 app 时会有默认 presets，但本次没有读取真实账号，不能假定默认名字。官方概念示例出现 `group-call-host`（连字符），不是保证每个 app 都存在的 `group_call_host`。建议 setup 创建专用 `feedie-call`；下列 body 按 Create Preset schema 填齐必需结构，只开放双方自己的音视频，服务端负责结束通话。此 payload 尚未用真实账号提交。[Preset 概念](https://developers.cloudflare.com/realtime/realtimekit/concepts/preset/)、[Create Preset schema](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/presets/methods/create/)

```js
// 专用一对一角色的完整创建参数；JSON.stringify 后作为 POST /{APP_ID}/presets 的 body。
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
```

## Web Core 2.1.0 与 React

本次 npm registry 的 `@cloudflare/realtimekit` latest 为 **2.1.0**，已下载其 `dist/index.d.ts` 核对。当前公开方法是 `meeting.join()` / `meeting.leave()`，不是旧示例中的 `joinRoom()` / `leaveRoom()`。`init()` 可能开始本地媒体准备，建议只在接听完成且准备进入通话时执行。[Core 文档，2026-11-16 更新](https://developers.cloudflare.com/realtime/realtimekit/humans/core/)、[官方发布包类型](https://unpkg.com/@cloudflare/realtimekit@2.1.0/dist/index.d.ts)

```js
import RealtimeKitClient from '@cloudflare/realtimekit';

// 此代码在服务器确认本设备已接受通话、返回专属 participant token 后运行。
const meeting = await RealtimeKitClient.init({
  authToken: participantToken,
  defaults: { audio: true, video: true },
});
await meeting.join();
// 用户挂断或服务端通知结束时，先让本地设备离开并释放媒体。
await meeting.leave();
```

React 包提供 `const [meeting, initMeeting] = useRealtimeKitClient()`，初始化参数与 Core 一样；可用 `RealtimeKitProvider`、`useRealtimeKitMeeting`、`useRealtimeKitSelector`。UI Kit 的基本组件为 `<RtkMeeting mode="fill" meeting={meeting} showSetupScreen={false} />`。适合先以现成 UI 验证两端连接，再按 Feedie 界面使用 Core；一对一人数约束由应用后端控制，不依靠界面网格。[React 快速开始](https://developers.cloudflare.com/realtime/realtimekit/quickstart/)

## 媒体与事件

- 本地 `meeting.self`，远端 `meeting.participants.joined`（不含自己）；`active` 是当前被订阅的媒体参与者集合。对象有 `audioTrack`、`videoTrack`、`audioEnabled`、`videoEnabled`。[远端参与者](https://developers.cloudflare.com/realtime/realtimekit/humans/core/remote-participants/)
- 视频优先调用 `participant.registerVideoElement(videoElement)`，卸载时 `deregisterVideoElement(videoElement)`；本地预览用 `meeting.self.registerVideoElement(videoElement, true)`，本地 video 设 `muted`、`playsInline`，避免回声。[视频挂载接口](https://developers.cloudflare.com/realtime/realtimekit/humans/core/remote-participants/#display-participant-videos)
- 远端集合：`joined.on('participantJoined', participant => ...)`、`joined.on('participantLeft', participant => ...)`；集合转发媒体事件：`joined.on('audioUpdate', (participant, {audioEnabled,audioTrack}) => ...)`，`videoUpdate` 同理。单一对象和 `self` 的同名事件回调只有 payload。先读取已有 tracks，再订阅更新，并用同一 callback 引用 `off()` 清理。[事件文档](https://developers.cloudflare.com/realtime/realtimekit/humans/core/remote-participants/events/)
- 使用 Core 自绘时，远端音频可将 `audioTrack` 放入 `new MediaStream([audioTrack])` 赋给独立 `<audio>` 的 `srcObject`，处理 `play()` 的失败并展示用户可点击的开启声音操作。不要把本地音频播回自己；轨道替换、静音和离开时同步更新。UI Kit 负责媒体播放，使用它时不要再重复渲染同一远端音频。
- `meeting.self.on('roomLeft', ({state}) => ...)` 的 state 包括 `left/kicked/ended/rejected/disconnected/failed`；应进入本地清理流程，并幂等通知应用呼叫状态结束。[本地参与者事件](https://developers.cloudflare.com/realtime/realtimekit/humans/core/local-participant/)

## 与现有登录和待机状态的边界

建议由 Worker 从 HttpOnly Cookie 查询会话得到 `user.id`，再路由到按账号 ID 命名的 Durable Object；不接受浏览器传来的 account/user ID 作为授权依据。DO 只保存同账号设备 presence、呼叫、响铃与接听状态，只有服务器确认接听后才创建 meeting 和两名设备 participant、向每个连接分别发送专属 token。账号相同不代表两个设备应共享同一个 participant token；`custom_participant_id` 建议取本次设备/呼叫内的稳定内部标识，避免邮箱等个人信息。

未接、拒绝和纯待机不调用 `join()`。创建 meeting/token 不产生参与者分钟，实际加入后即使静音或不收发媒体仍累计；挂断、超时或连接终止时明确关闭本地 SDK 和云端 meeting。[计费与参与者 FAQ](https://developers.cloudflare.com/realtime/realtimekit/faq/)

## 仓库实现与验证范围

- `worker/calls.js` 管理按账号隔离的设备信令、接听建会、独立令牌、离线与超时回收；`src/realtime.ts` 管理 SDK 与本机媒体释放，界面在 `src/Prototype.tsx`。
- `scripts/setup-realtimekit.mjs` 创建/复用应用并配置专用角色；实际配置步骤以 `README.md` 与 `.dev.vars.example` 为准。
- `tests/worker-calls.test.mjs` 在真实 workerd、D1 和 SQLite Durable Objects 中验证权限与生命周期，供应商 REST 接口由测试替身隔离。覆盖服务端关闭失败后由真实 alarm 重试。
- `tests/video-calls.spec.ts` 使用隔离的信令与 SDK 替身验证界面、媒体控制和挂断竞态，不代表已建立真实音视频流。
- 截至本次实现，尚缺真实 Cloudflare 凭据，未部署或进行真机通话验收；待配置后应覆盖 iPhone/Android、异网音视频、权限拒绝、自动播放与断网恢复。
