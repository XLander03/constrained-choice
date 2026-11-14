// Screenshot/smoke script (dev only). Needs: npm i -D playwright-core, a Chrome at /usr/bin/google-chrome, and npm run dev on :5173 (live.mjs: :5174 with VITE_API_BASE).
import { chromium } from "playwright-core"; import fs from "node:fs";
const URL = "http://localhost:5174"; const OUT = "/workspace/decision-engine/web/screenshots";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = []; page.on("console", m => { if (m.type() === "error") errors.push(m.text()); }); page.on("pageerror", e => errors.push(e.message));
const reqs = []; page.on("request", r => { if (r.url().includes(":8787")) reqs.push(r.method() + " " + r.url().replace("http://localhost:8787", "")); });
await page.goto(URL + "/inbox"); await page.evaluate(() => localStorage.setItem("od.theme","light")); await page.reload();
await page.waitForSelector(".panel");
await page.click("text=Hinglish, 5 lines"); await page.click("button:has-text('Parse order')");
await page.waitForURL(/\/review/); await page.waitForSelector(".line");
await page.screenshot({ path: `${OUT}/06-live-review.png` });
// resolve: for every pending line press n then Enter / 1 / 0
for (let k = 0; k < 20 && await page.locator('.line[data-state="pending"]').count(); k++) {
  await page.locator("[role=grid]").focus(); await page.keyboard.press("n");
  const cur = page.locator('.line[aria-selected="true"]');
  await page.keyboard.press((await cur.getAttribute("data-none")) === "true" ? "0" : "Enter"); await page.waitForTimeout(150);
  if ((await cur.getAttribute("data-state")) === "pending") { await page.keyboard.press("Escape"); await page.locator("[role=grid]").focus(); await page.keyboard.press("0"); }
}
await page.keyboard.press("Control+Enter"); await page.waitForSelector("text=Order approved");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('Download CSV')")]);
console.log("csv", dl.suggestedFilename()); console.log(fs.readFileSync(await dl.path(), "utf8"));
await page.screenshot({ path: `${OUT}/06b-live-approved.png` });
await page.click("nav >> text=Inbox"); await page.click("role=tab[name='Import chat']"); await page.click("text=Sample chat export");
await page.click("button:has-text('Import chat →')"); await page.waitForSelector(".import-result");
console.log((await page.locator(".import-result").innerText()).split("\n").slice(0, 3).join(" | "));
await page.click("nav >> text=Stats"); await page.waitForSelector(".kpis"); await page.screenshot({ path: `${OUT}/06c-live-stats.png` });
await page.click("nav >> text=Approved"); await page.waitForSelector("table.table");
await page.click("nav >> text=Catalog"); await page.waitForSelector(".cat-info");
console.log("requests:", [...new Set(reqs)].join("\n  "));
console.log("errors:", errors.join("\n") || "none"); await b.close();
