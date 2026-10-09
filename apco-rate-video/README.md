# APCo rate case: vertical video graphics

These are motion graphics for the 2:02 talking-head video (1080×1920, 30 fps) about Appalachian Power's rate case, case number PUR-2026-00044.

- `out/*.webm`: 11 graphics with transparent backgrounds (VP9 with alpha). Each is already trimmed to its spot, so drop it on a track above the A-roll at the **In** time listed below.
- `out/PREVIEW_full_timeline.mp4`: every graphic placed on the timeline over a still frame of the video, with a timecode in the corner. Use it to check timing.
- `graphics/scenes.html`: the source for every animation. Open `graphics/scenes.html?scene=07_roe_bars` in a browser to loop a single scene.
- `render.mjs`: re-renders the clips after you edit anything (`node render.mjs [scene_id]`). It writes lossless QuickTime Animation `.mov` files with alpha to `clips/`. Those files are about 800 MB, so they are left out of git.
- `capture_screenshots.mjs`: captures all of the b-roll screenshots below at phone size (see "Screenshots").

## Graphics timeline

| In | Out | File | On screen | Spoken cue |
|---|---|---|---|---|
| 0:01.0 | 0:06.9 | `01_merger` | Dominion Energy, "$67 BILLION" counting up, takeover by NextEra | "Dominion Energy's 67 billion dollar takeover" |
| 0:09.1 | 0:21.4 | `02_apco_bills_up` | "Appalachian Power, VA's 2nd-largest utility monopoly", then "Your bill could go up again", ≈ +$9.10/mo | "customers of Virginia's second largest…" / "your bills could be going up again" |
| 0:21.4 | 0:28.5 | `03_their_reasons` | APCo's justification: Inflation / Storm recovery / Higher capital costs (each pops in on its word) | "inflation, storm recovery… higher capital costs" |
| 0:28.4 | 0:35.3 | `04_elephant` | 🐘 "The elephant in the room", then "PROFIT: fixed & guaranteed by the state" | "the elephant in the room" |
| 0:35.7 | 0:44.4 | `05_what_is_roe` | "Return on Equity (ROE)" explainer, then a warning that it's one of the biggest drivers of rising bills | "it's referred to as return on equity" |
| 0:44.2 | 0:58.8 | `06_bill_died` | SW VA lawmakers tried to rein in profits, "the bill vs. utility lobby", then a "BILL DIED" stamp | stamp lands on "so ultimately the bill died" |
| 0:59.1 | 1:16.6 | `07_roe_bars` | Bar chart: 9.75% authorized now, growing to 10.50% requested, then "small %, big long-term impact" | "9.75% ROI" / "increase that to 10.5%" |
| 1:16.5 | 1:23.7 | `08_weigh_in` | "It's not too late to weigh in", "from the comfort of your own home" | "the good news is…" |
| 1:23.6 | 1:28.8 | `09_hearing_by_phone` | Calendar card: OCT 19, 10:00 AM, public testimony by phone | "will hear public testimony by phone" |
| 1:28.7 | 1:51.0 | `10_how_to_sign_up` | Five steps that highlight as she says them, then a large case number `PUR-2026-00044` | "to sign up visit…" through the case number |
| 1:51.4 | 2:02.6 | `11_deadline_cta` | "The SCC calls you the morning of Oct. 19", then calendars OCT 15 (register by) and OCT 19 (testify), then "Make your voice heard" | "that's it" through the end |

The cards sit in the lower-middle band, between y ≈ 860 and y ≈ 1760. That keeps them below her face, clear of the TikTok/Reels right-hand buttons, and above the bottom caption and UI area. **If you burn in captions, move them up near her chin (around y 900–1000) or hide them while a card is on screen**, because the cards take the usual caption position.

### Using the WebM files in your editor
- **CapCut, DaVinci Resolve, After Effects (2023+), browsers:** import the `.webm` files directly. The transparency is preserved.
- **Premiere Pro or Final Cut:** convert to ProRes 4444 first:
  ```sh
  for f in out/*.webm; do ffmpeg -c:v libvpx-vp9 -i "$f" -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le "${f%.webm}.mov"; done
  ```
  Or run `node render.mjs` to get lossless `.mov` files.

## Screenshots

These could not be captured from this cloud session because its network policy blocks those websites (scc.virginia.gov, the news sites, and so on). Run `node capture_screenshots.mjs` on your own computer and every one below is saved to `screenshots/` in phone shape (1290×2796). Each comes as a viewport version and a `_full` full-page version, and the key phrase is highlighted in yellow where noted.

| Where in the video | Screenshot | URL |
|---|---|---|
| 0:01–0:09, merger headline | Bloomberg wire: "NextEra to Buy Dominion for $67 Billion…" | https://www.advisorperspectives.com/articles/2026/05/18/nextera-buy-dominion-67-billion-form-power-giant (alternate: https://abcnews4.com/newsletter-daily/fpl-parent-nextera-energy-moves-to-buy-dominion-energy-in-67b-deal) |
| 0:16–0:21, "your bills could go up" | "Virginia to hear Appalachian Power rate hike that could add $9.10 a month" | https://www.yahoo.com/news/us/articles/virginia-hear-appalachian-power-rate-045200287.html |
| 0:21–0:28, APCo's justification | The Center Square: "Appalachian Power seeks to cover $61M with rate increase" | https://www.thecentersquare.com/virginia/article_b35e3d16-bb4b-4886-8b78-6aab8ab9eab6.html |
| 0:59–1:10, 9.75% to 10.5% | APCo legal notice (highlighted: "return on equity") | https://dailyprogress.com/ads/community/announcements/legal/ad_bc46e197-e395-557c-9076-c5dd08da82f6.html |
| 1:10–1:16 (optional) | Cardinal News: "Regulators prepare to hear Appalachian Power's case…" | https://cardinalnews.org/2026/10/01/regulators-prepare-to-hear-appalachian-powers-case-for-raising-rates/ |
| 1:28.8, "visit scc.virginia.gov" | SCC homepage | https://www.scc.virginia.gov/ |
| 1:34–1:41, Cases tab, then "Participating in SCC Cases", then "Testifying by Telephone" | Participating page (highlighted: "Telephone") | https://www.scc.virginia.gov/comm/part.aspx |
| 1:41–1:51, Public Witness form plus case number | Public Witness form page | https://www.scc.virginia.gov/pages/Public-Witness |
| 1:56–2:00, deadline Oct 15 | SCC "Cases for Comments" (highlighted: PUR-2026-00044, deadline 10/15/2026) | https://www.scc.virginia.gov/component-library/forms/cases-for-comments/ |
| (backup) Oct 19 hearing | SCC webcasting page listing the Oct 19 public witness session | https://www.scc.virginia.gov/case-information/webcasting/ |

**For the how-to section (1:28–1:51), screen-record the SCC site on your phone instead of using stills.** Tap Cases, then Participating in SCC Cases, scroll to Testifying by Telephone, and open the Public Witness form. That follows the voiceover exactly, and the site's menus are rendered by JavaScript, so a static screenshot may not show the menu open. `10_how_to_sign_up` can run on top of the recording, or you can drop it while the recording plays.

## Script and fact-check notes
These were checked against the SCC docket and news coverage (Oct 2026):

- **"SEC" should be "SCC".** The regulator is the Virginia **State Corporation Commission (SCC)**, and the website is **scc.virginia.gov**. The voiceover says "SEC" five times, and the auto-captions will repeat it. The graphics use SCC. Consider an ADR fix or correcting the captions at minimum, because a viewer who types "sec.virginia.gov" will not reach the sign-up page.
- **"ROI" should be "ROE"** (return on *equity*). She says "return on equity" correctly and then abbreviates it "ROI". The graphics use ROE.
- **"appco"** in the captions should be **APCo**.
- The facts were confirmed: authorized ROE is 9.75% and APCo requests 10.5%. The total request is about $61.4M per year, roughly +$9.10/month for a 1,000 kWh home after securitization savings. The phone testimony is Oct 19, 2026 at 10 a.m., registration closes Oct 15, and the case is PUR-2026-00044. The NextEra–Dominion deal was announced May 18, 2026 at about $67B in stock.
- An optional stat for the description or a pinned comment: the Attorney General's consumer counsel witness testified that at a 9.325% ROE, APCo would need only about **$1.4M** in new revenue instead of $61.4M (Cardinal News, Oct 1, 2026).
