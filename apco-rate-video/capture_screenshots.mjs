// Captures the b-roll screenshots for the APCo video, phone-shaped (1290x2796, iPhone Pro Max size).
// Run on your own machine (it needs normal internet access):
//   npm i -D playwright && npx playwright install chromium
//   node capture_screenshots.mjs
// Output: screenshots/<name>.png (what's visible on screen) and screenshots/<name>_full.png (full page)
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const SHOTS = [
  // name, url, (optional) text to scroll to and highlight
  ['01_news_nextera_dominion_67B', 'https://www.advisorperspectives.com/articles/2026/05/18/nextera-buy-dominion-67-billion-form-power-giant'],
  ['01b_news_nextera_dominion_67B_alt', 'https://abcnews4.com/newsletter-daily/fpl-parent-nextera-energy-moves-to-buy-dominion-energy-in-67b-deal'],
  ['02_news_apco_9-10_a_month', 'https://www.yahoo.com/news/us/articles/virginia-hear-appalachian-power-rate-045200287.html'],
  ['02b_news_apco_61M', 'https://www.thecentersquare.com/virginia/article_b35e3d16-bb4b-4886-8b78-6aab8ab9eab6.html'],
  ['03_news_cardinal_regulators_prepare', 'https://cardinalnews.org/2026/10/01/regulators-prepare-to-hear-appalachian-powers-case-for-raising-rates/'],
  ['04_legal_notice_apco_roe', 'https://dailyprogress.com/ads/community/announcements/legal/ad_bc46e197-e395-557c-9076-c5dd08da82f6.html', 'return on equity'],
  ['05_scc_home', 'https://www.scc.virginia.gov/'],
  ['06_scc_participating_in_cases', 'https://www.scc.virginia.gov/comm/part.aspx', 'Telephone'],
  ['07_scc_public_witness_form', 'https://www.scc.virginia.gov/pages/Public-Witness'],
  ['08_scc_webcasting_oct19', 'https://www.scc.virginia.gov/case-information/webcasting/', 'PUR-2026-00044'],
  ['09_scc_cases_for_comments', 'https://www.scc.virginia.gov/component-library/forms/cases-for-comments/', 'PUR-2026-00044'],
];

mkdirSync('screenshots', { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 15 Pro Max'] });
for (const [name, url, find] of SHOTS) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (find) {
      const loc = page.getByText(find, { exact: false }).first();
      if (await loc.count()) {
        await loc.scrollIntoViewIfNeeded();
        await loc.evaluate(el => { el.style.background = '#ffd23f'; el.style.color = '#0d1726'; el.style.outline = '6px solid #ffd23f'; });
      }
    }
    await page.screenshot({ path: `screenshots/${name}.png` });
    await page.screenshot({ path: `screenshots/${name}_full.png`, fullPage: true });
    console.log('ok  ', name);
  } catch (e) {
    console.log('FAIL', name, e.message.split('\n')[0]);
  }
  await page.close();
}
await browser.close();
