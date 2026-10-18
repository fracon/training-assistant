# AI foundation (phase 0, issue #62)

Status: phase 0 is integrated through merged [PR #67](https://github.com/fracon/training-assistant/pull/67),
merge `648d6a0`, following #66/#68. The issue #63 branch adds only the cycle
product adapter and explicit planning application; see [cycle planning](ai-cycle-planning.md).
That phase is not integrated until its own PR merges. #64/#65 remain future.
Cycle goals may be noncompetitive; the target date is a goal deadline, not a
required race. See the [calendar and adapter contract](ai-cycle-planning.md#goal-deadlines-and-calendar-validation).
Historical validation sections below record pre-merge phase 0 batches, not the
current merge status.

## Configuration and deployment

The existing application and prompt workflows work without an API key. Personal
memory and free administrator preview work with AI disabled. Copy `.env.example`
for local development. On ZimaOS put the variables in the `.env` beside Compose
and recreate the container with `docker compose up -d`. Keep that file private.
Compose passes the key at runtime; the Dockerfile does not contain it, and
`.dockerignore` excludes `.env*`. Ports remain `8081:3000`, the persistent volume
remains `./data:/app/data`, and the container continues to use the `node` user.

Adding `OPENAI_API_KEY` alone does not enable generation: set `AI_ENABLED=true`
explicitly. Restart `npm run dev` / `npm start` after editing `.env` (Node watch
tracks imported code, not dotenv file changes); recreate Compose containers after
runtime variable changes. Existing process environment takes precedence over
`.env`. Startup prints `[Kinesis] OpenAI:` with key presence, effective enabled
state, disabled/missing/invalid reason and invalid setting names only. It never
prints key values. Ready means locally configured, not verified provider access;
startup does not make a provider call. Reload the cycle page after restart.

| Variable | Default | Bounds / meaning |
| --- | --- | --- |
| `AI_ENABLED` | `false` | Explicit `true` or `false` |
| `OPENAI_API_KEY` | empty | Backend environment only; absent means unavailable |
| `AI_MODEL_CYCLE` / `AI_MODEL_WORKOUTS` / `AI_MODEL_ANALYSIS` | `gpt-6.1-sol` | Allowlist: `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`; no fallback |
| `AI_MAX_OUTPUT_TOKENS` | 2048 | 128–8192, includes model reasoning/output allowance |
| `AI_TIMEOUT_MS` | 60000 | 1000–180000 |
| `AI_CONCURRENCY_USER` / `AI_CONCURRENCY_GLOBAL` | 1 / 2 | 1–2 / 1–8 outstanding executions |
| `AI_DAILY_TOKENS_USER` / `AI_DAILY_TOKENS_GLOBAL` | 100000 / 500000 | 1000–10000000 / 1000–100000000 |
| `AI_DAILY_CALLS_USER` / `AI_DAILY_CALLS_GLOBAL` | 10 / 100 | 1–100 / 1–1000; reserve maximum retry attempts |
| `AI_DAILY_USD_USER` / `AI_DAILY_USD_GLOBAL` | 2 / 20 | Positive, at most 1000 USD |
| `AI_CONTEXT_TOKENS` | 12000 | 1000–24000 conservative UTF-8 byte bound, not an exact tokenizer |
| `AI_DETAIL_DAYS` | 14 | 7–28 |
| `AI_HISTORY_WEEKS` | 12 | 8–12 |
| `AI_RETENTION_DAYS` | 90 | 7–365 for terminal execution/debug and usage retention |
| `AI_RETRIES` | 1 | 0–2; only an explicit provider 429 can retry |

### Operational cycle-planning settings

For the complete A–F cycle plan use **`AI_MAX_OUTPUT_TOKENS=8192`** and
**`AI_TIMEOUT_MS=120000`** explicitly. `.env.example` supplies these settings;
the table above describes the unchanged backend fallbacks, not the example.
Existing `.env` files are not rewritten when the example changes. Compose also
retains its legacy 2048/60000 fallbacks: set both values in the operator's runtime
configuration before recreating the container. No production setting is changed
by this PR. Environment values take precedence over dotenv; restart after edits.

The 2026-10-18 isolated Chrome evaluation used the configured `gpt-6.1-sol`,
medium reasoning, those output/timeout limits, `AI_RETRIES=0`, concurrency 1/1,
daily USD caps 1/1 and daily call caps 2/2. One provider attempt completed in
78,479ms and yielded a validated, explicitly applied/reloaded version. The
conservative reservation was USD 0.237045; known usage reconciled it to an
estimated USD 0.06688. These settings are a demonstrated small case, not a
latency/quality guarantee for every history. Keep one-attempt evaluation overrides
separate from the deployment's documented 429 retry policy. See the
[complete evidence and limitations](ai-cycle-planning.md#end-to-end-real-evaluation-2026-10-18).
The earlier 2048-token exhaustion and 60s timeout remain historical failures;
unknown usage from an earlier timeout is not refunded or relabeled as known.

Older explicit values still override these recommended values: update the actual
runtime source (local `.env`, Compose `.env`/`--env-file`, shell exports or the
hosting environment UI), not only `.env.example`. For a deployed image, obtain
the intended build with `docker compose pull`, then recreate with
`docker compose up -d --force-recreate`. A plain `docker compose restart` retains
the container environment. Copying/editing the example cannot change an existing
container; Compose's shell environment can also override its `.env` interpolation.
These are operator instructions, not deployment actions performed by this task.

Invalid settings disable paid AI; invalid numeric limits retain bounded local
defaults so startup, personal memory and cleanup remain usable.
Administrator usage reports expose invalid setting **names**, never values or
credentials. Model documentation and public pricing were checked on 2026-10-14;
project access and actual model quality require a real controlled evaluation.
Models use medium reasoning, foreground Responses requests, `store:false`, no
provider tools and no arbitrary endpoint, prompt or model supplied by a browser.
The native Node fetch client avoids an additional SDK dependency and SDK retries.

Published rates vary with tier/context/caching. Each execution saves a versioned,
conservative pricing ceiling (`2026-10-14-conservative-ceiling`) in USD per
million tokens, including a possible input cache-write ceiling:

| Model | Input | Cached input | Cache write | Output |
| --- | --- | --- | --- | --- |
| gpt-6.1-sol | 4 | .2 | 5 | 15 |
| gpt-6-luna | .2 | .02 | .25 | .75 |
| gpt-6-astra | 20 | 2 | 25 | 75 |

These are local conservative estimates, not provider invoices or promised
prices. Input reservation uses UTF-8 bytes for the complete payload plus 1,024 tokens
of protocol overhead, plus output
allowance, with the larger input/cache-write rate. Requests above 50,000 input
bytes are refused. Known usage reconciles input, cached input and output (noncached input
retains the conservative input/cache-write ceiling);
unknown outcomes retain the full reservation. Review rates against official
pricing before enabling a functional phase. Do not enable paid tools or a
premium tier without updating this accounting contract.

### Execution diagnostics on the issue #63 branch

`2026-10-ai-execution-diagnostics-v1` idempotently adds `diagnostics_json` to
`ai_executions`, default `[]`. Existing snapshots, usage, errors, proposals and
applied versions are preserved; missing historical metadata is not invented.
Diagnostics live in the existing execution row and follow its retention and
account-deletion cascade, with at most three bounded attempt records.

Only current-admin own-execution debug returns diagnostics. Common polling and
planning responses contain the stable product error, not technical IDs or
validation paths. The allowlist includes stage/code, attempt, duration/effective client timeout, HTTP
status, request/response/client correlation IDs, known provider status, only
`max_output_tokens`/`content_filter` incomplete reasons, reasoning-token count,
transport reason (`timeout`/`network`), output-text item/byte counts and schema/domain code with a schema-defined path.
No body, refusal text, provider error prose, notes, Authorization or API key is
logged or copied into those records. Input/output/cache usage keeps its existing
accounting. Admin `costBasis` explicitly distinguishes `reservation_pending`,
`reported_usage_estimate`, `known_unbilled` and `reserved_unknown_usage`; the last
is a reserved estimate, not confirmed provider spend. Reasoning is included in provider output and is **not added twice**.
New execution configuration records application version and timeout. Historical
executions did not save exact runtime SHA/timeout, so these cannot be backfilled.

`X-Client-Request-Id=kin_<execution UUID>_<attempt>` is saved before network dispatch
and used only for correlation, not as provider-side deduplication. SQLite
idempotency and transactional claim remain the duplication boundary. A retry's
metadata is saved in the same transaction as its 429 requeue. A restart keeps the
client correlation and records uncertainty; it never resends an uncertain call.
If proposal persistence fails after a response, the transaction rolls back and a
sanitized `resultPersistenceFailed` settles the **known** usage instead of
misclassifying the call as transport uncertainty. No schema/domain rule is relaxed.
See the [operator workflow](ai-cycle-planning.md#failure-diagnostics-and-provider-correlation).

## Data, migration and privacy

Migration `2026-10-ai-foundation-v1` creates `ai_profiles`, `ai_memory`,
`ai_executions`, `ai_usage` and `ai_global_usage` atomically. Reinitialization is
idempotent and does not populate historical profiles or infer restrictions.
Existing user, session, training, cycle, shoe and feedback rows are preserved.

The account menu links to `/training-memory.html`. Both ordinary users and
administrators see a source-backed consolidated view, not a parallel registry.
Only optional previous running experience can be edited here (2,000 characters,
optimistic version, 409 on conflict). Reloading the current version preserves
unsaved input; saving never overwrites another account or restores a deleted
account. All other corrections navigate to their existing source screen.

### Source inventory and correction paths

| Information | Canonical fields / functions | Existing API and correction UI |
| --- | --- | --- |
| Goals / race | `training_cycles.objective`, `primary_goal`, `secondary_goal`, `target_date`, `start_date`, `updated_at`; `getActiveCycle`, cycle CRUD | `/api/cycles`, `/api/cycles/active`, `PUT /api/cycles/:id`; `/cycles.html` |
| Days / period / maximum duration / place | `ai_coach_availability.day_key`, `can_train`, `available_periods`, `available_minutes`, `location`, `updated_at`; availability domain | `GET/PUT /api/ai-coach/availability`; `/ai-coach.html` |
| Plans / execution | `trainings.dia`, type/title/details, completion, canonical `fit_*`, `result_data_source`; `trainingView` | `/api/calendar/trainings`, `/api/trainings/:id`; `/calendar.html`, `/training-result.html?id=…` |
| Dated reports / discomfort | `feedback_rpe`, notes, breathing, muscle, energy, has-pain and pain; `trainingView.report` | Existing training PATCH / result editor; same session link |
| Totals | `buildContext` disjoint weekly calculation over canonical results, missing-metric counts | Same selected sources; calendar/result correction |
| Prior experience | `ai_profiles.fields_json.experience` only | `PUT /api/ai/profile`; optional editor on memory page |

The page reuses shell, dashboard width/card rhythm, shared forms/buttons, Snackbar, date and
unit formatters and the existing DatePicker in admin preview. `memoryOverview`
projects `buildContext`'s bounded cycle-purpose selection in a read transaction;
it does not create an independent registry or send a model request. Source links
remain regular keyboard-accessible links. Each item shows source and relevant
date/period, plus update time where the canonical source supplies it. Session
rows have no separate update timestamp; do not fabricate one. Missing values and
empty states link to existing workflows. Actual execution selection varies by
task/budget; this overview is not a guarantee that every displayed record is sent.

### Memory presentation on the PR #67 branch

Integrated in main through PR #67. The page uses the dashboard's
1,080px content width, theme tokens and card spacing, with existing shared
controls and native keyboard-accessible disclosures. No new visual library,
profile fields, storage or paid summaries are introduced.

- The compact header holds the title and context date; context loads on opening.
  There is no permanent refresh action. A failed memory load exposes “Try again”
  beside its error, hidden after success. Experience conflicts instead expose
  “Reload saved version” beside the conflict, retaining typed experience. Other
  save/preview errors do not expose a memory-load retry. Recovery restores focus
  to the page heading or experience input only if the user has not moved it.
  “How your context is assembled” expands source, temporal and phase explanations;
  selection omissions
  remain visible independently of that disclosure.
- Goals and weekly availability sit side by side on desktop and stack on narrow
  screens. Goals include the canonical cycle status (never inferred from its
  target date). Availability uses a semantic Day / Period / Maximum / Location
  table ordered by the account's preferred week start. Unconfigured days are not
  invented. Equal source timestamps appear once; differing timestamps stay with
  their rows. The warm-up/cool-down explanation appears once.
- Sessions group date/title/completion, metrics and dated reports. RPE,
  discomfort and other feedback stay visible. Only long planned workout details
  expand on demand; disclosure state and focused source/disclosure identity
  survive language/preference rerenders and refresh. A refresh never takes focus
  away from a control deliberately focused while the request was pending.
- Older reference sessions identify their existing overlap with weekly totals;
  they must not be added again. Totals have labeled table columns, an explicit
  missing-result count, and unknown average RPE when absent. Table regions can
  be focused and scrolled by keyboard on narrow screens. Empty sections show
  their period (where defined) and a specific source action without tall filler.
- Prior experience remains the only optional inline editor, preserving optimistic
  versions, conflicts and input typed during requests. Administrator debug is a
  separate collapsed disclosure, absent from ordinary users' DOM. Opening it
  exposes only the existing own-data free preview/execution controls.

The readable `GET /api/ai/memory` projection additionally returns canonical
`cycle.status` and boolean session `includedInAggregates` (true only for references
already in aggregate totals). These are presentation metadata from the existing
context, not a second computation or new snapshot policy. Context v3, prompt
bytes, immutable snapshots, execution controls and ownership remain unchanged.

### Compatibility with the first PR #67 implementation

A read-only inspection of the configured local `data/database.sqlite` on
2026-10-15 found `ai_profiles`, `ai_memory`, `ai_executions` present and **zero
rows in each**. No real rows were changed or used as fixtures. Other installations
may have data, so schema and records are retained; no destructive migration is
needed. Reinitialization remains idempotent and is tested with existing records.

- Earlier goals/preferences/limitations and **all** generic `ai_memory` entries
  are inactive archives, not active source material. They never influence new
  contexts, including rows labeled interpretation or recommendation.
- The normal memory response contains only optional experience and the canonical
  view. A notice and owner-only JSON download (`GET /api/ai/memory/legacy`) make
  existing archived records accessible with their original dates/provenance.
  There is no generic create/update/delete contract; old mutation URLs return 404.
- Experience writes retain archived keys and metadata. No old goal is copied to
  a cycle, and no old note becomes a fact/current restriction. Archives remain
  until account deletion; ordinary execution retention does not erase them.
- Since policy `training-context-v2`, these fields are excluded; current policy v3
  also changes recent-context priority and invalidates v1/v2 execution freshness. Saved execution snapshots
  (including v1 inputs) remain exactly as used and inspectable in own admin debug;
  freshness checks identify prior-policy results as outdated. Queued old work
  fails source revalidation without dispatch; in-flight results cannot be applied
  against changed context. There is no hidden regeneration or paid refresh.

User reports, recorded canonical facts, planning records, derived aggregates,
AI interpretations, recommendations and reported actions have distinct authority
labels. The retained archive schema is not a new interpretation editor or active lifecycle.
Later interpretation producers must define evidence, disposition and supersession
with confirm/correct/dismiss actions; historical responses must never resurrect
a discarded/corrected interpretation. Public writes cannot impersonate AI. Existing completion and
canonical result metrics supply observed outcomes. Recommendations never become
performed facts by inclusion in a subsequent context. No recursive summarization
or embeddings are introduced.

### Effective selection policy: training-context-v3

The same deterministic service serves cycle, workouts and analysis; the memory
page projects its cycle-purpose selection. Default limits remain unchanged:
14 detailed days, older disjoint aggregates within 12 weeks, up to three older
comparables and saved future sessions within the next detail-window span.
Historical queries remain bounded. Unknown values are not zero-valued workouts,
rest days, diagnoses or evidence of recovery.

1. Preserve supplied experience, current cycle and the requested owned resource.
   The requested session is the sole detailed copy: it is excluded from recent,
   upcoming and comparable lists. Its full content is mandatory.
2. Preserve **all** recent explicit discomfort reports (`feedback_has_pain=yes`
   or a nonblank saved discomfort description) and recorded RPE 4/5. These
   sessions start with compact planning but retain their complete report,
   canonical metrics, source/version and dates. This rank is a selection rule,
   not a clinical interpretation or a permanent restriction. Contradictory or
   missing reports remain as recorded; no state is inferred from silence.
3. For workouts, preserve all configured weekly availability as essential task
   data. Missing days remain explicit gaps; this never invents availability.
   If mandatory material does not fit, return 413 `criticalContextTooLarge`.
4. Give remaining recent sessions a chance **in compact form before planning
   prose**: discomfort first, then valid reported RPE descending, then date
   descending and numeric ID descending. Missing/invalid RPE ranks last without
   changing its stored value. Preserve complete reports or record omission of
   the whole optional session. For cycle/analysis, availability is optional next.
5. With spare budget, restore recent planning prose in that same order. Then
   select weekly aggregates, purpose-specific comparables, future sessions and
   shoes. Future sessions try full detail, then compact planning, then an
   explicit whole-record omission. Planning reduction removes only `detalhes`,
   `observacoes` and `previsao`; report text is never clipped to fit.

Every selected source retains its content hash, even when its planning prose
is omitted. Reductions and exclusions are recorded in `omissions`, bounded to
a count and examples for large sets; a nonempty omission list also marks the
ordinary overview as selection-limited. Optional additions reserve 1,024 bytes
for final metadata. The final serialized snapshot, including provenance,
omissions, gaps and SHA-256 hash, must fit `AI_CONTEXT_TOKENS` (a conservative
UTF-8 byte bound); otherwise return 413 `contextTooLarge`. Nothing oversized or
silently truncated is sent. Increasing the default was not the solution.

Aggregates are calculated locally from canonical completed-session metrics,
with missing-result counts and no overlap with detailed recent dates. Requested
and comparable sessions that also occur in aggregates carry
`includedInAggregates`: they are references, never extra totals. Each source is
listed once globally. Weekly comparable lookup checks type **and workout name**
for long-run labels; analysis uses saved type and cycle uses recency. The
execution additionally versions every preserved-prompt dependency, including
sources omitted from the model context. No applied AI plan is fabricated for
an old cycle.

Policy v1/v2 snapshots remain byte-for-byte historical inputs. The v3 freshness
check marks them outdated and refuses dispatch of old-policy queued work without
automatic paid regeneration. No source row or historical snapshot is rewritten.

### Context extension: training-context-v5

The issue #63 branch retains the priority/budget rules above. It additionally
selects at most three previous non-active cycles for cycle generation, after
recent reports and availability, before optional planning detail.

For subsequent tasks, only the current applied plan's identity, dates, version,
source hash and freshness flag are mandatory. After all recent compact reports
and availability have had their turn, select optional planning in this order:
macro architecture entries (name/dates/objective), relevant near-term phases,
indicators, adaptation rules as a whole, and uncertainties. Array entries retain
their saved order; each entry or rules object is included whole or explicitly
omitted through the same budget path as optional session data. This precedes
restoration of recent planning prose. An omitted rules object is `null`; omitted
array entries are absent. No report is clipped to accommodate planning.

Optional selection reserves 1,024 bytes for final metadata and includes the
already-retained plan source reference in the bound. `omissions` identifies the
field (`architecture`, `phases`, `indicators`, `adaptations`, `uncertainties`), plan
ID and `context_budget`; the existing bounded count/examples policy applies.
Phase details outside the task window retain their separate omission reason.
Insufficient mandatory material still returns 413; optional plan prose alone
must not cause that refusal. See [cycle continuity](ai-cycle-planning.md#continuity-and-interpretation-boundary).

Plan-local assessments are excluded. v1/v2/v3/v4 execution snapshots remain
immutable and are marked outdated under v5, without automatic paid regeneration.
This corrects v4's unconditional inclusion of applied planning details. No
weekly/analysis product adapter is registered.

### Applied-planning RPE compatibility on the issue #63 branch

The cycle adapter now uses `cycle-delivery-v3`, declaring RPE 1–5, with a shared
bounded text guard. The schema, model, medium reasoning, v5 selection policy and
external prompt versions remain unchanged. See the [exact compatibility
contract](ai-cycle-planning.md#rpe-compatibility-cycle-delivery-v3).

Owner planning reads return the stable `compatibilityError:planningRpeIncompatible`
only on affected proposals/applied plans; no raw validation path is added to
ordinary payloads. New output refusal uses that product code and an admin-only
`rpe_scale` diagnostic/path, with known usage preserved and no retry.

Affected saved guidance is excluded as a whole from future `workouts`/`analysis`
contexts; plan identity/version/dates/provenance remain, with `compatibilityError`,
an explicit gap and omission reason `incompatible_rpe_scale`. No incompatible
phase, indicator or adaptation text is recycled as valid guidance. This is a
compatibility check, independent of `outdated`; compatible plans and their context
hashes are not globally invalidated. Only contexts actually changed by exclusion
receive different hashes. Historical snapshots and applied JSON are untouched;
consulting/checking compatibility is free. A new reviewed proposal must be applied
explicitly to replace a version. No schema migration or data rewrite is needed.

### Explicit module boundary

`src/public/shared/package.json` declares `"type":"module"` for the existing
shared frontend ES modules, including the reusable weekly/analysis generators
and their transitive `date.js`, `units.js` and `i18n.js` imports. The CommonJS
backend loads these synchronous ES modules through Node 24's `require(esm)`;
shared code must remain safe to import without browser globals or top-level
await. Browsers keep the same URLs and module imports; prompt text is unchanged.

The root package and backend remain CommonJS. The narrower shared scope leaves
`src/public/form-state.js`'s legacy CommonJS/UMD consumers intact, while existing
backend/test `require` and browser `import` consumers use the same utilities.
No warning suppression, duplicate prompt, dependency or module migration is
introduced. The existing Dockerfile's `COPY src ./src` includes the scoped
manifest automatically; no Dockerfile, Compose or deployment change is needed.

Experience remains editable; inactive archived records remain until account
deletion. Terminal execution payloads, context, results and usage expire after
90 days by default. Cleanup runs at startup and authenticated AI API access;
it is opportunistic, not an exact wall-clock deletion guarantee. Queued/running
work is not removed by terminal cleanup. Account deletion cascades all owned AI
records. A daily anonymous global consumption ledger has no account reference
or training content and remains until retention cleanup, preventing deletion
from silently refunding the deployment's global allowance. Host backups have
their own operator retention and must be protected accordingly.

The original external prompt is stored separately from the exact adapted API
payload, so protected debug can compare both. Payload/debug snapshots are
private SQLite data, not generic logs.
Ordinary users never receive an execution's debug payload, usage/cost, model configuration
or external prompt through the new APIs. Administrators can inspect **only
their own** snapshots and generate/copy existing external prompts for free.
Existing manual prompt workflows remain available to all users until their
individual replacement phases. Model responses render as text/data, never HTML.

Phase 0 introduced no paid adapters. The issue #63 branch registers only cycle
planning; enabling AI alone sends no athlete context to OpenAI. Explicit cycle
generation sends
only selected structured context and the rendered prompt. They must version
permitted delivery changes and validate the complete domain result. FIT/ZIP
binaries, raw GPS tracks, account email/name, session tokens and API credentials
are not selected. Free text can contain personal information entered by its
owner and belongs to the protected context, not to search queries or logs.
`store:false` disables Responses application-state storage; it does not promise
zero provider retention or disable abuse monitoring. Consult the current
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

## API and service contract

All routes require a current active session and operate on its owner. API inputs
are allowlisted, with no `user_id`, arbitrary model or arbitrary prompt option.

| Method/path | Contract |
| --- | --- |
| `GET /api/ai/memory` | Readable owner overview: `asOf`, `profile`, `cycle`, `availability`, `recent`, `upcoming`, `weekly`, `comparables`, `ranges`, `selectionLimited`, `legacyAvailable`; no technical payload/hash |
| `PUT /api/ai/profile` | `{fields:{experience?},expected_version}`; strings <=2000 chars |
| `GET /api/ai/memory/legacy` | Owner-only read-only archive `{fields,entries}`; excluded from new contexts |
| `GET /api/ai/context?purpose=...&resource_id=...&as_of=...` | Administrator's own technical context only; ordinary users receive 403 and use the overview |
| `POST /api/ai/executions` | `{purpose,resource_id?,target_date?,idempotency_key}` -> 202 and ID/state; purposes cycle/workouts/analysis; cycle adapter on issue #63 branch; workouts/analysis unregistered |
| `GET /api/ai/executions` | Latest 50 owned execution identifiers/states |
| `GET /api/ai/executions/:id` | Owned state, validated product response and outdated flag |
| `POST /api/ai/executions/:id/cancel` | Empty object; local cancellation, never a promise of no provider cost |
| `POST /api/ai/admin/preview` | Admin-owned `{purpose,resource_id?,target_date?}` -> prompt/context/version; free and nonpersistent |
| `GET /api/ai/admin/executions/:id` | Admin-owned exact payload/context/configuration/usage/error |
| `GET /api/ai/admin/usage` | Admin-owned usage and sanitized configuration availability |

States: queued, running, completed, failed, uncertain, cancelled, outdated.
Missing/disabled key -> 503 `aiUnavailable`; unregistered feature -> 409
`phaseNotAvailable`; quotas/concurrency -> 429; owner/role -> 401/403;
missing/unowned resource -> 404; stale memory/idempotency -> 409; excessive
required context -> 413. Provider errors have stable sanitized codes.

`createExecutionService` is reused by the next phases through a trusted
server-side registry of purpose adapters (version, explicit `adaptPrompt` transformation, output
instructions, schema and context-aware validator). Trusted adapters may provide
synchronous `prepare`, `onEnqueued`, `onCompleted` and `cleanup` hooks. Enqueue
and completion hooks share the existing atomic write transactions; none may
perform network I/O. Cleanup preserves accepted product artifacts while removing
expired unapplied proposals. HTTP cannot register adapters. Phase 0 originally registered no product adapter; issue #63 adds only cycle planning: append-only JSON instructions are not a substitute
for adapting conflicting Excel/weather delivery instructions in later phases.
The cycle application contract is in [cycle planning](ai-cycle-planning.md);
calendar/result application remains future scope.

An execution reserves per-user/global tokens, cost and maximum attempts inside
one immediate transaction, then dispatches outside any database transaction.
A local idempotency key returns the original execution even after reload;
changing its request parameters returns 409. Cancellation cannot free a running
reservation while the call remains unresolved. Known refusals, incomplete output,
invalid JSON and invalid domain responses are terminal and never applied.
Only explicit 429 responses may retry (bounded by AI_RETRIES). Retry eligibility
and requeue/settlement use one immediate transaction, so a concurrent local
cancellation cannot strand an unsettled reservation or concurrency slot. Network failure,
timeout, malformed transport output or server 5xx is uncertain and never
replayed automatically. On restart, persisted running work becomes uncertain;
queued work can resume after account, source and adapter checks, respecting
both current per-user and global concurrency limits. Reservations
from a previous UTC day expire without dispatch rather than bypassing today's
allowance; disabled configuration also refuses dispatch. Ownership,
activity and source versions (including prompt-only dependencies) are
rechecked atomically with the queued-to-running claim and final result write; deleted or changed data is never recreated or applied. Later phases
must also revalidate and apply atomically/idempotently at their own domain boundary.

## Validation and evaluation

`test/fixtures/ai/prompt-baseline.json` contains synthetic outputs captured from
main `addd967` before extraction: 12 PT/EN × km/mi × missing/manual/FIT variants,
covering weekly, macrocycle, frontend analysis and backend Markdown variants.
`test/aiFoundation.test.js` compares their output byte for byte; existing prompt
and browser suites remain active. Browser checks cover PT/EN, desktop/mobile,
admin DatePicker, conflict errors, keyboard focus, ownership and established shoe-form
computed styles. Screenshots are transient `/tmp` artifacts, never fixtures.

Context evaluation scenarios and the quality rubric are in
`test/fixtures/ai/context-evaluation.json`. The runtime environment had no `OPENAI_API_KEY`; no real model call or paid
evaluation was performed. Mock-based tests check contracts and
failure behavior, not model quality. Real evaluation must explicitly record the
model, configuration, rubric outcome, token usage, estimated/actual cost and
limitations. No paid evaluation runs in CI. Phase 0 does not claim measured
coaching quality or project-level access to a model from mocked success.

Official references checked at implementation:
[Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[model](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[pricing](https://developers.openai.com/api/docs/pricing),
[data controls](https://developers.openai.com/api/docs/guides/your-data).

## Validation status of this correction

The earlier review fixes remain in place: atomic dispatch/completion/cancellation,
restart concurrency, complete prompt dependency versions and DatePicker month
focus. Generic observation CRUD tests have been replaced with archive exclusion
and canonical-source tests because that editor is removed by approved scope.
The corrected branch passed these local gates on 2026-10-15:

- `npm test`: **1,176 passed**, zero failures/skips.
- `npm run test:coverage`: **1,176 passed**, **100% Statements, Branches,
  Functions and Lines** in the required backend/script scope. This is not a
  claim of frontend instrumentation coverage or model quality.
- 48 byte-identical external prompt comparisons against the unchanged baseline.
- `aiMemoryOverview.test.js`: canonical-source corrections, empty states,
  archive exclusion/preservation, idempotent initialization with existing data,
  account ownership/activity, immutable persisted v1 snapshots and refusal to
  dispatch old-policy queued work. HTTP tests update sources through existing
  cycle, availability and feedback endpoints and assert no provider call.
- Real Chrome: PT/EN, 1280/390px, regular/admin × empty/history; failed-load retry,
  pending reload and deliberate focus change, experience conflict/reload/resave,
  source links and language-change focus identity, dated yes/no discomfort,
  admin preview and DatePicker Previous/Next/Escape. Input/button computed styles
  match the established Shoes form. Transient screenshots were visually inspected
  outside Git. The test blocks external font/icon CDNs; this is a local UI check.
- `docker compose config --quiet` and `git diff --check` passed.

No `OPENAI_API_KEY` was present; no paid evaluation, deployment or image build
was performed. Mock providers validate failure/accounting contracts only.
Configuration, `.env.example`, Compose wiring, ports, volume and container user
are unchanged by this scope correction. Version stays beta 0.20.0 for the same
open PR. These are local results, separate from GitHub checks and owner review.

### Local validation

1. Use a development database (never production for validation), install existing
   dependencies, optionally copy `.env.example`, and run `npm start`. No API key
   is needed for memory or free admin preview.
2. Open the account menu → Training memory. With an empty account, follow the
   cycle/availability/calendar links; leave experience blank if desired.
3. Change an active cycle goal, save availability in Request Workouts, and edit
   a dated session feedback. Return/reload memory: the selected canonical
   information changes without another profile edit. Unknowns stay unknown.
4. Save prior experience, then edit it in two tabs to exercise 409/reload with
   retained input. A common account sees no technical debug; an admin sees only
   its own free preview/executions after expanding the administrator disclosure.
   Existing archived data has a download notice,
   not active editor controls or hidden influence on future context.
5. Run `node --test test/aiFoundation.test.js test/aiFoundation.routes.test.js
   test/aiMemoryOverview.test.js test/aiFoundation.browser.test.js`, then the full
   gates above. A local Chrome/Chromium executable is required for browser tests.
6. Check PT/EN at desktop/mobile widths, switch the preferred week start, and
   expand planning with Space. Dated RPE/discomfort must stay visible while
   planning is collapsed. Focus the weekly table and use the arrow keys to
   inspect overflowing columns; language changes must preserve its focus.

The complete diff against updated main was critiqued for contracts, authorization,
transactions, failure/restart/cancellation paths, bounded selection, preservation,
accessibility, prompt compatibility, documentation and tests. Coordinated fixes
include explicit context-policy freshness, canonical yes/no report rendering,
source-link focus identity and preserving edits during experience conflicts.
Phases 1–3 and evidence/disposition-based AI interpretations remain planned;
phase 0 was subsequently integrated through merged PR #67; the issue #63
branch is a separate, not-yet-merged phase.


### Consolidated P2 correction after review of 056d18f

Both findings were reproduced with failing regressions before correction:

- Weekly comparable lookup now checks the workout name (`treino`) as well as
  the training type (`tipo`), preserving ownership, completed-only selection,
  historical date bounds, ordering and the three-record limit. Imported
  `Corrida` / `Longão` and `Run` / `Long run` rows are covered alongside the
  legacy type-based representation and excluded private/incomplete/recent rows.
- The 429 retry state read and requeue-or-settlement decision now share one
  immediate transaction. A second SQLite connection either cancels before
  that transaction (settled without retry), or waits until the queued retry can
  be cancelled and settled. No network call holds this transaction. The
  regression checks cancelled state, settlement, empty response, released
  user/global tokens and cost, recorded attempt count, and a new reservation
  without restarting. Unknown provider outcomes retain their existing policy.

Final local gates for this corrective batch: `npm test` and
`npm run test:coverage` each passed **1,178 tests**, zero failures/skips; all four
required coverage metrics are **100%**. The full suite includes the existing
real-Chrome checks and all 48 exact prompt comparisons. `git diff --check`
passed. No UI, schema, runtime configuration, version or product-phase change
was introduced; no paid model evaluation was performed. Earlier 1,176-test
results above describe the preceding scope correction. This phase 0 batch was subsequently integrated through PR #67. No new automatic review is
requested for this localized correction of the already reviewed contracts.

### Priority and module-boundary correction after 81420d5

Reproduction on Node **24.18.0**, before changes: the default 12,000-byte policy
selected **six upcoming sessions and zero recent sessions** from the supplied
seven-session/340-character scenario; the dated discomfort/RPE 5 report was
missing. The new regression failed on that result. With v3 it selects **one
recent and six upcoming sessions**, preserving the whole report, reducing one
future session's planning prose and explicitly omitting another. The final
snapshot is **11,038 bytes**, including provenance, omissions and hash; the
configured limit is unchanged. Additional regressions cover an oversubscribed
recent list, all three purposes, full requested resources, essential availability,
explicit 413s, no-pain/missing reports, deterministic ranking, aggregate references
and immutable persisted v1/v2 snapshots.

`--trace-warnings` reproduced MODULE_TYPELESS_PACKAGE_JSON in both real `npm run
dev` and `npm start` before correction. `--trace-require-module=all` located the
CommonJS chain `server → routes → executions → prompt-service → shared prompt
generators`, whose transitive date/units/i18n files lacked explicit module type.
The scoped shared manifest removes the cause. A subprocess regression imports
the CommonJS server, shared generators and date utility, verifies legacy
`form-state.js` remains CommonJS-compatible, and checks that stderr has no
MODULE_TYPELESS_PACKAGE_JSON. It does not suppress or filter application warnings.

Final local validation for this batch:

- `npm test`: **1,190 passed**, zero failures/skips.
- `npm run test:coverage`: **1,190 passed**, zero failures/skips;
  **100% Statements, Branches, Functions and Lines** in the required scope.
- All **48** deterministic external PT/EN prompt comparisons remain exact.
- Chrome memory/free preview PT/EN desktop/mobile passed, as did the existing
  Request Workouts browser test. One initial coverage run timed out waiting for
  its availability grid; that test passed in isolation and the complete coverage
  gate was rerun successfully without weakening or changing the test.
- Real `npm run dev` and `npm start` with temporary SQLite databases on Node
  24.18.0 reached `/api/version` (200) with `--trace-warnings` and no typeless
  warning. Neither full final suite emitted that warning.
- The unchanged Dockerfile built successfully. An isolated container with no
  external network or published port, ephemeral `/app/data`, Node **24.22.0**,
  and UID **1000** started `npm start` without that warning and returned version
  0.20.0 (HTTP 200). The scoped manifest was present in `/app/src/public/shared`.
  The container was stopped/removed; no production deployment or real database
  was touched. No image, Dockerfile, Compose or CI configuration change is needed.
- `git diff --check` passed. Existing main was already included in the PR branch;
  no destructive reset, force push or further version increment was used.

The complete diff against main and the corrective batch were reviewed for source
priority, budget/omission metadata, deduplication, module consumers, authorization,
transactions, cancellation, quotas, focus/conflicts and prompt equivalence.
These are deterministic/software validations, not coaching-quality evaluation.
No paid OpenAI request was required or performed for this phase 0 batch,
subsequently integrated through PR #67. Cycle generation is now implemented
separately on the issue #63 branch.

### UI/UX consolidation validation

For the presentation revision on this branch, both final `npm test` and
`npm run test:coverage` passed **1,190 tests**, zero failures/skips; the required
backend scope retains **100% Statements, Branches, Functions and Lines**. The
48 byte-for-byte external prompt comparisons remain exact. `git diff --check`
passed. Real Chrome covers PT/EN, desktop/mobile, ordinary/admin, empty/history,
loading/errors/refresh, optimistic conflicts, input/focus preservation, preferred
week ordering, differing source dates, legacy periods, Space disclosures, table
keyboard scrolling, DatePicker and protected free preview. Frontend behavior is
verified by browser tests, not by the backend coverage percentage.

Read-only inspection with the authorized local login, compared with the Home
screen, measured the observed memory page at **2,222px** of scrollable content
versus **3,265px** before, at the same **1440×1000** viewport (about 32% less).
Temporary private screenshots and credentials are excluded from the repository;
automated browser fixtures are synthetic. No paid call/model-quality evaluation,
schema migration, context-policy change, infrastructure change or version bump
was needed. The complete diff against main and the UI batch were critiqued for
contracts, ownership, compatibility, focus, responsive tables, missing data and
regressions. This phase 0 UI was subsequently integrated through merged PR #67.
