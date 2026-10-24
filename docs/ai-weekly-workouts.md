# Weekly workout proposals (issue #64)

Status: implemented on the dedicated issue #64 branch; it becomes integrated
only after its PR merges. Cycle planning is integrated through merged PR #69.
This phase does not include issue #65, chat, Garmin, a new athlete profile,
spreadsheet downloads, or a second AI/job system.

## User flow and persistence

The existing Solicitar Treinos / Request Workouts page saves its existing
availability controls, then offers an explicit paid weekly generation action.
It uses the phase 0/#69 execution service, quotas, atomic reservations,
Responses client, bounded 429-only retry, cancellation, diagnostics, context
freshness and durable recovery. The operation is registered as
`weekly-workouts-v1`; each proposal points to its execution. On reload, the page
reads the user's latest weekly execution and retrieves the same persisted
proposal. Progress polling is bounded; a long-running or failed progress read
ends loading and exposes a free manual reread. An uncertain start is
resolved by its idempotency key and is never silently replayed as a new paid
call. Administrators can still explicitly preview the exact preserved external
prompt and inspect only their own current-role debug snapshots; ordinary users
receive the product proposal UI without technical prompt/debug controls.

The UI renders every session and its proposal-only justification before the
user applies anything. Generation never writes to the calendar. Application
uses one immediate SQLite transaction, rechecks active account, current
execution/response hash and source freshness, requires the same currently active
cycle and revalidates availability, preferred period, daily minute total, RPE,
shoe ownership/status and evidence. It adds only records whose existing
`(dia, treino, detalhes)` deduplication signature is absent. Existing entries,
completed results and result data are never edited or removed. The inserted
records reference the active cycle at application time. Reapplying the same
valid proposal returns its saved application result without another provider
call or writes. If relevant context changed, application returns a conflict;
the user can retain the proposal for review but must generate a fresh one to
apply against changed sources. Existing import behavior and the 12-column
XLSX/XLS contract remain independent and unchanged.

## Structured contract and validation

The delivery adapter is versioned independently of
`src/public/shared/workout-prompts.js`. External PT/EN prompts remain byte-for-
byte preserved. The adapter replaces the weather-research and spreadsheet
delivery sections deterministically for this operation, preserving the
training guidance. It requires a JSON object with `schemaVersion`, Monday
`weekStart`, and sessions. Every session has the exact 12 import fields
(`date`, `weekday`, `period`, `type`, `workout`, `details`, `targetHr`, `rpe`,
`shoeId`, `location`, `weather`, `notes`) and proposal fields
(`durationMinutes`, `justification`, `evidence`).

Dates are checked as Monday plus the declared weekday offset, independent of
session order. Only saved available days and that day's unique preferred
period are accepted. Each session duration includes warm-up/cool-down; all
sessions on a day are summed and bounded by saved available minutes. RPE is
either null or an integer on the explicit Kinesis 1–5 scale. A shoe must be an
active shoe in the owner's current snapshot. Location must exactly match the
saved string. Evidence identifiers must refer to captured context sources.
Free text has field limits and the shared bounded RPE-scale guard rejects
explicit incompatible scales. The response is validated before it can become
a completed execution; no model-generated XLSX or spreadsheet parsing is used.

The shared context contains the current cycle and applied plan when present,
owned planned and completed training, actual results and feedback including
dated RPE, saved availability, owned shoes, aggregates, explicit omissions and
history gaps. An unapplied cycle proposal is not current planning. An absent
applied AI plan does not block generation or require a separate paid call.
Context freshness tracks relevant cycle/plan, calendar, availability, shoe and
weather evidence. Proposal justifications remain attached to that execution;
there is no athlete-interpretation CRUD or automatic promotion into permanent
profile facts. Missing history does not imply rest/recovery, and generated
advice may not invent races, injury history, recovery status or permanent
limitations.

## Hourly weather evidence

Weekly weather is a backend flow separate from the existing daily result
autofill. It reuses the established Open-Meteo geocoding and location-context
ambiguity rules, then requests `temperature_2m` and `weather_code` hourly data
from Open-Meteo Forecast. Queries contain saved location-derived coordinates,
the requested local calendar date, and `timezone=auto`; no workout text or FIT
data is included. No API key, paid source, browser search or additional provider
is used. There is no authorized second hourly source in this deployment; if
Open-Meteo cannot provide trustworthy data the execution records that
limitation and planning continues without a forecast claim.

The verified preferred windows are local-time half-open intervals:
`[00:00,08:00)`, `[08:00,12:00)`, `[12:00,14:00)`, `[14:00,18:00)`,
`[18:00,24:00)`. The response timezone is validated and its DST rules determine
expected hourly coverage for the date. The geocoded timezone determines the
local-date horizon, which is rechecked against the forecast timezone. Each
weather evidence item notes that no authorized independent second hourly source
is configured. Only finite hourly values that match
the requested local date and selected interval contribute to the minimum and
maximum. The local interval high is never replaced with `daily` maximum.
The local date used for the 15-day bound comes from the geocoded location's
timezone when available and is rechecked against the forecast response timezone.
Missing hour(s), unresolved/ambiguous geocoding, an invalid timezone, missing
hourly fields, an out-of-horizon date, or provider failure remain explicitly
partial/unavailable. Partial data is preserved for audit but not presented as
a complete window. No fallback weather value is invented and no end user is
asked to confirm weather, timezone, research or authorization.

Each forecast evidence item saved in the execution context retains exact
location/date/period, source name/link, query URL when made, lookup time,
coordinates, source timezone, local hourly values, expected/verified coverage,
window temperature range/high and limitations/reason. The model receives the
hourly evidence as untrusted context under the shared safety instructions; it
cannot change app rules. The UI shows the source and coverage in the proposal.
Calendar records receive the derived source/range summary in the existing
weather field; the complete evidence remains with the execution.

## Schema and migrations

Migration `2026-10-weekly-workouts-v1` creates `weekly_workout_proposals`,
keyed by execution and cascading from the owned execution/user. It stores the
week reference, creation time and the atomic application timestamp/result.
Existing user/calendar rows are not rewritten or backfilled. The migration is
idempotent and runs through the normal database initialization path. Open a new
database and rerun initialization; also initialize a database with existing
users, cycles, executions and trainings to verify that those records and
ownership remain intact. Re-running an older migration is not a substitute for
this new migration.

## API, privacy and configuration

All endpoints use the authenticated, current active owner. `POST
/api/ai/executions` continues to create a `purpose=workouts` execution and
accepts only the existing request fields plus a bounded optional user note.
The route requires an active cycle and complete, reviewable availability;
the current applied AI planning version is optional. `GET
/api/ai/workouts/:id/proposal` and `POST
/api/ai/workouts/:id/apply` scope execution and proposal to the requester. Apply
accepts only `expected_response_hash`; the backend checks the same response and
source version in its write transaction. Current role checks for administrative
preview/debug remain independent, and admins never bypass ownership.

An explicit generation sends the selected existing athlete context, availability,
user note if entered, hourly forecast evidence, and adapted prompt to the
configured OpenAI Responses operation (`store:false`). It excludes account
identity, credentials, raw GPS and FIT/ZIP binaries. This operation uses the
already-effective `AI_MODEL_WORKOUTS`, reasoning, output, timeout, retry,
quota, concurrency and budget settings; this feature changes no environment
setting, limit, model, deployment, `.env`, main database or production state.
Open-Meteo receives only coordinates derived from the saved location plus the
date/timezone needed for hourly weather. Network providers can receive ordinary
connection metadata. `store:false` is not a promise of zero provider retention.

The main page's free external prompt is still explicitly available to admins
only; its prompt template output is byte-preserved. Admin preview/debug routes
read the current database role and owner scope. Common users cannot request a
prompt or technical diagnostics through the UI or API.

## Verification and real evaluation

Automated tests use local fixtures and simulated providers only. They verify
adapter determinism, preserved external templates, weekday/date mapping,
interleaved/multiple sessions, cumulative daily time, RPE, units, shoes,
context evidence, hourly period boundaries, DST, high temperatures outside the
window, partial coverage, ambiguity, horizon and outage, application conflicts,
deduplication and idempotent replay. Existing import and AI pipeline suites
remain required. Browser verification covers PT/EN, desktop/mobile, user/admin,
keyboard, focus, pending/recovery/error and calendar application. Mocks are not
model-quality or real-provider validation.

No paid OpenAI call was made for this branch. A controlled real evaluation,
before it is run, needs the operator to explicitly authorize one call and
provide a temporary evaluation window with: the current configured model and
reasoning; `AI_ENABLED=true` and a runtime key; a synthetic or specifically
approved test account with an active cycle, saved availability and no personal
data; `AI_RETRIES=0`, one outstanding call, configured timeout and output cap;
and a daily USD cap at least equal to the displayed reservation (while keeping
the global cap within the operator's chosen budget). The evaluator should
record reservation, provider-reported usage/cost, response validation, manual
review of evidence/RPE/session durations, explicit application, reload and
idempotent reapplication, then restore prior runtime settings. No real
evaluation should be described as complete until those measurements and the
owner's budget authorization are supplied. The local `.env`, production
database, deployed container and live service were not changed by this work.
