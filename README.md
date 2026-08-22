# Training Assistant

A one-page, minimalist **.FIT parser & AI prompt generator** — local and offline.

Drop a Garmin `.FIT` activity file into the browser, add how the workout felt, and get back a ready-to-paste markdown prompt for your AI coach — complete with a lap-by-lap metrics table. No accounts, no cloud, no telemetry: everything runs on `127.0.0.1`.

## Why

AI coaches are only as good as the data you give them. Exporting workouts by hand means losing detail. Training Assistant turns the raw `.FIT` file your watch already recorded into a structured, metric-rich review request in seconds — so every recommendation from your AI coach is grounded in real numbers.

## Features

- **Drag & drop `.FIT` upload** — or click to browse. Files never leave your machine.
- **Lap-by-lap metrics** extracted automatically:
  - Duration & cumulative time
  - Distance (km)
  - Average & best pace (min/km)
  - Average & max heart rate (bpm)
  - Ascent / descent (m)
  - Average & max cadence (steps/min)
  - Stride length (m) & calories (kcal)
- **Athlete feedback built in** — optional RPE (1–10) and free-form notes are embedded in the prompt.
- **Step classification** — laps labeled as Warmup, Run, Rest, or Cooldown when intensity data is present.
- **One-click copy** — the generated markdown goes straight to your clipboard.
- **Strict input handling** — `.FIT` files only, 10 MB size limit, 10 s parse timeout, clear error messages for unreadable files.

## Quick Start

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

1. Open the app and set your perceived effort (RPE 1–10) and any notes about the session — sleep, weather, niggles, how it felt.
2. Drop your `.FIT` file onto the dropzone.
3. Review the parsed laps table rendered in the page.
4. Click **Copy Prompt to AI Coach** and paste it into your favorite AI assistant.

The generated prompt looks like this:

```markdown
# AI Coach Review Request

You are a professional endurance coach reviewing a completed structured workout.
Analyse the lap metrics table below together with the athlete feedback.
Answer with: overall assessment, lap-by-lap insights, and concrete adjustments for upcoming sessions.

## Session Overview

- **Activity Type:** running
- **Start Time:** 2026-02-03T07:30:00.000Z
- **End Time:** 2026-02-03T08:10:00.000Z

## Laps

| Step | Lap | Time | Cumulative | Distance (km) | Avg Pace | Best Pace | Avg HR | Max HR | Ascent | Descent | Avg Cadence | Max Cadence | Stride (m) | Calories |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Warmup | 1 | 10:04 | 10:04 | 2.00 | 5:02 | 4:30 | 150 | 162 | 12 | 4 | ... | ... | ... | 60 |
| Run | 2 | 20:00 | 30:04 | 3.00 | 6:40 | 6:27 | 88 | 92 | 5 | 9 | ... | ... | ... | 80 |

## Athlete Feedback

- **RPE:** 7/10
- **Notes:** Legs felt heavy after yesterday's intervals.

Ground every recommendation in the table metrics: paces in min/km, heart rate in bpm, cadence in steps per minute, elevation in meters, energy in kcal.
```

## API

### `POST /api/fit/parse`

Parses a `.FIT` file and returns its summary plus the generated markdown prompt.

- **Content-Type:** `multipart/form-data`
- **Fields:**
  - `file` *(required)* — the `.FIT` file
  - `rpe` *(optional)* — integer between 1 and 10
  - `notes` *(optional)* — free-text athlete notes

```bash
curl -F "file=@workout.fit" -F "rpe=7" -F "notes=Felt strong" \
     http://127.0.0.1:3000/api/fit/parse
```

Responses:

| Status | Meaning |
|---|---|
| `200` | Success — returns `fileName`, `sizeBytes`, `activity`, `laps`, `markdown` |
| `400` | Bad request — missing file, non-`.FIT` extension, invalid RPE, not multipart |
| `413` | File exceeds the 10 MB limit |
| `422` | File could not be parsed or contains no lap records |

## Project Structure

```
├── src/
│   ├── server.js             # Fastify app: static UI + POST /api/fit/parse
│   ├── start.js              # Entry point (reads PORT/HOST env vars)
│   ├── fitParser.js          # .FIT → normalized activity/lap summary
│   ├── markdownGenerator.js  # Summary + feedback → AI coach prompt
│   └── public/               # Single-page frontend (HTML/CSS/vanilla JS)
├── scripts/
│   └── tryRealFit.js         # CLI sanity check: parse a real file or generate a synthetic .FIT
├── test/                     # node:test suites + .FIT fixture builder helper
└── package.json
```

## Verifying With Real Files

Sanity-check the parser against a real workout export (or generate a synthetic `.FIT` if you don't have one handy):

```bash
node scripts/tryRealFit.js path/to/activity.fit
```

## Tech Stack

- [Fastify](https://fastify.dev/) with `@fastify/multipart` and `@fastify/static`
- [fit-file-parser](https://www.npmjs.com/package/fit-file-parser) for binary `.FIT` decoding
- Vanilla HTML/CSS/JS frontend — zero build step
- [`node --test`](https://nodejs.org/api/test.html) + [c8](https://github.com/bcoe/c8) for testing with a hard 100% coverage gate
