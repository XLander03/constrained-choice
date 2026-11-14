// Needs playwright-core and real backends; see README "Screenshots". Token below is a local test value, not a secret.
import { chromium } from "playwright-core";
const OUT = "/workspace/decision-engine/web/screenshots";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const shot = async n => { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${n}.png` }); console.log("shot", n); };
// Token: UI on :5174 → backend :8787 (API_TOKEN set)
await page.goto("http://localhost:5174/inbox"); await page.evaluate(() => { sessionStorage.clear(); localStorage.setItem("od.theme","light"); }); await page.reload();
await page.waitForSelector(".gate input[type=password]"); await shot("07-token-prompt");
await page.fill(".gate input[type=password]", "wrong-token-000000000000"); await page.click(".gate button[type=submit]");
await page.waitForSelector("text=rejected", { timeout: 8000 }).catch(() => {}); await shot("07b-token-rejected");
await page.fill(".gate input[type=password]", "test-token-0123456789abcdef"); await page.click(".gate button[type=submit]");
await page.waitForSelector(".gate", { state: "detached", timeout: 10000 }); await page.waitForSelector("textarea", { timeout: 10000 }); await page.waitForTimeout(1500);
await shot("07c-token-accepted-live-inbox");
const bundleHasToken = await page.evaluate(async () => { const srcs=[...document.scripts].map(s=>s.src).filter(Boolean); let t=""; for (const s of srcs) t+=await (await fetch(s)).text(); return t.includes("test-token-0123456789abcdef"); });
console.log("token in served scripts:", bundleHasToken, "sessionStorage:", await page.evaluate(() => JSON.stringify(sessionStorage)));
// Too many lines (live backend): 401 lines
await page.fill("textarea", Array.from({ length: 401 }, (_, i) => `parle g ${i % 9 + 1} peti`).join("\n"));
await page.click("button:has-text('Parse order')"); await page.waitForSelector("text=split the order", { timeout: 15000 });
console.log("retry buttons:", await page.locator("button:has-text('Retry')").count()); await shot("08-error-too-many-lines");
// Origin blocked: UI on :5175 → backend :8788 (ALLOWED_ORIGINS=http://localhost:5173)
await page.goto("http://localhost:5175/inbox"); await page.waitForSelector("text=allowed", { timeout: 10000 }); await shot("08b-error-origin-blocked");
await b.close();
