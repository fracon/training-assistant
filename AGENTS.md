# Kinesis — Agent Guidelines

## Project and architecture

Kinesis is a self-hosted, multi-user running application. The server is Node.js
24, Fastify, and SQLite (`better-sqlite3`); the frontend is a multi-page,
vanilla HTML/CSS/JavaScript application using shared ES modules. The visual
system uses DM Sans and the tokens in `src/public/shared/theme.css`. Production
uses Docker Compose on ZimaOS, host port 8081 mapped to container port 3000,
with a Cloudflare Tunnel in front. Application version is maintained in
`package.json` and `package-lock.json` (currently `0.23.0` on the issue #64
follow-up branch); follow the SemVer
rule below.

Each major page has its own HTML/CSS/JS under `src/public/`: login, register,
home dashboard, contextual training result, calendar, Solicitar Treinos
(`ai-coach`), cycles, shoes, training memory,
and the admin-only administration page. Shared frontend responsibilities live under
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
`src/admin/operations.js`. Feedback persistence and validation live in
`src/feedback.js`, with review at `/admin-feedback.html`. Interactive commands live in `scripts/` and use the
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
  occupied email. Promotion changes only `role`, revokes the promoted account's
  existing sessions, creates no account, and is idempotent.
- Cancellation, EOF, mismatched passwords, and errors do not leave a partial
  account; secret input is not echoed. Neither command runs on server/container
  startup. In Docker/ZimaOS, run `docker exec -it <container-name> npm run
  admin:bootstrap` or `admin:promote` so it uses the mounted `/app/data`
  database. Access to the server/container is privileged.
- This feature adds no public bootstrap/promotion endpoint, cross-user data
  access, suspension, or configurable permission system.

## Account administration

`src/admin/users.js` owns the account CRUD used by the admin-only
administration page. `src/server.js` gates `/admin-users.html` and mounts
`/api/admin/users` behind `requireAuth` then `requireAdmin`; the shell renders
the `ADMIN_NAV_GROUP` only for an admin session. The group is a separate sidebar
section, never a loose header entry, and it must be absent from the DOM — not
merely hidden — for every other account.

- The list and read responses return identification, role, and the activity
  state only. They never expose or accept another account's training, cycle,
  shoe, or session data.
- The page's controls are a convenience, not the boundary: self-deletion and
  removing the last administrator are refused by the domain layer inside the
  write transaction that would otherwise persist the change. The web CRUD
  creates regular users and edits identity fields only; it cannot grant or
  alter roles. The role is re-read from the database on every request.
- Administrator grants are available only through the privileged local
  `admin:bootstrap` and `admin:promote` commands. A promotion revokes the
  promoted account's existing sessions.
- Creation and email changes reuse `src/auth/registration.js` normalization,
  validation, and password hashing. Web creation assigns `role = user` in the
  backend; `role`, `expected_role`, `is_active`, `active`, and unknown request
  fields are explicitly refused so no privilege, access, or column can be
  written indirectly.
- Deleting an account relies on the existing foreign-key cascades for its
  sessions, trainings, cycles, shoes, mileage ledger, and AI Planning
  availability.
- Every web create, identity update, delete, and activity transition writes one
  `admin_audit_log` row (idempotent migration
  `2026-09-admin-account-audit-v1`, extended with the
  `account_activity_changed` action by `2026-09-account-activity-v1`) with
  copied actor/target identities, the action, and a timestamp. A transition
  records only `{"from":…,"to":…}` account states. The table holds no password, hash, token, or
  training value, and identities are copied rather than joined so a deletion
  record outlives the deleted account.
- The audit table intentionally uses `id INTEGER PRIMARY KEY`, which lets
  SQLite assign IDs without `AUTOINCREMENT`; no requirement exists to prevent
  ID reuse after deletion. The `users.id` definition is not changed.
- The page reuses the shared shell, theme, modal, confirm dialog, form controls,
  custom tooltips, shared date formatter, and PT/EN dictionaries. The account
  dialog uses `createDialogFocusTrap` from `src/public/shared/dialog-focus.js`
  and restores focus to its trigger on close. It must keep localized errors,
  focus containment, Escape, and reduced-motion behavior intact.
- Creating an account confirms the initial password in the dialog, like public
  registration: a required, matching confirmation is validated in the shared
  grouped error box, keeps every value already typed, focuses the confirmation
  field, and links it with `aria-invalid` and `aria-describedby`. The
  confirmation is a frontend concern only — the request body carries `password`,
  and `password_confirmation` remains an unknown field that the API refuses, so
  it is never transmitted, stored, or audited.

## Account activity management

`users.is_active` is a database-constrained integer (`DEFAULT 1`,
`CHECK (is_active IN (0, 1))`) added by the idempotent
`2026-09-account-activity-v1` migration, which rebuilds `admin_audit_log` to
extend its `CHECK` and copies existing rows. Deactivation is reversible
suspension of access only: every training, cycle, shoe, mileage, preference, and
onboarding record of the account is preserved.

- `POST /api/admin/users/:id/activity` is mounted in `src/server.js` behind the
  same `requireAuth` then `requireAdmin` chain as the other admin routes. The
  body accepts exactly the two booleans `active` and `expected_active`;
  `invalidActivity`, `privilegedField`, and unknown fields are refused, as is
  any attempt to set the state through create or update.
- `expected_active` is the state the interface acted on, and the domain layer
  re-reads the target inside the same immediate transaction that writes the
  state, revokes sessions, and audits. A stale action is refused with `409
  activityConflict`; a request that already matches the current state is a
  no-op that touches no session and writes no transition.
- Only regular accounts change state, and never the signed-in one:
  `privilegedTarget` (`403`) and `selfActivityForbidden` (`400`) are refused.
  Activating an account must never be a way to obtain administrator access.
- Both directions delete every session of the target in the same transaction, so
  a suspended account never keeps a token that reactivation would silently
  honour, and `src/auth/sessions.js` independently refuses inactive accounts
  on every authenticated request.
- Sign-in refuses a suspended account only after the password verifies: `403`
  with the stable code `accountInactive`, no session, and no cookie. Wrong
  credentials keep the generic `401` answer, so the state is not discoverable
  without the real password. `src/public/login.js` hands the request error to
  `translateApiError`, which prefers `codes` over prose so one localized
  sentence serves both languages.
- That state check is **not** the one read before the verification.
  `verifyPassword` awaits scrypt, so anything can be committed in that window,
  and a suspension also revokes the account's sessions. `loginUser` therefore
  re-reads the account and inserts the session inside one
  `db.transaction(...).immediate()`; the state and the session are a single
  atomic step, the returned profile is the re-read row, and an account removed
  during the wait answers exactly like an unknown address. Never reintroduce a
  check against the pre-verification row, and never move the insert outside that
  transaction.
- The page follows the same contract: a transition in flight tracks the control
  it belongs to, and a successful rerender only **retargets** that control
  (`retargetRefreshFocus`). It must not re-track from scratch, because that would
  discard a focus change the person made while the refresh was pending and pull
  focus back to the list.
- The privileged local `admin:promote` command refuses an inactive account
  before the confirmation step; `admin:bootstrap` is unaffected.
- The page shows the state as a badge beside the role, offers the transition
  only for a regular non-self account through a localized confirmation dialog,
  and refreshes the list on a conflict instead of assuming the applied state.
  Status styling must stay visually distinct from the role badge and reuse the
  existing tokens and custom tooltips.

## Feedback

- Every authenticated shell mounts one localized topbar feedback control; login
  and registration do not. The dialog records only the selected type,
  description, allowlisted pathname, authenticated user ID, and an email
  snapshot. It does not collect screenshots, FIT files, form contents, device
  identifiers, or external telemetry.
- Feedback rows use the idempotent `2026-09-feedback-v1` migration. The author
  foreign key is nullable with `ON DELETE SET NULL`, so account deletion clears
  the relationship while retaining the email snapshot and original submission.
  Only admins can list, inspect, triage, or delete feedback.
- The admin page reuses the Administration sidebar group, shared modal/focus
  and confirmation patterns, escaped DOM text, and the PT/EN locale contract.

## Current product behavior and invariants

- Sessions are server-side and protected APIs use the shared `requireAuth`
  guard. Anonymous requests to `/` are sent to login; authenticated `/` requests
  redirect to `/home.html`. `/training-result.html` is a protected contextual
  page for a specific training. The Calendar page requires an active cycle and
  redirects to cycle management when there is none.
- The app supports planning and importing workouts, Solicitar Treinos prompt generation,
  calendar scheduling, manual and FIT results, single-FIT ZIP upload, shoe
  rotation, and a per-training shoe-mileage ledger. FIT/ZIP parsing and workout
  data processing are local to the application. Optional weather lookup sends
  the planned location/date to Open-Meteo; weekly proposal generation also
  requests hourly forecast data for saved available-day locations/dates and
  preferred periods. Optional Unsplash requests use a
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
- FIT running lap cadence is presented as `ppm` in PT and `spm` in EN, both
  meaning steps per minute considering the two feet. FIT field 17 uses
  alternative subfields: running cadence is `strides/min`, while generic
  cadence is `rpm`. The installed `fit-file-parser` 1.21.0 does not resolve
  those subfields and exposes field 17 as `avg_cadence` plus its fractional
  companion, so that fallback is treated as running cadence only when the
  decoded lap/session sport is `running`; Kinesis adds the fraction and
  converts once to two-foot steps/minute at the FIT boundary. Generic cadence
  without that context remains absent. New FIT summaries carry the
  `two-foot-spm-v1` marker and persisted values are displayed as stored without
  another conversion. The original `2026-10-fit-cadence-two-foot-v1` migration
  handles identifiable old running summaries without source metadata. The
  corrective `2026-10-fit-cadence-source-v2` migration also converts historical
  raw fields whose previous parser provenance is
  `avg_cadence_running`/`max_cadence_running` or
  `avg_running_cadence`/`max_running_cadence`. Average and maximum are checked
  independently and converted values carry `avgCadenceUnit` or
  `maxCadenceUnit`; set the summary-wide marker only when all numeric cadence
  fields are normalized. Preserve unknown origins and already normalized
  values. Old summaries did not persist fractional cadence, so migrations
  cannot reconstruct it; new FIT imports include available fractions before
  conversion.
- The result page keeps its import guide beside the FIT/ZIP upload controls;
  it is available regardless of whether the session has `none`, `manual`, or
  `fit_upload` provenance. Do not infer result existence from displayed fields.
- Realized effort (`feedback_rpe`, 1–5) is the only mandatory result
  feedback, and it is a backend invariant as well as a page rule: a concluded
  training and its realized effort are a pair that never comes apart. Every
  write that can change that pair — `PATCH /api/trainings/:id`,
  `PUT /api/trainings/:id/manual-results`, and `POST /api/trainings/:id/fit` —
  resolves the **effective state the request would leave behind** inside its own
  transaction and returns `400` with
  `A realized RPE between 1 and 5 is required to complete this training.`
  when that state is `completed = 1` without an effort of 1–5, writing nothing
  and touching no column. Judge the result, never the intent: a PATCH naming
  only `feedback_rpe` cannot clear the effort of a training that stays
  concluded, whether or not it also carries `completed: true`, and a refusal
  must leave notes, `completed`, and the RPE exactly as they were.
- The effective pair is read from the row inside the transaction that would
  write it, and each half comes from the request when the request names that
  column, so nothing stale or partial can conclude or strand a workout. Omission
  is the only case that reuses the stored effort: a manual or FIT result whose
  `feedback_rpe` is absent reuses the row's current value, so recording a result
  never discards a reported effort. Naming the field is authoritative, so `null`,
  `""`, a blank multipart part, or a value outside 1–5 concludes without an
  effort and is refused with the same stable message, writing nothing and keeping
  the stored value. Manual and FIT reuse that one conclusion error instead of the
  normalizer's field-format errors, so the contract is uniform across all three
  completion writes; validation of other fields still runs first and keeps its own
  errors. `PATCH` is not a completion write and keeps its strict integer
  validation, which rejects a non-integer before this rule.
  `{"completed": false, "feedback_rpe": ""}` is the deliberate way out: the
  session is open when the effort goes, and the same request is allowed.
- Only a request that names `feedback_rpe` or `completed` reaches this rule, so
  partial feedback edits — notes, weather, terrain, shoes, breathing — stay
  unrestricted on any training, concluded or not, including results completed
  before the rule, which stay readable and editable without an invented effort.
  No schema migration or backfill is involved.
- The result page blocks **Save and back to calendar**, **Save and Generate
  Analysis Prompt**, and the FIT/ZIP upload before any request, confirmation
  dialog, disabled-state change, or navigation: it marks the 1–5 radio group
  invalid, announces a localized error, focuses the first option, and preserves
  every other entered value. Arrow keys and Space must operate the group, the
  focus ring is drawn on the emoji label, and the RPE transitions respect
  `prefers-reduced-motion`.
- The public page/menu label is “Solicitar Treinos” (PT) / “Request Workouts” (EN); onboarding access actions remain “Planejar com IA” / “Plan with AI”. The page retains its free external prompt for explicit administrator use and adds an explicit weekly AI proposal for all users through the shared persisted execution pipeline. Keep the `ai-coach` route, module, API/database names, and `aiCoach` locale namespace as stable technical identifiers. The presentation rename must not rewrite any weekly, macrocycle, or workout-feedback prompt templates, including their titles, examples, instructions, or “coach” wording; keep prompt copy separate from presentation strings if a translation key is shared.
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
  Planejar com IA/import when an active cycle exists; otherwise it directs the user to
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

Account administration and activity behavior is covered by
`test/adminUsers.test.js` (domain), `test/adminUsers.routes.test.js` (HTTP),
`test/admin.test.js` (privileged commands), `test/adminUsers.browser.test.js`
(dialog markup, PT/EN rendering, confirmation and activity dialogs, focus
restoration, focus parked and deliberately moved during a held refresh),
`test/auth.routes.test.js` and `test/login.test.js` (suspended sign-in and
session refusal), `test/login.activity-race.test.js` (a suspension committed
while the password is verified, through a held verification),
`test/language.test.js` (`translateApiError` prefers a stable code), and
`test/database.test.js` (the activity migration).

The realized-RPE conclusion contract is covered by
`test/trainingSession.routes.test.js` (the three completion writes, the exact
refusal message, the stored-value fallback for an omitted RPE, explicit
`null`/empty/out-of-range values, direct FIT and ZIP uploads, and unchanged rows
after a refusal), `test/manualResults.test.js` (manual `feedback_rpe`
normalization and reported-versus-omitted presence),
`test/trainingResult.test.js` (guard placement, error lifecycle, markup, styles
including the reduced-motion transition reset, and both locale keys), and
`test/trainingResult.browser.test.js` (a real Chrome run blocking the manual
save, the prompt generation, and the FIT upload before any request, in PT and
EN, with keyboard selection, focus placement, preserved input, and a legacy
completed result that stays editable).

`npm run test:coverage` runs Node's test runner with concurrency set to one and
enforces exactly 100% Statements, Branches, Functions, and Lines for
c8-instrumented files under `src/**` (excluding
`src/public/**` and `src/start.js`) plus `scripts/admin-prompts.js`,
`scripts/admin-runtime.js`, and `scripts/admin-commands.js`. This percentage is
not instrumentation coverage of the frontend. Frontend behavior tests remain
mandatory when corresponding frontend behavior changes. Run `git diff --check`
before committing.

## Code Review Rules

Use these rules when reviewing behavior changes; keep the detailed product
contracts and the GOLDEN RULES in this document as the source of truth.

- **Authorization and ownership:** A privilege or cross-account data leak can
  occur when the UI is trusted, a stale role is used, or an object is fetched
  without the authenticated user's scope. Apply to every protected route and
  account operation. Verify authorization in the backend against the current
  database user row, require exactly `admin` for admin-only actions, scope every
  read/write to its owner, and keep web CRUD unable to promote or edit roles;
  use the privileged bootstrap/promotion commands described in *Account roles
  and administrative bootstrap*.
- **Persistence and concurrency:** Partial writes, stale actors, unrevoked
  sessions, or an older asynchronous response can leave security or user data
  inconsistent, or update the wrong dialog/list. Apply when a change persists
  data, revokes access, replaces state, or has overlapping requests. Trace all
  durable effects and failure paths, revalidate security-sensitive state inside
  the transaction that commits it, make related changes atomic, revoke sessions
  when the contract requires it, and ignore stale responses or block actions
  until required state has loaded, as specified by the relevant API contract.
- **Accessible, consistent interface:** A visually or technically working flow
  can still strand keyboard users, expose hidden controls, lose context, or
  diverge from Kinesis's interaction language. Apply when a change affects
  screens, forms, menus, modals, dialogs, or async rerendering. Check observable
  focus restoration, keyboard containment, accessible names/states, reduced
  motion, responsive behavior, and hidden/inert content; reuse the established
  components and tokens and inspect the result against the GOLDEN RULE —
  DESIGN SYSTEM FIRST / VISUAL CONSISTENCY.

### Review flow

Before requesting review on GitHub, the implementing agent should critique the
complete diff against `main` in one pass: contracts, authorization, error paths,
concurrency, accessibility, compatibility, documentation, and pertinent tests.
Correct the findings together. Once implementation is ready, request a Codex
review on GitHub and consolidate its findings into a coordinated correction;
do not automatically request another review after every corrective commit.
Request an additional review consciously when a correction substantially
changes authorization, persistence, architecture, or the security surface.

Classify each review comment by evidence and impact. Fix real problems; when a
finding does not apply, answer with the concrete justification and evidence.
Resolved threads are not a substitute for validation. Distinguish local test
results from checks published on GitHub, and do not promise that one Codex pass
will find every issue.

## Solicitar Treinos weekly availability

Weekly proposal generation and application reuse the existing AI execution,
quota, reservation, Responses client, context, diagnostics and recovery system;
do not add another job pipeline. The weekly-workouts-v3 delivery adapter is
versioned independently from byte-preserved PT/EN external prompts. It retains
training guidance while sending shared athlete context only once. Structured
warmup/main/cooldown components derive duration and persisted details; each
component carries execution and effort guidance, optional evidence-backed
targets, and explicit guidance for repeated recoveries. Adapter instructions
request Kinesis RPE 1–5 for each running stage and recovery, and forbid turning
observed average/maximum heart rate into a target or zone. Distance pace used for
duration estimation is separate from optional prescribed pace and is rounded
up. Global FC/RPE fields are derived only when component targets agree; the
proposal and training-result views derive labeled, stage-specific display
summaries from persisted details without averaging or changing numeric column
types. When no prescribed HR target exists, show the localized effort/breathing
fallback and never infer a target from observed average/maximum HR. Free text
is not parsed as another duration source. Notes persisted to `observacoes`
and proposal-only natural-language justifications appear in the complete
review; technical evidence IDs stay in protected diagnostics and are omitted
from common cards. Verified weather displays only the compact temperature
range, period maximum and available verified conditions; partial/unavailable
coverage remains explicit. Full source/query evidence remains protected with
the execution. After successful application, remove proposal cards and expose
the saved added/ignored counts plus a link to the applied calendar week;
reload must preserve this terminal state, and a lost apply response is resolved
by a free read of the same proposal. Open-Meteo hourly evidence is bound to an exact revisioned availability
snapshot before reservation/dispatch and application. Forecast IANA timezone
identity and distinct UTC hourly instants are checked through DST; the
16-date horizon is enforced locally, while Open-Meteo requests use
`start_date`/`end_date` without mutually exclusive `forecast_days`. Compact
hourly tuples retain instant, local time/offset, temperature and WMO code
inside the existing context budget. The execution snapshot retains the full
forecast query and availability binding, while the provider receives a
freshness-safe projection containing the source, coverage and verified hourly
evidence; use the same projection for payload budgeting. Record and display
that no authorized independent hourly source is configured; no daily maximum
is substituted. Ambiguous, partial,
incompatible-timezone, out-of-horizon and unavailable forecasts are explicit,
with planning continuing without invented weather. v1/v2 proposals cannot be
reviewed/applied under v3; their snapshots and historical calendar rows remain
untouched. Application is an explicit owner-scoped transaction, rechecks
freshness and ownership, preserves results and uses the calendar's existing
deduplication.
See [`docs/ai-weekly-workouts.md`](docs/ai-weekly-workouts.md).

- `/api/ai-coach/availability` is authenticated and user-scoped. Store one record per weekday with `can_train`, canonical period IDs (`before_08`, `08_12`, `12_14`, `14_18`, `after_18`), `available_minutes` as whole minutes, the exact `location` string, and an internal monotonic `revision` used to bind weather lookups to source versions.
- Each available day stores one preferred period. Legacy rows with multiple periods remain readable, are flagged for explicit review, and cannot be saved or used for prompt generation until one is selected. Clients of `PUT /api/ai-coach/availability` must send exactly one period for each available day; multiple periods are rejected as an incompatible contract change released in version `0.19.0`, with migration required for clients using the previous request shape. `available_minutes` is the maximum full session duration, including warm-up and cool-down, not a target and not the length of the period window. The maximum is 720 minutes per day.
- Unavailable days canonicalize to no periods, null duration, and empty location. Available days require at least one known period, positive duration, and a location; validate in the backend as well as the UI.
- The idempotent `2026-09-structured-ai-coach-availability-v1` migration does not derive periods or duration from old free text. The earlier AI Coach availability form was transient and did not persist these values; missing structured records must remain unconfigured and be reviewed. On first use the frontend presents missing rows as unchecked/unavailable defaults, without clearing `needsReview`; explicit unavailable rows remain unavailable after persistence.
- Initial availability defaults are presentation-only: they are never eligible for persistence or prompt generation until the authenticated GET has completed successfully. A failed load keeps save/generate blocked, preserves local edits, and may be retried; late responses from older load attempts must not replace a newer result.
- Applying a weekday setup is an explicit one-time copy from Monday to Tuesday–Friday. It never changes weekends or links records.
- The administrator-only external prompt continues to preserve its existing PT/EN wording and 12-column XLSX/XLS import contract. Its browser/research instructions apply only to that free prompt; the weekly paid adapter replaces conflicting Excel/research delivery instructions with backend-supplied hourly evidence and structured `weekly-workouts-v3` output. It derives duration/details from ordered timed/distance prescription components with per-stage execution/effort, optional targets and explicit repeated recovery guidance; pace estimates are distinct from targets, global FC/RPE are derived only when uniform, and free-text guidance is not parsed as a duration source. It previews persisted notes, binds forecasts to an exact revisioned availability snapshot, validates timezone identity and epoch-hour coverage through DST, and never substitutes a daily maximum. Unreliable weather remains explicitly unavailable and never blocks planning. No second provider or paid search is configured. RPE is explicitly the Kinesis 1–5 scale in both adapter and backend validation. Existing v1/v2 proposals are incompatible with v3 and cannot be applied under the changed schema; old snapshots/calendar data remain untouched.

## OpenAI foundation and future phases

The approved [plan](docs/ai-integration-plan.md) is integrated in main through
PRs #66/#68. Phase 0 (#62) is integrated through merged PR #67 (`648d6a0`).
Phase 1 (#63) is integrated through merged PR #69. Phase 2 (#64) is implemented
on its dedicated branch and awaits its PR; #65 remains future scope.
Read the plan and [foundation contract](docs/ai-foundation.md) in full before
changing this service. Update README, AGENTS, the plan and affected configuration,
API/privacy documentation with delivered behavior and honest branch status.

Context selection priorities and explicit module boundaries are defined in the
[foundation contract](docs/ai-foundation.md#context-extension-training-context-v5).
Keep complete recent discomfort/RPE 4–5 reports ahead of optional planning;
refuse insufficient mandatory budgets rather than silently dropping reports.
Applied plan identity/provenance stays mandatory; select its architecture and
prose through the shared budget path after recent reports and availability,
recording omissions. Do not let optional planning cause mandatory-context refusal.
Do not duplicate requested sessions in recent/upcoming/comparables or count
references as extra totals. Include final metadata in the byte bound.
`src/public/shared/package.json` scopes shared JS as ES modules; the root,
backend and legacy `public/form-state.js` remain CommonJS-compatible. Do not
remove that scope, introduce top-level await into synchronous shared imports,
or suppress Node module warnings.

Owner correction (2026-10-15): training memory is an evolving, source-backed
athlete-context view, not a parallel profile/observation form. Goals come from
cycles; availability/preferences from Request Workouts; metrics and discomfort
from dated sessions/feedback. Corrections navigate to those sources. Only prior
running experience is optional supplemental input in phase 0. Do not add
duplicate goals/preferences/limitations or generic manual observations CRUD.
Inventory existing sources before proposing new fields. The view must show
origin/date and uncertainty, without turning discomfort into a permanent
restriction. Later AI interpretations need evidence and owner-controlled
confirm/correct/dismiss state; old analyses must not resurrect discarded
interpretations. The exact execution payload remains separate admin-only,
owner-scoped debug. See the plan for phase boundaries and PR #67 correction.

The revised documentation and runtime correction are integrated via #68/#67. The view and paid-context
selection share `src/ai/context.js`; `overview.js` projects readable owner data
without payload/hash/configuration. `memory.js` accepts only optional experience
with optimistic versions. Do not restore generic manual memory CRUD.

- `src/ai/` owns the idempotent schema migration, optional experience,
  deterministic context policy, reusable prompts, runtime configuration,
  Responses client, durable execution/usage ledger and routes. The UI reuses
  shell, dashboard width/card rhythm, shared forms/buttons, DatePicker (admin
  preview) and PT/EN. The presentation contract is in
  `docs/ai-foundation.md#memory-presentation-on-the-pr-67-branch`: keep dated
  discomfort/RPE visible, preserve expanded planning and source-link focus on
  rerenders, respect the preferred week start, and keep technical debug separate
  and collapsed. Do not restore a persistent context-refresh control: load on
  opening, offer retry only on load failure, and offer saved-version recovery
  only on experience conflicts, preserving unsaved input and focus. UI projections may expose canonical status/aggregate overlap;
  they must not create another selection policy or change stored snapshots.
- Schema is retained for compatibility: old profile keys and `ai_memory` rows
  are an inactive read-only archive, exposed only to their owner through
  `/api/ai/memory/legacy`. Experience saves preserve those keys. New contexts
  never select that archive, including old interpretations/recommendations.
  Snapshots are immutable; context policy v4 makes v1/v2/v3 execution results stale
  without rewriting them. No semantic migration or silent deletion is allowed.
- Facts, dated reports, calculations, future interpretations/recommendations
  and performed actions remain distinct. Interpretation confirmation/correction/
  dismissal belongs to later producers, not phase 0. Corrected/discarded content
  must not reenter active context through old responses.
- Preserve byte-identical external PT/EN prompts. Pure browser/backend generators
  live in `shared/workout-prompts.js`, `shared/analysis-prompts.js` and
  `src/ai/{prompts,markdownGenerator}.js`; legacy imports remain compatible.
  The synthetic baseline captured from main addd967 is tested byte for byte.
  Weekly comparable selection checks long-run labels in both `tipo` and `treino`,
  since spreadsheet imports commonly store `tipo=Corrida`, `treino=Longão`.
- Phase 0 provided the infrastructure. This branch registers only the cycle
  product adapter, documented in `docs/ai-cycle-planning.md`;
  HTTP must never accept an arbitrary prompt/model/tool. Do not introduce
  functional generation early or hide conflicting delivery instructions.
- The configured backend is authorized to send minimum selected structured
  context for explicit later cycle/workout/analysis operations using `store:false`.
  Keep FIT/ZIP binaries, raw GPS, credentials and unnecessary identifiers local.
  No generic logs contain prompts, context, responses, keys or provider errors.
- Persist source versions, exact protected debug payloads, configuration, state,
  usage/cost ceilings and sanitized errors. Admin debug is current-role checked
  and restricted to its own data. Keep ordinary users' existing prompt flows.
- Reserve user/global cost/tokens/calls transactionally before network dispatch;
  never keep a transaction open during network calls. Recheck account activity,
  ownership and source versions before dispatch/access/application. Deletion or
  cancellation must never recreate data or silently refund uncertain usage.
- Explicit 429 alone may retry, within `AI_RETRIES`. Honor a valid
  `Retry-After` up to 60 seconds (minimum one second); otherwise use bounded
  exponential backoff with jitter. A requested wait beyond 60 seconds is
  terminal and must not be shortened into an early call. Persist the due time
  on the queued execution so restart resumes the same wait. Read execution
  state and decide retry versus cancellation settlement in one immediate
  transaction; a losing retry must never strand an unsettled cancelled
  reservation. Before dispatch, recheck current account, ownership, sources,
  adapter and the reserved quota. Never hold SQLite transactions during wait.
  Network/timeouts/5xx/transport
  uncertainty and restart-interrupted calls never replay automatically. Restart
  can dispatch untouched queued work after revalidation. Local cancellation
  makes no claim about provider billing. Global anonymous consumption survives
  account deletion; owned AI data cascades. Cleanup defaults to 90 days and runs
  at startup/authenticated AI access. Experience is editable; inactive archived
  records remain until account deletion. Owned records cascade on deletion.
- Runtime-only Compose environment wiring is authorized under golden rule 3;
  never bake the key into Dockerfile/image or change ports/privileges/CI.
- Tests: `aiFoundation.test.js`, `aiFoundation.routes.test.js`,
  `aiFoundation.browser.test.js`, `aiMemoryOverview.test.js`, existing prompt/result/coach/shell/onboarding
  suites, then npm test and 100% c8 in all four metrics. Use synthetic fixtures
  and mocked providers. Model-quality evaluation is separate, controlled and
  cost-recorded; a mock is never evidence of real model quality or access.

## Cycle planning (issue #63, branch implementation)

The free macrocycle prompt (`GET /api/cycles/:id/prompt`) requires the existing
`requireAuth` + `requireAdmin` chain and owner-scoped cycle lookup. Authentication
loads the current database role; administrator status cannot cross ownership.
Pass the account role through every cycle render/save/action/language path:
regular users have no prompt button or prompt modal and never fetch/open one on
save. Admins retain free prompt generation/copy only as an explicit card debug
action; neither role gets an automatic technical prompt after saving.
Product AI generation is owner-authorized for both roles, never admin-only.

“Planejamento do ciclo” / “Cycle planning” is a `.btn-icon` card action with decorative
Lucide `calendar-range`, translated accessible name and existing hover/focus
custom tooltip above and centered on its own button, using the same positioning
and animation as the other card actions, including on inactive cycles. The button
remains its positioning reference. On narrow screens, when planning is the only
card action, its tooltip aligns to the button's left edge to remain inside the
viewport while keeping the shared above-button spacing and animation. Opening
reads planning only.
The cycle state badge remains independent from a planning row: the card metadata
label (`Planning:` / `Planejamento:`) uses the existing strong-label style and
the short state value uses the existing neutral `.cycle-status` badge. Secondary
update/proposal information stays on a separate muted helper-text line.
`GET /api/cycles` attaches only a compact owner-scoped `planningSummary` (status,
short secondary state, availability and generation eligibility); it never sends
plan text, prompts, context or diagnostics for card rendering. Proposal selection
is deterministic: scan the newest 20 owned proposals in descending sequence and
select the first current, RPE-compatible, domain-valid, unapplied proposal whose
base version matches the applied version. A later failed attempt does not hide
an earlier usable proposal. Applied planning remains primary; a pending update,
ready proposal, failed update or unavailable AI appears separately. Incompatible
RPE and source freshness have distinct statuses. Summary read failures do not
become “no plan” or generation failures, and a polling read error cannot replace
a previously confirmed card state. The list is polled in one request only while
a visible page has pending cycle work; the open modal uses its existing poll.
The one card icon always opens the modal; only its explicit Generate action can
enqueue work. Opening, listing, refreshing and language changes are free reads.
The product modal uses CRUD `.modal-card`/`.modal-header`/Lucide x and
`.form-actions`, with one scrollable body and aligned wrapping footer; do not
reuse `.prompt-modal-card` or `.prompt-modal-actions` padding. Proposal and
applied-version headings/badge distinguish artifacts. Admin inspection stays in
a separate secondary body section. Preserve trap/inert, keyboard/Escape/backdrop,
focus restoration, language, reduced motion and stale-response protections.


Approved guided flow: canonical POST/PUT `{cycle}` response updates/upserts the
card before the form closes and active-cycle planning opens. No model call on
save/open/defer. Use returned IDs, current i18n at asynchronous completion, form
revision tokens, shared focus trap/inert and a save lock. Late/failed initial-list
or active-state reads cannot overwrite an acknowledged local record. A later
planning-read failure has its own saved-cycle message and free retry, never a
registration failure or a second create. Closing a pending form prevents its
late response from opening another modal; it does not undo a submitted write.

Read planning state before offering actions. Recover running/ready proposals;
use backend outdated flags and optimistic versions, not frontend freshness math.
After an edit, offer new planning/Keep for now for an outdated plan, generation
for an unplanned active cycle, or consultation for a current applied plan.
Unavailable/inactive states hide generation; Done/defer only closes. New proposals
never replace applied plans automatically. Keep unknown-acknowledgement generation
keys per cycle across modal transitions; clear obsolete polling before switching
cycles. Weekly generation stays in #64. Browser regressions also live in
`cyclePlanningFlow.browser.test.js` (synthetic provider only).

`cycle-plan-adapter.js` v3 retains v2 adaptations of the three allowlisted delivery spans plus three
explicit, owner-approved competition-conditional spans (equipment, nutrition,
taper), preserving external prompt bytes. A race is optional; target_date is the
goal deadline. Validate calendar dates and inclusive end >= max(asOf, saved start)
before reservations. Past start/absent start and target equal to asOf remain
supported. Distinguish missing/invalid target, invalid start, end before saved
start, end before reference and inactive cycle with stable localized codes. It
validates `cycle-plan-v1`. Execution lifecycle callbacks write pending/validated
proposals inside existing enqueue/settlement transactions. `cycle-plans.js`
owns read/apply; account/cycle/proposal/execution ownership and freshness are
revalidated inside immediate application, with optimistic base version and an
idempotent applied proposal ID. Never hold SQLite transactions over network.
`planning_revision` increments only for actual stored-value changes, compared
atomically with SQLite column affinities. No-op saves preserve timestamps and
freshness; edit followed by reversal still increments twice. Never reset historical
revisions or mark an outdated plan current just because it is kept.
The idempotent `2026-10-cycle-plan-fingerprint-v1` repair adds a missing
`cycle_plan_versions.fingerprint_json` to databases that already recorded the
older planning migration. Preserve existing versions; a missing historical
fingerprint means outdated, never infer freshness. AI route unexpected-error logs
must omit messages, SQL, request values, prompts, provider bodies, account IDs and
credentials while retaining a bounded stack location for diagnosis.
Regeneration is a separate proposal, never an implicit write to applied versions.
Applied architecture is `applied_planning`, not performed training. Plan-local
A–C assessments never become reusable athlete traits. Do not add speculative
interpretation CRUD. See `docs/ai-cycle-planning.md` for schema, retention,
context v5, configuration and real evaluation. Tests live in
`cyclePlanning{,.routes,.browser}.test.js` and `cyclePlanningDates.test.js`; keep provider calls mocked in CI.

Execution diagnostics are stored in `ai_executions.diagnostics_json` through the
idempotent `2026-10-ai-execution-diagnostics-v1` migration. Keep at most three
allowlisted per-attempt records, with no provider message/body, athlete values or
secrets. Correlate `X-Client-Request-Id` with the execution and attempt; retain
provider request/response IDs only in owner-scoped current-admin debug, alongside
HTTP/status/incomplete reason, reasoning count, duration and safe validation paths.
Never expose this metadata through ordinary execution/polling APIs. Keep known
usage if proposal persistence rolls back; uncertain usage retains its reservation.
Only an explicit 429 may retry under the existing limits/cancellation transaction
and bounded wait; opening, polling, parsing errors, incomplete/invalid output and
uncertainty never start another paid operation. A failed subsequent read remains
a separate error with a free retry. Keep the 429 wait, ordinary queued/running
copy, temporary-unavailability and uncertain-result copy localized in PT/EN.
Do not rewrite the polite live region on each identical polling response.
The product modal uses the existing alert for terminal execution reasons without
stealing focus on polling. Test `aiDiagnostics{,.browser}.test.js` with simulated
HTTP responses; real generation requires explicit authorization and a synthetic
cycle, and never applies a proposal automatically.

Operational setup for cycle planning uses the defaults
`AI_MAX_OUTPUT_TOKENS=8192` / `AI_TIMEOUT_MS=120000` in backend, `.env.example`
and Compose. Existing explicit environment values still override defaults and
must be updated by the operator. The 2026-10-18 real
isolated Chrome evaluation completed with one attempt (`AI_RETRIES=0`), reviewed,
applied version 1 and recovered after reload, without creating training records.
See `docs/ai-cycle-planning.md#end-to-end-real-evaluation-2026-10-18` for accounting
and the historical RPE /10 divergence, now guarded by the compatibility contract below. A successful
schema/domain gate does not certify free-text coaching quality. Never silently
convert a generated scale, rewrite the saved response or describe one synthetic
sample as a broad athlete-quality evaluation. Automated tests stay mocked; paid
calls require explicit budgets/authorization and uncertain calls count
conservatively. This correction does not change provider/schema/adapter behavior.

Cycle planning uses Kinesis RPE 1–5. Adapter `cycle-delivery-v3` explicitly binds
all numeric effort references to that scale, leaving HR/pace/other units and all
external PT/EN prompt bytes unchanged. `cycle-plan-rpe.js` is a bounded textual
guard, reused through schema `rpeIssue` for response validation, application,
compatibility reads and future context. Inspect every generated narrative field;
never alter/convert/clip the response to pass. Reject incompatible references as
`planningRpeIncompatible`, diagnostic `rpe_scale` plus allowlisted field path only.
Preserve known usage and terminal failure; never retry invalid output automatically.
Historical affected proposals are revalidated before new application. Applied
originals stay readable with `compatibilityError` and an exclusion warning; retain
identity/provenance but omit all affected guidance from later contexts with
`incompatible_rpe_scale`. No silent replacement, deletion, migration or blanket
freshness invalidation: unchanged compatible v5 contexts remain unchanged. The
owner replaces planning only through a new reviewed proposal and explicit Apply.
The previous real synthetic version 1 remains immutable; this correction has
**no new paid evaluation**. See `docs/ai-cycle-planning.md#rpe-compatibility-cycle-delivery-v3`
and `cyclePlanningRpe{,.browser}.test.js` for scope, limitations and regression tests.

Startup AI diagnostics must use the same validated configuration passed to the
execution service. Log only key presence, effective enabled state, disable reason
and invalid setting names; never secrets or invalid values. Keep explicit
`AI_ENABLED=true` opt-in and document restart after dotenv changes. Readiness
is not verification of provider credentials and must not trigger paid calls.

## Golden rules

## GOLDEN RULE — DESIGN SYSTEM FIRST / VISUAL CONSISTENCY

Before starting any frontend task, consult this rule and inspect an equivalent
screen or component already used by Kinesis. Every new component, page, form,
modal, or visual flow must follow the existing visual and interaction patterns.
Identify and reuse the established design tokens for typography, colors,
spacing, borders, radii, focus, hover, disabled, and error states; reuse
existing components and styles whenever possible; inspect the result in a real
browser on desktop and mobile; and compare it with at least one consolidated
screen, including keyboard and accessibility states.

Do not create a second design system, arbitrary colors, arbitrary radii, new
button styles without a demonstrated need, visually different equivalents of
existing controls, or a visual library without authorization. Do not replace
consolidated patterns with agent preference, and do not consider a frontend
change complete solely because functional tests pass.

If no suitable pattern exists, identify the gap, choose the smallest compatible
solution, prefer a reusable component, document the decision, and avoid
establishing a new visual convention without need. A new interface is complete
only when it is functional, accessible, responsive, visually inspected in the
browser, and consistent with the established Kinesis screens.

Visually equivalent controls must reuse the same structures and styles. Keep
label typography on labels, not on containers that also contain inputs, and do
not rely on indiscriminate inheritance when it creates inconsistent control
weights. Auxiliary text needs its own structure and style, distinct from its
label. Avoid page-specific CSS that unnecessarily duplicates shared controls
or fixes structural problems through cascaded overrides. When equivalent
components appear different, inspect computed styles and real dimensions,
including overflow; functional tests alone do not replace visual inspection.

1. **Local-first privacy:** except for the explicitly scoped future OpenAI
   integration described above, never send FIT files or workout data to an external
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
7. **SemVer:** increment the application version before opening a PR. While
   the application is in `0.x`, use MINOR for incompatible changes (and
   document the migration), MINOR for backward-compatible features, and PATCH
   for backward-compatible fixes. After `1.0.0`, use MAJOR for incompatible
   changes. Moving to `1.0.0` requires an explicit decision by the project
   owner. Keep `package.json`,
   `package-lock.json`, and documented version references consistent.
8. **Git workflow:** develop on a task-appropriate branch, not directly on
   `main`; test, inspect `git diff --check`, and commit descriptively only after
   required verification passes.
