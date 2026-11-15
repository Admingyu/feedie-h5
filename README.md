# Feedie

Feedie 是一款移动端婴儿喂养记录 H5 原型，支持竖屏和横屏。

## 功能

- 显示当前时间、上次喂养时间和奶量、已间隔时长与下次提醒进度。
- 调整本次奶量后，通过独立滑动条记录喂养；记录保存后可短暂撤销。
- 查看喂养历史，支持补录、修改时间和奶量、删除。
- 配置默认奶量、提醒间隔、提前提示、主题、睡眠模式与屏幕常亮。
- 在当前浏览器保存记录，并支持 JSON 导出。
- 横屏主屏采用双栏布局。

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

仓库根目录的 `wrangler.jsonc` 将 `worker/index.js` 与 `dist/client` 静态资源连接起来。Cloudflare Workers Builds 使用：

- 构建命令：`pnpm run build`
- 部署命令：`npx wrangler deploy`
- 根目录：`/`

### Cloudflare Pages

在 Cloudflare Pages 项目设置中使用以下构建配置：

- 构建命令：`pnpm run build:h5`
- 构建输出目录：`dist/client`
- 根目录：仓库根目录

`build:h5` 会生成可直接托管的静态 H5 页面，不需要仓库中的本机 Sites 配置。`build:sites` 单独用于 Sites 打包，并需要未提交的本机 `.openai/hosting.json`。

## 数据与提醒

记录保存在当前浏览器，不会自动同步到其他设备。提醒显示在页面内；关闭页面后不会发送推送通知。屏幕常亮取决于设备和浏览器支持。

## 许可

本项目采用 [定制 GPLv3 衍生非商业许可](LICENSE)。该许可禁止未经书面许可的商业使用；它不是标准 GPL。第三方组件和素材仍适用其各自的许可证。

## 账号与数据同步

在设置中选择「数据同步」，注册或登录后会合并本机和云端的喂养记录与设置。同步由用户手动触发，修改和删除的记录也会同步。字段以设备记录的修改时间为准，请确保设备时间准确。首次同步保留已有本机记录；此后本机同步数据绑定到首次使用的账号。

当前版本使用邮箱和密码登录，尚未提供邮箱验证或密码找回。请妥善保管密码，并在更换设备前完成同步或导出备份。

### 配置 D1

1. 在 Cloudflare 账户创建数据库：`npx wrangler d1 create feedie`。
2. 将命令输出的数据库 ID 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id`。
3. 执行 `npx wrangler d1 migrations apply feedie --remote` 初始化线上数据库，再构建并部署 Worker。

本地调试可先执行 `npx wrangler d1 migrations apply feedie --local`，然后运行 `pnpm run build` 和 `npx wrangler dev --local`。本地数据库和线上数据库互不影响。Cloudflare Pages 的纯静态构建无法提供登录和同步 API，需要使用 Worker 部署。
