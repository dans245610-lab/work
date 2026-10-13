// End-to-end checks for Little Hands. Run with: npm install && npm test
// Uses a fake camera, so no real person or webcam is needed.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import fs from "node:fs";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const PORT = 8765, BASE = `http://localhost:${PORT}`;
const launchOpts = {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--enable-unsafe-swiftshader"],
};
let failures = 0;
const check = (ok, label, detail = "") => { if (!ok) failures++; console.log(`${ok ? "✔" : "✘"} ${label}${detail ? `  (${detail})` : ""}`); };

const server = await serve(PORT);
const browser = await chromium.launch(launchOpts);

// Watches every request and console/CSP error on a page.
function audit(page) {
  const a = { requests: [], external: [], errors: [], csp: [] };
  page.on("request", r => { a.requests.push(r.url()); if (!r.url().startsWith(BASE) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) a.external.push(r.url()); });
  page.on("console", m => { if (m.type() === "error" && !/XNNPACK|GL Driver|OpenGL/i.test(m.text())) a.errors.push(m.text()); });
  page.on("pageerror", e => a.errors.push(e.message));
  return a;
}

// ---------------------------------------------------------------- 1. privacy: real camera path
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await ctx.newPage();
  const a = audit(page);
  await page.goto(BASE + "/");
  await page.evaluate(() => document.addEventListener("securitypolicyviolation", e => (window.__csp = (window.__csp || []).concat(e.blockedURI + " " + e.violatedDirective))));
  check(await page.locator("#welcome").evaluate(d => d.open), "welcome & disclaimer dialog shows on first visit");
  await page.click("#welcomeOk");
  await page.click("#startAll");
  await page.waitForFunction(() => document.getElementById("status").hidden || /camera|wrong/i.test(document.getElementById("statusTxt").textContent) && !/Starting|Loading/.test(document.getElementById("statusTxt").textContent), null, { timeout: 120000 });
  await page.waitForTimeout(2000);
  const coach = await page.textContent("#coachTxt");
  check(await page.locator("#status").isHidden(), "camera + hand/body models start", `coach says: "${coach}"`);
  check(await page.locator("#camchip").isVisible(), "camera-on indicator is visible while practising");
  check(a.external.length === 0, "no requests to any other website", a.external.slice(0, 3).join(", "));
  const csp = await page.evaluate(() => window.__csp || []);
  check(csp.length === 0, "no content-security-policy violations", csp.join("; "));
  const models = a.requests.filter(u => /\.task$|\.wasm$/.test(u)).map(u => u.replace(BASE, ""));
  check(models.length >= 3, "models and wasm served locally", models.join(", "));
  await page.click("#homeBtn");
  const camOff = await page.evaluate(() => !document.getElementById("video").srcObject);
  check(camOff, "camera is released when leaving the lesson");
  check(await page.locator("#camchip").isHidden(), "camera-on badge is hidden once the camera is off");
  check(a.errors.length === 0, "no console errors", a.errors.slice(0, 2).join(" | "));
  // Every outbound link opens safely in a new tab.
  const links = await page.goto(BASE + "/about.html").then(() => page.$$eval("a[href^='http']", as => as.map(a => ({ t: a.target, rel: a.rel }))));
  check(links.length > 0 && links.every(l => l.t === "_blank" && /noopener/.test(l.rel) && /noreferrer/.test(l.rel)), "external links open in a new tab with noopener noreferrer", `${links.length} links`);
  await ctx.close();
}

// ---------------------------------------------------------------- 2. offline after first visit
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Warm the cache with the models the way a first lesson would.
  await page.evaluate(async () => { for (const f of ["vendor/mediapipe/vision_bundle.js", "vendor/mediapipe/wasm/vision_wasm_internal.js", "vendor/mediapipe/wasm/vision_wasm_internal.wasm", "models/hand_landmarker.task", "models/pose_landmarker_lite.task"]) await fetch(f); });
  await page.waitForTimeout(1500);
  await ctx.setOffline(true);
  await page.reload();
  const title = await page.title();
  const modelOk = await page.evaluate(() => fetch("models/hand_landmarker.task").then(r => r.ok).catch(() => false));
  check(/Little Hands/.test(title) && modelOk, "works offline after the first visit (app + models cached)");
  await ctx.close();
}

// ---------------------------------------------------------------- 3. all 20 signs + wrong versions (simulated hands)
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await ctx.newPage();
  const a = audit(page);
  await page.goto(BASE + "/#debug");
  await page.evaluate(fs.readFileSync(new URL("./scenes.js", import.meta.url), "utf8"));
  await page.evaluate(() => window.__setup());
  const run = (scene, sign, secs = 4.5) => page.evaluate(([scene, sign, secs]) => window.__runScene(scene, sign, secs), [scene, sign, secs]);
  const ids = ["milk", "more", "eat", "drink", "water", "alldone", "please", "thanks", "yes", "no", "mommy", "daddy", "baby", "iloveyou", "hurt", "help", "sleep", "bath", "book", "play"];
  let passed = 0;
  for (const id of ids) { const r = await run(id, id); if (r.pass) passed++; else console.log(`   ${id} not recognised: ${r.lastHint}`); }
  check(passed === 20, "all 20 signs recognised when done correctly", `${passed}/20`);
  await page.evaluate(() => window.__open("eat"));
  check(await page.locator("#camchip").isHidden(), "camera-on badge never shows while the camera isn't running");
  await page.evaluate(() => window.__home());
  for (const [scene, sign] of [["eat@chest", "eat"], ["daddy@chin", "daddy"], ["please-tiny", "please"], ["mommy-fist", "mommy"], ["mommy-still", "mommy"], ["more-apart", "more"]]) {
    const r = await run(scene, sign, 4);
    check(!r.pass, `rejects wrong version: ${scene}`, r.lastHint.split(" | ").find(x => x.includes("✗")) || "");
  }
  check(a.errors.length === 0, "no console errors during practice", a.errors.slice(0, 2).join(" | "));
  await ctx.close();
}

// ---------------------------------------------------------------- 4. accessibility (axe)
for (const [path, label, prep] of [["/#debug", "home", null], ["/#debug", "lesson panel", p => p.evaluate(() => { window.__noCam = true; window.__open("mommy"); })], ["/about.html", "about page", null]]) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + path);
  if (prep) await prep(page);
  await page.evaluate(AXE);
  const res = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] }));
  const serious = res.violations.filter(v => v.impact === "serious" || v.impact === "critical");
  check(serious.length === 0, `accessibility (WCAG A/AA, serious+critical): ${label}`, serious.map(v => `${v.id} ×${v.nodes.length}`).join(", "));
  await ctx.close();
}

// ---------------------------------------------------------------- 5. phone layout
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 760 } });
  const page = await ctx.newPage();
  for (const path of ["/#debug", "/about.html"]) {
    await page.goto(BASE + path);
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `no sideways scrolling on a phone: ${path}`);
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
