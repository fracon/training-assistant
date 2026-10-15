# AI foundation (phase 0, issue #62)

Status: implemented on `feat/ai-phase-0-foundation`, validated locally and pending PR
review; **not integrated into main**. Main includes the approved documentation
plan (#66). Cycle, weekly-workout and analysis generation remain planned in
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

Invalid settings disable paid AI rather than breaking the rest of the app.
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

The account menu links to `/training-memory.html`. Owners can edit experience,
goals, preferences and reported limitations, and create/correct/delete dated
restrictions, milestones, interruptions and reported performed actions. Version
checks refuse concurrent overwrites with 409. Reloading the saved version keeps
unsaved input for review. Restriction states are explicit: current, resolved or
unconfirmed. Age and absent symptom feedback never change the saved state.

User reports, recorded canonical facts, planning records, derived aggregates,
AI interpretations, recommendations and reported actions have distinct authority
labels. The schema reserves interpretation/recommendation entries for trusted
future operations; public writes cannot impersonate AI. Existing completion and
canonical result metrics supply observed outcomes. Recommendations never become
performed facts by inclusion in a subsequent context. No recursive summarization
or embeddings are introduced.

Context policy `training-context-v1` selects mandatory profile, current
restrictions, the active cycle and a requested owned resource first; it refuses
an insufficient budget for that mandatory material. Other dated events, weekly
availability, already scheduled upcoming sessions, recent sessions, aggregates,
comparable sessions and shoes are
selected deterministically. The recent and aggregate periods are disjoint:
14 detailed days and the older part of a 12-week window by default. Saved
upcoming workouts in the next detail-window span are included as planning
records, with no inferred execution. Weekly
aggregates use saved kilometres, duration and completion; unknown values remain
explicit gaps. They are not inferred as zero-valued workouts or rest days.
Up to three older completed comparable sessions are selected by saved training
type for analysis, long-run type for weekly context, or recency for cycle context.
Comparable records state whether they also belong to an aggregate, so their
metrics must never be added again. Source IDs/content hashes, ranges, selection
reasons, missing data and budget/cutoff omissions are included. There is no
fabricated applied AI plan for an old cycle.

Profiles/observations remain until the owner corrects/deletes them or deletes
the account. Terminal execution payloads, context, results and usage expire after
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
| `GET /api/ai/memory` | `{profile:{fields,version,updatedAt},entries}` |
| `PUT /api/ai/profile` | `{fields:{experience?,goals?,preferences?,restrictions?},expected_version}`; strings <=2000 chars |
| `POST /api/ai/memory` | `{kind,text,observed_on,state,expected_version:0}` |
| `PUT /api/ai/memory/:id` | Same fields, positive `expected_version`; owned entry only |
| `DELETE /api/ai/memory/:id` | 204, or 404 for an absent/unowned entry |
| `GET /api/ai/context?purpose=...&resource_id=...&as_of=...` | Owner's selected structured memory; never an execution payload/prompt |
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
Only explicit 429 responses may retry (bounded by AI_RETRIES). Network failure,
timeout, malformed transport output or server 5xx is uncertain and never
replayed automatically. On restart, persisted running work becomes uncertain;
queued work can resume after account, source and adapter checks. Reservations
from a previous UTC day expire without dispatch rather than bypassing today's
allowance; disabled configuration also refuses dispatch. Ownership,
activity and selected source versions are rechecked before dispatch and after
completion; deleted or changed data is never recreated or applied. Later phases
must also revalidate and apply atomically/idempotently at their own domain boundary.

## Validation and evaluation

`test/fixtures/ai/prompt-baseline.json` contains synthetic outputs captured from
main `addd967` before extraction: 12 PT/EN × km/mi × missing/manual/FIT variants,
covering weekly, macrocycle, frontend analysis and backend Markdown variants.
`test/aiFoundation.test.js` compares their output byte for byte; existing prompt
and browser suites remain active. Browser checks cover PT/EN, desktop/mobile,
DatePicker, grouped errors, keyboard focus, ownership and established shoe-form
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

## Local delivery evidence (2026-10-15)

- `npm test`: 1,162 tests passed before the final focused refinements.
- Final `npm run test:coverage` (which runs `npm test`): 1,166 passed, zero
  failures/skips; Statements, Branches, Functions and Lines all 100% in the
  repository's required instrumentation scope.
- 48 byte-identical prompt comparisons across the 12 captured synthetic cases.
- Real Chrome PT/EN at 1280px and 390px: saved profile/observations, failed-load
  recovery with preserved input, conflicts, DatePicker keyboard/Escape/focus,
  reduced motion, absent regular-user debug, and comparison with shoe-form
  computed styles. Screenshots were inspected locally in `/tmp`.
- `docker compose config --quiet` and `git diff --check` passed. Dockerfile,
  image build instructions, deployment ports/user/volume and CI are unchanged;
  no image rebuild or production deployment was performed.
- No OpenAI key was configured, no paid request was made, and no real model
  quality/project-access claim is inferred from mocks.

The complete diff was critiqued against main before publication. Corrections
covered original/adapted prompt separation, FIT-lap and shoe-label source
versions without GPS transmission, upcoming planning, admin-only usage/cost,
expired reservations, conservative unknown usage and keyboard/input preservation.
GitHub checks and Codex review are separate from these local results; integration
into main still requires an owner-approved merge.
