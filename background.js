/* =========================================================================
   LeadPin  —  background service worker
   Fetches business websites to find EMAIL + CONTACT PERSON (CEO/owner).
   host_permissions bypass CORS. Everything stays local.
   ========================================================================= */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?)$/i;

// pages within a website that usually hold contact info
const PATHS = [
  "",
  "/contact",
  "/contact-us",
  "/contactus",
  "/about",
  "/about-us",
  "/team",
  "/our-team",
  "/company",
];

// look for a name near these roles
const ROLE_RE =
  /\b(CEO|Chief Executive(?: Officer)?|Founder|Co-?Founder|Owner|Proprietor|Managing Director|Director|President|Principal|Partner|Manager)\b/i;

// aam naam pattern: 2-3 capitalized words
const NAME_RE = /\b([A-Z][a-z]{1,15}(?:\s[A-Z][a-z]{1,15}){1,2})\b/;

// ---------- helpers ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// markers of a block/CAPTCHA page (Google "sorry" / unusual traffic / Cloudflare)
function looksBlocked(text) {
  return /\/sorry\/|unusual traffic|detected unusual|are not a robot|id="captcha|cf-browser-verification|Attention Required/i.test(
    (text || "").slice(0, 4000)
  );
}

// fetch with backoff on 429/503, browser-like headers, and block detection
async function fetchText(url, withCreds = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        credentials: withCreds ? "include" : "omit",
        headers: { "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(9000),
      });
      // rate-limited -> wait a bit and retry
      if (res.status === 429 || res.status === 503) {
        await wait(2000 + Math.random() * 2500);
        continue;
      }
      if (!res.ok) return "";
      const ct = res.headers.get("content-type") || "";
      if (ct && !/text|html|json|xml/i.test(ct)) return "";
      const body = await res.text();
      return body.length > 400000 ? body.slice(0, 400000) : body; // cap to avoid hang/OOM
    } catch (_) {
      await wait(600);
    }
  }
  return "";
}

// don't fetch internal/loopback/metadata hosts (SSRF guard)
function isInternalHost(url) {
  try {
    const h = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).hostname.toLowerCase();
    if (
      h === "localhost" ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      h === "0.0.0.0" ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h === "::1" ||
      h.startsWith("[")
    )
      return true;
    return false;
  } catch (_) {
    return true; // if it won't parse, block to be safe
  }
}

const stripTags = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

function pickEmail(html) {
  const emails = new Set();

  // 1) mailto: links (sabse bharosemand)
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = decodeURIComponent(m[1]).trim();
    if (e.includes("@") && !BAD_EMAIL.test(e)) emails.add(e);
  }

  // 2) de-obfuscate: "name [at] site [dot] com"
  const deob = html
    .replace(/\s*\[?\(?\s*at\s*\)?\]?\s*/gi, "@")
    .replace(/\s*\[?\(?\s*dot\s*\)?\]?\s*/gi, ".");

  // 3) plain emails
  for (const text of [html, deob]) {
    for (const m of text.match(EMAIL_RE) || []) {
      const e = m.trim();
      if (BAD_EMAIL.test(e)) continue;
      if (/\.(webp|png)$/i.test(e)) continue;
      emails.add(e);
    }
  }

  // drop sentry/wix/cdn/junk emails, prioritize info@/contact@
  const list = [...emails].filter(
    (e) =>
      !/sentry|example\.(com|org)|wixpress|@2x|yourname|email@|fbcdn|cloudfront|cdn\.|akamai|gstatic|googleapis|\.(png|jpg|gif)$|^[a-f0-9]{16,}@/i.test(
        e
      )
  );
  list.sort((a, b) => {
    const score = (e) =>
      /^(info|contact|hello|sales|admin|office)@/i.test(e) ? 0 : 1;
    return score(a) - score(b);
  });
  return list[0] || "";
}

function pickPerson(html) {
  // 1) JSON-LD structured data (founder / Person)
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const data = JSON.parse(m[1].trim());
      const person = findPersonInJsonLd(data);
      if (person) return person;
    } catch (_) {}
  }

  // 2) text: a name near a role keyword
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

  const roleMatch = text.match(ROLE_RE);
  if (roleMatch) {
    const idx = roleMatch.index;
    // look for a name within ~40 chars around the role
    const before = text.slice(Math.max(0, idx - 45), idx);
    const after = text.slice(idx, idx + roleMatch[0].length + 45);
    const nm =
      (before.match(NAME_RE) && before.match(NAME_RE)[1]) ||
      (after.replace(ROLE_RE, "").match(NAME_RE) &&
        after.replace(ROLE_RE, "").match(NAME_RE)[1]);
    if (nm) return nm;
  }
  return "";
}

function findPersonInJsonLd(data) {
  if (!data) return "";
  const arr = Array.isArray(data) ? data : [data];
  for (const node of arr) {
    if (!node || typeof node !== "object") continue;
    if (node["@graph"]) {
      const r = findPersonInJsonLd(node["@graph"]);
      if (r) return r;
    }
    for (const key of ["founder", "founders", "employee", "author"]) {
      const v = node[key];
      if (!v) continue;
      const items = Array.isArray(v) ? v : [v];
      for (const it of items) {
        if (typeof it === "string") return it;
        if (it && it.name) return it.name;
      }
    }
    if (node["@type"] === "Person" && node.name) return node.name;
  }
  return "";
}

function pickPhone(html) {
  // tel: link sabse reliable
  const tel = html.match(/tel:([+\d][\d\s().-]{6,})/i);
  if (tel) return tel[1].trim();
  return "";
}

function pickSocials(html) {
  const out = { facebook: "", instagram: "" };
  const fb = html.match(
    /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9.\-_/]{2,}/i
  );
  const ig = html.match(
    /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._\-/]{2,}/i
  );
  if (fb && !/sharer|plugins|dialog|\/tr\?/i.test(fb[0]))
    out.facebook = fb[0].replace(/[)"'].*$/, "");
  if (ig && !/\/p\//i.test(ig[0]))
    out.instagram = ig[0].replace(/[)"'].*$/, "");
  return out;
}

// ---------- main ----------
async function enrichSite(site) {
  if (isInternalHost(site)) return {}; // skip internal/loopback hosts (SSRF)
  let base = site;
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  let origin;
  try {
    origin = new URL(base).origin;
  } catch (_) {
    return {};
  }

  const result = { email: "", person: "", phone: "", facebook: "", instagram: "" };

  for (const path of PATHS) {
    const html = await fetchText(origin + path);
    if (!html) continue;
    if (!result.email) result.email = pickEmail(html);
    if (!result.person) result.person = pickPerson(html);
    if (!result.phone) result.phone = pickPhone(html);
    if (!result.facebook || !result.instagram) {
      const s = pickSocials(html);
      if (s.facebook && !result.facebook) result.facebook = s.facebook;
      if (s.instagram && !result.instagram) result.instagram = s.instagram;
    }
    if (result.email && result.person && result.facebook) break;
  }
  return result;
}

// ---------- LinkedIn via Google search (we never touch LinkedIn directly) ----------
const LI_QUERY_ROLES =
  '(CEO OR Founder OR "Co-Founder" OR Owner OR "Managing Director" OR Director OR President OR Proprietor)';

function buildLinkedInSearchUrl(name, location) {
  const q = `${name} ${location || ""} ${LI_QUERY_ROLES} site:linkedin.com/in`
    .replace(/\s+/g, " ")
    .trim();
  return "https://www.google.com/search?hl=en&num=10&q=" + encodeURIComponent(q);
}

async function findLinkedIn(name, location) {
  const out = { person: "", title: "", linkedin: "", linkedinSearch: "" };
  if (!name) return out;

  out.linkedinSearch = buildLinkedInSearchUrl(name, location); // hamesha fallback link
  const html = await fetchText(out.linkedinSearch, true);
  if (!html) return out; // network fail -> sirf link rahega
  if (looksBlocked(html)) {
    out.blocked = true; // Google ne CAPTCHA/unusual-traffic diya
    return out;
  }

  // profile url
  const urlm = html.match(
    /https?:\/\/[a-z]{0,3}\.?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i
  );
  if (urlm) out.linkedin = urlm[0].replace(/%3F.*$/, "");

  // result titles: "Name - Role - Company | LinkedIn"
  const titles = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean);

  for (const t of titles) {
    const clean = t.replace(/\s*[|\-–·]\s*LinkedIn.*$/i, "").trim();
    const parts = clean.split(/\s[-–|·]\s/);
    const cand = (parts[0] || "").trim();
    const nameMatch = cand.match(NAME_RE);
    // the name shouldn't match the business name (that's the company, not a person)
    if (
      nameMatch &&
      nameMatch[1].toLowerCase() !== name.trim().toLowerCase() &&
      !/\b(inc|llc|ltd|co|company|group|services|solutions)\b/i.test(cand)
    ) {
      out.person = nameMatch[1];
      const roleJoin = parts.slice(1).join(" ");
      const rm = roleJoin.match(ROLE_RE);
      if (rm) out.title = rm[0];
      break;
    }
  }
  return out;
}

// ---------- VERIFY: DNS lookup (DNS-over-HTTPS) ----------
async function dnsLookup(name, type) {
  try {
    const r = await fetch(
      "https://dns.google/resolve?name=" + encodeURIComponent(name) + "&type=" + type,
      { signal: AbortSignal.timeout(7000) }
    );
    const j = await r.json();
    return Array.isArray(j.Answer) ? j.Answer : [];
  } catch (_) {
    return null; // null = lookup fail
  }
}

// can the email's domain receive mail? MX, with an A-record fallback
async function checkMX(domain) {
  if (!domain) return { hasMX: null, hasA: null };
  const mx = await dnsLookup(domain, "MX");
  if (mx === null) return { hasMX: null, hasA: null }; // check fail
  const hasMX = mx.some((a) => a.type === 15);
  if (hasMX) return { hasMX: true, hasA: true };
  const a = await dnsLookup(domain, "A");
  return { hasMX: false, hasA: !!(a && a.some((x) => x.type === 1)) };
}

// ---------- VERIFY: website live + SSL + parked + business match? ----------
const PARKED_RE =
  /domain (is )?for sale|buy this domain|this domain (may be|is) for sale|parked (free|domain|by)|sedoparking|hugedomains|domain parking|godaddy\.com\/domainsearch|afternic/i;

async function checkSite(url, phone, name) {
  let u = url;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  const fail = {
    live: false, status: 0, https: false, parked: false,
    hasPhone: false, hasName: false,
  };
  if (isInternalHost(u)) return fail; // skip internal/loopback hosts (SSRF)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(u, {
        redirect: "follow",
        headers: { "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(9000),
      });
      if (r.status === 429 || r.status === 503) {
        await wait(1500 + Math.random() * 2000);
        continue;
      }
      const https = (r.url || u).toLowerCase().startsWith("https");
      const ct = r.headers.get("content-type") || "";
      let text = "";
      if (/text|html/i.test(ct)) text = (await r.text()).slice(0, 200000);
      const low = stripTags(text).toLowerCase();
      const parked = PARKED_RE.test(low) || PARKED_RE.test(text);
      const digitsOnly = low.replace(/\D/g, "");
      const last7 = (phone || "").replace(/\D/g, "").slice(-7);
      const hasPhone = last7.length >= 7 && digitsOnly.includes(last7);
      const tokens = (name || "")
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const hasName = tokens.length > 0 && tokens.some((w) => low.includes(w));
      return { live: !!r.ok, status: r.status, https, parked, hasPhone, hasName };
    } catch (_) {
      await wait(500);
    }
  }
  return fail;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "CHECK_MX") {
    checkMX(msg.domain).then((r) => sendResponse(r));
    return true;
  }
  if (msg && msg.type === "CHECK_SITE") {
    checkSite(msg.url, msg.phone, msg.name).then((r) => sendResponse(r));
    return true;
  }
  if (msg && msg.type === "ENRICH_SITE") {
    enrichSite(msg.url).then((r) => sendResponse(r));
    return true; // async
  }
  if (msg && msg.type === "FIND_LINKEDIN") {
    findLinkedIn(msg.name, msg.location).then((r) => sendResponse(r));
    return true; // async
  }
});
