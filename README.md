# 📍 LeadPin — Google Maps Lead Scraper

**100% local. No server, no login, no license.** Everything runs inside your own Chrome — no data ever leaves your machine.

LeadPin extracts business **leads** from Google Maps (phone, address, email, decision-maker), **verifies / cleans** them, and exports to **Excel / CSV / Google Sheets**.

> ⚠️ **Disclaimer:** Scraping Google Maps may violate Google's Terms of Service. This tool is for **educational and personal use only**. You are responsible for complying with Google's Terms, applicable laws (data-protection, anti-spam), and the rights of the people whose data you collect.

---

## 📸 Screenshots

_Coming soon._

<!-- Add PNGs to the screenshots/ folder, then uncomment:
| Panel on Google Maps | Verify & clean |
|---|---|
| ![LeadPin panel](screenshots/panel.png) | ![Verify](screenshots/verify.png) |
-->

---

## 🧩 Install (one time)

1. Open `chrome://extensions` in Chrome
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** → select the `lead-scraper` folder
4. The **📍 LeadPin** icon appears in your toolbar

> After changing the code: click the **🔄 refresh** on the LeadPin card in `chrome://extensions`, then reload the Google Maps tab.

---

## ▶️ Basic use (30 seconds)

1. Open **Google Maps** → run a search (e.g. `restaurants lahore`, `dentist karachi`)
2. The **LeadPin panel** appears on the right
3. Open **Options** → set **Target leads** (e.g. 20) — or 0 = all
4. Click **▶ Start**
5. A spinner + progress bar run. Status shows: *Collected… → Opening X/N… → Done*
6. Export with **⬇ Excel / CSV / Sheets**

---

## 🔄 How it works (4 phases)

| Phase | What it extracts | Reliability |
|-------|------------------|-------------|
| **1. List harvest** | Business name, rating, reviews, category, Maps URL (auto-scroll) | ✅ High |
| **2. Deep enrich** | Phone, address, website, hours (opens each place) | ✅ High |
| **3. Website enrich** | Email, contact person, Facebook, Instagram (from the website) | ⚠️ When a site exists |
| **4. LinkedIn** | Decision-maker name + title (via Google search) | ⚠️ Best-effort |

---

## ⚙️ Sections in detail

### Header
- **📍 count** — leads collected so far
- **🔄 spinner** — scraping is running
- **🌙 / ☀️** — light/dark theme toggle
- **–** — minimize the panel

### Stat chips
`leads` · `A-grade` · `phone` · `email` — live counts.

### Controls
- **Start** — begin scraping
- **Stop** — stop instantly (collected leads stay and can be exported)
- **Resume** — appears only when auto-paused on a CAPTCHA → solve it, then continue
- **✕ Clear** — clears **leads only** (settings/filters are kept)

### Export buttons
- **📊 Sheets** — copies data to clipboard and opens a new Google Sheet → paste at **A1** (Ctrl/Cmd+V)
- **⬇ Excel** — downloads a `.xls` file
- **⬇ CSV** — downloads a `.csv` file
- **⧉** — copies the full CSV to clipboard
- **📧** — copies **all emails** to clipboard (for bulk outreach)

### ⚙️ Options
- **Target leads** — how many leads you want (stops automatically). `0` = all.
- **Default country code** — for WhatsApp links (e.g. `92` PK, `1` USA, `44` UK). A lead's country is auto-detected from its address too; this is the fallback.
- **Fresh search** (ON) — a new Start clears old leads and scrapes only the current search
- **Deep enrich** (ON) — extracts phone + address (essential)
- **Email + contact person** (ON) — email/person from the website
- **Decision-maker (LinkedIn)** (ON) — LinkedIn decision-maker via Google
- **Speed** — Fast / Normal / **Safe** (slower, avoids blocks — recommended for large jobs)

### 🔁 Multi-search queue
One search per line:
```
dentist Lahore
gym Karachi
restaurant Islamabad
```
**Start** runs each search **one by one** (the tab navigates automatically) and collects all leads. Leave empty to use whatever search is currently open.

### 🎯 Filters (applied on export)
- **Preset** — one-click targeting: No website / Top rated / Popular / Needs help / Has email / Outreach-ready
- **Min/Max rating**, **Min/Max reviews**
- **Only without website** — great for web-design leads
- **Only with email**, **Only outreach-ready**
- **Min confidence** — export only verified High/Medium leads
- **Reset filters** (link) — clears filters only (leads are safe)

### 📋 Import existing (duplicate skip)
Paste your previously-contacted list (phone/email, one per line) → **Apply import**. Any match is flagged **"Already Have"** so you don't contact them twice.

### ✅ Verify & clean
Two jobs:
1. **Verify scraped leads** — verifies the leads you just scraped (fills email/website/confidence columns)
2. **Clean** — normalizes phone/email/name formatting

**Verify your own CSV (any format):**
1. **Choose File** → select your CSV
2. **Column mapping** dropdowns appear — tell it which column is Email/Phone/Website/Name/Address (auto-guessed; fix if wrong)
3. **Verify CSV** → checks each row (email MX, website live, phone format, duplicates, confidence) → auto-downloads `verified.csv`
4. **Verify on Maps** → searches each business on Maps for the real address/phone and compares → verdict (Verified ✓ / differs / not found) → auto-downloads `maps-verified.csv`
   - **Location hint** field — type a city/country (e.g. `Lahore, Pakistan`) so address-less rows match the right region

> **CSV format:** needs at least one of **Email / Phone / Website**. Business Name is optional. Extra columns are ignored. Use **Download sample template** for a ready-made file.

### 📑 Export columns
31 columns; tick which ones to export. 13 essentials are on by default (name, phone, email, address, city, website, category, rating…). The rest (zipcode, country, LinkedIn, social, status, hours…) are off by default.

### 💾 Saved lists
Save the current leads under a **name** (e.g. "Dentists Lahore") → **Load / Delete** later. Keep separate niches/cities in separate lists.

### 📊 Stats
A summary of your leads: % with phone/email/website, grade A/B/C counts, average rating, "no-website" count.

### 🧠 Lead detail (click a table row)
Full lead card + **Status** (New/Contacted/Replied/Won/Lost) + **Notes** (mini-CRM) + Copy + Delete.

---

## 📊 What the columns mean

| Column | Meaning |
|--------|---------|
| Lead Score | A/B/C (how contactable + quality) |
| Status / Notes | CRM — you set these |
| Outreach Ready | has at least one of email/phone/WhatsApp |
| Already Have | was already in your imported list |
| WhatsApp | wa.me link (built from the country code) |
| Confidence | after verify: High/Medium/Low |
| Email/Website Status | verify result (Deliverable, Dead, etc.) |

---

## 🛡️ Avoiding blocks (anti-detection)
- Runs in **your own browser** → looks like normal browsing to Google
- **Human-like delays** + micro-breaks + variable scrolling
- Use **Speed = Safe** for large jobs (especially with LinkedIn on)
- On a CAPTCHA the extension **auto-pauses and asks you to Resume** → solve it, then continue

---

## ⚠️ Honest limitations
- **Email/person** only where the business has a **website** (small shops/restaurants often don't)
- **LinkedIn** decision-maker depends on Google results (not always found — but you always get a clickable search link)
- **Email verify** is domain-level (MX) — a browser cannot confirm whether a specific inbox exists
- **Phone verify** is a format check — it cannot confirm a live number without calling
- Bulk-scraping Maps may violate Google's Terms — use responsibly

---

## 🛠️ Troubleshooting

**Panel appears but Start finds 0 leads / fields are empty.**
Google periodically changes its Maps HTML, which breaks the CSS selectors. The status line will warn: *"Results shown but nothing scraped — Google likely changed its DOM."*

Fix: open **`content.js`** and update the **`SEL` object** near the top (it has a comment on each selector). The usual culprits:
- `SEL.card` / `SEL.link` / `SEL.name` — list items (phase 1)
- `SEL.dAddress` / `SEL.dPhone` / `SEL.dWebsite` — detail panel (these use stable `data-item-id` and rarely change)

To find a new selector: right-click a result → **Inspect** → note the class/attribute, and update the matching line in `SEL`. Then reload the extension.

**Google shows a CAPTCHA.** You're going too fast. Set **Speed = Safe**, solve the CAPTCHA, and click **Resume**. The extension auto-pauses on blocks.

**WhatsApp column is empty.** Local numbers (e.g. `03xx`) need a country code. Set **Default country code** in Options (e.g. `92`), or make sure the address includes the country.

**Verify CSV rejects the file.** Use the **column mapping** dropdowns to point Email/Phone/Website at the right columns — any format works.

---

## 🔒 Privacy

- **Everything stays local.** Scraped leads live only in your browser's `chrome.storage`. Nothing is sent to any server owned by this project (there is none).
- **The "Decision-maker (LinkedIn)" option** searches Google (`site:linkedin.com/in`) to find an owner/decision-maker name. That Google search is sent **with your own Google cookies** (`credentials: include`) so it looks like a normal logged-in search and triggers fewer CAPTCHAs. It never touches LinkedIn directly, and the results stay on your machine.
  - This feature is **optional** — turn off **Decision-maker (LinkedIn)** in Options if you'd rather not use your Google session.
- **Website/email enrichment** fetches each lead's own website from your machine to look for a contact email. Loopback/private/metadata hosts are blocked. Fetched pages are only scanned locally with regex and never stored or uploaded.

---

## 📦 Technical
- **100% local** — no server/API/login. Data lives in `chrome.storage` (your browser).
- **Size:** ~160 KB (plain JS, no framework)
- **Files:** `manifest.json`, `content.js`, `background.js`, `content.css`, `popup.html`, `icons/`

## 📄 License
MIT — see [LICENSE](LICENSE).
