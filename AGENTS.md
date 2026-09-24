# Kinesis — Agent Guidelines

## Project and architecture

Kinesis is a self-hosted, multi-user running application. The server is Node.js
24, Fastify, and SQLite (`better-sqlite3`); the frontend is a multi-page,
vanilla HTML/CSS/JavaScript application using shared ES modules. The visual
system uses DM Sans and the tokens in `src/public/shared/theme.css`. Production
uses Docker Compose on ZimaOS, host port 8081 mapped to container port 3000,
with a Cloudflare Tunnel in front. Application version is maintained in
`package.json` and `package-lock.json` (currently `0.12.0`); follow the SemVer
rule below.

Each major page has its own HTML/CSS/JS under `src/public/`: login, register,
home dashboard, contextual training result, calendar, AI Coach, cycles, and
shoes. Shared frontend responsibilities live under
`src/public/shared/`: `shell.js` injects navigation and account controls;
`onboarding.js` contains onboarding state/presentation helpers;
`i18n.js` and `locales/en.json` / `locales/pt.json` provide English and Brazilian
Portuguese; `api.js` handles API requests; theme, date, units, preferences,
validation, and other reusable utilities remain shared. Keep dynamically
rendered content reactive to `app:languagechange` or use `data-i18n`.

Backend route registration and page gating live in `src/server.js`; auth and
domain modules are under `src/auth/`, `src/db/`, and the domain modules in
`src/`. Database schema, initialization, and idempotent migrations are managed
by `src/db/database.js`. Ownership checks must scope reads and writes to the
authenticated user. New schema changes must follow the existing idempotent
migration patterns.

User account operations live in `src/auth/`; the admin role check lives in
`src/auth/requireAdmin.js`, and privileged account operations are isolated in
`src/admin/operations.js`. Interactive commands live in `scripts/` and use the
same dotenv configuration and `DATABASE_FILE`/`<cwd>/data/database.sqlite`
path as `src/start.js`. The runtime Docker image must include the command
entrypoints and continue to run as its non-root `node` user.

## Account roles and administrative bootstrap

- Each account has a database-constrained `role` with exactly two values:
  `user` (default) and `admin`. Public registration always inserts `user` and
  ignores unrecognized fields such as a submitted role. Account preference and
  password endpoints update explicit fields only.
- The idempotent migration adds `role` to existing users with the `user`
  default. It preserves account IDs, password hashes, sessions, preferences,
  onboarding fields, and related records; it never promotes based on account
  order, email, or startup behavior. Re-running it preserves existing admins.
- Authentication joins each protected request to the current user row, so the
  role used by `createRequireAdmin()` reflects the database's current value.
  The guard returns 401 without an authenticated user and 403 unless the role
  is exactly `admin`; absent, invalid, or unknown roles are denied. Admin status
  never bypasses user-scoped ownership checks.
- `npm run admin:bootstrap` interactively creates the first administrator;
  `npm run admin:promote` explicitly promotes an existing account after the
  operator verifies its identity and confirms. Both require a TTY, reuse the
  application's registration validation, password hashing, and database
  initialization, and accept no password arguments. Bootstrap rechecks for an
  admin and the email inside an atomic write transaction after input and
  hashing; it cannot replace an existing user's password or promote an
  occupied email. Promotion changes only `role`, creates no account, and is
  idempotent.
- Cancellation, EOF, mismatched passwords, and errors do not leave a partial
  account; secret input is not echoed. Neither command runs on server/container
  startup. In Docker/ZimaOS, run `docker exec -it <container-name> npm run
  admin:bootstrap` or `admin:promote` so it uses the mounted `/app/data`
  database. Access to the server/container is privileged.
- This feature adds no admin panel, public bootstrap/promotion endpoint,
  cross-user data access, role editor, demotion, suspension, or configurable
  permission system.

## Current product behavior and invariants

- Sessions are server-side and protected APIs use the shared `requireAuth`
  guard. Anonymous requests to `/` are sent to login; authenticated `/` requests
  redirect to `/home.html`. `/training-result.html` is a protected contextual
  page for a specific training. The Calendar page requires an active cycle and
  redirects to cycle management when there is none.
- The app supports planning and importing workouts, AI Coach prompt generation,
  calendar scheduling, manual and FIT results, single-FIT ZIP upload, shoe
  rotation, and a per-training shoe-mileage ledger. FIT/ZIP parsing and workout
  data processing are local to the application. Optional weather lookup sends
  the planned location/date to Open-Meteo. Optional Unsplash requests use a
  generic running-image query and register the download; the browser may make
  a daily quote request to ZenQuotes. These requests must not include workout
  or FIT data or user-entered training context (network services can still
  receive ordinary connection metadata).
- Result provenance is `none`, `fit_upload`, or `manual` (`garmin_connect` is
  reserved). The backend calculates canonical pace. Manual results do not
  fabricate FIT summaries or laps. Confirmed FIT/manual replacement clears
  incompatible data transactionally. ZIP contents are validated and processed
  in memory and are not persisted.
- FIT pace uses session distance paired with valid `total_timer_time`, then
  session elapsed time, session average speed, complete internally consistent
  laps, and finally paired record distance/active duration. Never mix distance
  and duration from different sources. Store min/km as `m:ss`, rounded to the
  nearest second. Elevation prefers valid session `total_ascent`, then complete
  lap ascent totals, then positive deltas between consecutive valid records of
  one selected altitude field. Never add absolute deltas or combine session,
  lap, and record totals.
- The result page keeps its import guide beside the FIT/ZIP upload controls;
  it is available regardless of whether the session has `none`, `manual`, or
  `fit_upload` provenance. Do not infer result existence from displayed fields.
- The Training Result page also has a separate, informational “How to create a
  workout” guide. Its declarative catalog lives in
  `src/public/shared/workout-creation-guidance.js` and is rendered by
  `training-result.html`/`training-result.js`; it is not the result-import
  guide. It covers Garmin Connect, Apple Watch/iPhone, COROS, Polar Flow,
  Suunto, Samsung Health/Galaxy Watch, Xiaomi/Mi Fitness, and Huawei Health
  using official documentation consulted on 2026-09-22. Support marked as
  conditional or model-dependent must remain qualified by model, firmware, app
  version, operating system, or region. The guide makes no manufacturer
  requests, does not change session data, and must link externally with
  `noopener noreferrer`. All catalog copy is localized in both locales and
  must rerender on `app:languagechange`; its dialog preserves focus, Escape,
  keyboard containment, reduced-motion behavior, and focus restoration.
- Feedback shoe selection offers active shoes. A same-user retired shoe already
  associated with a training remains displayed as disabled historical context;
  unrelated feedback saves preserve it. Replacing it with an active shoe
  starts ledger accounting on the replacement and never subtracts an
  unledgered historical distance from the retired shoe.
- Weather geocoding tries normalized full location, locality before the first
  comma, then diacritic-free variants. Validate context against administrative
  fields and canonicalize country names in English/Portuguese or ISO alpha-2
  codes against the candidate country code. Recognized administrative
  abbreviations are resolved only within that canonical country (the catalog
  covers all Brazilian states and U.S. states plus District of Columbia);
  reject unknown or incompatible abbreviations and ambiguous matches. Preserve
  the exact user-entered location in the training.
- Spreadsheet import deduplicates by exact **Date (`dia`) + Training Name
  (`treino`) + Description (`detalhes`)**. Calendar drag-and-drop rescheduling
  persists through its dedicated endpoint. Keep the shared Snackbar behavior
  for import feedback; do not restore a permanent inline banner.
- Distances and temperatures are stored in canonical metric units and converted
  for display/prompt generation through `src/public/shared/units.js`. Displayed
  dates use the shared locale-aware date formatter. Date inputs use the shared
  DatePicker component, not raw text or uncontrolled native date inputs.

## Onboarding architecture and contract

The frontend onboarding experience is implemented by `src/public/shared/onboarding.js`,
the dashboard markup/styles/scripts (`home.html`, `home.css`, `home.js`), shared
shell menu logic in `shell.js`, locale dictionaries, and the backend routes in
`src/server.js`. The backend owns persistence and calculates progress; the
frontend renders and navigates but must never infer completion from a click,
visited page, or slide.

### API and stored state

- `GET /api/onboarding` is authenticated. It returns HTTP 200 with
  `{ onboarding: { status, guideHidden, steps, completed, total, complete,
  firstTrainingId } }`; anonymous requests return 401.
- `PATCH /api/onboarding/presentation` is authenticated. Its JSON body accepts
  one or both boolean keys `welcome_dismissed` and `guide_hidden`; empty bodies,
  unknown keys, and non-boolean values return 400. A valid patch returns 200
  with the refreshed `{ onboarding: ... }` state. The endpoint updates in one
  transaction and recomputes derived state for its response.
- Registration explicitly creates users with `onboarding_status='new'`.
  New databases default the status to `'active'`; initialization idempotently
  converts historical `'legacy'` rows to `'active'` while preserving user data
  and guide-hidden preferences. Existing accounts do not receive the automatic
  welcome. These are the persisted
  onboarding fields; do not add stored step counters or completion booleans.
- `welcome_dismissed: true` changes `new` to `active`; there is no separate
  persisted welcome-dismissed boolean. Other statuses are not promoted by that
  update. `guide_hidden` stores only the user's checklist presentation
  preference. Both fields are user-scoped.
- `steps.shoes` is true when the user owns at least one shoe; `steps.cycle` is
  true when the user owns an active cycle; `steps.trainings` is true when the
  user owns at least one planned training. `completed`, `total` (3), `complete`,
  and `firstTrainingId` are derived from those owned records. Progress is never
  persisted separately.

### Presentation, navigation, and accessibility

- A genuinely new (`new`) account receives the three-slide PT/EN welcome
  automatically. Existing (`active`) accounts do not. “Agora não” / “Not now” persists
  `welcome_dismissed`; it does not block access to the app. The three primary
  actions link to existing shoes and cycle flows. The workout-plan slide opens
  AI Coach/import when an active cycle exists; otherwise it directs the user to
  create the required cycle first. Explicitly opening the setup guide does not
  open the welcome dialog.
- The checklist is shown normally only while incomplete and not hidden. A
  completed or hidden checklist remains hidden and absent from the dashboard
  layout (`hidden` keeps it out of layout and keyboard navigation); there is no
  permanent completion card or dashboard reopen bar. The user menu's **Guia de
  configuração / Setup guide** opens it on demand, including for completed and
  active accounts. Opening it is transient: it changes no progress, status,
  welcome preference, or guide-hidden preference. Hiding it closes it and may
  persist only `guide_hidden=true`.
- In the dashboard, the shared shell requests opening through the local
  `kinesis:open-setup-guide` event. From another page it navigates to
  `/home.html?openSetupGuide=1`. `onboarding.js` consumes exactly the value `1`
  and removes that parameter with `history.replaceState`, preserving other
  query parameters and the hash. Do not persist this transient signal or cause
  a reload/reopen after it has been consumed.
- The shell exposes the setup-guide action only in the authenticated user menu;
  it closes the menu when activated. It must not know dashboard card internals.
  The dashboard owns rendering, focus, scrolling, and hiding. Focus the guide
  heading only after the guide is visible; respect reduced-motion preferences.
  When hiding from an explicit menu action, return focus to a stable visible
  control. No hidden control may remain in the tab order.
- Keep the welcome dialog's accessible name/description synchronized to the
  active slide. Preserve initial focus, Tab/Shift+Tab containment, Escape,
  focus restoration, and background `inert`. Programmatically focused
  non-interactive headings may suppress their own outline, but never remove
  visible focus styling from interactive controls. CSS must not override the
  browser's `[hidden]` behavior for onboarding elements.
- Resolve translated strings at action time. Dynamically rendered checklist,
  dialog, and menu content must update on language changes without duplicate
  listeners or stale/unused DOM, CSS, or translation keys.

## Testing and verification

Use the existing `node:test` suites. Onboarding behavior is covered primarily
by `test/onboarding.test.js` and `test/onboarding.routes.test.js`, with shared
menu integration in `test/shell.test.js`; run the relevant frontend/browser
tests whenever those behaviors change. Test both PT and EN, ownership, new and
existing accounts, incomplete/hidden/completed states, transient navigation,
focus and keyboard behavior, and ensure `[hidden]` elements are not visible or
focusable when changing onboarding UI.

`npm run test:coverage` enforces exactly 100% Statements, Branches, Functions,
and Lines for c8-instrumented files under `src/**` (excluding
`src/public/**` and `src/start.js`) plus `scripts/admin-prompts.js`,
`scripts/admin-runtime.js`, and `scripts/admin-commands.js`. This percentage is
not instrumentation coverage of the frontend. Frontend behavior tests remain
mandatory when corresponding frontend behavior changes. Run `git diff --check`
before committing.

## Golden rules

1. **Local-first privacy:** never send FIT files or workout data to an external
   cloud API for processing. Preserve only the defined integrations: Open-Meteo
   receives planned location/date, Unsplash receives a generic image request,
   and the browser sends ZenQuotes a daily quote request; none may receive
   workout/FIT data or user-entered training context.
2. **Vanilla frontend:** do not add a framework or dependency for functionality
   the current HTML/CSS/ES-module architecture can provide.
3. **Infrastructure:** do not alter Docker, Compose, or GitHub Actions without
   explicit authorization. The deployment mapping is host `8081` to container
   `3000`.
4. **UI and forms:** use existing theme tokens and shared controls. Inputs,
   textareas, and selects must follow the shared form styling; selects use the
   established custom chevron treatment.
5. **Tooltips:** never use native `title`; use the Kinesis custom tooltip
   component.
6. **Dates and units:** use the shared date formatter/DatePicker and unit
   conversion utilities. Do not locally format dates or hardcode display units
   for stored values.
7. **SemVer:** increment the application version before opening a PR. Use
   MAJOR for incompatible changes, MINOR for backward-compatible features, and
   PATCH for backward-compatible fixes. Keep `package.json`,
   `package-lock.json`, and documented version references consistent.
8. **Git workflow:** develop on a task-appropriate branch, not directly on
   `main`; test, inspect `git diff --check`, and commit descriptively only after
   required verification passes.
