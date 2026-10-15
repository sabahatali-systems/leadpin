/* =========================================================================
   LeadPin  —  content script
   Extracts business leads from Google Maps search results.
   100% local. No server, license or auth.

   PHASES:
     1) List harvest   -> business name, maps url, (rough) rating/reviews
     2) Deep enrich    -> open each place for PHONE / ADDRESS / WEBSITE
                          (stable data-item-id selectors)
     3) Website enrich -> EMAIL + CONTACT PERSON (from background.js)
   ========================================================================= */

(() => {
  "use strict";

  if (window.__leadScraperLoaded) return;
  window.__leadScraperLoaded = true;

  const state = {
    running: false,
    stopRequested: false,
    deepEnrich: true,
    findEmails: true,
    findLinkedin: true,
    targetCount: 0, // 0 = all; otherwise stop at this many leads
    countryCode: "92", // default WhatsApp/intl code (Pakistan). user badal sakta hai
    speed: 1, // 0.6 fast · 1 normal · 1.8 safe (avoid blocks)
    filters: {
      minRating: 0,
      maxRating: 0, // 0 = no limit
      minReviews: 0,
      maxReviews: 0, // 0 = no limit
      onlyNoWebsite: false,
      onlyWithEmail: false,
      onlyOutreachReady: false,
    },
    paused: false,
    rows: [],
    seen: new Set(),
    known: new Set(), // imported existing list (phone/email) -> mark duplicates
  };

  const MAX_ROWS = 8000; // safety cap so memory/Chrome doesn't fill up

  // interruptible sleep: a running delay is cancelled instantly on Stop/Pause
  const _pendingSleeps = new Set();
  function sleep(ms) {
    if (state.stopRequested) return Promise.resolve(); // already stopped -> resolve immediately
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        _pendingSleeps.delete(entry);
        resolve();
      }, ms);
      _pendingSleeps.add(entry);
    });
  }
  function cancelSleeps() {
    for (const e of _pendingSleeps) {
      clearTimeout(e.timer);
      e.resolve();
    }
    _pendingSleeps.clear();
  }
  // human-like random delay (to avoid blocks). speed = multiplier.
  const jitter = (base) => {
    const mult = state.speed; // 0.6 fast, 1 normal, 1.8 safe
    let v = base * mult * (0.7 + Math.random() * 0.8); // wider spread
    if (Math.random() < 0.12) v += 1000 + Math.random() * 2500; // kabhi "reading" pause
    return sleep(Math.round(v));
  };

  // micro-break: a longer random pause every few actions (breaks robotic rhythm)
  let _actionCount = 0;
  async function microBreak() {
    _actionCount++;
    const every = 14 + Math.floor(Math.random() * 8);
    if (_actionCount % every === 0) {
      const p = (3500 + Math.random() * 5000) * state.speed;
      setStatus("☕ Short human break (avoid blocks)…");
      await sleep(p);
    }
  }

  // ---------- persistence (leads survive reloads) ----------
  const STORE_KEY = "leadScraperRows";
  const JOB_KEY = "leadScraperJob"; // multi-query queue (runs across page reloads)

  async function saveStateNow() {
    try {
      const clean = state.rows.map(({ _card, ...r }) => r);
      await chrome.storage.local.set({ [STORE_KEY]: clean });
    } catch (_) {}
  }
  // debounced: avoid serializing the big array repeatedly (anti-freeze)
  let _saveTimer = null;
  function saveState() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveStateNow, 800);
  }
  async function loadState() {
    try {
      const got = await chrome.storage.local.get(STORE_KEY);
      const rows = got && got[STORE_KEY];
      if (Array.isArray(rows) && rows.length) {
        state.rows = rows;
        state.seen = new Set(rows.map((r) => r.mapsUrl || r.businessName));
      }
    } catch (_) {}
  }
  async function saveJob(job) {
    try {
      await chrome.storage.local.set({ [JOB_KEY]: job });
    } catch (_) {}
  }
  async function getJob() {
    try {
      const got = await chrome.storage.local.get(JOB_KEY);
      return (got && got[JOB_KEY]) || null;
    } catch (_) {
      return null;
    }
  }
  async function clearJob() {
    try {
      await chrome.storage.local.remove(JOB_KEY);
    } catch (_) {}
  }

  async function waitFor(fn, timeout = 6000, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (state.stopRequested) return null; // Stop -> wait chhodo
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // ---------- selectors ----------
  const SEL = {
    feed: 'div[role="feed"]',
    card: 'div[role="feed"] > div > div[jsaction]',
    link: 'a.hfpxzc, a[href*="/maps/place/"]',
    name: ".qBF1Pd, .fontHeadlineSmall",
    rating: ".MW4etd",
    reviews: ".UY7F9",
    info: ".W4Efsd",
    endText: "You've reached the end of the list",
    // --- detail panel (zyada stable: data-item-id) ---
    dAddress: 'button[data-item-id="address"]',
    dPhone: 'button[data-item-id^="phone:tel:"]',
    dWebsite: 'a[data-item-id="authority"]',
    dValue: ".Io6YTe", // value text inside the button/anchor
    dCategory: 'button[jsaction*="category"], .DkEaL',
    dHours: 'button[data-item-id="oh"], [jsaction*="openhours"], .t39EBf',
    dTitle: "h1.DUwDvf, h1.fontHeadlineLarge",
    backBtn:
      'button[aria-label="Back"], button[jsaction*="back"], button.hYBOP',
  };


  // ---------- phase 1: list ----------
  function getCards() {
    return Array.from(document.querySelectorAll(SEL.card)).filter(
      (c) => (c.innerText || "").length > 40
    );
  }

  // a blank lead object (single source of truth so no field is missed)
  function blankRow(name = "", url = "") {
    return {
      businessName: (name || "").trim(),
      leadScore: "",
      leadStatus: "", // CRM: New / Contacted / Replied / Won / Lost
      notes: "", // CRM: user notes
      outreachReady: "",
      alreadyHave: "",
      person: "",
      personTitle: "",
      phone: "",
      whatsapp: "",
      email: "",
      address: "",
      zipcode: "",
      city: "",
      country: "",
      website: "",
      linkedin: "",
      linkedinSearch: "",
      facebook: "",
      instagram: "",
      category: "",
      rating: "",
      reviews: "",
      businessHours: "",
      openStatus: "",
      latitude: "",
      longitude: "",
      emailStatus: "",
      websiteStatus: "",
      confidence: "",
      mapsUrl: url,
      _card: null, // runtime only, not exported to CSV
    };
  }

  function extractCard(card) {
    const link = card.querySelector(SEL.link);
    const url = link ? link.href.split("?")[0] : "";
    let name =
      (link && link.getAttribute("aria-label")) ||
      ((card.querySelector(SEL.name) || {}).textContent || "").trim();
    // Google appends "· Visited link" to visited places — strip it
    name = name.replace(/\s*[·•]?\s*Visited link\s*$/i, "").trim();

    const rating = ((card.querySelector(SEL.rating) || {}).textContent || "").trim();
    const reviews = (((card.querySelector(SEL.reviews) || {}).textContent) || "")
      .replace(/[(),]/g, "")
      .trim();

    // category: take only a clean token from the card (reject rating/price/hours).
    // do NOT take address from the card — it's flaky; deep enrich (detail panel) provides it.
    const infoLines = Array.from(card.querySelectorAll(SEL.info))
      .map((x) => (x.textContent || "").trim())
      .filter(Boolean);
    let category = "";
    for (const line of infoLines) {
      let first = line.split("·")[0].trim();
      // strip hours/status stuck onto the category (e.g. "BreakfastOpen 24 hours")
      first = first
        .replace(/(open|closed|closes|opens|permanently|temporarily)[\s\S]*$/i, "")
        .trim();
      if (!first || /^[\d+]/.test(first)) continue; // rating/price/plus-code
      if (/Rs\s|\$|₹|★|\d\s*[ap]m/i.test(first)) continue; // price/hours
      category = first;
      break;
    }

    const row = blankRow(name, url);
    row.rating = rating;
    row.reviews = reviews;
    row.category = category;
    return row;
  }

  // single-place result (when a search matches only 1 business, there is no feed)
  function harvestSinglePlace() {
    const titleEl = document.querySelector(SEL.dTitle);
    if (!titleEl) return 0;
    const key = location.href.split("?")[0];
    if (state.seen.has(key)) return 0;
    const row = blankRow(titleEl.textContent, key);
    const d = scrapeDetailPanel();
    if (d.address) row.address = d.address;
    if (d.phone) row.phone = d.phone;
    if (d.website) row.website = d.website;
    if (d.category) row.category = d.category;
    if (d.businessHours) row.businessHours = d.businessHours;
    if (d.openStatus) row.openStatus = d.openStatus;
    deriveFields(row);
    if (!row.businessName) return 0;
    state.seen.add(key);
    if (!passesHarvestFilter(row)) return 0;
    state.rows.push(row);
    renderTable();
    return 1;
  }

  // ---------- derived fields (zipcode, city, country, lat/lng, whatsapp) ----------
  function parseAddress(addr) {
    const out = { zipcode: "", city: "", country: "" };
    const zipM =
      addr.match(/\b\d{5}(?:-\d{4})?\b/) || // US / PK / EU-5
      addr.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/) || // UK
      addr.match(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/); // CA
    if (zipM) out.zipcode = zipM[0].trim();

    const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) {
      const last = parts[parts.length - 1];
      if (/^[A-Za-z .'\-]+$/.test(last) && parts.length > 1) out.country = last;

      let idx = out.zipcode
        ? parts.findIndex((p) => p.includes(out.zipcode))
        : -1;
      if (idx >= 0) {
        const same = parts[idx].replace(out.zipcode, "").trim();
        out.city = same || parts[idx - 1] || "";
      } else {
        out.city = out.country ? parts[parts.length - 2] || "" : last;
      }
      out.city = (out.city || "").replace(/\d{4,6}(-\d{4})?/g, "").trim();
      // sanity: numeric-only ya hours/price jaisi junk city reject
      if (/^[\d\s]*$/.test(out.city) || /Clos|Open|[AP]M|Rs\s/i.test(out.city))
        out.city = "";
    }
    return out;
  }

  // country naam -> international calling code (world-wide)
  const COUNTRY_CODES = {
    pakistan: "92", india: "91", bangladesh: "880", srilanka: "94", "sri lanka": "94",
    nepal: "977", afghanistan: "93", "united states": "1", usa: "1", us: "1", america: "1",
    canada: "1", "united kingdom": "44", uk: "44", england: "44", britain: "44",
    "united arab emirates": "971", uae: "971", "saudi arabia": "966", ksa: "966",
    qatar: "974", kuwait: "965", oman: "968", bahrain: "973", jordan: "962", lebanon: "961",
    australia: "61", "new zealand": "64", germany: "49", france: "33", italy: "39",
    spain: "34", netherlands: "31", belgium: "32", switzerland: "41", austria: "43",
    sweden: "46", norway: "47", denmark: "45", finland: "358", ireland: "353",
    portugal: "351", greece: "30", poland: "48", russia: "7", ukraine: "380",
    turkey: "90", türkiye: "90", egypt: "20", morocco: "212", algeria: "213", tunisia: "216",
    nigeria: "234", ghana: "233", kenya: "254", "south africa": "27", ethiopia: "251",
    tanzania: "255", uganda: "256", china: "86", japan: "81", "south korea": "82",
    korea: "82", indonesia: "62", malaysia: "60", singapore: "65", thailand: "66",
    vietnam: "84", philippines: "63", "hong kong": "852", taiwan: "886",
    brazil: "55", mexico: "52", argentina: "54", colombia: "57", chile: "56", peru: "51",
    iran: "98", iraq: "964", israel: "972", syria: "963", yemen: "967",
  };
  function countryToCode(name) {
    if (!name) return "";
    const k = String(name).toLowerCase().trim().replace(/\.$/, "");
    return COUNTRY_CODES[k] || "";
  }

  function deriveFields(row) {
    // lat/lng from the maps url (!3d!4d is most accurate, else @lat,lng)
    if (!row.latitude && row.mapsUrl) {
      const m =
        row.mapsUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
        row.mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (m) {
        row.latitude = m[1];
        row.longitude = m[2];
      }
    }
    // address -> zip/city/country
    if (row.address && (!row.zipcode || !row.city)) {
      const a = parseAddress(row.address);
      if (a.zipcode && !row.zipcode) row.zipcode = a.zipcode;
      if (a.city && !row.city) row.city = a.city;
      if (a.country && !row.country) row.country = a.country;
    }
    // whatsapp link (world-wide): use + if the number has it; otherwise the lead's country
    // for an auto code, otherwise the user's default country code
    if (row.phone) {
      let d = row.phone.replace(/[^\d+]/g, "");
      if (!d.startsWith("+")) {
        const cc = (
          countryToCode(row.country) ||
          state.countryCode ||
          ""
        ).replace(/\D/g, "");
        if (cc) {
          if (d.startsWith("0")) d = "+" + cc + d.slice(1); // local 0xx
          else if (d.length >= 6 && d.length <= 11) d = "+" + cc + d;
        }
      }
      row.whatsapp = /^\+\d{8,15}$/.test(d) ? "https://wa.me/" + d.slice(1) : "";
    }
    scoreLead(row);
    // mark duplicates against the imported existing list
    if (state.known && state.known.size) {
      const ph = normPhone(row.phone);
      const em = (row.email || "").toLowerCase();
      row.alreadyHave =
        (ph && state.known.has("p:" + ph)) || (em && state.known.has("e:" + em))
          ? "Yes"
          : "";
    }
  }

  // lead score A/B/C + outreach-ready flag (kitna contactable + quality)
  function scoreLead(row) {
    let s = 0;
    if (row.phone) s += 2;
    if (row.email) s += 3;
    if (row.whatsapp) s += 1;
    if (row.person) s += 2;
    if (row.website) s += 1;
    if (num(row.rating) >= 4) s += 1;
    if (num(row.reviews) >= 10) s += 1;
    row.leadScore = s >= 7 ? "A" : s >= 4 ? "B" : "C";
    // a direct outreach channel + a business name
    row.outreachReady =
      row.businessName && (row.email || row.whatsapp || row.phone) ? "Yes" : "";
  }

  // ---------- filters + dedupe ----------
  const num = (v) => {
    const n = parseFloat(String(v).replace(/,/g, ""));
    return isNaN(n) ? 0 : n;
  };

  // at harvest time, only the filters known from the card (rating/reviews)
  function passesHarvestFilter(row) {
    const f = state.filters;
    if (f.minRating && num(row.rating) < f.minRating) return false;
    if (f.maxRating && num(row.rating) > f.maxRating) return false;
    if (f.minReviews && num(row.reviews) < f.minReviews) return false;
    if (f.maxReviews && num(row.reviews) > f.maxReviews) return false;
    return true;
  }

  // full filters at export time (known after website/email enrich)
  function passesFilter(row) {
    if (!passesHarvestFilter(row)) return false;
    const f = state.filters;
    if (f.onlyNoWebsite && row.website) return false;
    if (f.onlyWithEmail && !row.email) return false;
    if (f.onlyOutreachReady && !row.outreachReady) return false;
    if (f.minConfidence === "High" && row.confidence !== "High") return false;
    if (f.minConfidence === "Med" && !["High", "Medium"].includes(row.confidence))
      return false;
    return true;
  }

  const normPhone = (p) => (p || "").replace(/\D/g, "").replace(/^0+/, "");
  const host = (u) => {
    try {
      return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).host.replace(
        /^www\./,
        ""
      );
    } catch (_) {
      return "";
    }
  };

  // merge duplicates by phone/website (across runs too, since rows persist)
  function dedupeRows() {
    const out = [];
    const byKey = new Map();
    for (const r of state.rows) {
      const keys = [];
      const ph = normPhone(r.phone);
      if (ph.length >= 7) keys.push("p:" + ph);
      const h = host(r.website);
      if (h) keys.push("w:" + h);
      // fuzzy: same business name + city — only when a city exists (otherwise
      // distinct businesses with an empty city were wrongly merged)
      const nm = (r.businessName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const ct = (r.city || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (nm.length > 3 && ct.length > 1) keys.push("n:" + nm + "|" + ct);

      let target = null;
      for (const k of keys)
        if (byKey.has(k)) {
          target = byKey.get(k);
          break;
        }

      if (target) {
        // fill empty fields of the target (make a more complete lead)
        for (const [field] of COLS)
          if (!target[field] && r[field]) target[field] = r[field];
        for (const k of keys) if (!byKey.has(k)) byKey.set(k, target);
      } else {
        out.push(r);
        for (const k of keys) byKey.set(k, r);
      }
    }
    state.rows = out;
  }

  function harvestVisible() {
    let added = 0;
    for (const card of getCards()) {
      const link = card.querySelector(SEL.link);
      const key = (link && link.href.split("?")[0]) || card.innerText.slice(0, 60);
      if (state.seen.has(key)) continue;
      // sponsored/ad result skip (paid placement)
      if (/\bSponsored\b|\bAd\s*·/.test(card.innerText || "")) {
        state.seen.add(key);
        continue;
      }
      const row = extractCard(card);
      if (!row.businessName) continue;
      state.seen.add(key); // don't re-check even if the filter rejects it
      if (state.rows.length >= MAX_ROWS) {
        state.stopRequested = true;
        setStatus(`⚠️ ${MAX_ROWS} leads limit reached — stopped. Export or Clear.`);
        break;
      }
      if (!passesHarvestFilter(row)) continue; // rating/reviews filter
      deriveFields(row);
      state.rows.push(row);
      added++;
    }
    return added;
  }

  async function scrollFeed() {
    const feed = document.querySelector(SEL.feed);
    if (!feed) return false;
    // scroll in small variable steps (reading-like, not straight to the bottom)
    const steps = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < steps; i++) {
      feed.scrollTop += 450 + Math.random() * 700;
      await sleep(180 + Math.random() * 320);
    }
    await jitter(900);
    if ((feed.innerText || "").includes(SEL.endText)) return false;
    return true;
  }

  // did a CAPTCHA/unusual-traffic page appear on Maps?
  function isMapsBlocked() {
    if (
      document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="/sorry/"], form[action*="/sorry/"]'
      )
    )
      return true;
    const t = (document.body && document.body.innerText) || "";
    return /unusual traffic|systems have detected|not a robot/i.test(
      t.slice(0, 1500)
    );
  }

  // ---------- phase 2: deep enrich (click each place) ----------
  function readDetailValue(el) {
    if (!el) return "";
    const v = el.querySelector(SEL.dValue);
    if (v && v.textContent) return v.textContent.trim();
    // fallback: aria-label "Phone: 123" / "Address: ..."
    const al = el.getAttribute("aria-label") || "";
    const idx = al.indexOf(":");
    return idx >= 0 ? al.slice(idx + 1).trim() : al.trim();
  }

  function scrapeDetailPanel() {
    const out = {};
    const addrEl = document.querySelector(SEL.dAddress);
    if (addrEl) out.address = readDetailValue(addrEl);

    const phoneEl = document.querySelector(SEL.dPhone);
    if (phoneEl) {
      // phone is most reliable from data-item-id="phone:tel:+92..."
      const id = phoneEl.getAttribute("data-item-id") || "";
      const m = id.match(/phone:tel:(.+)$/);
      out.phone = (m ? m[1] : readDetailValue(phoneEl)).trim();
    }

    const webEl = document.querySelector(SEL.dWebsite);
    if (webEl) out.website = webEl.href || readDetailValue(webEl);

    const catEl = document.querySelector(SEL.dCategory);
    if (catEl) {
      let c = (catEl.textContent || "")
        .replace(/(open|closed|closes|opens|permanently|temporarily)[\s\S]*$/i, "")
        .trim();
      if (c && !/^[\d+]/.test(c) && !/Rs\s|\d\s*[ap]m/i.test(c)) out.category = c;
    }

    const ohEl = document.querySelector(SEL.dHours);
    if (ohEl) {
      const al = (ohEl.getAttribute("aria-label") || ohEl.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (al) out.businessHours = al.slice(0, 220);
      const m = al.match(
        /\b(Open 24 hours|Permanently closed|Temporarily closed|Open|Closed)\b/i
      );
      if (m) out.openStatus = m[1];
    }

    return out;
  }

  // the Google Maps list is VIRTUALIZED (only visible cards are in the DOM). So
  // we click visible cards and scroll to render the rest.
  async function deepEnrich() {
    state.enrichFailed = 0;
    const enriched = new Set(); // mapsUrls jo process ho gaye
    // O(1) lookup: mapsUrl -> row (no find() each iteration)
    const byUrl = new Map(state.rows.map((r) => [r.mapsUrl, r]));
    const feedEl = () => document.querySelector(SEL.feed);
    const allDone = () =>
      state.rows.every(
        (r) => (r.phone && r.address) || enriched.has(r.mapsUrl)
      );
    const doneCount = () =>
      state.rows.filter((r) => r.phone || enriched.has(r.mapsUrl)).length;

    let stale = 0;
    while (!state.stopRequested && !allDone()) {
      // ek visible, abhi tak na-process card dhoondo
      let card = null, link = null, row = null;
      for (const c of getCards()) {
        const a = c.querySelector(SEL.link);
        const url = a && a.href.split("?")[0];
        if (!url || enriched.has(url)) continue;
        const rw = byUrl.get(url);
        if (!rw) { enriched.add(url); continue; }
        if (rw.phone && rw.address) { enriched.add(url); continue; }
        card = c; link = a; row = rw; break;
      }

      if (!card) {
        // no new visible card -> scroll to render more
        const f = feedEl();
        if (f) f.scrollTop += 700;
        await sleep(700);
        if (++stale > 12) break; // end of list / nothing new
        continue;
      }
      stale = 0;

      setStatus(`Opening ${doneCount() + 1}/${state.rows.length}: ${row.businessName}…`);
      setProgress((doneCount() / state.rows.length) * 100);

      try {
        card.scrollIntoView({ block: "center" });
        await sleep(200);
        link.click();
        await waitFor(
          () =>
            document.querySelector(SEL.dAddress) ||
            document.querySelector(SEL.dPhone) ||
            document.querySelector(SEL.dWebsite),
          6000
        );
        await jitter(350);
        const d = scrapeDetailPanel();
        if (d.address) row.address = d.address;
        if (d.phone) row.phone = d.phone;
        if (d.website) row.website = d.website;
        if (d.category) row.category = d.category;
        if (d.businessHours) row.businessHours = d.businessHours;
        if (d.openStatus) row.openStatus = d.openStatus;
        deriveFields(row);
        if (!row.phone && !row.address && !row.website) state.enrichFailed++;
        renderTable();
      } catch (_) {}
      enriched.add(row.mapsUrl);

      // back to the list
      try {
        const back = document.querySelector(SEL.backBtn);
        if (back) back.click();
        else history.back();
      } catch (_) {}
      await waitFor(() => feedEl(), 5000);
      await jitter(400);
      await microBreak();
      saveState();
    }
    saveState();
  }

  // ---------- phase 3: website -> email + person ----------
  async function websiteEnrich() {
    const total = state.rows.length;
    for (let i = 0; i < total; i++) {
      if (state.stopRequested) break;
      const row = state.rows[i];
      if (!row.website) continue;
      if (row.email && row.person) continue;
      setStatus(`Website ${i + 1}/${total}: ${row.businessName}…`);
      setProgress(((i + 1) / total) * 100);
      try {
        const res = await chrome.runtime.sendMessage({
          type: "ENRICH_SITE",
          url: row.website,
        });
        if (res) {
          if (res.email && !row.email) row.email = res.email;
          if (res.person && !row.person) row.person = res.person;
          if (res.phone && !row.phone) {
            row.phone = res.phone;
            deriveFields(row);
          }
          if (res.facebook && !row.facebook) row.facebook = res.facebook;
          if (res.instagram && !row.instagram) row.instagram = res.instagram;
        }
      } catch (_) {}
      renderTable();
      await jitter(150);
      await microBreak();
      if ((i + 1) % 10 === 0) saveState();
    }
    saveState();
  }

  // ---------- phase 4: LinkedIn (via Google search) ----------
  async function linkedinEnrich() {
    const total = state.rows.length;
    for (let i = 0; i < total; i++) {
      if (state.stopRequested) break;
      const row = state.rows[i];
      if (!row.businessName) continue;
      if (row.person && row.linkedin) continue; // already found
      // city/area hint from the address
      const loc = (row.address || "").split(",").slice(-2).join(" ").trim();
      setStatus(`LinkedIn ${i + 1}/${total}: ${row.businessName}…`);
      setProgress(((i + 1) / total) * 100);
      try {
        const res = await chrome.runtime.sendMessage({
          type: "FIND_LINKEDIN",
          name: row.businessName,
          location: loc,
        });
        if (res) {
          if (res.blocked) {
            // Google returned a CAPTCHA -> stop; other leads still have their linkedinSearch links
            saveState();
            pauseForBlock("Google LinkedIn-search limit");
            return;
          }
          if (res.person) row.person = res.person; // LinkedIn stronger
          if (res.title) row.personTitle = res.title;
          if (res.linkedin) row.linkedin = res.linkedin;
          if (res.linkedinSearch) row.linkedinSearch = res.linkedinSearch;
        }
      } catch (_) {}
      renderTable();
      // don't anger Google -> big delay (even bigger on Safe speed)
      await jitter(1600);
      await microBreak();
      if ((i + 1) % 8 === 0) saveState();
    }
    saveState();
  }

  // ---------- orchestrator ----------
  // scraping phases only (UI toggles live in the wrappers)
  async function runPipeline() {
    // phase 1: list harvest
    const rowsBeforePhase1 = state.rows.length;
    const feedExists = !!document.querySelector(SEL.feed);
    setProgress(-1);

    // single-place result (no list, a single business is open)
    if (!feedExists) {
      await waitFor(() => document.querySelector(SEL.dTitle), 4000);
      if (document.querySelector(SEL.dTitle)) {
        harvestSinglePlace();
        renderTable();
      }
    }

    let idle = 0;
    while (!state.stopRequested) {
      if (isMapsBlocked()) {
        pauseForBlock("Google CAPTCHA");
        return;
      }
      const before = state.rows.length;
      harvestVisible();
      // target = new leads this run (distinct from the old persisted count)
      const hitTarget = () =>
        state.targetCount > 0 &&
        state.rows.length - rowsBeforePhase1 >= state.targetCount;
      if (hitTarget()) {
        state.rows = state.rows.slice(0, rowsBeforePhase1 + state.targetCount);
        renderTable();
        setStatus(`Target reached: ${state.targetCount} leads.`);
        break;
      }
      renderTable();
      const got = state.rows.length - rowsBeforePhase1;
      const tgt = state.targetCount > 0 ? `/${state.targetCount}` : "";
      setStatus(`Collected ${got}${tgt}… (scrolling)`);
      const more = await scrollFeed();
      harvestVisible();
      if (hitTarget()) {
        state.rows = state.rows.slice(0, rowsBeforePhase1 + state.targetCount);
        renderTable();
        setStatus(`Target reached: ${state.targetCount} leads.`);
        break;
      }
      renderTable();
      if (state.rows.length === before) idle++;
      else idle = 0;
      if (!more || idle >= 4) break;
    }

    // selector-broken warning: there was a feed but nothing was found
    if (feedExists && state.rows.length === rowsBeforePhase1) {
      setStatus(
        "⚠️ Results shown but nothing scraped — Google likely changed its DOM. Update the SEL object in content.js."
      );
      console.warn(
        "[LeadPin] Phase 1 ne 0 leads diye jabke feed mojood hai. Selectors (SEL.card/link/name) tootay ho sakte hain."
      );
    }
    // phase 2: deep enrich
    if (state.deepEnrich && !state.stopRequested) {
      setStatus("Deep enrich: getting phone/address…");
      await deepEnrich();
    }
    // phase 3: website
    if (state.findEmails && !state.stopRequested) {
      setStatus("Finding email/person from website…");
      await websiteEnrich();
    }
    // phase 4: linkedin
    if (state.findLinkedin && !state.stopRequested) {
      setStatus("Finding decision-maker via LinkedIn (Google)…");
      await linkedinEnrich();
    }
    state.rows.forEach(deriveFields);
    dedupeRows();
    saveState();
  }

  function setRunningUI(on) {
    if (btnStart) btnStart.disabled = on;
    if (btnStop) btnStop.disabled = !on;
    if (btnResume) btnResume.style.display = "none";
    const sp = panel && panel.querySelector("#ls-spin");
    if (sp) sp.classList.toggle("on", !!on);
  }

  // hit a block/CAPTCHA -> stop but keep the job alive (for Resume)
  function pauseForBlock(msg) {
    state.stopRequested = true;
    cancelSleeps();
    state.paused = true;
    state.running = false;
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
    if (btnResume) btnResume.style.display = "";
    setStatus(`⚠️ ${msg} — solve the CAPTCHA on the page, then ▶ Resume.`);
  }

  // continue after pause/stop: current page's pipeline + advance the queue
  async function continueRun() {
    state.paused = false;
    state.stopRequested = false;
    state.running = true;
    setRunningUI(true);
    await runPipeline();
    if (state.paused) return; // blocked again
    const job = await getJob();
    if (job && job.active && !state.stopRequested) {
      const next = job.index + 1;
      if (next < job.queries.length) {
        await saveJob({ ...job, index: next });
        setStatus(`Queue: next #${next + 1} "${job.queries[next]}"…`);
        await sleep(1500);
        navigateToQuery(job.queries[next]);
        return;
      }
      await clearJob();
    }
    finishUI();
  }

  function finishUI() {
    state.running = false;
    state.paused = false;
    setProgress(100);
    saveStateNow();
    renderTableNow();
    const total = state.rows.length;
    const pass = state.rows.filter(passesFilter).length;
    const ph = state.rows.filter((r) => r.phone).length;
    const em = state.rows.filter((r) => r.email).length;
    const pr = state.rows.filter((r) => r.person).length;
    const failTxt = state.enrichFailed
      ? ` · ⚠️ ${state.enrichFailed} no-detail`
      : "";
    setStatus(
      `Done. ${total} leads (${pass} pass) · ${ph} phone · ${em} email · ${pr} person${failTxt}.`
    );
    setRunningUI(false);
  }

  function navigateToQuery(q) {
    window.location.href =
      "https://www.google.com/maps/search/" + encodeURIComponent(q);
  }

  // called from the UI "Start": run the QUEUE if there are queries, else the current page.
  async function startFromUI() {
    if (state.running) return;
    state.stopRequested = false;
    // fresh search: clear old leads (only on the user's Start, not between queue items)
    const fresh = panel.querySelector("#ls-fresh").checked;
    if (fresh) {
      state.rows = [];
      state.seen = new Set();
      await saveStateNow();
      renderTableNow();
    }
    if (state.queries && state.queries.length) {
      const job = {
        queries: state.queries,
        index: 0,
        active: true,
        options: {
          deepEnrich: state.deepEnrich,
          findEmails: state.findEmails,
          findLinkedin: state.findLinkedin,
          targetCount: state.targetCount,
          speed: state.speed,
          filters: state.filters,
        },
      };
      await saveJob(job);
      setStatus(
        `Queue: ${state.queries.length} searches · #1 "${state.queries[0]}"…`
      );
      await sleep(400);
      navigateToQuery(state.queries[0]); // reload -> resumeJob() aage chalayega
    } else {
      await runCurrentPage();
    }
  }

  async function runCurrentPage() {
    state.running = true;
    setRunningUI(true);
    await waitFor(() => document.querySelector(SEL.feed), 8000);
    await runPipeline();
    if (state.paused) return; // stay paused for Resume on a CAPTCHA
    finishUI();
  }

  // on page load: if there is an active queue job, continue it
  async function resumeJob() {
    const job = await getJob();
    if (!job || !job.active || !Array.isArray(job.queries) || !job.queries.length)
      return false;

    // restore saved options into state
    const o = job.options || {};
    state.deepEnrich = !!o.deepEnrich;
    state.findEmails = !!o.findEmails;
    state.findLinkedin = !!o.findLinkedin;
    state.targetCount = o.targetCount || 0;
    state.speed = o.speed || 1;
    if (o.filters) state.filters = o.filters;
    reflectOptionsToUI();

    state.running = true;
    state.stopRequested = false;
    setRunningUI(true);

    const q = job.queries[job.index];
    setStatus(`Queue ${job.index + 1}/${job.queries.length}: "${q}"…`);
    await waitFor(() => document.querySelector(SEL.feed), 10000);
    await runPipeline();

    // on a CAPTCHA/block keep the queue alive — Resume continues from this index
    if (state.paused) return true;

    // was it stopped?
    const latest = await getJob();
    if (!latest || !latest.active || state.stopRequested) {
      await clearJob();
      finishUI();
      return true;
    }

    const next = job.index + 1;
    if (next < job.queries.length) {
      await saveJob({ ...job, index: next });
      setStatus(`Queue: next #${next + 1} "${job.queries[next]}"…`);
      await sleep(1500);
      navigateToQuery(job.queries[next]);
    } else {
      await clearJob();
      finishUI();
    }
    return true;
  }

  async function stop() {
    state.stopRequested = true;
    cancelSleeps(); // chalta hua delay foran cancel -> instant stop
    state.paused = false;
    if (btnResume) btnResume.style.display = "none";
    const job = await getJob();
    if (job) await saveJob({ ...job, active: false });
    const mjob = await getMapsJob();
    if (mjob) await setMapsJob({ ...mjob, active: false });
    saveStateNow();
    setStatus("Stopping…");
  }

  async function reset() {
    state.stopRequested = true;
    cancelSleeps();
    state.paused = false;
    state.rows = [];
    state.seen = new Set();
    await clearJob(); // stop any running queue
    await clearMapsJob();
    saveStateNow();
    renderTableNow();
    setRunningUI(false);
    setStatus("Cleared.");
  }

  // ---------- CSV ----------
  const COLS = [
    ["businessName", "Business Name"],
    ["leadScore", "Lead Score"],
    ["leadStatus", "Status"],
    ["notes", "Notes"],
    ["outreachReady", "Outreach Ready"],
    ["alreadyHave", "Already Have"],
    ["person", "Contact Person"],
    ["personTitle", "Title"],
    ["phone", "Phone"],
    ["whatsapp", "WhatsApp"],
    ["email", "Email"],
    ["address", "Address"],
    ["zipcode", "Zipcode"],
    ["city", "City"],
    ["country", "Country"],
    ["website", "Website"],
    ["linkedin", "LinkedIn URL"],
    ["linkedinSearch", "LinkedIn Search"],
    ["facebook", "Facebook"],
    ["instagram", "Instagram"],
    ["category", "Category"],
    ["rating", "Rating"],
    ["reviews", "Reviews"],
    ["businessHours", "Hours"],
    ["openStatus", "Open/Closed"],
    ["emailStatus", "Email Status"],
    ["websiteStatus", "Website Status"],
    ["confidence", "Confidence"],
    ["latitude", "Latitude"],
    ["longitude", "Longitude"],
    ["mapsUrl", "Maps URL"],
  ];

  // default: only the useful columns ticked (user can enable the rest)
  const DEFAULT_COLS = new Set([
    "businessName", "leadScore", "person", "phone", "whatsapp", "email",
    "address", "city", "website", "category", "rating", "reviews", "mapsUrl",
  ]);

  // only the chosen columns for export
  function activeCols() {
    if (!panel) return COLS;
    const checked = new Set(
      Array.from(panel.querySelectorAll("#ls-cols input[data-col]:checked")).map(
        (i) => i.getAttribute("data-col")
      )
    );
    if (!checked.size) return COLS; // if none chosen, use all
    return COLS.filter(([k]) => checked.has(k));
  }

  // export only rows that pass the filters (read the latest filters from the UI)
  function getExportRows() {
    readFiltersFromUI();
    return state.rows.filter(passesFilter);
  }

  function triggerDownload(content, mime, ext) {
    const blob = new Blob(["﻿" + content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `leads-${stamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toCSV(rows) {
    const cols = activeCols();
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = [cols.map((c) => c[1]).join(",")];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c[0]])).join(","));
    return lines.join("\r\n");
  }

  function downloadCSV() {
    const rows = getExportRows();
    if (!rows.length) return setStatus("Nothing to export (filters?).");
    triggerDownload(toCSV(rows), "text/csv;charset=utf-8;", "csv");
    setStatus(`Exported ${rows.length} leads (CSV).`);
  }

  // Excel .xls (HTML-table trick — Excel opens it with clean columns)
  function downloadXLS() {
    const rows = getExportRows();
    if (!rows.length) return setStatus("Nothing to export (filters?).");
    const esc = (s) =>
      String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const cols = activeCols();
    const head = cols.map((c) => `<th>${esc(c[1])}</th>`).join("");
    const body = rows
      .map(
        (r) =>
          "<tr>" + cols.map((c) => `<td>${esc(r[c[0]])}</td>`).join("") + "</tr>"
      )
      .join("");
    const html =
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" ` +
      `xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head>` +
      `<body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
    triggerDownload(html, "application/vnd.ms-excel;charset=utf-8;", "xls");
    setStatus(`Exported ${rows.length} leads (Excel).`);
  }

  async function copyCSV() {
    const rows = getExportRows();
    if (!rows.length) return setStatus("Nothing to copy (filters?).");
    try {
      await navigator.clipboard.writeText(toCSV(rows));
      setStatus(`${rows.length} leads copied.`);
    } catch (_) {
      setStatus("Copy failed.");
    }
  }

  // all unique emails to the clipboard (for bulk outreach)
  async function copyEmails() {
    const rows = getExportRows();
    const emails = [
      ...new Set(
        rows.map((r) => (r.email || "").trim().toLowerCase()).filter(Boolean)
      ),
    ];
    if (!emails.length) return setStatus("No emails to copy.");
    try {
      await navigator.clipboard.writeText(emails.join(", "));
      setStatus(`${emails.length} emails copied.`);
    } catch (_) {
      setStatus("Copy failed.");
    }
  }

  // Google Sheets: copy TSV to clipboard + open a new blank Sheet for the user to paste
  function toTSV(rows) {
    const esc = (v) =>
      String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ");
    const cols = activeCols();
    const lines = [cols.map((c) => c[1]).join("\t")];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c[0]])).join("\t"));
    return lines.join("\n");
  }

  // ================= VERIFY MODULE =================
  const DISPOSABLE = new Set([
    "mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com",
    "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com",
    "temp-mail.org", "throwawaymail.com", "fakeinbox.com", "maildrop.cc",
    "dispostable.com", "mailnesia.com", "tempr.email", "emailondeck.com",
  ]);
  const FREE_PROVIDERS = new Set([
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
    "icloud.com", "protonmail.com", "gmx.com", "yandex.com", "mail.com",
    "live.com", "msn.com", "ymail.com", "hotmail.co.uk",
  ]);

  // aam domain typos -> sahi (free typo-fix)
  const DOMAIN_TYPOS = {
    "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmil.com": "gmail.com",
    "gnail.com": "gmail.com", "gmail.co": "gmail.com", "gmaill.com": "gmail.com",
    "yaho.com": "yahoo.com", "yhoo.com": "yahoo.com", "yahooo.com": "yahoo.com",
    "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmil.com": "hotmail.com",
    "outlok.com": "outlook.com", "outlook.com": "outlook.com", "iclod.com": "icloud.com",
  };

  function fixEmailTypo(email) {
    const at = email.lastIndexOf("@");
    if (at < 0) return email;
    const local = email.slice(0, at);
    const dom = email.slice(at + 1).toLowerCase();
    return DOMAIN_TYPOS[dom] ? local + "@" + DOMAIN_TYPOS[dom] : email;
  }

  // random/gibberish email local-part? (xk29fjz@..)
  function isGibberishEmail(email) {
    const local = email.split("@")[0].replace(/[._\-+].*$/, "");
    if (local.length < 7) return false;
    const vowels = (local.match(/[aeiou]/gi) || []).length;
    const letters = (local.match(/[a-z]/gi) || []).length;
    const longConsonant = /[bcdfghjklmnpqrstvwxyz]{6,}/i.test(local);
    const vowelRatio = letters ? vowels / letters : 0;
    return (letters >= 7 && vowelRatio < 0.18) || longConsonant;
  }

  // ---------- data cleaning / normalize ----------
  function titleCase(s) {
    return String(s || "").replace(
      /\w\S*/g,
      (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
    );
  }
  function cleanPhone(p) {
    let s = String(p || "").trim().replace(/[^\d+]/g, "");
    if (s.indexOf("+") > 0) s = s.replace(/\+/g, ""); // + only at the start
    return s;
  }
  function cleanRow(r) {
    if (r.email) r.email = fixEmailTypo(r.email.trim().toLowerCase());
    if (r.businessName) r.businessName = r.businessName.trim().replace(/\s+/g, " ");
    if (r.person) r.person = titleCase(r.person.trim());
    if (r.city) r.city = titleCase(r.city.trim());
    if (r.phone) r.phone = cleanPhone(r.phone);
    if (r.whatsapp) r.whatsapp = r.whatsapp.trim();
    if (r.website) r.website = r.website.trim();
  }

  async function cleanLeads() {
    if (!state.rows.length) return setStatus("No leads.");
    state.rows.forEach((r) => {
      cleanRow(r);
      deriveFields(r);
    });
    saveStateNow();
    renderTableNow();
    setStatus(`🧹 ${state.rows.length} leads cleaned/normalized.`);
  }

  // verify scraped leads directly (no CSV needed)
  async function verifyScrapedLeads() {
    if (state.running) return;
    if (!state.rows.length) return setStatus("No scraped leads.");
    const doSite = panel.querySelector("#ls-vsite").checked;
    const doMX = panel.querySelector("#ls-vmx").checked;
    state.running = true;
    state.stopRequested = false;
    setRunningUI(true);
    const total = state.rows.length;
    for (let i = 0; i < total; i++) {
      if (state.stopRequested) break;
      const r = state.rows[i];
      setStatus(`Verify lead ${i + 1}/${total}: ${r.businessName}…`);
      setProgress(((i + 1) / total) * 100);
      const rec = { emailStatus: "", phoneStatus: "", websiteStatus: "", confidence: "" };
      if (r.email)
        rec.emailStatus = await verifyEmail(r.email, doMX, host(r.website));
      if (r.phone) rec.phoneStatus = verifyPhone(r.phone);
      if (r.website)
        rec.websiteStatus = doSite ? await verifySite(r.website, r.phone, r.businessName) : "Not checked";
      rec.confidence = scoreConfidence(rec);
      r.emailStatus = rec.emailStatus;
      r.websiteStatus = rec.websiteStatus;
      r.confidence = rec.confidence;
      renderTable();
      await jitter(120);
      await microBreak();
      if ((i + 1) % 10 === 0) saveState();
    }
    state.running = false;
    setRunningUI(false);
    setProgress(100);
    saveStateNow();
    renderTableNow();
    const hi = state.rows.filter((r) => r.confidence === "High").length;
    setStatus(`Verify done · ${hi} High-confidence leads.`);
  }

  // robust CSV parser (handles quotes/commas/newlines)
  function parseCSV(text) {
    const rows = [];
    let field = "", row = [], inQ = false;
    text = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // sample CSV template (so the uploader knows what to provide)
  function downloadSampleCSV() {
    const csv =
      "Business Name,Contact Person,Phone,Email,Website,City\r\n" +
      '"ABC Traders","Ali Khan","+92 300 1234567","info@abctraders.com","https://abctraders.com","Lahore"\r\n' +
      '"XYZ Services","John Doe","+1 415 555 0123","contact@xyz.com","xyz.com","New York"\r\n' +
      '"Sample Co","","+44 20 7946 0000","","sampleco.co.uk",""';
    triggerDownload(csv, "text/csv;charset=utf-8;", "leadpin-sample-template.csv");
    setStatus("Sample template downloaded — fill it and upload.");
  }

  // build mapping dropdowns on file upload (for any CSV format)
  function buildColumnMapping() {
    if (!state.verifyText || !panel) return;
    const grid = parseCSV(state.verifyText);
    if (!grid.length) return;
    const headers = grid[0].map((h) => (h || "").trim());
    const guess = detectCols(headers);
    const opts = (sel) =>
      '<option value="-1">(none)</option>' +
      headers
        .map(
          (h, i) =>
            `<option value="${i}" ${i === sel ? "selected" : ""}>${escHtml(
              h || "col " + (i + 1)
            )}</option>`
        )
        .join("");
    panel.querySelector("#ls-map-email").innerHTML = opts(guess.email);
    panel.querySelector("#ls-map-phone").innerHTML = opts(guess.phone);
    panel.querySelector("#ls-map-website").innerHTML = opts(guess.website);
    panel.querySelector("#ls-map-name").innerHTML = opts(guess.name);
    panel.querySelector("#ls-map-address").innerHTML = opts(guess.address);
    panel.querySelector("#ls-vmap").style.display = "";
  }

  // column indexes from the mapping dropdowns (null = no mapping UI)
  function readColumnMapping() {
    if (!panel) return null;
    const box = panel.querySelector("#ls-vmap");
    if (!box || box.style.display === "none") return null;
    const v = (id) => parseInt(panel.querySelector(id).value);
    return {
      email: v("#ls-map-email"),
      phone: v("#ls-map-phone"),
      website: v("#ls-map-website"),
      name: v("#ls-map-name"),
      address: v("#ls-map-address"),
    };
  }

  function detectCols(headers) {
    const h = headers.map((x) => (x || "").toLowerCase().trim());
    const find = (re, avoid) =>
      h.findIndex((x) => re.test(x) && (!avoid || !avoid.test(x)));
    return {
      // pick "Email", not "Email Status"
      email: find(/e-?mail/i, /status/i),
      // pick "Phone/Mobile/Tel" — do not treat "Contact Person" as phone
      phone: find(/\bphone\b|mobile|telephone|\btel\b|cell|phone ?(no|number)/i),
      // pick "Website", not "Website Status"
      website: find(/website|^web$|\burl\b|domain|site/i, /status/i),
      name: find(/business|company|^name$|business name/i),
      address: find(/address|location|street/i),
    };
  }

  async function verifyEmail(emailRaw, doMX, websiteDomain) {
    const email = fixEmailTypo(String(emailRaw).trim().toLowerCase());
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return "Invalid format";
    const typoFixed = email !== String(emailRaw).trim().toLowerCase();
    const domain = email.split("@")[1].toLowerCase();
    if (DISPOSABLE.has(domain)) return "Disposable (fake)";
    if (isGibberishEmail(email)) return "Gibberish (likely fake)";

    const role = /^(info|contact|sales|admin|office|support|hello|team|enquiry|mail)@/i.test(email);
    const free = FREE_PROVIDERS.has(domain);
    const ownDomain = websiteDomain && domain === websiteDomain;

    let base = ownDomain
      ? "Own-domain"
      : free
      ? "Free provider"
      : role
      ? "Role-based"
      : "Valid format";

    const tag = typoFixed ? " (typo-fixed)" : "";
    if (doMX) {
      try {
        const res = await chrome.runtime.sendMessage({ type: "CHECK_MX", domain });
        if (res && res.hasMX === false && res.hasA === false)
          return "Dead domain (no mail)" + tag;
        if (res && res.hasMX === true) {
          if (ownDomain) return "Deliverable ✓ (own domain)" + tag;
          return base + " + MX ok" + tag;
        }
      } catch (_) {}
    }
    return base + tag;
  }

  function verifyPhone(phone) {
    const d = phone.replace(/[^\d+]/g, "");
    const digits = d.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return "Invalid length";
    if (/^(\d)\1+$/.test(digits)) return "Fake (repeated)";
    // only fake when the WHOLE number is sequential (a real number can contain "1234567",
    // so we avoid a substring match)
    if ("01234567890".includes(digits) || "09876543210".includes(digits))
      return "Fake (sequential)";
    return d.startsWith("+") ? "Valid (intl)" : "Valid (local)";
  }

  async function verifySite(site, phone, name) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "CHECK_SITE",
        url: site,
        phone,
        name,
      });
      if (!res || !res.live)
        return res && res.status ? `Dead (${res.status})` : "Dead/unreachable";
      if (res.parked) return "Parked / for-sale (dead business)";
      let s =
        res.hasPhone || res.hasName
          ? "Live + business match ✓"
          : "Live (match unverified)";
      if (res.https === false) s += " · no SSL";
      return s;
    } catch (_) {
      return "Check failed";
    }
  }

  function scoreConfidence(rec) {
    let s = 0, n = 0;
    const all = rec.emailStatus + rec.phoneStatus + rec.websiteStatus;
    if (rec.emailStatus) {
      n++;
      if (/Deliverable|MX ok|Own-domain/.test(rec.emailStatus)) s++;
      else if (/Valid format/.test(rec.emailStatus)) s += 0.5;
    }
    if (rec.phoneStatus) { n++; if (/Valid/.test(rec.phoneStatus)) s++; }
    if (rec.websiteStatus && rec.websiteStatus !== "Not checked") {
      n++;
      if (/business match/.test(rec.websiteStatus)) s++;
      else if (/^Live/.test(rec.websiteStatus)) s += 0.6;
    }
    if (n === 0) return "Unknown";
    const bad = /Invalid|Dead|Disposable|Fake|Parked|Gibberish/.test(all);
    const ratio = s / n;
    if (bad && ratio < 0.5) return "Low";
    if (ratio >= 0.8 && !bad) return "High";
    if (ratio >= 0.5) return "Medium";
    return "Low";
  }

  async function runVerify() {
    if (state.running) return;
    if (!state.verifyText) return setStatus("Choose a CSV file first.");
    const grid = parseCSV(state.verifyText);
    if (grid.length < 2) return setStatus("CSV empty or invalid.");

    const headers = grid[0].map((h) => (h || "").trim());
    // take from the mapping dropdowns (what the user set); else auto-detect
    const idx = readColumnMapping() || detectCols(headers);
    if (idx.email < 0 && idx.phone < 0 && idx.website < 0)
      return setStatus("Map at least one of Email / Phone / Website column.");

    const doMX = panel.querySelector("#ls-vmx").checked;
    const doSite = panel.querySelector("#ls-vsite").checked;
    const dataRows = grid.slice(1).filter((r) => r.some((c) => c && c.trim()));

    state.verifyHeaders = headers;
    state.verifyRows = [];
    const seenEmail = new Set(), seenPhone = new Set();

    state.running = true;
    state.stopRequested = false;
    setRunningUI(true);

    for (let i = 0; i < dataRows.length; i++) {
      if (state.stopRequested) break;
      const r = dataRows[i];
      const email = (idx.email >= 0 ? r[idx.email] || "" : "").trim();
      const phone = (idx.phone >= 0 ? r[idx.phone] || "" : "").trim();
      const site = (idx.website >= 0 ? r[idx.website] || "" : "").trim();
      const name = (idx.name >= 0 ? r[idx.name] || "" : "").trim();
      const siteDomain = host(site);
      setStatus(`Verify ${i + 1}/${dataRows.length}…`);
      setProgress(((i + 1) / dataRows.length) * 100);

      const rec = { cells: r, emailStatus: "", phoneStatus: "", websiteStatus: "", dup: "", confidence: "" };
      if (email) rec.emailStatus = await verifyEmail(email, doMX, siteDomain);
      if (phone) rec.phoneStatus = verifyPhone(phone);
      if (site) rec.websiteStatus = doSite ? await verifySite(site, phone, name) : "Not checked";

      const em = email.toLowerCase(), ph = normPhone(phone);
      if ((em && seenEmail.has(em)) || (ph && seenPhone.has(ph))) rec.dup = "Duplicate";
      if (em) seenEmail.add(em);
      if (ph) seenPhone.add(ph);

      rec.confidence = scoreConfidence(rec);
      state.verifyRows.push(rec);
      renderVerifySummary();
      await jitter(120);
    }

    state.running = false;
    setRunningUI(false);
    setProgress(100);
    renderVerifySummary();
    // save + auto-download so the result isn't lost
    try {
      chrome.storage.local.set({
        [VRESULTS_KEY]: { headers: state.verifyHeaders, rows: state.verifyRows },
      });
    } catch (_) {}
    if (!state.stopRequested && state.verifyRows.length) exportVerified();
    setStatus(`Verify done: ${state.verifyRows.length} rows checked. CSV downloaded.`);
  }

  function renderVerifySummary() {
    const el = panel && panel.querySelector("#ls-vsummary");
    if (!el) return;
    const rows = state.verifyRows || [];
    if (!rows.length) {
      el.textContent = 'Upload a CSV. (XLSX? In Excel use "Save as CSV".)';
      return;
    }
    const c = (f) => rows.filter(f).length;
    const email = c((r) => /Deliverable|MX ok|Own-domain/.test(r.emailStatus));
    const badEmail = c((r) => /Dead|Disposable|Invalid|Gibberish/.test(r.emailStatus));
    const live = c((r) => /Live/.test(r.websiteStatus));
    const unknown = c((r) => !r.confidence || r.confidence === "Unknown");
    const phoneOk = c((r) => /Valid/.test(r.phoneStatus));
    el.innerHTML =
      `${rows.length} rows · <b style="color:#137a3f">${c((r) => r.confidence === "High")} High</b>` +
      ` · ${c((r) => r.confidence === "Medium")} Med` +
      ` · <b style="color:#b42318">${c((r) => r.confidence === "Low")} Low</b>` +
      ` · ${unknown} no-data · ${c((r) => r.dup)} dup<br>` +
      `📧 ${email} good · ${badEmail} bad &nbsp; 📞 ${phoneOk} ok &nbsp; 🌐 ${live} live`;
  }

  function exportVerified() {
    const rows = state.verifyRows || [];
    if (!rows.length) return setStatus("Run Verify first.");
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const extra = ["Email Status", "Phone Status", "Website Status", "Duplicate", "Confidence"];
    const headers = [...(state.verifyHeaders || []), ...extra];
    const lines = [headers.map(esc).join(",")];
    for (const rec of rows) {
      const cells = [...rec.cells];
      while (cells.length < (state.verifyHeaders || []).length) cells.push("");
      lines.push(
        [...cells, rec.emailStatus, rec.phoneStatus, rec.websiteStatus, rec.dup, rec.confidence]
          .map(esc)
          .join(",")
      );
    }
    triggerDownload(lines.join("\r\n"), "text/csv;charset=utf-8;", "verified.csv");
    setStatus(`Exported ${rows.length} verified rows.`);
  }

  // ================= GOOGLE MAPS CROSS-VERIFY =================
  // re-searches each business on Maps for the real address/phone/website
  // and compares them with the CSV. Navigation-based (slow).
  const MJOB_KEY = "leadScraperMapsJob";
  const MRESULTS_KEY = "leadScraperMapsResults";
  const VRESULTS_KEY = "leadScraperVerifyResults";
  const getMapsJob = async () => {
    try {
      const g = await chrome.storage.local.get(MJOB_KEY);
      return (g && g[MJOB_KEY]) || null;
    } catch (_) { return null; }
  };
  const setMapsJob = async (j) => {
    try { await chrome.storage.local.set({ [MJOB_KEY]: j }); } catch (_) {}
  };
  const clearMapsJob = async () => {
    try { await chrome.storage.local.remove(MJOB_KEY); } catch (_) {}
  };

  // common filler words in addresses (they add noise to the match)
  const ADDR_STOP = new Set([
    "shop", "plot", "street", "road", "blvd", "boulevard", "avenue", "lane",
    "block", "market", "near", "opposite", "main", "floor", "building", "the",
    "number", "house", "flat", "suite", "unit", "sector", "phase", "town",
    "colony", "society", "area", "commercial", "and",
  ]);
  function tokenize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !ADDR_STOP.has(w));
  }
  function addressMatch(a, b) {
    if (!a || !b) return false;
    const ta = new Set(tokenize(a));
    const tb = new Set(tokenize(b));
    if (!ta.size || !tb.size) return false;
    let common = 0;
    for (const w of tb) if (ta.has(w)) common++;
    // best overlap from both sides (ignores format differences)
    const ratio = Math.max(common / tb.size, common / ta.size);
    return ratio >= 0.34;
  }

  async function scrapeTopResult() {
    // single place (no feed)
    if (!document.querySelector(SEL.feed) && document.querySelector(SEL.dTitle)) {
      return {
        name: (document.querySelector(SEL.dTitle).textContent || "").trim(),
        ...scrapeDetailPanel(),
      };
    }
    const link = document.querySelector(SEL.link);
    if (!link) return {};
    const name = link.getAttribute("aria-label") || "";
    try {
      link.click();
      await waitFor(
        () => document.querySelector(SEL.dAddress) || document.querySelector(SEL.dPhone),
        6000
      );
      await jitter(400);
      return { name, ...scrapeDetailPanel() };
    } catch (_) {
      return { name };
    }
  }

  async function startMapsVerify() {
    if (state.running) return;
    if (!state.verifyText) return setStatus("Choose a CSV first.");
    const grid = parseCSV(state.verifyText);
    if (grid.length < 2) return setStatus("CSV empty or invalid.");
    const headers = grid[0].map((h) => (h || "").trim());
    const idx = readColumnMapping() || detectCols(headers);
    if (idx.name == null || idx.name < 0)
      return setStatus("Map the Business Name column for Maps verify.");
    const dataRows = grid.slice(1).filter((r) => r.some((c) => c && c.trim()));
    const items = dataRows
      .map((r) => ({
        cells: r,
        name: (r[idx.name] || "").trim(),
        address: idx.address >= 0 ? (r[idx.address] || "").trim() : "",
        phone: idx.phone >= 0 ? (r[idx.phone] || "").trim() : "",
      }))
      .filter((it) => it.name);
    if (!items.length) return setStatus("No business names found in CSV.");
    if (!confirm(`Maps verify ${items.length} businesses? Each is a Maps search (slow).`))
      return;
    const loc = panel.querySelector("#ls-vloc").value.trim();
    const job = { items, index: 0, active: true, headers, results: [], loc };
    await setMapsJob(job);
    state.stopRequested = false;
    setStatus(`Maps verify: ${items.length} businesses · #1 "${items[0].name}"…`);
    await sleep(500);
    navigateToQuery(mapsQuery(items[0], loc));
  }

  // the business search query (location hint + CSV address for a better match)
  function mapsQuery(item, loc) {
    const parts = [item.name];
    if (item.address) parts.push(item.address);
    else if (loc) parts.push(loc); // no address -> use the location hint
    return parts.join(" ");
  }

  async function resumeMapsVerify() {
    const job = await getMapsJob();
    if (!job || !job.active || !Array.isArray(job.items)) return false;
    state.running = true;
    state.stopRequested = false;
    setRunningUI(true);
    const it = job.items[job.index];
    setStatus(`Maps verify ${job.index + 1}/${job.items.length}: "${it.name}"…`);
    setProgress((job.index / job.items.length) * 100);

    await waitFor(
      () => document.querySelector(SEL.feed) || document.querySelector(SEL.dTitle),
      10000
    );
    await jitter(600);

    let found = {};
    try { found = await scrapeTopResult(); } catch (_) {}

    const res = {
      cells: it.cells,
      mapsName: found.name || "",
      mapsAddress: found.address || "",
      mapsPhone: found.phone || "",
      mapsWebsite: found.website || "",
      addressMatch: "",
      verdict: "",
    };
    if (!found.name && !found.address && !found.phone) {
      res.verdict = "Not found on Maps";
    } else {
      const am = addressMatch(it.address, found.address);
      res.addressMatch = it.address ? (am ? "Yes" : "No") : "";
      res.verdict = !it.address
        ? "Found on Maps"
        : am
        ? "Verified ✓"
        : "Found (address differs)";
    }
    job.results.push(res);

    const next = job.index + 1;
    if (state.stopRequested || next >= job.items.length) {
      job.active = false;
      await setMapsJob(job);
      finishMapsVerify(job);
      return true;
    }
    job.index = next;
    await setMapsJob(job);
    await jitter(1300);
    await microBreak();
    navigateToQuery(mapsQuery(job.items[next], job.loc));
    return true;
  }

  function finishMapsVerify(job) {
    state.running = false;
    setRunningUI(false);
    setProgress(100);
    state.mapsResults = { headers: job.headers, results: job.results };
    // save so it isn't lost on reload
    try {
      chrome.storage.local.set({ [MRESULTS_KEY]: state.mapsResults });
    } catch (_) {}
    clearMapsJob();
    const r = job.results;
    const found = r.filter((x) => !/Not found/.test(x.verdict)).length;
    const ver = r.filter((x) => /Verified/.test(x.verdict)).length;
    const el = panel && panel.querySelector("#ls-vsummary");
    if (el)
      el.innerHTML = `📍 Maps verify: ${r.length} · ${found} found · ${ver} address-verified. (CSV downloaded)`;
    setStatus(`Maps verify done: ${found}/${r.length} found. CSV downloading…`);
    exportMapsVerify(); // auto-download so the result isn't lost
  }

  function exportMapsVerify() {
    const mv = state.mapsResults;
    if (!mv || !mv.results.length) return setStatus("Run Maps verify first.");
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const extra = ["Maps Name", "Maps Address", "Maps Phone", "Maps Website", "Address Match", "Maps Verdict"];
    const headers = [...(mv.headers || []), ...extra];
    const lines = [headers.map(esc).join(",")];
    for (const rec of mv.results) {
      const cells = [...rec.cells];
      while (cells.length < (mv.headers || []).length) cells.push("");
      lines.push(
        [...cells, rec.mapsName, rec.mapsAddress, rec.mapsPhone, rec.mapsWebsite, rec.addressMatch, rec.verdict]
          .map(esc)
          .join(",")
      );
    }
    triggerDownload(lines.join("\r\n"), "text/csv;charset=utf-8;", "maps-verified.csv");
    setStatus(`Exported ${mv.results.length} Maps-verified rows.`);
  }

  async function exportSheets() {
    const rows = getExportRows();
    if (!rows.length) return setStatus("Nothing to export (filters?).");
    // open the Sheet first (within the user gesture) or the popup may be blocked
    window.open("https://sheets.new", "_blank");
    try {
      await navigator.clipboard.writeText(toTSV(rows));
      setStatus(
        `${rows.length} leads copied. In the new Sheet, paste at cell A1 (Ctrl+V / Cmd+V).`
      );
    } catch (_) {
      setStatus("Clipboard blocked — use CSV instead.");
    }
  }

  // ---------- UI ----------
  let panel, statusEl, countEl, tableBody, btnStart, btnStop, btnResume, progEl;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "lead-scraper-panel";
    panel.innerHTML = `
      <div class="ls-head">
        <span class="ls-logo">📍</span>
        <span class="ls-title">LeadPin</span>
        <span class="ls-spin" id="ls-spin"></span>
        <span class="ls-count" id="ls-count">0</span>
        <button class="ls-x" id="ls-theme" title="Light/Dark">🌙</button>
        <button class="ls-x" id="ls-min" title="Minimize">–</button>
      </div>
      <div class="ls-body" id="ls-body">

        <div class="ls-chips">
          <div class="ls-chip"><b id="ls-c-total">0</b><span>leads</span></div>
          <div class="ls-chip ls-chip-a"><b id="ls-c-a">0</b><span>A-grade</span></div>
          <div class="ls-chip"><b id="ls-c-phone">0</b><span>phone</span></div>
          <div class="ls-chip"><b id="ls-c-email">0</b><span>email</span></div>
        </div>

        <div class="ls-prog-wrap"><div class="ls-prog" id="ls-prog"></div></div>

        <div class="ls-row">
          <button class="ls-btn ls-primary" id="ls-start">▶ Start</button>
          <button class="ls-btn ls-resume" id="ls-resume" style="display:none">▶ Resume</button>
          <button class="ls-btn ls-stop" id="ls-stop" disabled>■ Stop</button>
        </div>

        <div class="ls-row">
          <button class="ls-btn ls-sheets" id="ls-sheets">📊 Sheets</button>
          <button class="ls-btn" id="ls-xls">⬇ Excel</button>
          <button class="ls-btn" id="ls-csv">⬇ CSV</button>
          <button class="ls-btn" id="ls-copy" title="Copy CSV">⧉</button>
          <button class="ls-btn" id="ls-cmail" title="Copy all emails">📧</button>
          <button class="ls-btn ls-danger" id="ls-clear" title="Clear leads (keeps settings)">✕</button>
        </div>

        <details class="ls-sec" id="ls-sec-opts">
          <summary>⚙️ Options</summary>
          <label class="ls-check"><b>Target leads</b>
            <input type="number" id="ls-target" min="0" placeholder="0 = all" />
          </label>
          <label class="ls-check">Default country code
            <input type="text" id="ls-cc" placeholder="e.g. 1, 44, 92" />
          </label>
          <div class="ls-hint">For WhatsApp on local numbers. Auto-detected from each lead's country when known; this is the fallback.</div>
          <label class="ls-check"><input type="checkbox" id="ls-fresh" checked /> Fresh search (clear old leads on Start)</label>
          <label class="ls-check"><input type="checkbox" id="ls-deep" checked /> Deep enrich (phone + address)</label>
          <label class="ls-check"><input type="checkbox" id="ls-emails" checked /> Email + contact person (website)</label>
          <label class="ls-check"><input type="checkbox" id="ls-linkedin" checked /> Decision-maker (LinkedIn via Google)</label>
          <label class="ls-check">Speed:
            <select id="ls-speed">
              <option value="0.6">Fast</option>
              <option value="1" selected>Normal</option>
              <option value="1.8">Safe (avoid blocks)</option>
            </select>
          </label>
        </details>

        <details class="ls-sec">
          <summary>🔁 Multi-search queue</summary>
          <textarea id="ls-queries" class="ls-ta" rows="3"
            placeholder="One line = one search, e.g.&#10;dentist Lahore&#10;gym Karachi&#10;restaurant Islamabad&#10;(empty = use whatever is open now)"></textarea>
          <div class="ls-hint">Start → runs each search one by one.</div>
        </details>

        <details class="ls-sec">
          <summary>🎯 Filters</summary>
          <label class="ls-check">Preset:
            <select id="ls-preset">
              <option value="">— choose —</option>
              <option value="nowebsite">No website (web-dev leads)</option>
              <option value="toprated">Top rated (4.5★+)</option>
              <option value="popular">Popular (100+ reviews)</option>
              <option value="needshelp">Needs help (under 3.5★)</option>
              <option value="hasemail">Has email</option>
              <option value="ready">Outreach-ready</option>
            </select>
          </label>
          <div class="ls-frow">
            <label>Min rating <input type="number" id="ls-minrating" min="0" max="5" step="0.1" placeholder="0" /></label>
            <label>Max rating <input type="number" id="ls-maxrating" min="0" max="5" step="0.1" placeholder="5" /></label>
          </div>
          <div class="ls-frow">
            <label>Min reviews <input type="number" id="ls-minrev" min="0" placeholder="0" /></label>
            <label>Max reviews <input type="number" id="ls-maxrev" min="0" placeholder="∞" /></label>
          </div>
          <label class="ls-check"><input type="checkbox" id="ls-nowebsite" /> Only without website</label>
          <label class="ls-check"><input type="checkbox" id="ls-hasemail" /> Only with email</label>
          <label class="ls-check"><input type="checkbox" id="ls-ready" /> Only outreach-ready</label>
          <label class="ls-check">Min confidence:
            <select id="ls-minconf">
              <option value="">Any</option>
              <option value="High">High only</option>
              <option value="Med">High + Medium</option>
            </select>
          </label>
          <div class="ls-filt-foot">
            <span class="ls-hint" style="margin:0">Filters apply to exports (Sheets/CSV/Excel).</span>
            <button class="ls-link" id="ls-filt-reset">Reset filters</button>
          </div>
        </details>

        <details class="ls-sec">
          <summary>📋 Import existing (duplicate skip)</summary>
          <textarea id="ls-known" class="ls-ta" rows="3"
            placeholder="Existing list — phone or email, one per line. Matches get marked 'Already Have'."></textarea>
          <button class="ls-btn" id="ls-import" style="width:100%;margin-top:4px">Apply import</button>
          <div class="ls-hint" id="ls-known-count">No list imported.</div>
        </details>

        <details class="ls-sec">
          <summary>✅ Verify &amp; clean</summary>
          <label class="ls-check"><input type="checkbox" id="ls-vmx" checked /> Email domain check (MX)</label>
          <label class="ls-check"><input type="checkbox" id="ls-vsite" checked /> Website live + business match</label>
          <div class="ls-row">
            <button class="ls-btn ls-primary" id="ls-vleads">🔎 Verify scraped leads</button>
            <button class="ls-btn" id="ls-clean" title="Normalize phone/email/name">🧹 Clean</button>
          </div>
          <div class="ls-hint">— or verify your own CSV (any format): —</div>
          <div class="ls-sample">
            <div class="ls-hint" style="margin:0 0 4px">
              <b>CSV format</b> — needs at least one of
              <code>Email</code>, <code>Phone</code>, <code>Website</code>.
              <code>Business Name</code> optional. Extra columns are ignored.
            </div>
            <table class="ls-sample-tbl">
              <tr><th>Business Name</th><th>Phone</th><th>Email</th><th>Website</th></tr>
              <tr><td>ABC Traders</td><td>+92 300 1234567</td><td>info@abc.com</td><td>abc.com</td></tr>
            </table>
            <button class="ls-btn" id="ls-sample" style="width:100%;margin-top:4px">⬇ Download sample template</button>
          </div>
          <input type="file" id="ls-vfile" accept=".csv,.txt" class="ls-vfile" />
          <div id="ls-vmap" class="ls-vmap" style="display:none">
            <div class="ls-hint">Map your columns (auto-guessed — fix if wrong):</div>
            <label class="ls-check">Email col <select id="ls-map-email"></select></label>
            <label class="ls-check">Phone col <select id="ls-map-phone"></select></label>
            <label class="ls-check">Website col <select id="ls-map-website"></select></label>
            <label class="ls-check">Name col <select id="ls-map-name"></select></label>
            <label class="ls-check">Address col <select id="ls-map-address"></select></label>
          </div>
          <div class="ls-row">
            <button class="ls-btn ls-primary" id="ls-verify">✅ Verify CSV</button>
            <button class="ls-btn" id="ls-vexport">⬇ Export</button>
          </div>
          <input type="text" id="ls-vloc" class="ls-list-name" style="width:100%;margin-bottom:6px" placeholder="Location hint for Maps (e.g. Lahore, Pakistan) — optional" />
          <div class="ls-row">
            <button class="ls-btn ls-sheets" id="ls-vmaps">📍 Verify on Maps</button>
            <button class="ls-btn" id="ls-vmaps-exp">⬇ Maps CSV</button>
          </div>
          <div class="ls-hint">Maps verify: searches each business on Maps to compare address/phone (slow — the tab navigates). Location hint helps find the right country/city when the CSV has no address.</div>
          <div class="ls-hint" id="ls-vsummary">Upload a CSV. (XLSX? In Excel use "Save as CSV".)</div>
        </details>

        <details class="ls-sec">
          <summary>📑 Export columns</summary>
          <div class="ls-hint">Tick the columns to include in exports.</div>
          <div id="ls-cols" class="ls-cols"></div>
        </details>

        <details class="ls-sec">
          <summary>💾 Saved lists</summary>
          <div class="ls-row">
            <input type="text" id="ls-list-name" class="ls-list-name" placeholder="List name (e.g. Dentists Lahore)" />
            <button class="ls-btn ls-primary" id="ls-list-save">Save</button>
          </div>
          <div class="ls-row">
            <select id="ls-list-sel" style="flex:1"></select>
            <button class="ls-btn" id="ls-list-load">Load</button>
            <button class="ls-btn ls-danger" id="ls-list-del">🗑</button>
          </div>
          <div class="ls-hint">Save current leads as a named list; load/delete later.</div>
        </details>

        <div class="ls-row" style="margin:6px 0">
          <button class="ls-btn" id="ls-stats" style="width:100%">📊 Stats</button>
        </div>

        <div class="ls-status" id="ls-status">Search on Google Maps, then Start.</div>
        <div class="ls-table-wrap">
          <table class="ls-table">
            <thead><tr><th>#</th><th>Business</th><th>⭐</th><th>Phone</th><th>Email</th></tr></thead>
            <tbody id="ls-tbody"></tbody>
          </table>
        </div>
      </div>`;
    document.body.appendChild(panel);

    statusEl = panel.querySelector("#ls-status");
    countEl = panel.querySelector("#ls-count");
    tableBody = panel.querySelector("#ls-tbody");
    btnStart = panel.querySelector("#ls-start");
    btnStop = panel.querySelector("#ls-stop");
    btnResume = panel.querySelector("#ls-resume");
    progEl = panel.querySelector("#ls-prog");

    btnStart.addEventListener("click", () => {
      state.targetCount = parseInt(panel.querySelector("#ls-target").value) || 0;
      state.countryCode = panel.querySelector("#ls-cc").value.trim() || "92";
      state.deepEnrich = panel.querySelector("#ls-deep").checked;
      state.findEmails = panel.querySelector("#ls-emails").checked;
      state.findLinkedin = panel.querySelector("#ls-linkedin").checked;
      state.speed = parseFloat(panel.querySelector("#ls-speed").value) || 1;
      readFiltersFromUI();
      state.queries = parseQueries();
      saveSettings();
      startFromUI();
    });
    btnStop.addEventListener("click", stop);
    btnResume.addEventListener("click", () => {
      if (state.paused) continueRun();
    });
    panel.querySelector("#ls-sheets").addEventListener("click", exportSheets);
    panel.querySelector("#ls-xls").addEventListener("click", downloadXLS);
    panel.querySelector("#ls-csv").addEventListener("click", downloadCSV);
    panel.querySelector("#ls-copy").addEventListener("click", copyCSV);
    panel.querySelector("#ls-cmail").addEventListener("click", copyEmails);
    panel.querySelector("#ls-clear").addEventListener("click", reset);
    panel.querySelector("#ls-cc").addEventListener("change", () => {
      state.countryCode = panel.querySelector("#ls-cc").value.trim() || "92";
      state.rows.forEach((r) => {
        r.whatsapp = "";
        deriveFields(r);
      });
      saveStateNow();
      renderTableNow();
      setStatus(`Country code: +${state.countryCode}`);
    });
    panel.querySelector("#ls-preset").addEventListener("change", applyPreset);
    panel.querySelector("#ls-filt-reset").addEventListener("click", resetFilters);
    panel.querySelector("#ls-import").addEventListener("click", applyImport);
    panel.querySelector("#ls-verify").addEventListener("click", runVerify);
    panel.querySelector("#ls-vexport").addEventListener("click", exportVerified);
    panel.querySelector("#ls-sample").addEventListener("click", downloadSampleCSV);
    panel.querySelector("#ls-theme").addEventListener("click", toggleTheme);
    panel.querySelector("#ls-list-save").addEventListener("click", saveList);
    panel.querySelector("#ls-list-load").addEventListener("click", loadList);
    panel.querySelector("#ls-list-del").addEventListener("click", deleteList);
    panel.querySelector("#ls-stats").addEventListener("click", showStats);
    panel.querySelector("#ls-vmaps").addEventListener("click", startMapsVerify);
    panel.querySelector("#ls-vmaps-exp").addEventListener("click", exportMapsVerify);
    panel.querySelector("#ls-vleads").addEventListener("click", verifyScrapedLeads);
    panel.querySelector("#ls-clean").addEventListener("click", cleanLeads);
    panel.querySelector("#ls-vfile").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.verifyText = reader.result || "";
        buildColumnMapping();
        setStatus(`"${f.name}" loaded — check column mapping, then Verify.`);
      };
      reader.onerror = () => setStatus("Could not read that file.");
      reader.readAsText(f);
    });
    // click a row -> lead detail
    tableBody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-idx]");
      if (tr) showLeadDetail(parseInt(tr.getAttribute("data-idx")));
    });
    panel.querySelector("#ls-min").addEventListener("click", () => {
      const b = panel.querySelector("#ls-body");
      const hidden = b.style.display === "none";
      b.style.display = hidden ? "" : "none";
      panel.querySelector("#ls-min").textContent = hidden ? "–" : "+";
    });
    // export column checkboxes (dynamic — essentials pre-ticked)
    panel.querySelector("#ls-cols").innerHTML = COLS.map(
      ([k, label]) =>
        `<label class="ls-colchk"><input type="checkbox" data-col="${k}" ${
          DEFAULT_COLS.has(k) ? "checked" : ""
        }/> ${label}</label>`
    ).join("");

    // remember settings whenever something changes
    panel.querySelectorAll("input,select,textarea").forEach((el) =>
      el.addEventListener("change", saveSettings)
    );

    makeDraggable(panel, panel.querySelector(".ls-head"));
  }

  function parseQueries() {
    const ta = panel && panel.querySelector("#ls-queries");
    if (!ta) return [];
    return ta.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function readFiltersFromUI() {
    if (!panel) return;
    const g = (id) => panel.querySelector(id);
    state.filters = {
      minRating: parseFloat(g("#ls-minrating").value) || 0,
      maxRating: parseFloat(g("#ls-maxrating").value) || 0,
      minReviews: parseInt(g("#ls-minrev").value) || 0,
      maxReviews: parseInt(g("#ls-maxrev").value) || 0,
      onlyNoWebsite: g("#ls-nowebsite").checked,
      onlyWithEmail: g("#ls-hasemail").checked,
      onlyOutreachReady: g("#ls-ready").checked,
      minConfidence: g("#ls-minconf").value,
    };
  }

  // reset filters only (not leads) — settings are intentionally separate
  function resetFilters() {
    const g = (id) => panel.querySelector(id);
    [
      "#ls-minrating", "#ls-maxrating", "#ls-minrev", "#ls-maxrev",
      "#ls-preset", "#ls-minconf",
    ].forEach((id) => (g(id).value = ""));
    ["#ls-nowebsite", "#ls-hasemail", "#ls-ready"].forEach(
      (id) => (g(id).checked = false)
    );
    readFiltersFromUI();
    saveSettings();
    renderTable();
    setStatus("Filters reset.");
  }

  // niche presets — set targeting in one click
  function applyPreset() {
    const v = panel.querySelector("#ls-preset").value;
    const g = (id) => panel.querySelector(id);
    // reset
    g("#ls-minrating").value = "";
    g("#ls-maxrating").value = "";
    g("#ls-minrev").value = "";
    g("#ls-maxrev").value = "";
    g("#ls-nowebsite").checked = false;
    g("#ls-hasemail").checked = false;
    g("#ls-ready").checked = false;
    if (v === "nowebsite") g("#ls-nowebsite").checked = true;
    else if (v === "toprated") g("#ls-minrating").value = "4.5";
    else if (v === "popular") g("#ls-minrev").value = "100";
    else if (v === "needshelp") g("#ls-maxrating").value = "3.5";
    else if (v === "hasemail") g("#ls-hasemail").checked = true;
    else if (v === "ready") g("#ls-ready").checked = true;
    readFiltersFromUI();
    saveSettings();
    renderTable();
    setStatus(v ? `Preset: ${v}` : "Filters cleared.");
  }

  // existing list import -> state.known (phone/email) + rows dobara mark
  function applyImport() {
    const txt = panel.querySelector("#ls-known").value || "";
    const known = new Set();
    for (let line of txt.split("\n")) {
      line = line.trim();
      if (!line) continue;
      if (line.includes("@")) known.add("e:" + line.toLowerCase());
      else {
        const ph = normPhone(line);
        if (ph.length >= 7) known.add("p:" + ph);
      }
    }
    state.known = known;
    state.rows.forEach(deriveFields); // alreadyHave dobara compute
    renderTable();
    saveState();
    saveSettings();
    const n = state.rows.filter((r) => r.alreadyHave).length;
    panel.querySelector("#ls-known-count").textContent =
      `${known.size} entries imported · ${n} leads already have.`;
    setStatus(`Imported ${known.size} · ${n} duplicates marked.`);
  }

  function reflectOptionsToUI() {
    if (!panel) return;
    panel.querySelector("#ls-target").value = state.targetCount || "";
    panel.querySelector("#ls-deep").checked = state.deepEnrich;
    panel.querySelector("#ls-emails").checked = state.findEmails;
    panel.querySelector("#ls-linkedin").checked = state.findLinkedin;
    panel.querySelector("#ls-speed").value = String(state.speed);
    const f = state.filters || {};
    panel.querySelector("#ls-minrating").value = f.minRating || "";
    panel.querySelector("#ls-maxrating").value = f.maxRating || "";
    panel.querySelector("#ls-minrev").value = f.minReviews || "";
    panel.querySelector("#ls-maxrev").value = f.maxReviews || "";
    panel.querySelector("#ls-nowebsite").checked = !!f.onlyNoWebsite;
    panel.querySelector("#ls-hasemail").checked = !!f.onlyWithEmail;
    panel.querySelector("#ls-ready").checked = !!f.onlyOutreachReady;
    if (f.minConfidence) panel.querySelector("#ls-minconf").value = f.minConfidence;
  }

  // ---------- named saved lists ----------
  const LISTS_KEY = "leadScraperLists";
  async function getLists() {
    try {
      const g = await chrome.storage.local.get(LISTS_KEY);
      return (g && g[LISTS_KEY]) || {};
    } catch (_) {
      return {};
    }
  }
  async function refreshListDropdown() {
    if (!panel) return;
    const lists = await getLists();
    const names = Object.keys(lists).sort();
    const sel = panel.querySelector("#ls-list-sel");
    sel.innerHTML = names.length
      ? names
          .map(
            (n) =>
              `<option value="${escAttr(n)}">${escHtml(n)} (${
                (lists[n] && lists[n].count) || 0
              })</option>`
          )
          .join("")
      : '<option value="">— no saved lists —</option>';
  }
  async function saveList() {
    const name = panel.querySelector("#ls-list-name").value.trim();
    if (!name) return setStatus("Enter a list name.");
    if (!state.rows.length) return setStatus("No leads to save.");
    const lists = await getLists();
    lists[name] = {
      count: state.rows.length,
      savedAt: new Date().toISOString(),
      rows: state.rows.map(({ _card, ...r }) => r),
    };
    try {
      await chrome.storage.local.set({ [LISTS_KEY]: lists });
    } catch (_) {
      return setStatus("Save failed (storage full?).");
    }
    await refreshListDropdown();
    setStatus(`Saved "${name}" (${state.rows.length} leads).`);
  }
  async function loadList() {
    const name = panel.querySelector("#ls-list-sel").value;
    if (!name) return setStatus("No list selected.");
    const lists = await getLists();
    const lst = lists[name];
    if (!lst) return setStatus("List not found.");
    state.rows = (lst.rows || []).slice();
    state.seen = new Set(state.rows.map((r) => r.mapsUrl || r.businessName));
    saveStateNow();
    renderTableNow();
    setStatus(`Loaded "${name}" (${state.rows.length} leads).`);
  }
  async function deleteList() {
    const name = panel.querySelector("#ls-list-sel").value;
    if (!name) return;
    if (!confirm(`Delete saved list "${name}"?`)) return;
    const lists = await getLists();
    delete lists[name];
    try {
      await chrome.storage.local.set({ [LISTS_KEY]: lists });
    } catch (_) {}
    await refreshListDropdown();
    setStatus(`Deleted "${name}".`);
  }

  // ---------- mini analytics ----------
  function showStats() {
    const r = state.rows;
    if (!r.length) return setStatus("No leads yet.");
    const pct = (n) => Math.round((n / r.length) * 100);
    const cnt = (f) => r.filter(f).length;
    const ratings = r.map((x) => num(x.rating)).filter((x) => x > 0);
    const avgR = ratings.length
      ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2)
      : "—";
    const rows = [
      ["Total leads", r.length],
      ["With phone", `${cnt((x) => x.phone)} (${pct(cnt((x) => x.phone))}%)`],
      ["With email", `${cnt((x) => x.email)} (${pct(cnt((x) => x.email))}%)`],
      ["With website", `${cnt((x) => x.website)} (${pct(cnt((x) => x.website))}%)`],
      ["With person", `${cnt((x) => x.person)} (${pct(cnt((x) => x.person))}%)`],
      ["WhatsApp ready", `${cnt((x) => x.whatsapp)} (${pct(cnt((x) => x.whatsapp))}%)`],
      ["Outreach-ready", `${cnt((x) => x.outreachReady)} (${pct(cnt((x) => x.outreachReady))}%)`],
      ["Grade A / B / C", `${cnt((x) => x.leadScore === "A")} / ${cnt((x) => x.leadScore === "B")} / ${cnt((x) => x.leadScore === "C")}`],
      ["Avg rating", avgR],
      ["No website (web-dev leads)", cnt((x) => !x.website)],
    ];
    let ov = document.getElementById("ls-detail");
    if (ov) ov.remove();
    ov = document.createElement("div");
    ov.id = "ls-detail";
    ov.innerHTML = `
      <div class="ls-d-card">
        <div class="ls-d-head"><b>📊 Lead Stats</b><button class="ls-x" id="ls-d-close">✕</button></div>
        <table class="ls-d-table">${rows
          .map(
            ([k, v]) =>
              `<tr><td class="ls-d-k">${k}</td><td class="ls-d-v">${v}</td></tr>`
          )
          .join("")}</table>
      </div>`;
    panel.appendChild(ov);
    ov.querySelector("#ls-d-close").onclick = () => ov.remove();
    ov.onclick = (e) => {
      if (e.target === ov) ov.remove();
    };
  }

  function toggleTheme() {
    const dark = panel.classList.toggle("ls-dark");
    panel.querySelector("#ls-theme").textContent = dark ? "☀️" : "🌙";
    try {
      chrome.storage.local.set({ leadScraperTheme: dark ? "dark" : "light" });
    } catch (_) {}
  }
  async function loadTheme() {
    try {
      const g = await chrome.storage.local.get("leadScraperTheme");
      if (g && g.leadScraperTheme === "dark") {
        panel.classList.add("ls-dark");
        panel.querySelector("#ls-theme").textContent = "☀️";
      }
    } catch (_) {}
  }

  function setStatus(m) {
    if (statusEl) statusEl.textContent = m;
  }

  // throttled render (anti-freeze): avoid rebuilding the whole table repeatedly
  let _renderTimer = null;
  let _lastRender = 0;
  function renderTable() {
    const now = Date.now();
    if (now - _lastRender > 250) {
      _lastRender = now;
      renderTableNow();
    } else if (!_renderTimer) {
      _renderTimer = setTimeout(() => {
        _renderTimer = null;
        _lastRender = Date.now();
        renderTableNow();
      }, 250);
    }
  }

  function renderTableNow() {
    if (!tableBody) return;
    countEl.textContent = state.rows.length;
    const rows = state.rows.slice(-200);
    const start = state.rows.length - rows.length;
    tableBody.innerHTML = rows
      .map((r, i) => {
        const idx = start + i;
        const g = r.leadScore || "";
        const dup = r.alreadyHave ? ' <span class="ls-dup" title="Already have">●</span>' : "";
        return `<tr data-idx="${idx}" class="ls-clickable">
          <td>${idx + 1}</td>
          <td title="${escAttr(r.businessName)}">${escHtml(r.businessName)}${dup}</td>
          <td><span class="ls-grade ls-grade-${g}">${g}</span></td>
          <td>${escHtml(r.phone)}</td>
          <td title="${escAttr(r.email)}">${escHtml(r.email)}</td>
        </tr>`;
      })
      .join("");
    updateChips();
  }

  // ---------- lead detail view (row click) ----------
  function showLeadDetail(idx) {
    const r = state.rows[idx];
    if (!r) return;
    let ov = document.getElementById("ls-detail");
    if (ov) ov.remove();
    ov = document.createElement("div");
    ov.id = "ls-detail";
    const link = (v) =>
      /^https?:\/\//i.test(v)
        ? `<a href="${escAttr(v)}" target="_blank">${escHtml(v)}</a>`
        : escHtml(v);
    const rowsHtml = COLS.filter(([f]) => r[f])
      .map(
        ([f, label]) =>
          `<tr><td class="ls-d-k">${label}</td><td class="ls-d-v">${link(
            r[f]
          )}</td></tr>`
      )
      .join("");
    const STATUSES = ["", "New", "Contacted", "Replied", "Won", "Lost"];
    const statusOpts = STATUSES.map(
      (s) =>
        `<option value="${s}" ${r.leadStatus === s ? "selected" : ""}>${
          s || "— status —"
        }</option>`
    ).join("");
    ov.innerHTML = `
      <div class="ls-d-card">
        <div class="ls-d-head">
          <b>${escHtml(r.businessName) || "Lead"}</b>
          <button class="ls-x" id="ls-d-close">✕</button>
        </div>
        <div class="ls-d-crm">
          <select id="ls-d-status">${statusOpts}</select>
          <textarea id="ls-d-notes" placeholder="Notes…" rows="2">${escHtml(r.notes || "")}</textarea>
        </div>
        <table class="ls-d-table">${rowsHtml}</table>
        <div class="ls-d-foot">
          <button class="ls-btn" id="ls-d-copy">⧉ Copy</button>
          <button class="ls-btn ls-danger" id="ls-d-del">🗑 Delete</button>
        </div>
      </div>`;
    panel.appendChild(ov);
    // CRM: status/notes save on change
    ov.querySelector("#ls-d-status").onchange = (e) => {
      r.leadStatus = e.target.value;
      saveStateNow();
      renderTable();
    };
    ov.querySelector("#ls-d-notes").onblur = (e) => {
      r.notes = e.target.value;
      saveStateNow();
    };
    ov.querySelector("#ls-d-close").onclick = () => ov.remove();
    ov.onclick = (e) => {
      if (e.target === ov) ov.remove();
    };
    ov.querySelector("#ls-d-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(
          COLS.filter(([f]) => r[f])
            .map(([f, l]) => `${l}: ${r[f]}`)
            .join("\n")
        );
        setStatus("Lead copied.");
      } catch (_) {}
    };
    ov.querySelector("#ls-d-del").onclick = () => {
      state.rows.splice(idx, 1);
      saveState();
      renderTable();
      ov.remove();
      setStatus("Lead deleted.");
    };
  }

  function updateChips() {
    if (!panel) return;
    const set = (id, v) => {
      const el = panel.querySelector(id);
      if (el) el.textContent = v;
    };
    set("#ls-c-total", state.rows.length);
    set("#ls-c-a", state.rows.filter((r) => r.leadScore === "A").length);
    set("#ls-c-phone", state.rows.filter((r) => r.phone).length);
    set("#ls-c-email", state.rows.filter((r) => r.email).length);
  }

  // progress bar: pct 0-100, ya -1 = indeterminate (scrolling)
  function setProgress(pct) {
    if (!progEl) return;
    if (pct < 0) {
      progEl.style.width = "100%";
      progEl.classList.add("ls-prog-indet");
    } else {
      progEl.classList.remove("ls-prog-indet");
      progEl.style.width = Math.max(0, Math.min(100, pct)) + "%";
    }
  }

  // ---------- settings persistence ----------
  const SETTINGS_KEY = "leadScraperSettings";
  async function saveSettings() {
    if (!panel) return;
    const g = (id) => panel.querySelector(id);
    try {
      await chrome.storage.local.set({
        [SETTINGS_KEY]: {
          fresh: g("#ls-fresh").checked,
          deep: g("#ls-deep").checked,
          emails: g("#ls-emails").checked,
          linkedin: g("#ls-linkedin").checked,
          target: g("#ls-target").value,
          cc: g("#ls-cc").value,
          speed: g("#ls-speed").value,
          queries: g("#ls-queries").value,
          minRating: g("#ls-minrating").value,
          maxRating: g("#ls-maxrating").value,
          minRev: g("#ls-minrev").value,
          maxRev: g("#ls-maxrev").value,
          noWeb: g("#ls-nowebsite").checked,
          hasEmail: g("#ls-hasemail").checked,
          ready: g("#ls-ready").checked,
          minConf: g("#ls-minconf").value,
          known: g("#ls-known").value,
          cols: Array.from(
            panel.querySelectorAll("#ls-cols input[data-col]:checked")
          ).map((i) => i.getAttribute("data-col")),
        },
      });
    } catch (_) {}
  }
  async function loadSettings() {
    if (!panel) return;
    try {
      const got = await chrome.storage.local.get(SETTINGS_KEY);
      const s = got && got[SETTINGS_KEY];
      if (!s) return;
      const g = (id) => panel.querySelector(id);
      g("#ls-fresh").checked = s.fresh !== false;
      g("#ls-deep").checked = s.deep !== false;
      g("#ls-emails").checked = s.emails !== false;
      g("#ls-linkedin").checked = s.linkedin !== false;
      if (s.target != null) g("#ls-target").value = s.target;
      if (s.cc != null) {
        g("#ls-cc").value = s.cc;
        state.countryCode = s.cc.trim() || "92";
      }
      if (s.speed) g("#ls-speed").value = s.speed;
      if (s.queries != null) g("#ls-queries").value = s.queries;
      if (s.minRating != null) g("#ls-minrating").value = s.minRating;
      if (s.maxRating != null) g("#ls-maxrating").value = s.maxRating;
      if (s.minRev != null) g("#ls-minrev").value = s.minRev;
      if (s.maxRev != null) g("#ls-maxrev").value = s.maxRev;
      g("#ls-nowebsite").checked = !!s.noWeb;
      g("#ls-hasemail").checked = !!s.hasEmail;
      g("#ls-ready").checked = !!s.ready;
      if (s.minConf) g("#ls-minconf").value = s.minConf;
      if (Array.isArray(s.cols) && s.cols.length) {
        const want = new Set(s.cols);
        panel.querySelectorAll("#ls-cols input[data-col]").forEach((i) => {
          i.checked = want.has(i.getAttribute("data-col"));
        });
      }
      if (s.known != null) {
        g("#ls-known").value = s.known;
        applyImport(); // rebuild state.known
      }
    } catch (_) {}
  }

  const escHtml = (s) =>
    String(s || "").replace(/[&<>]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])
    );
  const escAttr = (s) => escHtml(s).replace(/"/g, "&quot;");

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.style.cursor = "move";
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = ox + (e.clientX - sx) + "px";
      el.style.top = oy + (e.clientY - sy) + "px";
      el.style.right = "auto";
    });
    document.addEventListener("mouseup", () => (dragging = false));
  }

  async function init() {
    if (document.getElementById("lead-scraper-panel")) return;
    buildPanel();
    await loadTheme(); // light/dark
    await loadSettings(); // restore saved options/filters/queries (state.known too)
    await refreshListDropdown();
    await loadState(); // bring back old leads
    if (state.known && state.known.size) state.rows.forEach(deriveFields); // dup mark
    renderTable();
    if (state.rows.length)
      setStatus(`${state.rows.length} saved leads loaded. Start to add more.`);

    // restore old Maps-verify + Verify-CSV results (for the export buttons)
    try {
      const g = await chrome.storage.local.get([MRESULTS_KEY, VRESULTS_KEY]);
      if (g && g[MRESULTS_KEY]) state.mapsResults = g[MRESULTS_KEY];
      if (g && g[VRESULTS_KEY]) {
        state.verifyHeaders = g[VRESULTS_KEY].headers || [];
        state.verifyRows = g[VRESULTS_KEY].rows || [];
      }
    } catch (_) {}

    // continue Maps cross-verify if it was running
    if (await resumeMapsVerify()) return;
    // continue the multi-search queue if it was running
    const resumed = await resumeJob();
    if (resumed) return;
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
