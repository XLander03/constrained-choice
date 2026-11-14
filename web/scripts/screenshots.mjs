// Screenshot/smoke script (dev only). Needs: npm i -D playwright-core, a Chrome at /usr/bin/google-chrome, and npm run dev on :5173 (live.mjs: :5174 with VITE_API_BASE).
import { chromium } from "playwright-core";
import fs from "node:fs";
const OUT = process.env.OUT ?? "/workspace/decision-engine/web/screenshots";
const URL = process.env.URL ?? "http://localhost:5173";
const MOCK = !process.env.LIVE;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, colorScheme: "light" });
const page = await ctx.newPage();
const errors = [];
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") errors.push(m.type() + ": " + m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + e.message));
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log("shot", name); };
const theme = t => page.evaluate(t => { document.documentElement.dataset.theme = t; localStorage.setItem("od.theme", t); }, t);
const grid = () => page.locator("[role=grid]").focus();

async function resolveAll(tag) {
  for (let k = 0; k < 30; k++) {
    if (!(await page.locator('.line[data-state="pending"]').count())) return;
    await grid(); await page.keyboard.press("n");
    const cur = page.locator('.line[aria-selected="true"]'); const idx = await cur.getAttribute("aria-rowindex");
    const row = page.locator(`.line[aria-rowindex="${idx}"]`);
    if ((await cur.locator("select").inputValue()) === "unspecified") await page.keyboard.press("u");
    await page.keyboard.press((await cur.getAttribute("data-none")) === "true" ? "1" : "Enter");
    await page.waitForTimeout(120);
    if ((await row.getAttribute("data-state")) === "pending") {
      if (!(await page.locator(".alts").count())) await page.keyboard.press("a");
      await page.waitForSelector(".alts");
      if (tag) { await shot(tag); tag = null; }
      await page.keyboard.press("1"); await page.waitForTimeout(150);
      if ((await row.getAttribute("data-state")) === "pending") { await grid(); await page.keyboard.press("u"); await page.keyboard.press("Enter"); }
      if ((await row.getAttribute("data-state")) === "pending") { await grid(); await page.keyboard.press("0"); }
    }
  }
}

await page.goto(URL + "/inbox");
await page.evaluate(() => { localStorage.clear(); localStorage.setItem("od.theme", "light"); });
await page.reload();
await page.waitForSelector("table.table tbody tr, .state");
await page.click("text=Hinglish, 5 lines");
await shot("01-inbox");

await page.click("button:has-text('Parse order')");
await page.waitForURL(/\/review/); await page.waitForSelector(".line");
await shot("02-review");
await grid(); await page.keyboard.press("a"); await page.waitForSelector(".alts");
await shot("02b-review-alternatives");
await page.keyboard.press("Escape");
await theme("dark"); await shot("02c-review-dark");
await page.setViewportSize({ width: 400, height: 860 });
await shot("02d-review-400px");
await page.screenshot({ path: `${OUT}/02e-review-400px-full.png`, fullPage: true });
await theme("light"); await shot("02d2-review-400px-light");
await page.setViewportSize({ width: 1440, height: 900 });

await resolveAll("02g-review-fix-line");
await shot("02f-review-resolved");
console.log("approve enabled:", await page.locator("button:has-text('Approve order')").isEnabled());
await page.keyboard.press("Control+Enter");
await page.waitForSelector("text=Order approved");
await shot("03a-order-approved");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('Download CSV')")]);
console.log("download:", dl.suggestedFilename()); console.log(fs.readFileSync(await dl.path(), "utf8"));

await page.click("nav >> text=Approved"); await page.waitForSelector("table.table");
await page.locator("tbody tr.clickable").first().click();
await shot("03-approved");
const [dl2] = await Promise.all([page.waitForEvent("download"), page.locator("tbody tr.clickable").first().locator("button:has-text('CSV')").click()]);
console.log("list download:", dl2.suggestedFilename(), fs.readFileSync(await dl2.path(), "utf8").split("\n").length - 2, "lines");

for (const [label, name] of [["Which pack?", "02h-review-ambiguous"], ["Not in catalog", "02i-review-not-in-catalog"]]) {
  await page.click("nav >> text=Inbox"); await page.waitForSelector(".sample-chip");
  await page.click(`.sample-chip:has-text("${label}")`); await page.click("button:has-text('Parse order')");
  await page.waitForURL(/\/review/); await page.waitForSelector(".line"); await shot(name);
}
await grid(); await page.keyboard.press("a"); await page.waitForSelector(".alts"); await page.keyboard.press("/");
await page.keyboard.type("gillette"); await page.waitForTimeout(500); await shot("02k-review-catalog-search");
await page.keyboard.press("Escape");
await theme("dark"); await shot("02j-review-not-in-catalog-dark"); await theme("light");

await page.click("nav >> text=Stats"); await page.waitForSelector(".kpis"); await shot("05-stats");
await theme("dark"); await shot("05b-stats-dark"); await theme("light");

await page.click("nav >> text=Catalog"); await page.waitForSelector(".drop"); await shot("04-catalog");
await page.click("text=Example with errors"); await page.waitForSelector(".summary-strip"); await shot("04b-catalog-errors");
await page.click("text=Choose another file"); await page.click("text=Tally-style example"); await page.waitForSelector(".summary-strip"); await shot("04c-catalog-preview-ok");
if (MOCK) {
  await page.click("button:has-text('Replace catalog')"); await page.waitForSelector("text=Detected columns"); await page.waitForSelector(".cat-info:has-text('Uploaded')"); await shot("04d-catalog-uploaded");
  await page.click("button:has-text('Reset demo data')"); await page.waitForTimeout(800);
}
await page.click("nav >> text=Inbox"); await page.waitForSelector("table.table tbody tr"); await shot("01b-inbox-after");
await page.goto(URL + "/nope"); await shot("99-not-found");
console.log("errors:", errors.join("\n") || "none");
await browser.close();
