// Needs playwright-core (not a dependency) and a local Chrome. Run against `npm run dev` (http://localhost:5173, mock).
import { chromium } from "playwright-core"; import fs from "node:fs";
const OUT = "/workspace/decision-engine/web/screenshots"; const URL = "http://localhost:5173";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on("console", m => { if (m.type() === "error") errors.push(m.text()); }); page.on("pageerror", e => errors.push(e.message));
const shot = async n => { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/${n}.png` }); console.log("shot", n); };
const grid = () => page.locator("[role=grid]").focus();
await page.goto(URL + "/inbox"); await page.evaluate(() => { localStorage.clear(); localStorage.setItem("od.theme", "light"); }); await page.reload();
await page.waitForSelector("table.table tbody tr");
await shot("01-inbox");
await page.setViewportSize({ width: 400, height: 860 }); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/01e-inbox-400px.png`, fullPage: true }); console.log("shot 01e", await page.evaluate(() => document.documentElement.scrollWidth));
await page.setViewportSize({ width: 1440, height: 900 });
// Not in catalog sample: low_overlap + none_of_these
await page.click('.sample-chip:has-text("Name mismatch")'); await page.click("button:has-text('Parse order')");
await page.waitForURL(/\/review/); await page.waitForSelector(".line");
console.log("reasons:", (await page.locator(".line-reasons").allInnerTexts()).join(" | ").replace(/\n/g, " "));
await shot("02m-review-low-overlap");
// Hinglish sample → resolve → approve
await page.click("nav >> text=Inbox"); await page.click('.sample-chip:has-text("Hinglish")'); await page.click("button:has-text('Parse order')");
await page.waitForURL(/\/review/); await page.waitForSelector(".line"); await shot("02-review");
await page.setViewportSize({ width: 400, height: 860 }); await shot("02d-review-400px"); await page.setViewportSize({ width: 1440, height: 900 });
for (let k = 0; k < 20 && await page.locator('.line[data-state="pending"]').count(); k++) {
  await grid(); await page.keyboard.press("n"); const cur = page.locator('.line[aria-selected="true"]');
  if ((await cur.getAttribute("data-none")) === "true") { await page.keyboard.press("0"); continue; }
  await page.keyboard.press("1"); await page.waitForTimeout(120);
  if ((await cur.getAttribute("data-state")) === "pending") { await grid(); await page.keyboard.press("u"); await page.keyboard.press("Enter"); }
  if ((await cur.getAttribute("data-state")) === "pending") { await grid(); await page.keyboard.press("0"); }
}
await page.keyboard.press("Control+Enter"); await page.waitForSelector("text=Order approved"); await shot("03a-order-approved");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('Download CSV')")]);
console.log(fs.readFileSync(await dl.path(), "utf8").split("\n").slice(0, 2).join("\n"));
await page.click("nav >> text=Approved"); await page.waitForSelector("table.table"); await page.locator("tbody tr.clickable").first().click(); await shot("03-approved");
// Import
await page.click("nav >> text=Inbox"); await page.click("role=tab[name='Import chat']"); await page.click("text=Sample chat export");
await page.click("button:has-text('Import chat →')"); await page.waitForSelector(".import-result"); await shot("01d-inbox-import-result");
// Stats
await page.click("nav >> text=Stats"); await page.waitForSelector(".kpis"); await shot("05-stats");
// Catalog swap → stale order warnings: open a parsed (unapproved) order after uploading Tally example
await page.click("nav >> text=Catalog"); await page.waitForSelector(".drop"); await page.click("text=Tally-style example"); await page.waitForSelector(".summary-strip");
await page.click("button:has-text('Replace catalog')"); await page.waitForSelector("text=Detected columns");
await page.click("nav >> text=Review"); await page.waitForSelector(".line"); await shot("02n-review-catalog-stale");
await grid(); await page.keyboard.press("n"); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
await page.keyboard.press("Control+Enter"); await page.waitForSelector("text=Order approved"); await page.waitForTimeout(300); await shot("03b-approved-warnings");
await page.click("nav >> text=Catalog"); await page.click("button:has-text('Reset demo data')"); await page.waitForTimeout(800);
// Zero-line order
await page.click("nav >> text=Inbox"); await page.fill("textarea", "Namaste bhai\njaldi bhejna\nthanks"); await page.click("button:has-text('Parse order')");
await page.waitForURL(/\/review/); await page.waitForSelector("text=No product lines found"); await shot("02o-review-no-lines");
console.log("errors:", errors.join("\n") || "none"); await b.close();
