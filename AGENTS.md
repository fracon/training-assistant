# Kinesis — Agent Guidelines

## Project and architecture

Kinesis is a self-hosted, multi-user running application. The server is Node.js
24, Fastify, and SQLite (`better-sqlite3`); the frontend is a multi-page,
vanilla HTML/CSS/JavaScript application using shared ES modules. The visual
system uses DM Sans and the tokens in `src/public/shared/theme.css`. Production
uses Docker Compose on ZimaOS, host port 8081 mapped to container port 3000,
with a Cloudflare Tunnel in front. Application version is maintained in
`package.json` and `package-lock.json` (currently `0.17.0`); follow the SemVer
rule below.

Each major page has its own HTML/CSS/JS under `src/public/`: login, register,
home dashboard, contextual training result, calendar, AI Coach, cycles, shoes,
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
  sessions, trainings, cycles, shoes, mileage ledger, and AI Coach
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

`npm run test:coverage` enforces exactly 100% Statements, Branches, Functions,
and Lines for c8-instrumented files under `src/**` (excluding
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

## AI Coach weekly availability

- `/api/ai-coach/availability` is authenticated and user-scoped. Store one record per weekday with `can_train`, canonical period IDs (`before_08`, `08_12`, `12_14`, `14_18`, `after_18`), `available_minutes` as whole minutes, and the exact `location` string.
- Available periods are alternatives for one session. `available_minutes` is the maximum full session duration, including warm-up and cool-down, not a target and not the length of the period window. The maximum is 720 minutes per day.
- Unavailable days canonicalize to no periods, null duration, and empty location. Available days require at least one known period, positive duration, and a location; validate in the backend as well as the UI.
- The idempotent `2026-09-structured-ai-coach-availability-v1` migration does not derive periods or duration from old free text. The earlier AI Coach availability form was transient and did not persist these values; missing structured records must remain unconfigured and be reviewed. On first use the frontend presents missing rows as unchecked/unavailable defaults, without clearing `needsReview`; explicit unavailable rows remain unavailable after persistence.
- Initial availability defaults are presentation-only: they are never eligible for persistence or prompt generation until the authenticated GET has completed successfully. A failed load keeps save/generate blocked, preserves local edits, and may be retried; late responses from older load attempts must not replace a newer result.
- Applying a weekday setup is an explicit one-time copy from Monday to Tuesday–Friday. It never changes weekends or links records.
- AI Coach prompts must state unavailable days and preserve the distinction between periods and session duration. They must not contain “Rotina normal”/“Normal routine” defaults. Do not invent forecast conditions or exact times inside a period; availability adds no weather API call.

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
