# 同账号跨设备视频通话可行性

核对日期：2026-11-18。本文为技术调研与建议，尚未实现或验证真实通话。

## 结论

可以继续部署在 Cloudflare Workers 上，实现同一账号不同设备之间的一对一音视频通话。同账号只是应用的授权与设备归属规则；媒体通信可使用浏览器 WebRTC。WebRTC 的 SDP、ICE 等连接协商需要应用提供独立的信令通道。[WebRTC 官方连接指南](https://webrtc.org/getting-started/peer-connections)

## 已有项目基础

- `wrangler.jsonc` 的入口是 `worker/api.js`，已绑定 D1，尚未配置 Durable Objects。
- `worker/api.js` 已实现邮箱密码登录和 Cookie 会话；每次登录新增独立 session，登出只删除当前 token。`migrations/0001_sync.sql` 没有限制每个账号只能有一个会话，因此已有结构允许同账号多设备登录。
- 当前快照同步不等于实时呼叫：仍需新增在线设备身份、呼叫状态和信令交换。设备应使用独立 ID 区分，由服务端从会话解析账号并限制同账号通信，不能信任客户端自报的账号 ID。

## 建议的最小架构

1. H5 使用 `getUserMedia` 获取音视频，以 `RTCPeerConnection` 建立一对一通话。
2. Worker 复用登录校验；以账号为作用域的 Durable Object 通过 WebSocket 管理在线设备、呼叫/接听/挂断和 SDP/ICE 信令。Cloudflare 官方推荐在需要协调多个 WebSocket 连接时使用 Durable Objects。[Workers WebSocket](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、[Durable Objects WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
3. 媒体优先设备间直连；NAT 或防火墙使直连失败时，通过 Cloudflare TURN 中继。TURN 是独立媒体网络服务，普通 Worker 路由在此设计中只承担鉴权和信令，不转发音视频帧。Cloudflare 明确支持自己的 TURN 用于 P2P 应用。[Cloudflare Realtime](https://developers.cloudflare.com/realtime/)、[TURN 服务](https://developers.cloudflare.com/realtime/turn/)

另一个方案是 Cloudflare RealtimeKit：由其托管信令和媒体路由，提供 Web/移动 SDK 和现成通话 UI。Realtime SFU 则只负责媒体转发，应用仍管理信令、权限和会话。家庭少量设备偶尔通话时，RealtimeKit 通常更省开发维护投入；长时间看护时，P2P + TURN 更值得评估长期媒体费用。这是根据功能范围与计费方式作出的建议，不是已经验证的选型结果。[官方选型说明](https://developers.cloudflare.com/realtime/)

## 免费 Workers 计划下的成本比较

以下价格于 2026-11-18 查证。Workers 的计划与 Realtime 产品的用量计费需要分别考虑；没有查到纯音视频通话必须先升级 Workers Paid 的官方要求。[RealtimeKit 快速开始](https://developers.cloudflare.com/realtime/realtimekit/quickstart/)仅要求 Cloudflare 账号，且价目表明确免费用量也适用于 Free 账号。

- **RealtimeKit**：最新正式[价目表](https://developers.cloudflare.com/realtime/realtimekit/platform/pricing/)更新于 2026-11-05，每月含 10,000 音视频参与者分钟，超出为每分钟 0.002 美元。按每个实际加入的设备分别累计，静音或不收发媒体也不停止累计，离开会话才停止；因此两人通话 1 小时是 120 参与者分钟。[计费 FAQ](https://developers.cloudflare.com/realtime/realtimekit/faq/)
- **P2P + TURN**：直连时媒体不产生 TURN 用量；需要中继时，TURN 与 SFU 共享每月 1,000 GB 免费出站额度，超出每 GB 0.05 美元。信令使用的 Workers、Durable Objects 等按各自计划另算。[Realtime SFU/TURN 价目表](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)、[TURN 计量规则](https://developers.cloudflare.com/realtime/turn/faq/)
- 以上是 Cloudflare 账号级产品用量，不是给每个 Feedie 登录账号单独分配一份免费额度。以下估算假设没有其他应用消耗同一配额，不开启录制、转录或 AI 功能。

| 使用例子 | RealtimeKit 音视频用量与媒体费 | P2P + TURN 的媒体费估算 |
| --- | --- | --- |
| 两端，每天通话 1 小时，30 天 | 3,600 参与者分钟，免费额度内 | 假设每端总发送码率 2 Mbps，全部中继约 54 GB，免费额度内 |
| 两端，每天通话 8 小时，30 天 | 28,800 参与者分钟，超额约 37.60 美元 | 相同码率且全部中继约 432 GB，免费额度内 |

TURN 估算使用十进制 GB，未计协议开销，实际用量取决于码率、连接路径与重传。结合开发成本，少量偶尔通话优先评估 RealtimeKit；长期持续看护优先评估 P2P + TURN。

**官方页面仍有不一致**：[RealtimeKit 宣传页](https://realtime.cloudflare.com/)仍标示 Beta 免费、计算器是 GA 预估价，与正式文档的按用量收费措辞不同。预算采用上面的正式价目表，不假定 Beta 会无限期免费；本轮未找到 RealtimeKit 整体 GA 的明确公告。产品页写有[免费开始无需信用卡](https://www.cloudflare.com/products/realtime/)，但本轮未进入账号验证具体启用/绑卡流程，不能保证该账号的开通要求。

## 必须明确的使用边界

- 页面要通过 HTTPS 访问，并获得摄像头/麦克风权限。登录成功不会自动授予这些设备权限；浏览器可能保存先前授权，但是否保存由浏览器决定。[W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- 双方保持网页在前台、正常联网，可以作为首版支持目标。应用自己的深色待机/睡眠遮罩仍是前台网页，与手机系统锁屏不同。
- 对系统锁屏、切换到后台、网页关闭后仍能持续采集或可靠响铃，纯 H5 不应承诺原生电话级可靠性。浏览器和操作系统可冻结或回收页面；Chrome 对正在使用 WebRTC 的页面有保留策略，但极端资源压力仍可能回收。具体 iOS/Android 行为需要真机验证，不能由 Workers 部署方式解决。[Chrome 页面生命周期](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- 自动接听属于可设计的应用策略，并非 WebRTC 一概禁止。若设备已授权、页面前台且用户主动开启接听待机，可进一步验证自动建立连接；首次权限和带声音播放仍受浏览器策略控制。首版默认手动接听更容易形成清楚的使用边界。[Chrome 自动播放策略](https://developer.chrome.com/blog/autoplay/)、[WebKit 对 WebRTC 自动播放的说明](https://webkit.org/blog/7763/a-closer-look-into-webrtc/#media-capture-and-autoplay-video)

实施前应先确定：这是双方主动接听的视频通话，还是固定设备持续待机、另一设备随时查看的看护模式。两者可共用 WebRTC，但权限、接听与断线恢复行为不同。
