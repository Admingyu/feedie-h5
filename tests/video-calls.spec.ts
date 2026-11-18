import { expect, test, type Page } from "@playwright/test";

// UI 测试隔离供应商网络和摄像头权限，只验证信令到界面的行为；真实媒体需真机联调。
// 执行示例：node node_modules/@playwright/test/cli.js test tests/video-calls.spec.ts --workers=1

/** 为测试页面提供登录、同步与可控的设备信令，待机不加载任何媒体 SDK。 */
async function callPage(page: Page, configured = true) {
  await page.route("**/api/session", route => route.fulfill({ json: { id: "test-user", email: "test@example.test" } }));
  await page.route("**/api/sync", route => route.fulfill({ json: { revision: 1, data: { records: {}, settings: {} } } }));
  await page.route("**/api/calls/config", route => route.fulfill(configured ? { json: { enabled: true } } : { status: 503, json: { error: "视频通话尚未启用，请先完成服务配置" } }));
  /** 测试服务端只模拟协议对端，客户端发送的消息记录供行为断言。 */
  let signal: Parameters<Parameters<Page["routeWebSocket"]>[1]>[0] | undefined;
  const sent: { type: string; id?: string; target?: string; reason?: string }[] = [];
  await page.routeWebSocket("**/api/calls/connect?*", socket => {
    signal = socket;
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      sent.push(message);
      if (message.type === "call") socket.send(JSON.stringify({ type: "ringing", id: "test-call", peer: "另一台设备" }));
      if (message.type === "heartbeat") socket.send(JSON.stringify({ type: "pong" }));
    });
    socket.send(JSON.stringify({ type: "devices", devices: [{ id: "remote", name: "另一台设备", busy: false }] }));
  });
  await page.goto("/h5.html");
  await page.getByRole("button", { name: "打开视频通话", exact: true }).click();
  if (configured) await expect(page.getByRole("button", { name: "呼叫", exact: true })).toBeEnabled();
  else await expect(page.getByRole("alert")).toContainText("视频通话尚未启用");
  return { sent, server: () => signal! };
}

test("standby and cancelling a call do not load the media SDK", async ({ page }) => {
  let sdkRequests = 0;
  page.on("request", request => { if (request.url().includes("@cloudflare_realtimekit")) sdkRequests++; });
  const { sent } = await callPage(page);
  await page.getByRole("button", { name: "呼叫", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "视频通话", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消呼叫", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "取消呼叫", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(sent).toContainEqual({ type: "call", target: "remote" });
  expect(sent).toContainEqual({ type: "end", id: "test-call", reason: "hangup" });
  expect(sdkRequests).toBe(0);
});

test("missing service configuration is visible and never opens a signaling connection", async ({ page }) => {
  const { server } = await callPage(page, false);
  expect(server()).toBeUndefined();
  await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeEnabled();
});

test("incoming call appears above the home screen and allows explicit rejection", async ({ page }) => {
  const { sent, server } = await callPage(page);
  await page.getByRole("button", { name: "返回主页", exact: true }).click();
  server().send(JSON.stringify({ type: "incoming", id: "incoming-call", peer: "另一台设备" }));
  await expect(page.getByRole("button", { name: "接听", exact: true })).toBeVisible();
  await expect(page.locator("main.home")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  expect(sent).toContainEqual({ type: "end", id: "incoming-call", reason: "reject" });
  await expect(page.locator("main.home")).not.toHaveAttribute("inert");
});

test("accepted call exposes mute, camera and hangup controls in landscape", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  // 替代 SDK 的已核对公共接口，验证 UI 连接与退出；不生成真实媒体或访问供应商。
  await page.route("**/@cloudflare_realtimekit.js*", route => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.__videoTestEvents = [];
      // 测试对象只提供界面消费的 SDK 公共方法，状态改变由真实 hook 刷新。
      const self = {
        name: '我', audioEnabled: false, videoEnabled: false,
        // 记录监听注册，无需为本用例生成媒体轨道。
        on() {}, registerVideoElement() {}, deregisterVideoElement() {},
        async enableAudio() { this.audioEnabled = true; },
        async enableVideo() { this.videoEnabled = true; },
        async disableAudio() { this.audioEnabled = false; },
        async disableVideo() { this.videoEnabled = false; },
        cleanUpTracks() { window.__videoTestEvents.push('stop-tracks'); }
      };
      export default class Client {
        // 初始化必须发生在服务器 join 消息后。
        static async init() { window.__videoTestEvents.push('init'); return new Client(); }
        self = self;
        participants = { joined: { on() {}, toArray() { return []; } } };
        // 模拟成功加入与离开。
        async join() { window.__videoTestEvents.push('join'); }
        async leave() { window.__videoTestEvents.push('leave'); }
      }
    `,
  }));
  const { sent, server } = await callPage(page);
  server().send(JSON.stringify({ type: "incoming", id: "joined-call", peer: "另一台设备" }));
  await page.getByRole("button", { name: "接听", exact: true }).click();
  expect(sent).toContainEqual({ type: "accept", id: "joined-call" });
  server().send(JSON.stringify({ type: "join", id: "joined-call", peer: "另一台设备", token: "test-only-token" }));
  await expect(page.getByText("通话中", { exact: true })).toBeVisible();
  const hangup = page.getByRole("button", { name: "挂断", exact: true });
  const bounds = await hangup.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "静音", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消静音", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "关闭摄像头", exact: true }).click();
  await expect(page.getByRole("button", { name: "开启摄像头", exact: true })).toHaveAttribute("aria-pressed", "true");
  await hangup.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __videoTestEvents?: string[] }).__videoTestEvents)).toEqual(["init", "join", "stop-tracks", "leave"]);
});

test("hanging up while SDK initialization is pending prevents a late join", async ({ page }) => {
  await page.route("**/@cloudflare_realtimekit.js*", route => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.__videoTestEvents = [];
      export default class Client {
        // 人为延迟供应商初始化，模拟用户在网络请求结束前挂断。
        static init() {
          return new Promise(resolve => {
            window.__resolveVideoClient = () => resolve({
              self: { cleanUpTracks() { window.__videoTestEvents.push('stop-tracks'); } },
              async join() { window.__videoTestEvents.push('join'); },
              async leave() { window.__videoTestEvents.push('leave'); }
            });
          });
        }
      }
    `,
  }));
  const { server } = await callPage(page);
  server().send(JSON.stringify({ type: "incoming", id: "slow-call", peer: "另一台设备" }));
  await page.getByRole("button", { name: "接听", exact: true }).click();
  server().send(JSON.stringify({ type: "join", id: "slow-call", peer: "另一台设备", token: "test-only-token" }));
  await expect.poll(() => page.evaluate(() => typeof (window as Window & { __resolveVideoClient?: unknown }).__resolveVideoClient)).toBe("function");
  await page.getByRole("button", { name: "挂断", exact: true }).click();
  await page.evaluate(() => (window as Window & { __resolveVideoClient?: () => void }).__resolveVideoClient!());
  await expect.poll(() => page.evaluate(() => (window as Window & { __videoTestEvents?: string[] }).__videoTestEvents)).toEqual(["stop-tracks", "leave"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
