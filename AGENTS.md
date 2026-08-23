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

- **Phase 4: Dashboard & Calendar (Excel Import) [🚧 PLANNED]**
  - Create new UI screens: Dashboard and Training Calendar.
  - Implement bulk training plan import directly via Excel files.

- **Phase 5: Garmin Automation (WebUSB / File System API) [🚧 PLANNED]**
  - Eliminate manual `.FIT` file drag-and-drop.
  - Implement direct read access to connected Garmin watch via browser APIs.

- **Phase 6: Advanced LLM Integration [🚧 PLANNED]**
  - Potential direct API connection to LLMs for automated response rendering within the UI.
