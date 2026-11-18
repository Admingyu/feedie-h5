# Feedie

Feedie 是一款移动端婴儿喂养记录 H5 原型，支持竖屏和横屏。

## 功能

- 显示当前时间、上次喂养时间和奶量、已间隔时长与下次提醒进度。
- 调整本次奶量后，通过独立滑动条记录喂养；记录保存后可短暂撤销。
- 查看喂养历史，支持补录、修改时间和奶量、删除。
- 配置默认奶量、提醒间隔、提前提示、主题、睡眠模式与屏幕常亮。
- 在当前浏览器保存记录，并支持 JSON 导入和导出。
- 横屏主屏采用双栏布局。
- 同账号在线设备之间的视频呼叫、接听、静音和挂断（需配置 Cloudflare RealtimeKit）。

## 开发与构建

安装依赖后运行开发服务器：

```sh
pnpm install
pnpm run dev
```

打开 `/h5.html` 使用真实数据，或打开 `/h5.html?demo=1` 查看固定示例数据。

构建独立 H5：

```sh
pnpm run build:h5
```

### Cloudflare Workers

仓库根目录的 `wrangler.jsonc` 将 `worker/api.js` 与 `dist/client` 静态资源及 D1 数据库连接起来。Cloudflare Workers Builds 使用：

- 构建命令：`pnpm run build`
- 部署命令：`npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`
- 根目录：`/`

### Cloudflare Pages

在 Cloudflare Pages 项目设置中使用以下构建配置：

- 构建命令：`pnpm run build:h5`
- 构建输出目录：`dist/client`
- 根目录：仓库根目录

`build:h5` 会生成可直接托管的静态 H5 页面，不需要仓库中的本机 Sites 配置。`build:sites` 单独用于 Sites 打包，并需要未提交的本机 `.openai/hosting.json`。

## 数据与提醒

记录保存在当前浏览器，登录后会自动同步到其他设备。提醒显示在页面内；关闭页面后不会发送推送通知。屏幕常亮取决于设备和浏览器支持。

## 许可

本项目采用 [定制 GPLv3 衍生非商业许可](LICENSE)。该许可禁止未经书面许可的商业使用；它不是标准 GPL。第三方组件和素材仍适用其各自的许可证。

## 账号与数据同步

在设置中选择「导入记录 JSON」，可导入本应用导出的 v1 备份；只导入喂养记录，按 ID 跳过本机已有记录，不覆盖设置。同步时云端已有的同 ID 记录或删除状态优先。登录后导入的记录会自动同步。选择「登录以同步」并注册或登录后会合并本机和云端的喂养记录与设置。新增、修改和删除会自动同步；页面打开时每 30 秒检查云端更新，重新联网或返回页面时也会同步。网络异常时数据保留在本机并自动重试，也可以选择「立即同步」。字段以设备记录的修改时间为准，请确保设备时间准确。首次同步保留已有本机记录；此后本机同步数据绑定到首次使用的账号。

当前版本使用邮箱和密码登录，尚未提供邮箱验证或密码找回。请妥善保管密码，并在更换设备前完成同步或导出备份。

### 配置 D1 和自动迁移

`wrangler.jsonc` 绑定已有的 `feddie` 数据库。Cloudflare Workers Builds 的部署命令会先执行 `wrangler d1 migrations apply DB --remote`，仅应用尚未执行的迁移；迁移失败时不会部署新 Worker。构建 API 令牌需要拥有 D1 编辑权限。

本地手动部署时先运行 `pnpm run build`，再运行 `pnpm run deploy`。直接运行 `npx wrangler deploy` 不会自动执行 D1 迁移。

本地调试可先执行 `npx wrangler d1 migrations apply DB --local`，然后运行 `pnpm run build` 和 `npx wrangler dev --local`。本地数据库和线上数据库互不影响。Cloudflare Pages 的纯静态构建无法提供登录和同步 API，需要使用 Worker 部署。

## 视频通话：Cloudflare RealtimeKit

首页左侧「视频」查看同账号的其他在线设备；双方保持页面打开，由对方手动接听。支持静音、关闭摄像头和挂断，浏览器阻止声音自动播放时显示「轻触开启声音」。每个标签页是一个独立通话端，一个账号同时进行一通一对一通话。手机锁屏、后台运行和关闭网页后的可靠接听不在 H5 支持范围内。

Worker 复用现有登录 Cookie，按账号将设备连接路由到 SQLite Durable Object。设备待机和响铃不加入会议；接听后才创建本次会议与两份独立参与者令牌。挂断时本机立即停止采集，服务端将会议设为 `INACTIVE`，阻止旧令牌重新加入。未接听 45 秒、连接准备超过 60 秒或心跳丢失会结束通话；网络消失的清理可能延迟至约 105 秒。云端关闭请求失败时保留清理状态并重试，期间不能新建通话。

### 配置服务

使用 Node.js 22.12 或以上。创建一个限定到当前 Cloudflare 账号、拥有 **Realtime Admin** 权限的 API Token；它只保存在服务端，不写入 `VITE_*` 或浏览器存储。

```sh
# 建立不入库的本地配置，填入 ACCOUNT_ID 和 API_TOKEN；已有应用时也填 APP_ID。
cp .dev.vars.example .dev.vars

# 创建应用（如果 APP_ID 为空）并创建/校准最小权限 feedie-call 角色。
pnpm run setup:realtimekit
```

脚本会输出非敏感的应用 ID，将它填入 `.dev.vars` 的 `REALTIMEKIT_APP_ID`。脚本不会部署 Worker，也不会开通录制、转录或升级套餐。首次创建应用后请保留该 ID，重新运行时会复用已填写的应用。

线上 Worker 的 **Settings → Variables and Secrets** 需要以下三个配置，也可在 Wrangler 登录后逐项录入：

```sh
# 每条命令在交互提示中输入对应值；不要把真实密钥放在命令参数或提交到 Git。
pnpm exec wrangler secret put REALTIMEKIT_ACCOUNT_ID
pnpm exec wrangler secret put REALTIMEKIT_APP_ID
pnpm exec wrangler secret put REALTIMEKIT_API_TOKEN
```

`wrangler.jsonc` 已包含 `CALL_ROOMS` 绑定与 SQLite 类迁移，可用于 Workers Free。构建并部署新版本时会创建该绑定；没有配置凭据时，喂养和同步功能仍可使用，视频页面明确显示服务尚未启用。

### 本地验证

```sh
# 使用隔离的本地数据库，迁移后构建 H5，再启动带 API 的 Worker 预览。
pnpm exec wrangler d1 migrations apply DB --local
pnpm run build
pnpm run dev:worker

# 在真实 workerd/D1/DO 中验证呼叫权限、设备隔离和生命周期；外部供应商接口被隔离替代。
pnpm run test:calls
```

打开本地 Worker 后，在两个浏览器或设备上登录同一账号测试。仅运行 Vite 的 `pnpm run dev` 不提供 Worker API。真实设备需要可访问的 HTTPS 地址及摄像头、麦克风权限。

RealtimeKit 独立于 Workers 计费；配额由整个 Cloudflare 账号共享。参见[当前价目表](https://developers.cloudflare.com/realtime/realtimekit/platform/pricing/)。实现与 SDK 核对见 [接入笔记](docs/realtimekit-integration-notes.md)。
