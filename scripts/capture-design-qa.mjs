import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

await mkdir("qa", { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
for (const [name, width, height] of [["portrait", 390, 844], ["landscape", 844, 390]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto("http://127.0.0.1:4173/h5.html?demo=1", { waitUntil: "networkidle" });
  await page.screenshot({ path: `qa/${name}.png` });
  await page.close();
}
await browser.close();
