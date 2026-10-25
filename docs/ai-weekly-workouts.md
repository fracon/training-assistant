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
`weekly-workouts-v3`; each proposal points to its execution. On reload, the page
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

Once application succeeds, the proposal cards and Apply action are replaced by
the persisted added/duplicate counts and a localized link to the applied week
in Calendar. Reload recovers that terminal state without restoring a pending
preview; recovery selects only the latest workout execution. If the apply
response is lost, the page reads that same proposal before deciding success. A
failed status read can be retried for free and never starts another generation.
The response, full forecast evidence, and application record remain available
in the protected execution/debug view.

## Structured contract and validation

The delivery adapter is versioned independently of
`src/public/shared/workout-prompts.js`. External PT/EN prompts remain byte-for-
byte preserved. The adapter replaces the weather-research and spreadsheet
delivery sections deterministically for this operation, preserving the
training guidance. The adapted prompt retains the source's planning guidance
but omits its rendered cycle, availability, shoe and optional-context blocks;
the versioned shared context is supplied once as structured data. This avoids
duplicating personal context in the bounded model payload. It requires a JSON
object with `schemaVersion`, Monday `weekStart`, and sessions. The model
supplies session kind and ordered warmup, main and cooldown components. Each
component contains repetitions and one structured time or distance measure,
execution `instruction` (required, up to 240 characters), effort/breathing
`effort` (required, up to 160), numeric `rpe` (1–5), optional
`targetHr` (up to 80 characters, empty when unsupported), optional explicit
`paceTargetSecondsPerKm`, and a separate `paceSecondsPerKm` estimate basis
when the component uses distance. Repeated main components require structured
`recoveryMinutes` (integer 0–30) and `recoveryGuidance` (up to 160 characters),
with numeric `recoveryRpe` (1–5). Single-repeat main components and
warmup/cooldown have no recovery fields. Warmup, each main block and cooldown are
reviewable independently. Progressions/fartleks use multiple ordered main
components to express changing effort. Pace/HR targets can be absent; the
instruction should use supported effort and breathing cues instead of
inventing metrics or zones. The strict request schema declares the same numeric
bounds enforced by the domain validator, including repetitions, distances,
paces, recoveries and both RPE fields. It also matches the location (200),
weather (1,000), notes and justification (2,000) string limits. Nullable
fields remain explicit; cross-field rules such as requiring recovery guidance
only on repeated main components remain domain-validated and are stated in the
adapter instructions. The response schema keeps nullable placeholders for
non-applicable fields, while the adapter explicitly asks for Kinesis RPE 1–5
on every running stage and recovery. It also forbids converting observed
average/maximum HR into a target or zone; measured values remain observations.

Duration is calculated only from structured fields: timed component minutes ×
repetitions, plus `(repetitions - 1) × recoveryMinutes`, warmup and cooldown.
Distance components estimate each repetition with `paceSecondsPerKm`, round
each repetition upward to whole minutes, then add recoveries. That pace is a
calculation basis, never an instruction to hold that pace. An optional explicit
pace target has its own field, is displayed separately, and is validated
independently. Use timed components if the context does not support a useful
distance-duration estimate. The legacy global calendar `targetHr` and `rpe`
columns are derived only when every component has the same non-empty FC target
or the same non-null RPE (including recovery RPE for repeated components);
varying stages are never collapsed into a contradictory global target. The
proposal and later training-result page derive a display-only labeled summary
from the same persisted component details, preserving stage and recovery
targets without averaging. If no numeric RPE exists, effort/breathing guidance
remains visible. If no prescribed HR target exists, a localized effort/
breathing fallback is shown; observed average or maximum HR is never promoted
to a target. The preserved synthetic live sample had no numeric observed HR
readings and no prescribed HR reference in its shared context, so its generated
proposal correctly had no numeric target.

The v3 adapter is intentionally incompatible with saved v1/v2 proposals;
`configuration_json.adapterVersion` must match the registered version on review
and apply. This code/schema gate does not migrate the database: execution
snapshots, prior application JSON and calendar rows remain unchanged. New
execution payloads use only the v3 component contract.

The backend derives duration, workout/type labels and the persisted 12-column
`details` from this component contract; the model cannot supply a second
duration/details field. The same multiline materialized details are shown in
the preview and saved to the calendar. Free-text execution/effort/recovery
guidance explains how to execute, but is not a duration source. It has bounded
length and the existing explicit RPE-scale guard, but Kinesis does not claim to
semantically parse every natural-language contradiction about duration or
distance. The delivery prompt tells the model not to add alternate time or
distance prescriptions to prose. Notes (persisted as `observacoes`) and
proposal-only justifications stay separate and are shown in full before
application; text is rendered safely with line breaks. The adapter asks the
model to keep complete materialized `details` at or below 2,000 characters.
JSON Schema cannot express the combined length of all rendered component lines,
so the backend rejects overlength output without truncating or repairing it.

Materialization yields the same 12 import fields (`date`, `weekday`, `period`,
`type`, `workout`, `details`, `targetHr`, `rpe`, `shoeId`, `location`,
`weather`, `notes`) plus proposal fields (`durationMinutes`, `justification`,
`evidence`). `targetHr` and `rpe` are derived output fields, not independent
session claims in the model input. Proposals from `weekly-workouts-v1` and
`weekly-workouts-v2` are explicitly incompatible with v3 review/application.
Their execution snapshots and any saved application result remain intact, but
the current proposal UI refuses to render old output under the v3 contract. No
old calendar details or records are rewritten.

Dates are checked as Monday plus the declared weekday offset, independent of
session order. Only saved available days and that day's unique preferred
period are accepted. Derived duration includes warm-up/cool-down and
between-repeat recovery; all sessions on a day are summed and bounded by saved
available minutes. Component and recovery RPE are null or integers on the
explicit Kinesis 1–5 scale; incompatible RPE references in component prose are
refused by the bounded shared guard. A shoe must be an
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
the requested local calendar date as `start_date` and `end_date`,
`timeformat=unixtime`, and the resolved geocoder timezone; no workout text or
FIT data is included. Do not combine explicit dates with `forecast_days`:
Open-Meteo rejects those parameters as mutually exclusive. The backend enforces
the documented 16-date range locally (current local date through day +15).
Hourly timestamps are UTC epoch seconds interpreted in the returned timezone
([Forecast API](https://open-meteo.com/en/docs)). No API key, paid
source, browser search or additional provider is used. There is no authorized
second hourly source in this deployment; if
Open-Meteo cannot provide trustworthy data the execution records that
limitation and planning continues without a forecast claim.

Transport and response failures retain only bounded categories and stage in
the execution evidence: geocoding/forecast transport (DNS, TLS, connection,
timeout), HTTP status class, JSON parsing, or hourly-data validation. Raw
provider bodies/messages are not persisted. This metadata is diagnostic only;
all unavailable weather remains unavailable and does not block generation.

The verified preferred windows are local-time half-open intervals:
`[00:00,08:00)`, `[08:00,12:00)`, `[12:00,14:00)`, `[14:00,18:00)`,
`[18:00,24:00)`. The forecast timezone must be the same canonical IANA zone as
the resolved geocoder timezone. Runtime IANA alias resolution is used; offset
equality is never sufficient. Requested/returned zones and mismatch reason are
retained. UTC epoch instants are checked for hourly alignment, strict order and
uniqueness. Coverage is the set of expected instants inside the local interval,
not sample count. Missing, duplicated, unordered, invalid or misaligned
timestamps cannot produce verified coverage. Fall-back's repeated local hour
is valid only when represented by two distinct UTC instants; otherwise
coverage is unavailable/partial. Each weather evidence item notes that no authorized independent second hourly source
is configured. Only finite hourly values that match
the requested local date and selected interval contribute to the minimum and
maximum. The local interval high is never replaced with `daily` maximum.
The local date used for the 16-date horizon comes from the geocoded location's
timezone.
Missing hour(s), unresolved/ambiguous geocoding, an invalid timezone, missing
hourly fields, an out-of-horizon date, or provider failure remain explicitly
partial/unavailable. Partial data is preserved for audit but not presented as
a complete window. No fallback weather value is invented and no end user is
asked to confirm weather, timezone, research or authorization.

Availability has a monotonically increasing per-user/day revision. The route
captures its complete availability snapshot before forecast requests and holds
no SQLite transaction open while waiting on weather. Each evidence item is
bound to owner ID, weekday, local date, period, exact location and revision.
Before enqueue/reservation/provider dispatch, an immediate transaction verifies
the active owner and exact snapshot. Any change, including change-and-revert,
returns a localized conflict without reserving or calling OpenAI. Application
also checks current execution freshness and availability revision.

Each forecast evidence item saved in the execution context retains exact
location/date/period, source name/link, query URL when made, lookup time,
coordinates, source timezone, local hourly values, expected/verified coverage,
window temperature range/high and limitations/reason. The model receives the
hourly evidence as untrusted context under the shared safety instructions. To
stay inside the existing context budget without dropping forecast evidence,
verified samples are stored compactly as `[UTC epoch seconds, local HH:MM with
UTC offset, temperature Celsius, WMO code]`; the top-level evidence retains the
date and IANA timezone. The model receives the evidence; it cannot change app
rules. Common UI uses a compact verified window range, labels the high as the
maximum within that period, and includes verified WMO conditions when
available. Partial and unavailable evidence stays explicit, never as a
complete range. URLs, query timestamps, timezone internals and sample counts
remain in the protected snapshot/debug data. Calendar records receive the same
compact derived string in the existing weather field; complete evidence
remains with the execution.

Proposal cards separate warm-up, each main component, and cool-down, with
duration, instruction, effort, RPE/FC targets, recovery, and secondary shoe/
location information. Notes and proposal-only natural-language rationale are
shown in full as safe text. Technical evidence IDs are not shown in the common
UI; recognized identifiers are removed from rationale display only. The
original response JSON and evidence list are unchanged for administrator
diagnostics. Stored global RPE/FC column types and the 12-column import schema
are unchanged.

## Schema and migrations

Migration `2026-10-weekly-workouts-v1` creates `weekly_workout_proposals`,
keyed by execution and cascading from the owned execution/user. It stores the
week reference, creation time and the atomic application timestamp/result.
Existing user/calendar rows are not rewritten or backfilled. The migration is
idempotent and runs through the normal database initialization path.
Migration `2026-10-weekly-availability-revision-v1` adds a revision defaulting
to 1 while preserving legacy availability; repeated initialization is safe.
Proposals are not rewritten; the adapter version gate refuses v1/v2 responses
for v3 review/application. Open a new
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

The complete context snapshot retains each forecast's exact query URL,
coordinates, source binding (owner, weekday, local date, period, location and
availability revision), lookup time, timezone, coverage, window, hourly values
and limitations. `projectContextForModel()` sends the model only the relevant
date/weekday/period, source/link, lookup time, timezone/status/reason, coverage,
window and compact hourly tuples, plus shared limitations. It omits internal
owner/revision bindings, coordinates, exact query URLs and duplicate source
version hashes from the provider view; those remain in the owner-scoped
execution snapshot and its freshness hash. Source type/ID references remain
available to the response validator. The conservative context byte budget uses
the same projection as the request, without raising its configured limit or
dropping forecast samples.

The main page's free external prompt is still explicitly available to admins
only; its prompt template output is byte-preserved. Admin preview/debug routes
read the current database role and owner scope. Common users cannot request a
prompt or technical diagnostics through the UI or API.

The request form places its two actions in the existing wrapping `.form-actions`
layout: the product generation action is primary with Lucide `calendar-plus`,
and the admin-only free prompt preview uses the shared `.btn-secondary` style
with Lucide `sparkles`. The page loads `shared/components.css` for that shared
button contract. Both icons are decorative; translated labels provide accessible
names. The actions remain content-sized and wrap on narrow screens. Generating
still creates a proposal for review and never applies calendar entries.

## Verification and real evaluation

Automated tests use local fixtures and simulated providers only. They verify
adapter determinism, preserved external templates, weekday/date mapping,
interleaved/multiple sessions, cumulative daily time, timed/distance estimates,
separate explicit pace targets, interval recovery, stage-specific progression
and fartlek instructions, warmup/cooldown guidance, numeric and textual RPE,
units, shoes, context evidence, hourly period boundaries, DST, high temperatures
outside the window, partial coverage, ambiguity, horizon and outage, application
conflicts, v1/v2 incompatibility, deduplication and idempotent replay. Existing
import and AI pipeline suites remain required. Browser verification covers
PT/EN, desktop/mobile, user/admin, complete multiline details/notes/rationale,
keyboard, focus, pending/recovery/error, exact review-to-calendar details and
application. Mocks are not model-quality or real-provider validation.

A single controlled live evaluation was completed on 2026-10-25 with explicit
authorization for one call and a maximum $1.00 reservation. Its effective
runtime configuration, synthetic scenario, provider-reported usage, actual
weather outcome, review, application, recovery and concrete limitations are
recorded in [`ai-weekly-workouts-live-evaluation.md`](ai-weekly-workouts-live-evaluation.md).
That record is one sample, not a general model-quality claim. All other AI
tests remain provider simulations. The evaluation did not change the local
`.env`, primary database, production database, deployed container or live
service.
