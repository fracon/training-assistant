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
`workout-analysis-v1` adapter and strict response schema validate the response
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
  persisted interpretation states. Missing or foreign sessions return 404.
- `POST /api/ai/executions` with `purpose: analysis`, the session ID as
  `resource_id`, and an idempotency key creates/reuses the standard execution.
  A second active execution for the same owner and training reuses the existing
  one.
- `GET /api/ai/executions/:id` is a free read and never exposes the raw analysis
  response through the generic execution endpoint. Protected administrator
  debug remains separately owner-scoped.
- `POST /api/ai/interpretations/:id/{confirm,correct,discard}` applies an
  optimistic `expected_version`. Correction accepts bounded user text. Discarded
  and superseded items cannot be revived by an old analysis. These actions are
  local writes and do not call a provider.
- `POST /api/ai/admin/preview` can return the external analysis prompt only to
  an administrator whose current database role is `admin`, for a training the
  admin owns. Preview is free and the prompt action is created only in the admin
  DOM. A role does not bypass training ownership.

The product response omits raw evidence identifiers. The admin prompt/debug
modal is separate from ordinary analysis text and uses the shared focus trap.

## Context, freshness, and interpretations

The context builder reuses the shared cycle, planning, history, feedback,
availability, shoe and preference selection policy. For analysis it adds the
selected owned session, canonical result, reported feedback and bounded FIT laps.
An associated cycle can be included even when it is no longer active. No applied
AI planning is required. Existing planning is marked stale using its original
fingerprint; incompatible RPE guidance is excluded by the established cycle-plan
contract. Interpretations enter later cycle/week/analysis contexts only while
all recorded evidence source versions are still selected and current.

`training-analysis-context-v1` and `workout-analysis-v1` version the analysis
policy and delivery. Analysis versions store the execution ID, owner, training,
context snapshot, adapter version, sequence, language, response, terminal state
and safe error code. The response keeps structured evidence in protected
storage; ordinary presentation suppresses IDs. Historical context snapshots
are never silently reinterpreted under a newer adapter. A new explicit analysis
creates a new sequence and retains prior versions.

Reusable interpretation records have a source-linked evidence fingerprint,
version, disposition (`pending`, `confirmed`, `corrected`, `dismissed`, or
`superseded`) and timestamps. A new analysis with the same evidence can reuse an
identical interpretation; a different interpretation for that evidence
supersedes an earlier pending/confirmed item. User corrections are stored
separately from model text. This is the minimum decision workflow, not general
memory CRUD. Dismissal is durable and never silently becomes current again.

## Persistence and migration

Idempotent migration `2026-10-workout-analysis-v1` adds
`workout_analysis_versions` and `ai_interpretations`, with owner/training and
analysis foreign keys, uniqueness for per-training sequence and evidence
identity, and indexes for bounded owner reads. It preserves all existing
training, result, cycle, AI execution and legacy `ai_memory` records. The
legacy `ai_memory` archive remains readable only through its existing admin
contract and is not enabled as current context. Re-running initialization does
not rewrite analysis history or promote old data into interpretations.

Analysis completion hooks run inside the existing execution settlement
transaction. Invalid output does not persist a partial analysis or any
interpretations. Source freshness, active account and ownership are rechecked by
the shared execution lifecycle. Analysis reads and decisions are account scoped.

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
