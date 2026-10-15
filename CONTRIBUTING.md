# Contributing to LeadPin

Thanks for your interest! LeadPin is plain JavaScript (Manifest V3) — no build step, no dependencies.

## Setup
1. Clone the repo
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the folder
3. Edit a file → click **🔄 refresh** on the extension card → reload the Google Maps tab

## Project layout
| File | Role |
|------|------|
| `content.js` | UI panel + scraping/verify logic (runs on Google Maps) |
| `background.js` | Service worker: website/email fetch, DNS (MX), site checks |
| `content.css` | Panel styles (incl. dark theme) |
| `popup.html` | Toolbar popup |
| `manifest.json` | MV3 config |

## Most common maintenance: selectors
Google changes its Maps DOM often. If scraping stops returning data, the fix is almost always the **`SEL` object near the top of `content.js`**. See the "Troubleshooting" section in the README.

## Guidelines
- Keep it dependency-free and lightweight (plain JS/CSS).
- Comments and UI text in **English**.
- Wrap anything that can throw (storage, clipboard, fetch) in `try/catch`.
- Test on a small search (10–15 leads) before opening a PR.

## Reporting bugs
Open an issue with: Chrome version, what you searched, what you expected vs. got, and (if possible) the status text / console error.
