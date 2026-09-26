# Kinesis

A **secure, self-hosted, multi-user running application** for planning training and recording results. Create cycles and workouts, import a spreadsheet, record results from `.FIT`/`.ZIP` or manual measurements, manage shoe mileage, and prepare localized prompts for an AI coach.

Current application version: **0.13.1** (active development).

### Shoe mileage integrity

For each shoe, `shoes.base_mileage` is a non-negative user-authoritative
baseline. `shoes.mileage` is that baseline plus only the canonical training
distances recorded in the per-training `training_shoe_mileage` ledger. The
backend reconciles each unique ledger entry in the same SQLite transaction as
feedback, completion, result, shoe-swap, or deletion changes. Editing the
displayed total intentionally rebases the shoe and clears its applied ledger;
those workouts then become historical and cannot be subtracted later.

The idempotent `2026-09-shoe-mileage-accounting-v1` migration adds the stable
shoe relationship, links historical `feedback_shoe` labels only when exactly
one same-user shoe matches, and leaves ambiguous labels untouched. It derives a
non-negative baseline equal to the user's existing authoritative total and an
empty ledger, so ambiguous historical runs are never added or subtracted. The
durable v2 marker in `schema_migrations` makes this conversion idempotent.

An associated completed workout without a ledger entry is treated as historical:
distance edits and deletions leave its shoe mileage unchanged rather than
guessing at a prior contribution. An explicit swap to a different shoe starts
accounting the workout distance on the newly selected shoe without subtracting
the unknown historical contribution from the old shoe. Detaching and later
reattaching a workout also starts one reversible ledger entry. Legacy shoe
labels remain a presentation fallback when loading the
associated shoe is not possible; FIT, ZIP-extracted FIT, and manual results all
use canonical `fit_distance` in kilometres.

The feedback shoe selector offers active shoes for new selections. A workout's
same-user shoe that was retired later remains visible as a disabled historical
selection; unrelated feedback saves preserve it. Replacing it with an active
shoe starts mileage accounting on the replacement without subtracting an
unledgered historical distance from the retired shoe.

Authenticated pages and APIs use server-side sessions. FIT files and workout data are processed by the Kinesis application server, not sent to external processing services. Optional weather lookup sends the planned location and date to Open-Meteo. If `UNSPLASH_ACCESS_KEY` (or its accepted legacy alias `UNSPLASH_API_KEY`) is configured, the Kinesis server asks Unsplash for a generic running image and registers the image download. The dashboard makes a daily quote request to ZenQuotes and falls back to bundled localized quotes. These integrations do not send FIT files, workout data, or user-entered training context; as with other network requests, providers may receive connection metadata such as the requesting IP address.

## Why

New accounts receive a short PT/EN welcome carousel and a non-blocking setup
guide. The guide's three steps are derived from that user's shoes, active cycle,
and planned workout records. Dismissing welcome or hiding the guide changes only
presentation state; opening the guide from the user menu is transient. Existing
accounts do not receive the welcome automatically.

AI coaches are only as good as the data you give them. Exporting workouts by hand means losing detail. Kinesis turns the raw `.FIT` file your watch already recorded into a structured, metric-rich review request in seconds — so every recommendation from your AI coach is grounded in real numbers.

## Features

### Accounts & Access
- **User accounts & security** — email/password registration and sign-in backed by Node's native `crypto` (`scrypt`) password hashing.
- **Account roles** — every account has a database-constrained `user` or `admin` role. Public registration always creates `user`; admin status only comes from the privileged local bootstrap or promotion commands. Admin role does not bypass per-user ownership checks.
- **Secure sessions** — 256-bit random session tokens stored in SQLite, delivered as `HttpOnly` / `Secure` / `SameSite=Lax` cookies with server-side expiry.
- **Server-side route gating** — unauthenticated visitors are redirected to the login page by Fastify itself; the training tool is never rendered without a valid session.
- **User dropdown menu** — the authenticated user badge opens **Setup guide**, **Change Password**, and **Preferences**. Logout remains a separate topbar action.
- **Secure change password flow** — a dedicated modal with client-side validation that accumulates every problem into a robust grouped error box (the only error surface — no stray inline hints), backed by hardened `scrypt` verification of the current password before re-hashing and storing the new one.
- **Global route guards** — the Training Calendar is strictly gated: users without an active Training Cycle are redirected to the Cycles page by the server, and cycle-dependent navigation is disabled in the shell as a second line of defense.
- **New-user onboarding** — the first-visit welcome and three-step setup checklist are available in English and Brazilian Portuguese. The guide can be reopened from the user dropdown without changing progress or presentation preferences.
- **One-click logout** — invalidates the session on the server and clears the cookie.

### User Preferences Module

The user badge dropdown opens a standardized Preferences modal (sharing the
Change Password modal structure) with three account-wide settings:

- **First day of the week** — Monday or Sunday.
- **Distance unit** — kilometres (`km`) or miles (`mi`).
- **Temperature unit** — Celsius (`°C`) or Fahrenheit (`°F`).

Preferences are persisted through the authenticated user API and mirrored in
`localStorage` for immediate rendering. The Calendar/Trainings page's
Seg/Dom start-of-week toggle is two-way bound to the same store: changing it
updates the modal, Calendar grid, Home Dashboard “This Week” tracker, and its
week boundaries. Unit changes are reflected in dashboard totals, shoe mileage,
and training-session metrics without changing metric values stored by the
backend.

### Training Log & AI Prompts
- **Manual workout results** — when a Garmin file is unavailable, record total distance, duration (hours/minutes/seconds), average/max HR, elevation gain, and calories directly against the planned training. Distance and duration are required; the server stores distance in canonical kilometres and calculates the rounded average pace.
- **Drag & drop `.FIT` or `.ZIP` upload** — a ZIP must contain exactly one FIT activity; the extracted buffer follows the same parser and persistence pipeline as a direct FIT upload.
- **Lap-by-lap metrics** extracted automatically:
  - Duration & cumulative time
  - Distance (km)
  - Average & best pace (min/km)
  - Average & max heart rate (bpm)
  - Ascent / descent (m)
  - Average & max cadence (steps/min)
  - Stride length (m) & calories (kcal)
- **Structured coach prompt** — planned vs. realized workout, conditions, equipment, perceived effort (RPE 1–5), breathing/muscle/energy feedback, and free-form notes are merged into a localized Portuguese or English coaching template.
- **Workout totals computed automatically** — total duration, distance, average pace, weighted average HR, max HR, and ascent.
- **Step classification** — laps labeled as Warmup, Run, Rest, or Cooldown when intensity data is present.
- **One-click copy** — review the generated markdown on screen, then copy it straight to your clipboard.
- **Smart form memory** — repetitive fields (shoes, HR source, terrain) are saved in `localStorage` and pre-filled next time.
- **Strict input handling** — `.FIT` or `.ZIP` files only, 10 MB upload limit, 10 s parse timeout, and clear errors for unreadable files.

FIT results can be uploaded directly or inside a ZIP exported by a training
service. ZIP processing is local and memory-only: directories and macOS metadata
are ignored, while archives with zero or multiple FIT files are rejected. The
upload is limited to 10 MB, at most 100 entries, 10 MB per decompressed FIT, and
25 MB total decompressed content. All regular entries are validated and consumed
sequentially (the FIT may appear anywhere); declared sizes are only an early
rejection and actual streamed bytes are authoritative. Encrypted, corrupt,
unsafe, or over-limit archives fail before any training data is changed. ZIP uploads retain the
`fit_upload` provenance and never persist the archive or extracted file.

The Training Result page includes a neutral, multibrand import guide for
Garmin, COROS, Polar, Amazfit/Zepp, Huawei, Apple, and Samsung. It links only
to official support documentation verified on 2026-09-09, explains whether a
FIT/ZIP-FIT path is direct, conditional, unsupported, or unverified, and always
offers manual entry as a fallback. The guide does not request credentials,
connect to manufacturer APIs, or send telemetry. See
[`docs/workout-import-compatibility.md`](docs/workout-import-compatibility.md)
for the audited matrix and sources. GPX, TCX, XML, CSV, and JSON imports remain
future work and are not made compatible by renaming their extensions.

The same page also offers **How do I create my workout? / Como criar meu
treino?** in the internal header of the planned-workout card. This is an informational, localized guide for
creating structured workouts in Garmin Connect, Apple Watch/iPhone, COROS,
Polar Flow, Suunto, Samsung Health/Galaxy Watch, Xiaomi/Mi Fitness, and Huawei
Health. It is separate from importing a completed result and does not connect to
manufacturer accounts or synchronize anything from Kinesis. The catalog links to
official documentation and marks support that depends on a model, firmware,
application version, operating system, or region; Xiaomi/Mi Fitness is not
presented as having one confirmed custom-workout flow for every device, and
Huawei's documented plans are likewise model-dependent. See
[`docs/workout-creation-compatibility.md`](docs/workout-creation-compatibility.md)
for the sources and scope.

Every realized result has one persisted source: `none`, `fit_upload`, or `manual` (`garmin_connect` is reserved for a future integration). A manual result intentionally has no synthetic FIT summary or laps. Replacing FIT data with manual aggregates, or manual aggregates with a FIT upload, requires explicit confirmation and executes atomically; the outgoing source's incompatible data is cleared. The result screen marks the source clearly, and its analysis prompt identifies manual data, notes the absence of laps, and states that Kinesis calculated pace from distance and duration. Since dashboard, calendar, and AI Coach already aggregate the canonical training metrics, manual results participate in weekly totals without a second source of truth.

FIT activity pace uses a valid session distance paired with valid
`total_timer_time`, falling back to session elapsed time, session average speed,
then complete internally consistent laps, and finally paired record-derived
distance/active duration. Distance and duration are never mixed across
sources. Pace is rounded to the nearest second and stored as `m:ss` min/km. An
idempotent startup migration converts recognized old FIT decimal-minute values
such as `6.53` to `6:32`. Elevation gain prefers session `total_ascent`, then
complete lap ascent totals, then the sum of positive deltas between consecutive
valid records from one selected altitude field. Descents are never added by
absolute value; invalid samples break record sequences, and session, lap, and
record totals are never combined.

The result page keeps **How to import? / Como importar?** beside the FIT/ZIP
upload controls. It is an independent import guide and remains available in
sessions with no result, manual results, or FIT/ZIP results; result provenance
is never inferred from visible form fields.

The FIT result is persisted as soon as the upload to `/api/trainings/:id/fit`
completes. The final result-page actions then persist the manual result when
needed and save the complete feedback before continuing: **Save and back to
calendar** returns to the Calendar after saving; **Save and Generate Analysis
Prompt** generates the prompt only after that feedback save, using the
canonical training state returned by the backend, including backend-calculated
pace and current provenance. The screen avoids reposting an unchanged manual
result by comparing canonical metric values.

Calories are available for both result sources. For FIT uploads, Kinesis reads the
authoritative activity/session total (`sessions[0].total_calories`) exposed by
`fitParser` as `summary.totals.calories`; per-lap calorie values remain available
for the detailed table but are never summed into the activity total. Values are
normalized to a finite, non-negative integer (real zero is preserved), while
missing or invalid values remain `null`. Manual calories use the same
`fit_calories` field, and replacing one source with another replaces its calorie
value as well. No calorie estimates are generated. Older FIT summaries that do
not contain an authoritative total are not backfilled from laps; re-uploading
the file is required to recover calories safely.

### Running version in the footer

The footer fetches `/api/version` without caching, so it reflects the running backend process. Restart the local process or rebuild and restart the deployed container after changing the application version.

#### Dynamic Training Prompt Generator

The **AI Coach** page builds the weekly training request from the latest local application state when the user submits the form. It fetches the active cycle and injects its cycle name, goal, target race date, current week/total weeks, and days remaining immediately after the prompt introduction. It also fetches the previous week's calendar entries and summarizes completed workouts as a count, total distance in kilometres, and total time in minutes. Missing values use the prompt's `-` fallback, while valid stored values are preserved and formatted for the selected language.

The generated briefing is fully localized: the Portuguese (`pt-BR`) and English (`en-US`) templates contain the same cycle and performance context fields, with localized labels and week wording. Context is resolved inside the generation action so it always reflects the currently active cycle, latest training data, and current i18n language.

Weekly availability is stored per authenticated user and weekday through
`/api/ai-coach/availability`. Each record contains `can_train`, stable
`available_periods` IDs (`before_08`, `08_12`, `12_14`, `14_18`, `after_18`),
`available_minutes` as an integer number of minutes, and the exact user-entered
`location`. A 12-hour (720-minute) daily maximum prevents unreasonable input.
Unavailable days are stored with an empty period list, null duration, and empty
location. Available days require at least one period, positive duration, and a
location. Multiple periods are alternatives for one session. The duration is
the total maximum session time, including warm-up and cool-down; it is not a
target and is independent of the time window.

The idempotent `2026-09-structured-ai-coach-availability-v1` migration creates
the user/day table without rewriting existing training locations. The previous
AI Coach text fields were transient and had no database persistence, so there
is no authoritative legacy availability to translate. Missing structured days
are returned as unconfigured and require explicit review; on first use the
frontend presents those missing days as unchecked/unavailable defaults while
preserving the review requirement until the week is explicitly saved. Explicit
unavailable days remain unavailable after persistence; text such as “Normal
routine” is never treated as availability or sent in the prompt. The
“Apply Monday's setup to weekdays” action explicitly copies Monday to Tuesday
through Friday; Saturday and Sunday are untouched, and later edits are
independent.

Initial unchecked availability values are presentation-only and cannot be
saved or used to generate a prompt until the availability GET succeeds. A
failed load keeps both operations blocked, preserves edits made locally, and
offers a localized retry; older asynchronous responses cannot replace a newer
load result.

The prompt states each unavailable day and, for available days, its selected
periods, maximum session minutes, and location. It explicitly tells the coach
that periods are alternatives for one session and minutes are a ceiling, not a
goal or a conversion from the size of a period window. The prompt also directs
the coach to consider local time and use weather only when valid forecast data
exists. Kinesis does not add a weather API call to availability or invent an
exact time inside a selected window; the existing optional Open-Meteo flow
continues to receive only a planned training location/date.

### Home Dashboard

- **Current cycle overview** — cycle title, primary goal, target date, progress, and localized metadata render independently.
- **Weekly tracker first** — the “This Week” card places the week tracker above accumulated distance/time tiles. Its order follows the account's Monday/Sunday week-start preference. Active days use compact pills with a Lucide `sport-shoe` icon.
- **Card navigation** — subtle Lucide `external-link` actions link the cycle card to `/cycles.html` and the weekly card to `/calendar.html`.
- **Responsive weekly metrics** — completed workout distance and duration are read from the calendar API (`fit_distance`/`fit_duration`), normalized, summed, and formatted in dashboard units.
- **Shoe Rotation widget** — tracks active shoes and renders a dynamic “traffic light” progress bar (green → yellow → red) showing each pair's mileage against its useful lifespan, so runners know at a glance when it is time to replace their gear. Wear level uses the per-shoe target mileage (defaulting to 500 km / 300 mi), distances respect the dashboard unit preference, and the bar turns yellow at 75% and red at 90% of usable life.
- **Accessible quote hero** — the dashboard can request a generic running image through the optional Unsplash API proxy. The server caches the result in memory for 20 minutes, registers the required download event, hotlinks the returned image, and renders photographer/Unsplash attribution. Without a key or if the request fails, it uses a bundled local image. The browser makes a daily ZenQuotes request for the quote where available; failures use localized bundled quotes. Neither request includes workout data or user-entered training context, though network providers may see the requester’s connection metadata. Loading text, quote text, and author each have dark semitransparent contrast backdrops for legibility over bright photos.

### New-user onboarding

While a newly registered account has onboarding status `new`, the dashboard
automatically shows a three-slide welcome modal: add shoes, create a cycle, and
prepare workouts. Its primary links lead to
the existing shoe and cycle flows. The workout-planning slide opens AI Coach or
spreadsheet import when a cycle exists; otherwise it directs the user to create
the required cycle first. The welcome is not a required tour. “Not now” persists
dismissal by changing
`onboarding_status` from `new` to `active` through the presentation endpoint.

The compact checklist appears automatically while incomplete and not hidden by
the saved preference. Its steps are calculated from data owned by the signed-in
user: at least one shoe row, an active cycle, and at least one planned training
row. Seeing a screen or choosing an action does not complete a step. Newly
registered users start with status `new`; existing rows with the historical
`legacy` value are migrated idempotently to `active`. Existing accounts do not
receive the welcome retroactively. Only `new` accounts receive it automatically.

When the three steps are complete, or the user hides the checklist, it is absent
from the normal dashboard layout. The user can open **Setup guide** / **Guia de
configuração** from the account menu on any authenticated page. On the dashboard
the shell sends a page-local event; elsewhere it navigates to
`/home.html?openSetupGuide=1`. The dashboard consumes that exact signal and
removes it from the URL while preserving other query parameters and the hash.
This opening is transient: it changes no progress, onboarding status, or saved
presentation preference. An explicitly opened guide can show all completed
steps for any signed-in account; opening the guide does not open the welcome modal.
“Hide guide” saves only the per-user
hidden preference; it does not change step data. An incomplete checklist appears
automatically only while `guide_hidden` is false; after completion it remains
absent unless explicitly opened from the menu.

The backend contract, persisted fields, derived response fields, and migration
defaults are documented under [Onboarding API](#onboarding-api).

### Date and Locale Architecture

All user-facing dates go through `src/public/shared/date.js`, the shared formatter used by the dashboard, cycle cards, workout sessions, and AI Coach prompt context. It parses date-only ISO values without timezone drift and uses `Intl.DateTimeFormat` with the active language:

- Portuguese (`pt`/`pt-BR`): `DD/MM/YYYY` (for example, `05/09/2026`)
- English (`en`/`en-US`): `MM/DD/YYYY` (for example, `09/05/2026`)

Components must not reverse ISO strings, concatenate date parts, or otherwise format dates locally. The same locale-aware utility is used when a date is rendered in the UI or inserted into a localized prompt, keeping language changes consistent across the application.

Distance and temperature display conversions follow the same preference store
through `src/public/shared/units.js`: stored kilometres/Celsius values are
converted to miles/Fahrenheit only at presentation time.

The AI Coach prompt generator reads the active preferences when the prompt is
generated. It converts previous-week distance totals, formats shoe and workout
metrics in the selected unit, and inserts localized instructions and weather
examples (for example, `23–24 °C` or `73–75 °F`) in the active Portuguese or
English template. Weather guidance uses each day's supplied location and
session time, falling back to the usual location only when that day has no
specific location; it has no mandatory geographic default.

### Excel Training Import

The Calendar page imports `.xlsx`/`.xls` plans and validates every row before persistence. The backend uses the SheetJS [`xlsx`](https://www.npmjs.com/package/xlsx) reader for workbook parsing, which tolerates namespace-prefixed XML emitted by Excel, LibreOffice, Google Sheets, and Numbers. The normalized rows then pass through `src/trainingImport.js`, which maps Portuguese and English aliases (including `Data`, `Dia`, `Período`, `Tipo`, `Treino`, `Detalhes`, `FC alvo`, `RPE`, `Tênis`, `Localização`, `Previsão do tempo`, and `Observações`) into the application schema. The AI Coach contract uses these 12 columns, while legacy spreadsheets without a location column remain valid and import with no planned location.

Upload validation accepts the standard Excel MIME types and falls back to the `.xlsx`/`.xls` filename extension when browsers send generic types such as `application/octet-stream` or `application/zip`. SheetJS performs the structural parsing; genuinely corrupt buffers receive a 400 response instead of crashing the server. Excel serial dates are normalized to the correct calendar day before persistence, including workbooks whose XML contains namespace prefixes.

Duplicate prevention uses the exact composite signature **Date (`dia`) + Training Name (`treino`) + Description (`detalhes`)**. Rows matching a stored training or repeated within the same workbook are skipped; workouts on the same date with a different name or description remain valid and are imported.

Import completion uses the shared Snackbar rather than a permanent inline banner. It renders two localized lines: successfully imported trainings and duplicate rows skipped, with singular/plural English and Brazilian Portuguese translations.

### Branding Assets

Official brand PNGs are kept under `src/public/assets/brand/`:

- `logo.png` — expanded application logo fallback.
- `logo-mark.png` — standalone mark used by the sidebar and login card.
- `favicon.png` — centered 64×64 browser-tab icon.

Every page references the favicon from this shared public path, while the
sidebar switches between the mark and its translated **Kinesis** label according
to its expanded or collapsed state. New brand assets should remain in this
directory so all pages use one consistent identity.

### Weather Auto-Fill (Open-Meteo)

The Training Feedback view shows the planned **Location** from the imported plan
next to the other planned-workout fields. When a training has a location and the
weather field is still blank, the page asks the backend for that day's weather
readout and pre-fills the editable input (e.g. `22 °C, Overcast`). The field
stays fully editable — a manually typed value is never overwritten.

The integration is completely **keyless** and uses [Open-Meteo](https://open-meteo.com/):

- **Geocoding:** `https://geocoding-api.open-meteo.com/v1/search` searches up to 10 candidates. It tries normalized full location text, locality before the first comma, then diacritic-free variants. Country names and ISO alpha-2 codes are canonicalized; recognized Brazilian state and U.S. state (including DC) abbreviations are checked only within their country. Supplied context is checked against administrative and country fields; unknown, ambiguous, or incompatible matches are rejected.
- **Historical weather:** `https://archive-api.open-meteo.com/v1/archive` returns the past day's max temperature and WMO weather code (`temperature_2m_max`, `weather_code`, `timezone=auto`).
- **Recent dates:** when the archive cannot answer, the request automatically falls back to the live forecast at `https://api.open-meteo.com/v1/forecast`.

The API always returns metric Celsius; the frontend converts it to the user's
preferred temperature unit and translates the WMO code through the shared
`weather.*` locale keys. Runs occur under the request limits and requirements of
Open-Meteo's free tier — no API key, account, or `.env` value is needed. Search
normalization is temporary; the planned training keeps the exact location the
user entered.

## Quick Start (local development)

Requirements: **Node.js ≥ 24**

```bash
npm install
npm start
```

Then open <http://127.0.0.1:3000> — you'll land on the login page. Create an account (first run) and sign in to reach the dashboard. The SQLite database is created automatically at `data/database.sqlite` unless `DATABASE_FILE` overrides it.

| Command | Description |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with auto-reload on file changes |
| `npm run admin:bootstrap` | Interactively create the first administrator in this application's database |
| `npm run admin:promote` | Explicitly promote an existing account after confirmation |
| `npm test` | Run the test suite |
| `npm run test:coverage` | Run tests with c8 — enforces **100%** statements, branches, functions, and lines in instrumented backend files |

> **The 100% Rule:** `npm run test:coverage` enforces 100% Statements, Branches, Functions, and Lines for the files instrumented by c8 (`src/**`, excluding `src/public/**` and `src/start.js`, plus `scripts/admin-prompts.js`, `scripts/admin-runtime.js`, and `scripts/admin-commands.js`). Frontend behavior remains test-mandatory when it changes, but `src/public/**` is not included in that instrumentation percentage.

Configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATABASE_FILE` | `<cwd>/data/database.sqlite` | SQLite database location |
| `UNSPLASH_ACCESS_KEY` | _optional_ | Unsplash Access Key sent as `Authorization: Client-ID ...` for the running-photo hero. Responses are cached for 20 minutes to minimize API calls. |

`UNSPLASH_API_KEY` is also accepted as a legacy alias by the server. `dotenv`
loads `.env` from the process working directory at startup; the environment
values above are the supported runtime configuration.

For local setup, optionally copy `.env.example` to `.env` and put your Unsplash **Access Key**
in `UNSPLASH_ACCESS_KEY`; `dotenv` loads `.env` when `npm start` runs. The server also accepts the legacy
`UNSPLASH_API_KEY` alias. For Docker Compose, put the Access Key variable in
the `.env` file beside `docker-compose.yml`; Compose passes it into the server
container. Kinesis works without the key by using the bundled local fallback
image. The key is server-only and must never be placed in frontend files or
committed to Git.

### Administrator setup

Roles are `user` and `admin`; new accounts and migrated accounts use `user`.
The idempotent role migration preserves existing IDs, password hashes, sessions,
preferences, onboarding state, and related data. It never chooses an admin.
The database rejects any other role. Admin status does not change the ownership
scope of training, cycle, or shoe operations.

For a fresh database, run `npm run admin:bootstrap` from the application
directory before normal use. It asks for the account details, hides password
input, validates and hashes through the application auth code, and creates an
`admin` account with normal new-account onboarding. If any admin already
exists, it makes no changes. If the address is already registered, it directs
the operator to promote that account. For an existing account, run
`npm run admin:promote`; inspect the displayed identity and type `yes` to
confirm. Promotion updates only `role`; it does not create missing users or
change passwords, preferences, onboarding, or sessions.

Both commands require an interactive TTY, use the same `DATABASE_FILE` setting
as the server, and never accept a password argument. Cancellation and EOF leave
no partial account. They run only when explicitly invoked and are not part of
application or container startup. Treat access to the server/container as
privileged because these commands can grant admin access.

## Usage

1. Open **Sign In**. Create an account through **Register** (first name, last name, email, and password of at least 8 characters) or sign in to an existing account.
2. A new account is offered the optional PT/EN welcome carousel. Use its actions to register shoes, create a cycle, then prepare workouts with AI Coach or import an Excel plan. You may skip it and use the application freely; the dashboard checklist tracks data actually saved.
3. Open the **Calendar**, choose a planned training, and enter conditions, shoes, perceived effort (RPE 1–5), and feedback on its result page.
4. Choose **Import FIT or ZIP file** for activity data, or **Enter data manually** for aggregate distance and duration (with optional heart rate, elevation, and calories). A FIT/ZIP upload is persisted when its upload request succeeds.
5. **Save and back to calendar** saves any pending manual result and complete feedback, then returns to the calendar. **Save and Generate Analysis Prompt** saves those data first, then generates the prompt from the canonical training state returned by the backend.
6. Copy the generated prompt to your chosen AI assistant. Kinesis does not send the prompt to an LLM.
7. Use **Logout** in the top bar to end the server-side session.

The result-analysis prompt is localized in Portuguese or English. A Portuguese excerpt:

```markdown
Analise o treino de corrida abaixo considerando todo o histórico do meu treinamento…

DADOS DO TREINO PLANEJADO

Data: 03/02/2026
Dia da semana: terça-feira
Tipo de treino: Intervalado
FC alvo: 145–155 bpm
RPE alvo: 4/5
Tênis: Nimbus 26

DADOS DO TREINO REALIZADO

Duração total: 30:04
Distância total: 5.00 km
Pace médio: 6:01 min/km
Calorias: 742 kcal
FC média: 151 bpm
FC máxima: 162 bpm
Desnível positivo: 22 m

…

DADOS DETALHADOS

| Step | Lap | Time | Cumulative | Distance (km) | Avg Pace | Best Pace | Avg HR | Max HR | … |
|---|---|---|---|---|---|---|---|---|---|
| Run | 1 | 10:04 | 10:04 | 2.00 | 5:02 | 4:30 | 150 | 162 | … |

INSTRUÇÕES PARA A ANÁLISE

1. Compare o treino realizado com o treino planejado.
…
```

## Security Model

- **Password hashing** — `scrypt` via Node's native `node:crypto`, salted per user, stored as `scrypt$<salt>$<key>`; verification uses `crypto.timingSafeEqual`.
- **User enumeration resistance** — failed logins always return the same generic message ("Invalid email or password."), and unknown emails go through an equivalent scrypt computation so response timing doesn't reveal whether an account exists.
- **Session tokens** — 32 bytes from `crypto.randomBytes` (256 bits of entropy), persisted server-side in SQLite with an expiry timestamp; expired sessions are purged on each login and rejected on lookup.
- **Cookies** — `HttpOnly` (inaccessible to JavaScript), `Secure`, `SameSite=Lax`, scoped to `/`, cleared with matching attributes on logout.
- **SQL injection prevention** — all database access goes through better-sqlite3 **prepared statements**; zero string interpolation anywhere near SQL.
- **Database integrity** — WAL journal mode and enforced foreign keys with cascading deletes (users → sessions/trainings).
- **Route gating at the server** — pages and protected APIs validate the session against the database before rendering or responding.

## API

Except for the public version and authentication routes, these API endpoints
require the authenticated `ta_session` cookie. Protected data reads and writes
are scoped to the signed-in user's records.

### Route index

| Method and path | Access | Purpose |
|---|---|---|
| `GET /api/version` | Public | Running application version |
| `POST /api/auth/register` | Public | Create account |
| `POST /api/auth/login` | Public | Authenticate and set session cookie |
| `POST /api/auth/logout` | Public | Invalidate the current session if present and clear cookie |
| `GET /api/me` | Session | Current account and preferences |
| `GET /api/onboarding` | Session | Data-derived onboarding state |
| `PATCH /api/onboarding/presentation` | Session | Update welcome/guide presentation preferences |
| `GET /api/hero-image` | Session | Optional Unsplash image proxy/fallback |
| `PUT /api/auth/password` | Session | Change password |
| `PATCH /api/users/me/language` | Session | Update language preference |
| `PATCH /api/users/me/calendar-preference` | Session | Update week-start preference |
| `PATCH /api/users/me/preferences` | Session | Update distance/temperature preferences |
| `GET /api/calendar/trainings` | Session | Read calendar trainings |
| `POST /api/calendar/import` | Session | Import spreadsheet rows |
| `GET /api/trainings/:id` | Session | Read one owned training |
| `PATCH /api/trainings/:id` | Session | Update training fields and feedback |
| `PATCH /api/trainings/:id/reschedule` | Session | Reschedule an owned training |
| `PUT /api/trainings/:id/manual-results` | Session | Save manual result |
| `POST /api/trainings/:id/fit` | Session | Upload and persist FIT or single-FIT ZIP result |
| `DELETE /api/trainings/:id` | Session | Delete an owned training |
| `POST /api/fit/parse` | Session | Parse a FIT upload and return analysis data |
| `GET /api/weather` | Session | Resolve planned location and date through Open-Meteo |
| `GET /api/cycles` | Session | List owned cycles |
| `GET /api/cycles/active` | Session | Read active cycle |
| `POST /api/cycles` | Session | Create cycle |
| `PUT /api/cycles/:id` | Session | Update owned cycle |
| `DELETE /api/cycles/:id` | Session | Delete owned cycle |
| `GET /api/cycles/:id/prompt` | Session | Read cycle prompt context |
| `GET /api/shoes` | Session | List owned shoes |
| `POST /api/shoes` | Session | Create shoe |
| `PUT /api/shoes/:id` | Session | Update owned shoe |
| `DELETE /api/shoes/:id` | Session | Delete owned shoe |

Endpoint-specific validation and error statuses are described below where
documented; inspect the route handlers in `src/server.js` and their route
modules for the complete response contract.

### Onboarding API

`GET /api/onboarding` requires a valid session, returns `401` otherwise, and
responds `200` with `{ "onboarding": state }`. The state fields are `status`
(`new` or `active`), `guideHidden`, `steps` (`shoes`, `cycle`,
`trainings` booleans), `completed`, `total` (3), `complete`, and
`firstTrainingId` (number or `null`). Step completion is derived from records
owned by the authenticated user: any shoe, an active cycle, and any planned
training row, respectively.

`PATCH /api/onboarding/presentation` also requires a session. Its JSON body must
contain one or both of `welcome_dismissed` and `guide_hidden`, each a boolean.
An empty body/object, unknown key, or non-boolean value returns `400`; a valid
request returns `200` with `{ "onboarding": <refreshed state> }`. The persisted
columns are `users.onboarding_status` and `users.onboarding_guide_hidden`:

- `welcome_dismissed: true` changes only status `new` to `active`; no separate
  dismissed boolean is stored, and other statuses remain unchanged.
- `guide_hidden` stores the per-user presentation preference as integer 0/1.
- Neither preference stores progress; progress is recalculated from owned data.
- Registration explicitly creates users with status `new`. New schemas default
  to `active`; the idempotent migration adds the status column to older schemas
  with a compatibility default and converts every existing `legacy`
  value to `active`, preserving the guide-hidden preference and all user data.
  The hidden preference defaults to `0`.

`openSetupGuide=1` is a transient frontend navigation signal, not an API field
or persisted preference.

### `PUT /api/trainings/:id/manual-results`

Stores one manual realized result for an authenticated user's planned training.
The JSON body accepts canonical `distance_km` and `duration_seconds` (both
required), plus optional `avg_hr`, `max_hr`, `elevation_gain_m`, and
`calories`. The server validates every value, calculates `fit_avg_pace`, sets
`result_data_source` to `manual`, and returns the updated training. Replacing
an existing FIT result requires `confirm_replace_fit: true`; this removes the
stored FIT summary/laps in the same SQLite transaction. No external service is
used. ZIP Garmin exports and the mobile/desktop export guidance are available
in the Training Result import guide.

All protected API endpoints require a valid session cookie (`ta_session`). Use a cookie jar when scripting:

### Public — Authentication

#### `POST /api/auth/register`

Creates an account. Passwords must be ≥ 8 characters.

```bash
curl -X POST http://127.0.0.1:3000/api/auth/register \
     -H "content-type: application/json" \
     -d '{"email":"you@example.com","password":"super-secret-1","first_name":"Ada","last_name":"Lovelace"}'
```

| Status | Meaning |
|---|---|
| `201` | Account created — returns `{ id, email, first_name, last_name }` |
| `400` | Missing/invalid fields (short password, malformed email) |
| `409` | Email already registered |

#### `POST /api/auth/login`

Authenticates a user and sets the session cookie.

```bash
curl -c jar.txt -X POST http://127.0.0.1:3000/api/auth/login \
     -H "content-type: application/json" \
     -d '{"email":"you@example.com","password":"super-secret-1"}'
```

| Status | Meaning |
|---|---|
| `200` | Success — sets `ta_session` cookie, returns the user profile |
| `400` | Missing email or password |
| `401` | Invalid credentials (generic message — always identical for unknown emails and wrong passwords) |

#### `POST /api/auth/logout`

Deletes the session row and clears the cookie.

### Protected — Session Required

#### `GET /api/me`

Returns the authenticated user's profile; `401` without a valid session.

#### `POST /api/fit/parse`

Parses a `.FIT` file and returns its summary plus the generated markdown prompt.

```bash
curl -b jar.txt -F "file=@workout.fit" -F "tipo_treino=Longão" -F "rpe_percebido=3" \
     http://127.0.0.1:3000/api/fit/parse
```

- **Content-Type:** `multipart/form-data`
- **Fields:**
  - `file` *(required)* — the `.FIT` file
  - `tipo_treino`, `treino_planejado`, `fc_alvo`, `tenis`, `fonte_fc`, `clima`, `terreno`, `respiracao`, `sensacao_muscular`, `energia_final`, `dor_desconforto`, `feedback_livre` *(optional)* — free-form text from the form
  - `rpe_alvo`, `rpe_percebido` *(optional)* — integers between 1 and 5

| Status | Meaning |
|---|---|
| `200` | Success — returns `fileName`, `sizeBytes`, `activity`, `laps`, `totals`, `markdown` |
| `400` | Bad request — missing file, non-`.FIT` extension, invalid RPE, not multipart |
| `401` | No valid session |
| `413` | File exceeds the 10 MB limit |
| `422` | File could not be parsed or contains no lap records |

#### `GET /api/weather`

Resolves a planned location to a daily weather readout (max temperature in
Celsius + WMO code) via Open-Meteo. Keyless — no credentials required by the
upstream service.

| Query param | Required | Description |
|---|---|---|
| `location` | yes | Free-text place name, geocoded server-side |
| `date` | yes | Training date in `YYYY-MM-DD` |

```bash
curl -b jar.txt "http://127.0.0.1:3000/api/weather?location=Fânzeres&date=2026-08-23"
```

Returns `200` with `{ location, latitude, longitude, date, temperature_c, weather_code, source }`, where `source` is `archive` (past days) or `forecast` (fallback for recent dates).

| Status | Meaning |
|---|---|
| `200` | Success — weather readout with source and coordinates |
| `400` | Missing `location` or invalid `date` |
| `401` | No valid session |
| `404` | Location could not be geocoded |
| `502` | Open-Meteo is unreachable and no fallback answered |

## Frontend Architecture

Every primary flow is a standalone page (no single-page hacks, no overlapping layout states):

| Page | Files | Purpose |
|---|---|---|
| Login | `src/public/login.html` · `src/public/login.css` · `src/public/login.js` | Sign-in form only |
| Register | `src/public/register.html` · `src/public/register.css` · `src/public/register.js` | Sign-up form with aggregated validation errors and success toast |
| Training result | `src/public/training-result.html` · `src/public/training-result.css` · `src/public/training-result.js` | Contextual FIT/ZIP and manual result capture, gated behind a session |
| Home | `src/public/home.html` · `src/public/home.css` · `src/public/home.js` | Authenticated dashboard with onboarding, cycle, weekly metrics, tracker, and quote hero |
| Calendar | `src/public/calendar.html` · `src/public/calendar.css` · `src/public/calendar.js` | Monthly training calendar and deduplicating Excel import |
| AI Coach | `src/public/ai-coach.html` · `src/public/ai-coach.css` · `src/public/ai-coach.js` | Local prompt builder for weekly coaching plans |
| Cycles | `src/public/cycles.html` · `src/public/cycles.css` · `src/public/cycles.js` | Training-cycle management |
| Shoes | `src/public/shoes.html` · `src/public/shoes.css` · `src/public/shoes.js` | Shoe rotation and mileage management |

Shared code lives in `src/public/shared/`: `shell.js` injects the authenticated shell and user menu; `onboarding.js` owns welcome/checklist state and the transient guide signal; `i18n.js` and `locales/` provide PT/EN; `theme.css` owns tokens and shared controls; `api.js`, validators, date, units, preferences, and supporting modules are reused by pages. `src/trainingImport.js` normalizes SheetJS workbook data on the backend.

## Project Structure

```
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # CI/CD: build & push image to GHCR on pushes to main
├── src/
│   ├── server.js               # Fastify route registration, page gating and shared APIs
│   ├── start.js                # Entry point (PORT/HOST/DATABASE_FILE and dotenv)
│   ├── fitParser.js            # .FIT → normalized activity/lap/totals summary
│   ├── markdownGenerator.js    # Training feedback → localized analysis prompt
│   ├── auth/                   # Passwords (scrypt), registration, sessions and auth guard
│   ├── db/                     # SQLite schema, initialization and idempotent migrations
│   ├── cycles.js               # Training-cycle persistence and prompt context
│   ├── shoes.js                # Shoe data and mileage ledger
│   ├── trainingImport.js       # Workbook row validation and normalization
│   └── public/                 # Standalone login/register/home/result/calendar/coach/cycles/shoes pages
│       ├── locales/            # English and Brazilian Portuguese dictionaries
│       └── shared/             # Shell, onboarding, i18n, theme, API, date, units, preferences
├── scripts/
│   ├── tryRealFit.js           # CLI sanity check: parse a real file or generate a synthetic .FIT
│   ├── update-qa-location.js   # QA-only mutation of fixed-date rows in local data/database.sqlite
│   └── deploy-zimaos.sh        # Server-side helper: docker compose pull && up -d
├── test/                       # node:test suites + .FIT fixture builder helper
├── Dockerfile                  # Production image (node:24-alpine)
├── docker-compose.yml          # ZimaOS production deployment
├── docs/                       # Product and import compatibility documentation
├── .env.example                # Optional Unsplash key template
├── package.json                # Version and npm scripts
└── package-lock.json           # Locked dependency tree
```

`scripts/update-qa-location.js` is a QA-only data-writing utility for the
specific date encoded in that script; do not run it against production data.

---

## Deployment & Infrastructure

Kinesis runs in production on a self-hosted **ZimaOS** server, built and shipped automatically through GitHub Actions and exposed to the internet securely through Cloudflare.

### Architecture Overview

```
GitHub main ──push──▶ Self-Hosted Runner (Docker on ZimaOS)
                          │  builds image
                          ▼
                 ghcr.io/fracon/training-assistant:latest
                          │  docker compose pull
                          ▼
              Kinesis (Fastify, Docker on ZimaOS :8081)
                          │  HTTP
                          ▼
                 Cloudflare Tunnel (Zero Trust)
                          │  HTTPS terminated by Cloudflare
                          ▼
                     https://your-domain.com
```

- **App:** Node.js 24 / Fastify running in a Docker container (`node:24-alpine` base, non-root user).
- **Host:** ZimaOS, orchestrated with Docker Compose.
- **Exposure:** Cloudflare Zero Trust Tunnel — no open inbound ports on the router; Cloudflare handles the public HTTPS layer.

### CI/CD Pipeline (Self-Hosted Runner)

Builds run on a **Self-Hosted GitHub Runner** executing inside a Docker container on the ZimaOS server itself.

- Workflow: [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)
- Trigger: every push to the `main` branch.
- Steps: checkout → log in to GHCR (`github.actor` + `GITHUB_TOKEN`) → extract tags/labels → build with Buildx (GHA cache) → push to `ghcr.io/fracon/training-assistant`.
- Tags produced: `latest` (default branch) and the commit SHA.

> **Note — GHCR package visibility:** set the `training-assistant` package to **Public** in *GitHub → Packages → training-assistant → Package settings*. Public visibility allows the ZimaOS server to pull the image seamlessly without configuring a registry credential.

### ZimaOS Production Deployment

Production uses the repository's `docker-compose.yml`:

```yaml
services:
  training-assistant:
    image: ghcr.io/fracon/training-assistant:latest
    container_name: training-assistant
    restart: unless-stopped
    ports:
      - "8081:3000"
    environment:
      - UNSPLASH_ACCESS_KEY=${UNSPLASH_ACCESS_KEY:-}
    volumes:
      - ./data:/app/data
```

**Port mapping constraint:** the host port is **8081**, mapped to the container's internal port **3000** (`8081:3000`). Port 8080 is deliberately avoided because it collides with default services on the ZimaOS host.

The `./data:/app/data` volume persists the SQLite database (users, sessions) on the ZimaOS host across container upgrades.

Run privileged account setup manually against that same persisted database:

```bash
docker exec -it <container-name> npm run admin:bootstrap
docker exec -it <container-name> npm run admin:promote
```

Use the actual running container name and an interactive terminal (`-it`). The
bootstrap command creates the first admin only; the promotion command requires
an existing account and explicit confirmation. Neither command runs when the
container starts. The production image includes both scripts and runs them as
the same non-root `node` user as the server.

Manual deployment commands (run where `docker-compose.yml` lives):

```bash
docker compose pull
docker compose up -d
```

Or use the bundled helper, which does exactly that:

```bash
./scripts/deploy-zimaos.sh
```

### External Access (Cloudflare Tunnel)

Public access is provided by a Cloudflare Zero Trust Tunnel — the server never exposes ports directly to the internet.

Tunnel public hostname configuration:

| Parameter | Value |
|---|---|
| Service type | `HTTP` |
| URL | `<ZIMAOS_LOCAL_IP>:8081` |

- Point the tunnel at the ZimaOS machine's local IP on port **8081** (the compose host port above).
- **Cloudflare handles HTTPS automatically** — certificates, TLS termination, and renewal all happen on Cloudflare's edge; the local hop stays plain HTTP inside the LAN.
- DNS for your domain is managed by the tunnel (CNAME to the tunnel ID), so no port forwarding rules are ever created on the router.

---

## Verifying With Real Files

Sanity-check the parser against a real workout export (or generate a synthetic `.FIT` if you don't have one handy):

```bash
node scripts/tryRealFit.js path/to/activity.fit
```

## Tech Stack

- [Fastify](https://fastify.dev/) with `@fastify/multipart`, `@fastify/static`, and `@fastify/cookie`
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for storage — strictly prepared statements, WAL mode, enforced foreign keys
- [fit-file-parser](https://www.npmjs.com/package/fit-file-parser) for binary `.FIT` decoding
- Multi-page vanilla HTML/CSS/JS frontend (login, register, dashboard, training result, calendar, AI Coach, cycles, shoes) with shared ES modules, PT/EN translations, and DM Sans — zero build step
- Authentication built on Node's native `node:crypto` (`scrypt` hashing, timing-safe comparison, `randomBytes` session tokens)
- [`node --test`](https://nodejs.org/api/test.html) + [c8](https://github.com/bcoe/c8) for testing with a hard 100% coverage gate
- Docker (`node:24-alpine`) deployed on ZimaOS via Docker Compose
- CI/CD with GitHub Actions on a self-hosted runner, published to GHCR
- Secure exposure via Cloudflare Zero Trust Tunnel
