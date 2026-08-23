# Training Assistant

A one-page, minimalist **.FIT parser & AI prompt generator** — local and offline.

Drop a Garmin `.FIT` activity file into the browser, add how the workout felt, and get back a ready-to-paste markdown prompt for your AI coach — complete with a lap-by-lap metrics table. No accounts, no cloud, no telemetry: everything runs locally.

## Why

AI coaches are only as good as the data you give them. Exporting workouts by hand means losing detail. Training Assistant turns the raw `.FIT` file your watch already recorded into a structured, metric-rich review request in seconds — so every recommendation from your AI coach is grounded in real numbers.

## Features

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

Then open <http://127.0.0.1:3000>.

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

## Usage

1. Open the app and fill in what you can: planned session details, conditions, gear, perceived effort (RPE 1–5), and feedback. Only the `.FIT` file is mandatory.
2. Drop your `.FIT` file onto the dropzone.
3. Review the parsed laps table and the generated prompt rendered on screen.
4. Click **Copiar Prompt** and paste it into your favorite AI assistant.

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

## API

### `POST /api/fit/parse`

Parses a `.FIT` file and returns its summary plus the generated markdown prompt.

- **Content-Type:** `multipart/form-data`
- **Fields:**
  - `file` *(required)* — the `.FIT` file
  - `tipo_treino`, `treino_planejado`, `fc_alvo`, `tenis`, `fonte_fc`, `clima`, `terreno`, `respiracao`, `sensacao_muscular`, `energia_final`, `dor_desconforto`, `feedback_livre` *(optional)* — free-form text from the form
  - `rpe_alvo`, `rpe_percebido` *(optional)* — integers between 1 and 5

```bash
curl -F "file=@workout.fit" -F "tipo_treino=Longão" -F "rpe_percebido=3" \
     http://127.0.0.1:3000/api/fit/parse
```

Responses:

| Status | Meaning |
|---|---|
| `200` | Success — returns `fileName`, `sizeBytes`, `activity`, `laps`, `totals`, `markdown` |
| `400` | Bad request — missing file, non-`.FIT` extension, invalid RPE, not multipart |
| `413` | File exceeds the 10 MB limit |
| `422` | File could not be parsed or contains no lap records |

## Project Structure

```
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # CI/CD: build & push image to GHCR on pushes to main
├── src/
│   ├── server.js               # Fastify app: static UI + POST /api/fit/parse
│   ├── start.js                # Entry point (reads PORT/HOST env vars)
│   ├── fitParser.js            # .FIT → normalized activity/lap/totals summary
│   ├── markdownGenerator.js    # Summary + form payload → PT-BR AI coach prompt
│   └── public/                 # Single-page frontend (HTML/CSS/vanilla JS)
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

Training Assistant runs in production on a self-hosted **ZimaOS** server, built and shipped automatically through GitHub Actions and exposed to the internet securely through Cloudflare.

### Architecture Overview

```
GitHub main ──push──▶ Self-Hosted Runner (Docker on ZimaOS)
                          │  builds image
                          ▼
                 ghcr.io/fracon/training-assistant:latest
                          │  docker compose pull
                          ▼
              Training Assistant (Fastify, Docker on ZimaOS :8081)
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
```

**Port mapping constraint:** the host port is **8081**, mapped to the container's internal port **3000** (`8081:3000`). Port 8080 is deliberately avoided because it collides with default services on the ZimaOS host.

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

- [Fastify](https://fastify.dev/) with `@fastify/multipart` and `@fastify/static`
- [fit-file-parser](https://www.npmjs.com/package/fit-file-parser) for binary `.FIT` decoding
- Vanilla HTML/CSS/JS frontend with DM Sans typography — zero build step
- [`node --test`](https://nodejs.org/api/test.html) + [c8](https://github.com/bcoe/c8) for testing with a hard 100% coverage gate
- Docker (`node:24-alpine`) deployed on ZimaOS via Docker Compose
- CI/CD with GitHub Actions on a self-hosted runner, published to GHCR
- Secure exposure via Cloudflare Zero Trust Tunnel
