// Screenshot/smoke script (dev only). Needs: npm i -D playwright-core, a Chrome at /usr/bin/google-chrome, and npm run dev on :5173 (live.mjs: :5174 with VITE_API_BASE).
import { chromium } from "playwright-core";
const URL = process.env.URL ?? "http://localhost:5173"; const OUT = process.env.OUT ?? "/workspace/decision-engine/web/screenshots";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("console", m => { if (m.type() === "error") errors.push(m.text()); }); page.on("pageerror", e => errors.push(e.message));
await page.goto(URL + "/inbox"); await page.evaluate(() => { localStorage.clear(); localStorage.setItem("od.theme","light"); }); await page.reload();
await page.click("role=tab[name='Import chat']"); await page.click("text=Sample chat export");
await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/01c-inbox-import-chat.png` });
await page.click("button:has-text('Import chat →')"); await page.waitForSelector(".import-result");
await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/01d-inbox-import-result.png` });
console.log(await page.locator(".import-result").innerText());
await page.click("text=Review first order →"); await page.waitForSelector(".line"); await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02l-review-from-chat-import.png` });
console.log("errors:", errors.join("\n") || "none"); await b.close();
