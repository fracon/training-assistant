# Contextual workout analysis (issue #65)

Status: implemented in the dedicated issue #65 branch, pending its PR merge.
The preceding phases are integrated through #67, #69 and #70. This is a focused
analysis of one already recorded workout in the existing Training Result page;
it is not a chatbot, medical assessment, automatic training change, or required
step for saving a result.

## User flow

Saving a manual/FIT result and its feedback follows the existing transactional
result APIs. It never starts AI. Once the canonical saved row has been reread,
the person can explicitly select **Analyze workout / Analisar treino**. This
requires a completed owned result with reported Kinesis RPE 1–5. It does not
require a cycle, an applied cycle plan, or FIT provenance. If persistence fails,
no analysis execution is requested. Later AI failure does not undo the recorded
result, feedback, calendar entry, or shoe mileage.

The page uses the existing persisted `ai_executions`, client, worker, reservation,
quotas, retries, cancellation/recovery and protected diagnostics. The
`workout-analysis-v2` delivery adapter and strict `workout-analysis-v1`
response schema validate the response
before it is stored. It distinguishes planned values, recorded facts, user
reports, prior interpretations, evidence, recommendations and limitations.
RPE is the explicit 1–5 scale; observed heart rate is never converted into a
prescribed zone. FIT laps, when available, are bounded and copied from the
persisted summary. No unsupported metrics, history, causality, recovery, race,
or permanent restriction is inferred.

An active execution is recovered on reload and polled until a terminal backend
state. Reads are serialized, transient read errors use bounded jittered backoff,
returning to the tab triggers a read, and stale responses are ignored. A read or
reload never creates another execution. An uncertain start is reconciled with
its idempotency key before another explicit action. No arbitrary frontend poll
count or elapsed-time limit declares a running execution failed.

The page presents the latest validated analysis automatically without moving
focus. Analysis history remains owner-scoped and indicates source freshness.
A failed newer analysis does not erase the previous accepted analysis. Opening
an old analysis does not restore interpretations that have been dismissed or
superseded.

## API and authorization

- `GET /api/trainings/:id/analyses` returns only the authenticated owner's
  analyses for that training, current freshness, presentation text, and the
  persisted interpretation states. Interpretation reads and all three mutation
  responses use the same explicit projection (`id`, `kind`, `text`,
  `disposition`, nullable `correction`, `version`, and `updatedAt`). They never
  spread database rows or expose evidence JSON, hashes, or internal references.
  A terminal analysis version may include one allowlisted public `errorCode`;
  provider messages, validation paths and execution diagnostics remain in the
  owner-scoped admin debug response. Missing or foreign sessions return 404.
- `POST /api/ai/executions` with `purpose: analysis`, the session ID as
  `resource_id`, and an idempotency key creates/reuses the standard execution.
  A second active execution for the same owner and training reuses the existing
  one.
- `GET /api/ai/executions/:id` is a free read and never exposes the raw analysis
  response through the generic execution endpoint. Protected administrator
  debug remains separately owner-scoped.
- `POST /api/ai/interpretations/:id/{confirm,correct,discard}` applies an
  optimistic `expected_version`. Correction accepts bounded user text. Discarded
  and superseded items cannot be revived by an old analysis. `confirm` is only
  valid from `pending`; correcting a `corrected` item cannot be undone by
  confirming its original model text. Corrections remain the authoritative
  future-context text. Version conflicts and invalid transitions return 409.
  These actions are local writes and do not call a provider.
- `POST /api/ai/admin/preview` can return the external analysis prompt only to
  an administrator whose current database role is `admin`, for a training the
  admin owns. Preview is free and the prompt action is created only in the admin
  DOM. In the Training Result page, that action first saves pending result and
  feedback fields through the existing result APIs, then reads the prompt from
  the canonical stored training. Opening/copying remains free and never creates
  an AI execution. A role does not bypass training ownership.

The product response omits raw evidence identifiers. The admin prompt/debug
modal is separate from ordinary analysis text and uses the shared focus trap.

## Context, freshness, and interpretations

The context builder reuses the shared cycle, planning, history, feedback,
availability, shoe and preference selection policy. For analysis it adds the
selected owned session, canonical result, reported feedback and bounded FIT laps.
Feedback edited on the result page is persisted on the owned training row; its
date and user-report fields are then selected into analysis and later shared
contexts from that canonical row. It does not require a separate AI-memory write.
An associated cycle can be included even when it is no longer active. No applied
AI planning is required. Existing planning is marked stale using its original
fingerprint; incompatible RPE guidance is excluded by the established cycle-plan
contract. Interpretations enter later cycle/week/analysis contexts only while
all recorded evidence source versions are still selected and current.

`training-analysis-context-v1`, the `workout-analysis-v2` delivery adapter,
and the structured `workout-analysis-v1` response version the analysis policy
and delivery. RPE text validation reuses the shared bounded Kinesis scale guard:
only values explicitly associated with an RPE/effort-scale label are checked;
the guard accepts the 1–5 scale and rejects incompatible numerators or
denominators across supported PT/EN forms. It does not rewrite prose, infer
scale from unrelated numbers, or claim to interpret all natural language.
Analysis versions store the execution ID, owner, training,
context snapshot, adapter version, sequence, language, response, terminal state
and safe error code. The response keeps structured evidence in protected
storage; ordinary presentation suppresses IDs. Historical context snapshots
are never silently reinterpreted under a newer adapter. A new explicit analysis
creates a new sequence and retains prior versions.

Reusable interpretation records have separate source-version evidence and
exact-content fingerprints, version, disposition (`pending`, `confirmed`,
`corrected`, `dismissed`, or `superseded`) and timestamps. Content identity is
the exact `(kind, text)` string paired with the evidence-version identity; no
semantic equivalence between different prose is claimed. Distinct texts with
the same kind and evidence from one response remain separate. An exact later
repeat is ignored without reactivating or changing its existing disposition.
When a later analysis inserts a different item for the same kind and underlying
evidence, earlier `pending`/`confirmed` items from other analyses are explicitly
marked `superseded` and linked through replacement history. Siblings from the
same response never replace one another; `corrected` and `dismissed` decisions
are preserved. The link keeps a protected snapshot of the replaced item so the
new analysis's freshness check can reproduce its input exactly; later contexts
select only the effective current items. User corrections are stored separately
from model text. This is the minimum decision workflow, not general memory CRUD.
Dismissal is durable and never silently becomes current again.

## Persistence and migration

Idempotent migration `2026-10-workout-analysis-v1` adds
`workout_analysis_versions` and the initial `ai_interpretations` table.
Incremental migration `2026-10-workout-interpretation-identity-v2` rebuilds that
table with exact-content identity and adds owner-scoped
`ai_interpretation_replacements` history. It preserves existing IDs, original
text, correction text, evidence snapshots, dispositions, versions, timestamps,
and analysis links while deriving content hashes for existing rows. Both
migrations are safe to rerun and the v2 migration upgrades databases that
already ran v1; it does not rewrite historical workout or analysis responses.
The tables keep owner/training and analysis foreign keys, uniqueness for
per-training sequence and interpretation identity, and indexes for bounded
owner reads. It preserves all existing
training, result, cycle, AI execution and legacy `ai_memory` records. The
legacy `ai_memory` archive remains readable only through its existing admin
contract and is not enabled as current context. Re-running initialization does
not rewrite analysis history or promote old data into interpretations.

Analysis completion hooks run inside the existing execution settlement
transaction. Invalid output does not persist a partial analysis or any
interpretations. Source freshness, active account and ownership are rechecked by
the shared execution lifecycle. Analysis reads and decisions are account scoped.
RPE rejection records only the allowlisted diagnostic code and JSON path for
administrator debugging; no failed response or interpretation is partially
persisted.

When a generation POST is rejected before an execution is created, the page
shows its known localized reason. If the POST response is lost, the same stored
idempotency key is reconciled against execution history, including already
terminal executions; terminal analysis results/errors are loaded immediately.
If reconciliation itself cannot be read, generation stays blocked until a free
read clarifies the outcome. No recovery read starts or replays a provider call.

## Privacy, cost, and errors

The external prompt templates are kept byte-identical and moved to a private
backend module so ordinary browsers do not download the technical template.
Versioned adaptation removes duplicate populated session blocks; the shared
context is the source of athlete/session data. The model receives only the
bounded selected context and no other user's records. Never put credentials,
prompt bodies, response prose, training values, or provider messages in generic
logs. The existing owner-admin debug path retains allowlisted diagnostic codes,
paths, safe provider correlation fields and known usage.

Only explicit generation may incur provider cost. The existing conservative
reservation, configured model/reasoning, token cap, timeout, retry policy,
concurrency, daily call and cost limits apply unchanged. Only the foundation's
authorized 429 retry may issue another attempt. Timeout, network uncertainty,
5xx, invalid/incomplete output, domain rejection and persistence failures are
not replayed automatically. Reload, polling, prompt preview, analysis history,
confirm, correct and discard are free. CI/browser E2E uses a deterministic fake
provider; it does not validate real-model quality and makes no paid call.

## Limitations and verification

The schema/domain validator constrains structure, evidence IDs, field bounds,
RPE scale and source ownership. It cannot prove the semantic truth of every
natural-language causal claim; instructions require proportional, evidence-led
language and the UI makes the analysis reviewable. A real-model quality study
requires separate owner approval and a stated budget; it must not be used as a
retry loop. The implementation's validation record distinguishes local tests,
synthetic Chrome runs, provider calls, and GitHub checks.
