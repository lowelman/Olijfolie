# CLAUDE.md

## What this is
A simple, fully responsive webpage where people can preorder olive oil.
Visitors enter their name, email address and the number of jugs they want.
Each order is appended as a row to a shared Google Sheet.

## Tech stack
- Static `index.html` with vanilla JS (no build step, no framework)
- Tailwind CSS via the Play CDN (pinned version)
- Google Apps Script web app as the form backend
- Google Sheets as the order "database"
- Cloudflare Turnstile captcha, verified server-side in Apps Script. The secret key lives in the Script Properties (`TURNSTILE_SECRET`), never in the repo
- Hosting: GitHub Pages

## Structure
index.html           → The preorder page (UI + form logic)
images/              → Background photos (resized to ~1600px wide, keep them web-sized)
apps-script/Code.gs  → Apps Script source; paste into the Sheet's script editor
README.md            → Setup and deploy instructions
.github/workflows/health-check.yml → Daily check of the page + Apps Script self-test (?health=1)

## Rules
- All UI text in Dutch
- Mobile-first, fully responsive layouts
- Tailwind only — no inline styles
- Validate all input in Apps Script (client-side checks are only for UX)
- Keep it build-free: no npm, bundlers or frameworks
- After changing Code.gs, redeploy as a new version of the existing deployment so the URL stays the same

## Commands
npx serve .        → Preview the page locally (needed for the captcha; file:// won't work)
git push           → Deploys to GitHub Pages
