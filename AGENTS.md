# 🧠 AI Agent Context & Guidelines: Training Assistant

## 🎯 Project Overview
"Training Assistant" is a local-first, privacy-focused Node.js web application designed for runners. It parses Garmin `.FIT` files locally and combines them with user-inputted context (RPE, weather, gear, planned workout) to generate a highly structured, copy-pasteable prompt. This prompt is then fed by the user into an LLM (like ChatGPT or Claude) to act as a personalized running coach.

## 🛠️ Tech Stack & Infrastructure
- **Backend:** Node.js (v24), Fastify, vanilla JavaScript.
- **Frontend:** HTML5, Vanilla JS, CSS3 (Custom properties, CSS Grid/Flexbox).
- **UI/UX Theme:** Premium, minimalist, earthy tones (sage green, cream), utilizing "DM Sans" font.
- **Deployment:** Self-hosted on ZimaOS via Docker Compose.
- **CI/CD:** Automated via Self-Hosted GitHub Runner pushing to GitHub Container Registry (GHCR).
- **Networking:** Exposed securely via Cloudflare Zero Trust Tunnels (HTTP on port 8081).

## 🏆 Golden Rules
1. **Local-First & Privacy:** Never send `.FIT` data or user inputs to external cloud APIs for processing. All data parsing happens on the local server/browser.
2. **Test Coverage (The 100% Rule):** Test coverage must strictly remain at 100%. Never introduce new logic without accompanying tests (`npm run test:coverage`).
3. **No Bloatware:** Stick to Vanilla JS and pure CSS. Do not introduce heavy frontend frameworks (React/Vue/Tailwind) unless explicitly requested and justified.
4. **Infrastructure Immutability:** Do not alter Docker or GitHub Actions configurations without explicit permission. The current ZimaOS/Cloudflare setup (port 8081) is finalized.
5. **UI Consistency:** Any new UI elements must match the existing modern, high-density, cozy aesthetic.

## 🎨 Frontend Architecture (Immutable)

These rules codify the Phase 3 refactor and must never be violated by future work:

1. **Multi-Page Principle:** No single-page hacks or overlapping layout states. Every primary screen or user flow (e.g., Login, Register, TrainingResult/Dashboard) **must** reside in its own dedicated, standalone files following the `<page>.html` / `<page>.css` / `<page>.js` convention (`src/public/login.html`, `src/public/register.html`, `src/public/training-result.html`).
2. **Shared Abstractions & Modularization:** Common styling tokens (earthy color variables, fonts, resets) are centralized in shared assets (e.g., `src/public/shared/theme.css`), imported by every page stylesheet. Reusable logic (validators, API helpers) must be abstracted into ES modules under `src/public/shared/` (e.g., `validators.js`, `api.js`) and imported by the page scripts — never duplicated across pages.
3. **Server-Side Routing & Gating:** Fastify must strictly handle access control at the server level: unauthenticated requests to root or protected paths redirect to `login.html`; authenticated sessions are served `training-result.html`; authenticated users are redirected away from auth pages back to `/`.
4. **Testing Mandate:** All new pages and modular components must ship with accompanying tests and keep code coverage strictly at **100%** (`npm run test:coverage`).

## 💻 Development Workflow
Whenever starting the development of a new feature, you MUST follow this strict git workflow:
1. **Branching:** Create and checkout a new branch named `feature/<feature-name>`. Do NOT develop directly on the `main` branch.
2. **Implementation:** Develop the requested feature and write/update the corresponding tests.
3. **Verification:** Always execute the test suite (`npm run test:coverage`).
4. **Coverage Check:** Verify that the code coverage remains at exactly 100%. If it drops, write the missing tests before proceeding.
5. **Commit:** Only after tests pass and coverage is at 100%, commit the changes to the feature branch with a descriptive conventional commit message.

## 🗺️ Project Phases & Status

- **Phase 1: Core MVP & UI [✅ FINISHED]**
  - Fastify server setup & FIT file parsing.
  - High-density form UI, modern typography (DM Sans), 1-5 RPE scale.
  - Prompt generation logic and 100% test coverage.

- **Phase 2: Self-Hosted Infrastructure & CI/CD [✅ FINISHED]**
  - Dockerfile (node-24-alpine).
  - GitHub Actions Workflow (GHCR publishing).
  - ZimaOS `docker-compose.yml` & Cloudflare Tunnel mapping.

- **Phase 3: Authentication [⏳ ON-HOLD / NEXT]**
  - Implement a secure authentication system to protect the application from unauthorized access.

- **Phase 4: Internationalization (i18n) [🚧 PLANNED]**
  - Deliver a seamless cross-device language experience with a highly polished, minimalist UI.
  - **Languages Supported:** American English (`en-US`) and Brazilian Portuguese (`pt-BR`).
  - **Default Language:** `en-US` is the default fallback everywhere.
  - **Storage & Data Structure:** translations live in dedicated JSON files (e.g., `src/public/locales/en.json`, `src/public/locales/pt.json`). Strictly Vanilla JS — no heavy third-party i18n libraries.
  - **Full Scope Coverage:** both the Frontend UI (`login`, `register`, `training-result`) and the Backend AI Prompt Generator (`src/markdownGenerator.js`) must be translatable.
  - **Mechanics, Database & State Management:**
    - Update the SQLite schema: add a `preferred_lang` column to the `users` table.
    - The Registration UI must include a language selection input to capture this preference upon account creation.
    - The frontend uses `localStorage` for immediate, synchronous client-side rendering.
    - Upon successful login (or via the `GET /api/me` route), the frontend reads `preferred_lang` from the database and updates `localStorage` to ensure cross-device consistency.
    - Toggling the language instantly updates the UI, writes `localStorage`, and fires a background API call syncing the preference back to the user's database record.
  - **UI Placement & UX:**
    - A clean, minimalist language switcher (e.g., a simple "EN | PT" text toggle), located in the top-right corner of the screen across all pages.
    - On public pages (`login.html`, `register.html`) it sits alone in the top-right; on authenticated pages (`training-result.html`) it sits in the topbar directly next to the user badge and Logout button.

- **Phase 5: App Shell & Home UI Layout [🚧 PLANNED]**
  - Elevate the UI to a modern SaaS application standard with a polished master layout.
  - **Goal:** create a master layout file (`src/public/home.html`) that serves as the main entry point for authenticated users, replacing/absorbing `training-result.html`.
  - **Layout Structure (Modern SaaS Design):**
    - **Header/Topbar:** retain the exact header we already built (user badge, i18n language switcher, Logout button).
    - **Sidebar (Left Menu):**
      - Implement a vertical navigation menu on the left side.
      - Menu items must contain both an **Icon** (SVG or minimal icon set) and a **Label** (translatable via our i18n system).
      - Must be **collapsible/expandable**: when expanded, shows icon + label; when collapsed, the sidebar shrinks laterally, hiding the text and smoothly centering only the icons.
      - Must use smooth CSS transitions for the collapse/expand animation.
    - **Main Content Area (Center/Right):** the large remaining portion of the screen where specific feature content (like the FIT file parser today, future calendars, or settings) will be rendered or injected.
  - **Aesthetic:** strictly adhere to the existing minimalist, earthy theme (DM Sans, sage/cream/charcoal colors). It must look highly polished and premium.
  - **Technical Constraints:** strictly Vanilla HTML/CSS/JS. No heavy frameworks. Re-use existing shared CSS tokens.

- **Phase 6: Calendar View [🚧 PLANNED]**
  - **Feature Scope:**
    - **Monthly View Only (Initially):** a classic monthly grid layout (weeks as rows, days as cells). No week/agenda views in this phase.
    - **First Day of the Week Toggle:** users must be able to choose whether the calendar week starts on Monday or Sunday.
    - **Default State:** Monday MUST be the default first day of the week everywhere (DB default, localStorage fallback, and initial render).
  - **Architecture & Technical Constraints:**
    - **Multi-Page Adherence:** built as a standalone feature page following the strict convention: `src/public/calendar.html` / `calendar.css` / `calendar.js`.
    - **App Shell Integration:** `calendar.html` MUST import `shared/shell.js` so the Topbar and Sidebar are automatically injected (the UI layout work is already done; mark Calendar as the active nav item and enable it).
    - **Vanilla JS Only:** use the native JavaScript `Date` object for all calendar math. Do NOT introduce heavy libraries (Moment.js, date-fns, etc.). Use CSS Grid for the monthly layout, re-using existing shared CSS tokens.
  - **Database & State Management:**
    - Add a new column to the `users` table: `first_day_of_week` (e.g., TEXT storing `'Monday' | 'Sunday'`, defaulting to `'Monday'`), via an idempotent migration in `migrateDatabase()` like the i18n rollout.
    - The preference must be returned by login and `GET /api/me`, and synced to `localStorage` upon login/`/api/me` for immediate synchronous client-side rendering (same pattern used for `preferred_lang`).
    - Expose a protected update endpoint (mirroring `PATCH /api/users/me/language`) and place the Mon/Sun toggle in the Topbar or within the Calendar view header.
  - **i18n Coverage:** month names and days of the week must be fully translatable using the existing `src/public/locales/en.json` / `pt.json`; the locale key-parity test must keep both files in sync.

- **Phase 7: AI Coach Prompt Generator [🚧 PLANNED]**
  - **Feature Scope:** a dedicated tool page that builds a highly detailed, pre-formatted prompt for an external AI Coach (ChatGPT/Claude) to plan the next training week. The user copies the generated text and pastes it into their LLM of choice — nothing is ever sent anywhere by this app (local-first rule).
  - **Architecture & Multi-Page Adherence:**
    - Standalone page following the strict convention: `src/public/ai-coach.html` / `ai-coach.css` / `ai-coach.js`.
    - MUST import `shared/shell.js` so the Topbar and Sidebar are automatically injected; mark "AI Coach" as the active nav item.
    - Add a new Sidebar navigation item (e.g., **"AI Coach"**) with a Lucide icon (`bot` or `sparkles`), label translatable via i18n locales.
    - Strictly Vanilla JS — no external libraries. Re-use existing shared CSS tokens and the earthy aesthetic.
  - **Form Variables:**
    - `Target Date`: defaults to the date of the *next* Monday (auto-computed on load, still editable).
    - `Availability`: 7 input fields, Monday through Sunday, each defaulting to a standard routine text.
    - `Optional Context`: a `<textarea>` for free-form notes (e.g., "traveling on Tuesday").
    - A **"Generate Prompt"** button that replaces the placeholders in the template and renders the final text in a copyable block with a **"Copy to Clipboard"** action (with success feedback).
  - **The Prompt Template Requirement (CRITICAL):**
    - The exact Portuguese prompt template provided by the user MUST be strictly used verbatim — no rewriting, translation, or "improvements" to its wording.
    - The template contains specific personal rules: Fânzeres weather context, RPE progression rules, shoe rotation, and a strict Excel-style output format for the weekly plan.
    - Only three placeholders are replaced at generation time: `{{DATA_DA_SEGUNDA}}` (Target Date), `{{DISPONIBILIDADE}}` (the 7-day availability lines), and `{{CONTEXTO_OPCIONAL}}` (optional notes).
  - **i18n Coverage:** all UI chrome (labels, buttons, hints) must be translatable via `src/public/locales/en.json` / `pt.json`. Both prompt templates are embedded verbatim: Portuguese (`pt-BR`, default fallback) and English (`en-US`); the active UI language selects which one is generated. Placeholder names (`{{DATA_DA_SEGUNDA}}`, per-day `{{DISP_…}}`, `{{CONTEXTO_OPCIONAL}}`) stay identical in both templates.

- **Phase 8: Garmin Automation (WebUSB / File System API) [🚧 PLANNED]**
  - Eliminate manual `.FIT` file drag-and-drop.
  - Implement direct read access to connected Garmin watch via browser APIs.

- **Phase 9: Advanced LLM Integration [🚧 PLANNED]**
  - Potential direct API connection to LLMs for automated response rendering within the UI.
