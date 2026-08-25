# Kinesis

A **secure, self-hosted, multi-user web application** for managing training logs — drop a Garmin `.FIT` file into the browser, add how the workout felt, and get back a ready-to-paste markdown prompt for your AI coach.

Every account is protected with server-side sessions, every `.FIT` file is parsed locally on your own machine: no cloud parsing, no telemetry — your training data never leaves your hardware.

## Why

AI coaches are only as good as the data you give them. Exporting workouts by hand means losing detail. Kinesis turns the raw `.FIT` file your watch already recorded into a structured, metric-rich review request in seconds — so every recommendation from your AI coach is grounded in real numbers.

## Features

### Accounts & Access
- **User accounts & security** — email/password registration and sign-in backed by Node's native `crypto` (`scrypt`) password hashing.
- **Secure sessions** — 256-bit random session tokens stored in SQLite, delivered as `HttpOnly` / `Secure` / `SameSite=Lax` cookies with server-side expiry.
- **Server-side route gating** — unauthenticated visitors are redirected to the login page by Fastify itself; the training tool is never rendered without a valid session.
- **One-click logout** — invalidates the session on the server and clears the cookie.

### Training Log & AI Prompts
- **Drag & drop `.FIT` upload** — or click to browse.
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
- **Strict input handling** — `.FIT` files only, 10 MB size limit, 10 s parse timeout, clear error messages for unreadable files.

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

Configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATABASE_FILE` | `<cwd>/data/database.sqlite` | SQLite database location |

## Usage

1. Open the app — you are presented with the **Sign In** page. New here? Follow **Register** to create an account (first name, last name, email, password of at least 8 characters).
2. After signing in you reach the **Training Result** page: fill in what you can — planned session details, conditions, gear, perceived effort (RPE 1–5), and feedback. Only the `.FIT` file is mandatory.
3. Drop your `.FIT` file onto the dropzone.
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
- **Database integrity** — WAL journal mode and enforced foreign keys with cascading deletes (users → sessions/workouts).
- **Route gating at the server** — pages and protected APIs validate the session against the database before rendering or responding.

## API

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

## Frontend Architecture

Three standalone pages (no single-page hacks, no overlapping layout states):

| Page | Files | Purpose |
|---|---|---|
| Login | `src/public/login.html/.css/.js` | Sign-in form only |
| Register | `src/public/register.html/.css/.js` | Sign-up form with aggregated validation errors and success toast |
| TrainingResult | `src/public/training-result.html/.css/.js` | The FIT parser tool, gated behind a session |

Shared code lives in `src/public/shared/`: `theme.css` (earthy color tokens, DM Sans, resets), `validators.js` and `api.js` ES modules imported by the page scripts.

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
│   └── public/                 # Multi-page frontend (login / register / training-result)
│       └── shared/             # theme.css + ES modules (validators, api helpers)
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
