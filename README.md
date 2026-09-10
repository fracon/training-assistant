# Kinesis

A **secure, self-hosted, multi-user web application** for managing training logs — drop a Garmin `.FIT` file into the browser, add how the workout felt, and get back a ready-to-paste markdown prompt for your AI coach.

Current application version: **0.9.4** (active development).

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
direct shoe swaps, distance edits, and deletions leave mileage unchanged rather
than guessing at a prior contribution. To start accounting, the workout must
first be detached and later reattached, which creates one reversible ledger
entry. Legacy shoe labels remain a presentation fallback when loading the
associated shoe is not possible; FIT, ZIP-extracted FIT, and manual results all
use canonical `fit_distance` in kilometres.

Every account is protected with server-side sessions, every `.FIT` file is parsed locally on your own machine: no cloud parsing, no telemetry — your training data never leaves your hardware.

## Why

AI coaches are only as good as the data you give them. Exporting workouts by hand means losing detail. Kinesis turns the raw `.FIT` file your watch already recorded into a structured, metric-rich review request in seconds — so every recommendation from your AI coach is grounded in real numbers.

## Features

### Accounts & Access
- **User accounts & security** — email/password registration and sign-in backed by Node's native `crypto` (`scrypt`) password hashing.
- **Secure sessions** — 256-bit random session tokens stored in SQLite, delivered as `HttpOnly` / `Secure` / `SameSite=Lax` cookies with server-side expiry.
- **Server-side route gating** — unauthenticated visitors are redirected to the login page by Fastify itself; the training tool is never rendered without a valid session.
- **User dropdown menu** — the user badge in the topbar opens a dropdown with account actions, including **Change Password**.
- **Secure change password flow** — a dedicated modal with client-side validation that accumulates every problem into a robust grouped error box (the only error surface — no stray inline hints), backed by hardened `scrypt` verification of the current password before re-hashing and storing the new one.
- **Global route guards** — the Training Calendar is strictly gated: users without an active Training Cycle are redirected to the Cycles page by the server, and cycle-dependent navigation is disabled in the shell as a second line of defense.
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
- **Structured coach prompt** — planned vs. realized workout, conditions, equipment, perceived effort (RPE 1–5), breathing/muscle/energy feedback, and free-form notes are merged into a professional PT-BR coaching template.
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

Every realized result has one persisted source: `none`, `fit_upload`, or `manual` (`garmin_connect` is reserved for a future integration). A manual result intentionally has no synthetic FIT summary or laps. Replacing FIT data with manual aggregates, or manual aggregates with a FIT upload, requires explicit confirmation and executes atomically; the outgoing source's incompatible data is cleared. The result screen marks the source clearly, and its analysis prompt identifies manual data, notes the absence of laps, and states that Kinesis calculated pace from distance and duration. Since dashboard, calendar, and AI Coach already aggregate the canonical training metrics, manual results participate in weekly totals without a second source of truth.

Manual metrics are saved as part of either final result-page action: **Save and back to calendar** persists them before feedback and redirects only after both succeed; **Generate analysis prompt** persists them first so the prompt uses the backend-calculated pace and current provenance. The screen avoids reposting an unchanged manual result by comparing canonical metric values.

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

The footer fetches the version from the backend process at `/api/version` with cache disabled (`Cache-Control: no-store` and `fetch(..., { cache: 'no-store' })`). It therefore reflects the version actually running on the server, rather than a cached response. Updating `package.json` alone cannot update an already-running Node process: restart local development if its watcher does not reload package metadata, and rebuild/pull the new Docker image then restart the container in deployment. Cache prevention avoids stale responses; it cannot make a backend still running `0.6.4` report `0.7.0`.

#### Dynamic Training Prompt Generator

The **AI Coach** page builds the weekly training request from the latest local application state when the user submits the form. It fetches the active cycle and injects its cycle name, goal, target race date, current week/total weeks, and days remaining immediately after the prompt introduction. It also fetches the previous week's calendar entries and summarizes completed workouts as a count, total distance in kilometres, and total time in minutes. Missing values use the prompt's `-` fallback, while valid stored values are preserved and formatted for the selected language.

The generated briefing is fully localized: the Portuguese (`pt-BR`) and English (`en-US`) templates contain the same cycle and performance context fields, with localized labels and week wording. Context is resolved inside the generation action so it always reflects the currently active cycle, latest training data, and current i18n language.

### Home Dashboard

- **Current cycle overview** — cycle title, primary goal, target date, progress, and localized metadata render independently.
- **Weekly tracker first** — the “This Week” card places the Monday–Sunday tracker above accumulated distance/time tiles. Active days use compact minimalist pills with a Lucide `sport-shoe` icon; empty days remain muted and borderless.
- **Card navigation** — subtle Lucide `external-link` actions link the cycle card to `/cycles.html` and the weekly card to `/calendar.html`.
- **Responsive weekly metrics** — completed workout distance and duration are read from the calendar API (`fit_distance`/`fit_duration`), normalized, summed, and formatted in dashboard units.
- **Shoe Rotation widget** — tracks active shoes and renders a dynamic “traffic light” progress bar (green → yellow → red) showing each pair's mileage against its useful lifespan, so runners know at a glance when it is time to replace their gear. Wear level uses the per-shoe target mileage (defaulting to 500 km / 300 mi), distances respect the dashboard unit preference, and the bar turns yellow at 75% and red at 90% of usable life.
- **Accessible quote hero** — the dashboard requests a running-focused image through the optional Unsplash proxy. The server keeps the response in a 20-minute in-memory TTL cache (protecting the 1,000 requests/hour production limit), triggers the required download event, hotlinks the returned image, and renders explicit photographer/Unsplash attribution. Missing keys, rate limits, and network failures use a bundled local image without disrupting the dashboard. Loading text, quote text, and author each have dark semitransparent contrast backdrops for legibility over bright photos.

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
English template.

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

- **Geocoding:** `https://geocoding-api.open-meteo.com/v1/search` resolves the planned location name to coordinates (`name`, `count=1`, `format=json`).
- **Historical weather:** `https://archive-api.open-meteo.com/v1/archive` returns the past day's max temperature and WMO weather code (`temperature_2m_max`, `weather_code`, `timezone=auto`).
- **Recent dates:** when the archive cannot answer, the request automatically falls back to the live forecast at `https://api.open-meteo.com/v1/forecast`.

The API always returns metric Celsius; the frontend converts it to the user's
preferred temperature unit and translates the WMO code through the shared
`weather.*` locale keys. Runs occur under the request limits and requirements of
Open-Meteo's free tier — no API key, account, or `.env` value is needed.

## Quick Start (local development)

Requirements: **Node.js ≥ 24**

```bash
npm install
npm start
```

Then open <http://127.0.0.1:3000> — you'll land on the login page. Create an account (first run) and sign in to reach the training tool. The SQLite database is created automatically at `data/database.sqlite`.

| Command | Description |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with auto-reload on file changes |
| `npm test` | Run the test suite |
| `npm run test:coverage` | Run tests with c8 — enforces **100%** statements, branches, functions, lines |

> **The 100% Rule:** every new feature, page, or shared module must ship with tests that keep **coverage strictly at 100%** across all four metrics (Statements, Branches, Functions, Lines). `npm run test:coverage` is the gate — if it drops below 100%, the missing tests must be written before any commit.

Configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATABASE_FILE` | `<cwd>/data/database.sqlite` | SQLite database location |
| `UNSPLASH_ACCESS_KEY` | _optional_ | Unsplash Access Key sent as `Authorization: Client-ID ...` for the running-photo hero. Responses are cached for 20 minutes to minimize API calls. |

For local setup, copy `.env.example` to `.env`, put your Unsplash **Access Key**
in `UNSPLASH_ACCESS_KEY`, and start with `node --env-file=.env src/start.js` (or export
the variable before `npm start`). For Docker Compose, put the same variable in
the `.env` file beside `docker-compose.yml`; Compose passes it into the server
container. Kinesis works without the key by using the bundled local fallback
image. The key is server-only and must never be placed in frontend files or
committed to Git.

## Usage

1. Open the app — you are presented with the **Sign In** page. New here? Follow **Register** to create an account (first name, last name, email, password of at least 8 characters).
2. After signing in you reach the **Training Result** page: fill in what you can — planned session details, conditions, gear, perceived effort (RPE 1–5), and feedback.
3. Choose **Import FIT file** for detailed lap data, or **Enter data manually** to register aggregated results without a watch export. Manual entries require distance and duration; FIT remains the detailed-data path.
4. Review the parsed laps table and the generated prompt rendered on screen.
5. Click **Copiar Prompt** and paste it into your favorite AI assistant.
6. When you're done, hit **Logout** in the header — the session is destroyed server-side.

The generated prompt follows an exact PT-BR template (defined in `src/markdownGenerator.js`). A trimmed excerpt:

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

### `PUT /api/trainings/:id/manual-results`

Stores one manual realized result for an authenticated user's planned training.
The JSON body accepts canonical `distance_km` and `duration_seconds` (both
required), plus optional `avg_hr`, `max_hr`, `elevation_gain_m`, and
`calories`. The server validates every value, calculates `fit_avg_pace`, sets
`result_data_source` to `manual`, and returns the updated training. Replacing
an existing FIT result requires `confirm_replace_fit: true`; this removes the
stored FIT summary/laps in the same SQLite transaction. No external service is
used. ZIP Garmin exports and mobile/desktop export guidance belong to later
phases and are intentionally not implemented here.

All endpoints except registration and login require a valid session cookie (`ta_session`). Use a cookie jar when scripting:

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
| Login | `src/public/login.html/.css/.js` | Sign-in form only |
| Register | `src/public/register.html/.css/.js` | Sign-up form with aggregated validation errors and success toast |
| TrainingResult | `src/public/training-result.html/.css/.js` | The FIT parser tool, gated behind a session |
| Home | `src/public/home.html/.css/.js` | Authenticated dashboard with cycle, weekly metrics, tracker, and quote hero |
| Calendar | `src/public/calendar.html/.css/.js` | Monthly training calendar and deduplicating Excel import |
| AI Coach | `src/public/ai-coach.html/.css/.js` | Local prompt builder for weekly coaching plans |

Shared code lives in `src/public/shared/`: `theme.css` (earthy color tokens, DM Sans, resets), `validators.js` and `api.js` ES modules imported by the page scripts. Backend spreadsheet parsing is provided by the `xlsx` (SheetJS) dependency and normalized centrally in `src/trainingImport.js`.

## Project Structure

```
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # CI/CD: build & push image to GHCR on pushes to main
├── src/
│   ├── server.js               # Fastify app: route gating, auth endpoints, .FIT parsing
│   ├── start.js                # Entry point (reads PORT/HOST/DATABASE_FILE env vars)
│   ├── fitParser.js            # .FIT → normalized activity/lap/totals summary
│   ├── markdownGenerator.js    # Summary + form payload → PT-BR AI coach prompt
│   ├── auth/                   # passwords (scrypt), registration, login, sessions, requireAuth
│   ├── db/                     # SQLite setup (better-sqlite3, WAL, FKs, schema)
│   └── public/                 # Multi-page frontend (auth, home, calendar, AI Coach, FIT session)
│       └── shared/             # theme.css + ES modules (shell, i18n, validators, API helpers)
├── scripts/
│   ├── tryRealFit.js           # CLI sanity check: parse a real file or generate a synthetic .FIT
│   └── deploy-zimaos.sh        # Server-side helper: docker compose pull && up -d
├── test/                       # node:test suites + .FIT fixture builder helper
├── Dockerfile                  # Production image (node:24-alpine)
├── docker-compose.yml          # ZimaOS production deployment
└── package.json
```

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
    volumes:
      - ./data:/app/data
```

**Port mapping constraint:** the host port is **8081**, mapped to the container's internal port **3000** (`8081:3000`). Port 8080 is deliberately avoided because it collides with default services on the ZimaOS host.

The `./data:/app/data` volume persists the SQLite database (users, sessions) on the ZimaOS host across container upgrades.

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
- Multi-page vanilla HTML/CSS/JS frontend (login / register / training-result) with shared ES modules and DM Sans typography — zero build step
- Authentication built on Node's native `node:crypto` (`scrypt` hashing, timing-safe comparison, `randomBytes` session tokens)
- [`node --test`](https://nodejs.org/api/test.html) + [c8](https://github.com/bcoe/c8) for testing with a hard 100% coverage gate
- Docker (`node:24-alpine`) deployed on ZimaOS via Docker Compose
- CI/CD with GitHub Actions on a self-hosted runner, published to GHCR
- Secure exposure via Cloudflare Zero Trust Tunnel
