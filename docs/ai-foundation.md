# AI foundation (phase 0, issue #62)

Status: implemented on `feat/ai-phase-0-foundation` ([open PR #67](https://github.com/fracon/training-assistant/pull/67)),
validated locally and pending owner review; **not integrated into main**. Main includes the approved documentation
plan and owner scope correction (#66/#68). Cycle, weekly-workout and analysis generation remain planned in
#63–#65. This foundation does not enable those paid product operations.

## Configuration and deployment

The existing application and prompt workflows work without an API key. Personal
memory and free administrator preview work with AI disabled. Copy `.env.example`
for local development. On ZimaOS put the variables in the `.env` beside Compose
and recreate the container with `docker compose up -d`. Keep that file private.
Compose passes the key at runtime; the Dockerfile does not contain it, and
`.dockerignore` excludes `.env*`. Ports remain `8081:3000`, the persistent volume
remains `./data:/app/data`, and the container continues to use the `node` user.

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

The page reuses shell, shoe-card layout, shared forms/buttons, Snackbar, date and
unit formatters and the existing DatePicker in admin preview. `memoryOverview`
projects `buildContext`'s bounded cycle-purpose selection in a read transaction;
it does not create an independent registry or send a model request. Source links
remain regular keyboard-accessible links. Each item shows source and relevant
date/period, plus update time where the canonical source supplies it. Session
rows have no separate update timestamp; do not fabricate one. Missing values and
empty states link to existing workflows. Actual execution selection varies by
task/budget; this overview is not a guarantee that every displayed record is sent.

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
- Policy `training-context-v2` excludes these fields. Saved execution snapshots
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

Context policy `training-context-v2` selects optional supplied experience,
the active cycle and a requested owned resource first; it refuses
an insufficient budget for that mandatory material. Weekly
availability, already scheduled upcoming sessions, recent sessions, aggregates,
comparable sessions and shoes are
selected deterministically. The recent and aggregate periods are disjoint:
14 detailed days and the older part of a 12-week window by default. Saved
upcoming workouts in the next detail-window span are included as planning
records, with no inferred execution. Weekly
aggregates use saved kilometres, duration and completion; unknown values remain
explicit gaps. They are not inferred as zero-valued workouts or rest days.
The ordinary history query is limited to the configured date window. A separate
query retrieves at most three older completed comparable sessions, selected by saved training
type for analysis, long-run labels in either `tipo` or `treino` for weekly
context (including imported `tipo=Corrida`, `treino=Longão`), or recency for cycle context.
Comparable records state whether they also belong to an aggregate, so their
metrics must never be added again. The execution also records versions of every preserved-prompt dependency,
including records omitted from detailed model context. Source IDs/content
hashes, ranges, selection
reasons, missing data and budget/cutoff omissions are included. There is no
fabricated applied AI plan for an old cycle.

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

Phase 0's production registry has no paid operation adapters, so enabling AI
alone sends no athlete context to OpenAI. Future registered adapters may send
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
| `POST /api/ai/executions` | `{purpose,resource_id?,target_date?,idempotency_key}` -> 202 and ID/state; purposes cycle/workouts/analysis; no registered production operations in phase 0 |
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
instructions, schema and validator). HTTP cannot register adapters. The adapter is deliberately absent
from production in phase 0: append-only JSON instructions are not a substitute
for adapting conflicting Excel/weather delivery instructions in later phases.
No cycle/calendar/result application API is introduced now.

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
   its own free preview/executions. Existing archived data has a download notice,
   not active editor controls or hidden influence on future context.
5. Run `node --test test/aiFoundation.test.js test/aiFoundation.routes.test.js
   test/aiMemoryOverview.test.js test/aiFoundation.browser.test.js`, then the full
   gates above. A local Chrome/Chromium executable is required for browser tests.

The complete diff against updated main was critiqued for contracts, authorization,
transactions, failure/restart/cancellation paths, bounded selection, preservation,
accessibility, prompt compatibility, documentation and tests. Coordinated fixes
include explicit context-policy freshness, canonical yes/no report rendering,
source-link focus identity and preserving edits during experience conflicts.
Phases 1–3 and evidence/disposition-based AI interpretations remain planned;
phase 0 is implemented in this branch and **not integrated into main**.


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
results above describe the preceding scope correction. This remains an open
PR implementation, not integrated into main. No new automatic review is
requested for this localized correction of the already reviewed contracts.
