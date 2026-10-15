# Changelog

All notable changes to LeadPin are documented here.

## [1.2.0] — 2026-10-16
### Added
- Custom toolbar icon (map pin, 16/32/48/128)
- Google Maps **cross-verify** for imported CSVs (compares real address/phone), with a **Location hint** and auto-download
- **Column mapping** so any CSV format can be verified (map Email/Phone/Website/Name/Address)
- Sample CSV template download
- Mini-CRM: per-lead **Status** + **Notes** (in the lead detail view)
- **Saved lists** (save/load/delete named lead lists)
- **Stats** overlay (coverage %, grade distribution, average rating)
- **Copy-emails** button and **dark mode** toggle
- Business hours + open/closed columns
- World-wide WhatsApp links (country auto-detect + default country code)
- Export **column picker**
- "Reset filters" link (separate from Clear leads)

### Changed
- **Deep enrich is now virtualization-aware** — reliably scrapes phone/address for all visible+scrolled leads (was missing most before)
- Verify results auto-download and persist (no longer lost on reload)
- Smarter address matching (ignores filler words / format differences)
- Category no longer bleeds hours/rating text

### Fixed
- Invalid manifest host wildcard
- Stale-leads bug (new search kept old leads); added **Fresh search**
- "Contact Person" wrongly detected as the phone column in verify
- `· Visited link` suffix stripped from business names

## [1.1.0]
### Added
- Verify & clean (email MX, website live, phone format, confidence)
- Filters + presets, import-existing (duplicate skip)
- Multi-search queue, target leads, anti-block pacing + CAPTCHA pause/resume

## [1.0.0]
- Initial: Google Maps list scrape, deep enrich (phone/address/website),
  website email + contact person, LinkedIn decision-maker, CSV/Excel/Sheets export
