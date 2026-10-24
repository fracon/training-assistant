# Cycle planning — issue #63

Status: **implemented on `feat/issue-63-cycle-planning`, not integrated until its
PR merges**. Beta **0.21.0** builds on phase 0 merged in PR #67 (`648d6a0`).
Weekly generation #64 and result analysis #65 are not implemented here.
The [2026-10-24 final v3 evaluation](#end-to-end-final-v3-evaluation-2026-10-24)
completed real generation, RPE validation, explicit application and reload recovery
on the final runtime code. Earlier evaluations and their limitations remain below.

## Product flow and existing sources

Cycle registration (`src/cycles.js`, existing `/api/cycles` CRUD) still records
objective, goal, target/start dates, distance, previous experience at that distance
and other events. It works without AI. The **Cycle planning / Planejamento do ciclo** icon action on
the same cycle card opens the product modal, shared controls and theme.
It shows saved planning separately from a new proposal, with PT/EN labels.

**Generate planning** explicitly starts a paid request when runtime configuration
permits it; saving a cycle never starts one. Only the selected owned active cycle
can generate/apply new planning. Inactive cycles retain read access to saved plans.
The saved target must be a valid ISO date no earlier than the effective start;
start is the later of the phase 0 UTC snapshot date and the saved start, or that
snapshot date if start is absent.
Past cycles can be edited through the existing form; they are not recreated or
backfilled. No elapsed preparation is invented. No weekly sessions are generated.

The phase 0 context service provides the selected cycle, its original goals,
optional previous-running-experience supplement, saved Request Workouts
availability, recent reports, canonical aggregates and reference sessions.
Context v5 also selects at most three preceding non-active canonical cycles.
The v3 discomfort/RPE priority, full critical reports, byte budget, provenance,
omission disclosure and explicit 413 on insufficient mandatory context remain.
Missing history, missing symptom updates and missing sessions establish neither
fitness nor recovery nor rest. No new profile fields are added.

The existing persisted execution service handles enqueue, reserve, dispatch,
retries/cancellation, uncertain outcomes, restart recovery and source revalidation.
The modal polls the owner-scoped planning view while queued/running. Reopening
or reloading recovers durable state; closing the dialog does not cancel a call.
Local cancellation does not guarantee that provider billing stops. A lost generation POST
response retains its idempotency key per cycle across modal transitions in the
current page; a known
new request receives a new key. No paid call runs automatically on load or restart
except untouched queued work under the existing recovery contract.

## Presentation and free prompt access

The card uses the same 32×32 `.btn-icon` action as edit/complete/cancel, with a
15×15 decorative Lucide `calendar-range`, translated aria-label and the existing
custom hover/focus tooltip: **Planejamento do ciclo / Cycle planning**. The
tooltip opens below the button and aligns to its left edge so it remains visible
near the viewport edge without moving to the far edge of the card. No native
title is added. Inactive cycles keep this read access.
Opening never generates, applies or activates a cycle.

The **Planejamento do ciclo / Cycle planning** modal follows the cycle and shoe CRUD
references: `.modal-card`, `.modal-header` and the 30×30 `.modal-close` containing
an 18×18 Lucide x. The existing cycle modal padding is shared by header, body and
footer. A flexible, vertically scrollable body separates explanation, live status,
localized error, proposal and applied plan; paragraph/heading spacing is explicit.
The applied version uses the existing cycle status badge. Width uses the existing
800px extended-modal limit; header/close and footer stay visible, long text wraps,
and actions wrap without new button sizes or horizontal scrolling.

Footer `.form-actions` uses the established primary/secondary buttons: generate
initially, status plus cancellation while processing, apply as primary when a
proposal is ready, and regenerate for an applied plan. Technical inspection is a
secondary admin-only section in the scrollable body. The product modal does not
use prompt-output card/action classes. Focus trap/inert, Escape/backdrop, restored
trigger after rerender, language changes and out-of-order polling stay intact.

`GET /api/cycles/:id/prompt` now uses the shared authentication/admin chain:
anonymous 401, current non-admin 403, owned admin cycle 200 and unowned/missing
admin cycle 404. It is a free local renderer; it does not reserve budget or call
OpenAI. Regular accounts have neither a card prompt action nor its modal/listeners.
Saving either account role's cycle never fetches or opens the technical prompt.
Admin preview/copy remains an explicit active-card debug action. The automatic
post-save destination is the product planning step for both roles.
Every save/refresh/language render and delegated prompt handler carries the role
restriction. This does not restrict AI planning to administrators.

## Guided creation and editing

This owner-approved experience is implemented on the PR #69 branch, pending merge:
**save registration → cycle planning → separately requested weekly workouts**.
The card/modal label is **Planejamento do ciclo / Cycle planning**. The existing
card icon and corrected CRUD modal remain; there is no wizard or new visual system.

`POST /api/cycles` / `PUT /api/cycles/:id` returns the persisted `{cycle}`. The page upserts that
canonical record immediately, updates active-cycle navigation, closes/deactivates
the form trap, and opens planning for the returned ID when its status is active.
It does not depend on a second list read to recover that card. Source-of-truth
planning state is read through the existing GET endpoint before actions appear.

| Persisted state | Presentation/actions |
| --- | --- |
| Newly saved/unplanned active cycle | Saved confirmation, phases/priorities explanation and separate weekly-workout wording; Generate plan / Not now |
| Edited active cycle with outdated applied plan | Saved changes and earlier-information explanation; Generate new plan / Keep for now |
| Current applied plan after save | Consult version and Done; no unnecessary regeneration offer |
| Running execution | Recover status/polling; Close and existing local cancellation; never enqueue on open |
| Current unapplied proposal | Review and explicitly Apply; opening/saving does not apply it |
| Outdated/conflicting proposal | Explain why it cannot be applied; offer new generation when eligible |
| Inactive saved cycle | No automatic generation step after saving; card still opens read-only planning |
| Disabled/unconfigured AI | Saved cycle and unavailable explanation, Done; generation hidden, existing plans readable |

Defer/Keep/Done only closes the modal. It never deletes/reverts a cycle, removes
an applied version, clears an outdated flag or calls the provider. Generation
creates another proposal; application stays explicit and atomic.

Freshness comes exclusively from backend execution/applied-plan flags and version
contracts. `updateCycle` atomically compares submitted values with persisted
columns using SQLite affinities and null-safe `IS`: e.g. numeric form string
`"3"` equals stored INTEGER 3. A no-op touches no revision or timestamp; a real
change and reversal still advance the revision twice. There is no migration,
revision rollback, historical snapshot rewrite or automatic freshness repair.

The save lock prevents duplicate submits. A form revision token suppresses late
errors/transitions after close or another form opens. Late acknowledged writes
still update their own cards; closing cannot undo a write already submitted.
Post-write rendering uses current i18n. List and active-read versions protect
local acknowledged state against older responses. Form/planning share the existing
trap/inert and restore focus to the saved cycle's visible planning icon after
rerender, with no overlapping dialogs.

A failed planning read after save explains that registration succeeded, keeps
the card, disables generation/application until reloaded and offers a free retry.
It never reports a registration failure or retries POST creation. Read errors
and old polling responses cannot alter another open cycle. Pending poll timers
are cleared on switch, and stale callbacks are rejected before issuing reads.
Unknown generation acknowledgements keep the same per-cycle key across modal
close/reopen in the current page; reload recovers durable backend state.
No new execution/job/client/cost mechanism, profile fields, output schema or
training-prompt instructions are introduced. #64/#65 remain future phases.

## Structured output and delivery adapter

`cycle-plan-schema.js` defines strict `cycle-plan-v1`:

| Part | Fields |
| --- | --- |
| Identity/window | schemaVersion, cycleId, start, end |
| A–C, proposal-local evaluation | assessment, continuity, feasibility, confidence (low/moderate/high/insufficient_data) |
| D, architecture | 1–12 phases: name/start/end/objective/volume/longRuns/quality/intensity/easyRuns/strength/risks/advanceCriteria/rationale/evidence |
| E, indicators | 5–10 nonblank indicators |
| F, adaptation rules | increase, maintain, reduce, replaceQuality, reduceLongRun |
| Limitations | uncertainties, declared assumptions and questions |

Unknown keys, wrong types, blank/oversized strings and excessive arrays are
rejected. Text is capped at 1,600 characters; limitation/evidence arrays at 12.
Phases must cover the exact effective window, inclusive, in chronological order,
without gaps or overlaps. Each phase needs evidence IDs in the selected context's
`type:id` allowlist. Cycle identity and dates must match the actual requested
resource. No row is applied from schema validity alone; backend domain validation
runs after transport/refusal/completion checks and again on application.
Semantic coaching quality still requires real evaluation; structural validation
cannot establish the truth of free-text clinical or performance claims.

`cycle-delivery-v3` preserves the three delivery adaptations originally delivered
in v1, retaining all 22 numbered sections:

1. “Plan in detail only the current/next week” becomes architecture only for this
   operation (weekly calendars belong to #64).
2. The first-response delivery line maps A–F, in the original order, to schema fields.
3. The summary-table delivery sentence maps its columns to structured phases.

The approved noncompetitive-goal correction also scopes three original spans
**only in the API adapter**:

- Equipment: “Do not introduce new equipment near the race…” becomes conditional
  on an explicitly registered race.
- Nutrition: “Use the cycle's long runs to develop and validate the race nutrition
  strategy” becomes goal-relevant nutrition with race strategy conditional.
- Section 17 TAPER receives an explicit condition: its race guidance applies only
  to a registered race; otherwise recovery follows the goal and observed response,
  without imposing competitive taper.

The original template already says “Main race or objective” and “Race/objective
date”; these are preserved. Higher-priority adapter instructions clarify that a
race is optional, target_date is the goal deadline, and event/registration/date or
participation must not be invented. Schema, source identities, contiguous phases,
application and external/weekly/analysis prompt output are unchanged. Historical
v1 snapshots retain their original prompt/payload/version; the existing execution
service refuses an old queued adapter version rather than silently reinterpreting
it. Applied plans and completed snapshots are not rewritten.

The transformations are explicit/versioned and tested as an allowlisted diff,
including user fields containing matching delivery sentences: only the final
fixed-template occurrence is changed.
The external generator is unchanged, including weekly/analysis prompts. All
external baseline comparisons remain byte-for-byte tests. Free external macrocycle
prompt generation/copy is restricted to administrators for their own cycles; they also inspect
only their own exact execution payload/context, original external prompt,
adapter/model versions, sanitized errors and usage/cost in the planning modal or
Training memory debug. Common accounts never receive those technical payloads.

## RPE compatibility (cycle-delivery-v3)

### Confirmed source and minimal instruction

The external PT/EN macrocycle prompt requests “RPE/sensação esperada” / “expected
RPE/sensation” without defining a scale. It does not instruct RPE/10. Adapter v2
also omitted the scale. Read-only inspection of the isolated real evaluation
confirmed an empty history, no incompatible scale in its context/instructions,
and an incompatible numeric reference in the returned first phase's intensity.
The rendering displays the stored text; it did not convert a correct value.
The confirmed cause is an unspecified unit contract that allowed the model to
choose another scale, plus missing output validation — not disobedience of an
explicit 1–5 instruction or evidence of a 1–10 training record.

Adapter **`cycle-delivery-v3`** adds only this integrated unit instruction:

> RPE in Kinesis uses a scale of 1 to 5: every numeric effort prescription or reference must use that scale, never RPE/10, a 0–10 scale or values above 5. Heart rate, pace, distance, percentages and other quantities keep their own units.

The six existing allowlisted delivery/competition transformations, all 22
training sections, original PT/EN external outputs, schema `cycle-plan-v1`, model
and reasoning stay unchanged. New payloads record v3; old snapshots keep their
actual v2 payload. Already queued v2 work is not silently sent with v3 instructions:
the existing adapter-version claim check refuses it. Historical completed valid
proposals are still eligible after current domain validation; no blanket invalidation.

### Bounded validation and refusal

`cycle-plan-rpe.js` checks explicit numeric effort references in **all generated
narrative fields**: A–C assessment/continuity/feasibility, every phase text field
including names/objectives/intensity/rationale, indicators, adaptations,
uncertainties, assumptions and questions. Identity, dates, enums and evidence IDs
are not interpreted as effort prose. The same `rpeIssue` traversal is reused in
response validation, existing-proposal read/application and applied-plan context
selection, avoiding divergent rules.

Covered PT/EN notation includes RPE/perceived effort/exertion and Portuguese
perceived-effort/effort-scale labels, values, decimal comma/dot, ranges with
dash/a/e/to/and, slash/de/em/out-of denominators, numeric readings before RPE,
common qualifiers such as approximate/approximately and “aproximado de”, and
parenthesized named scales. A generic “effort/esforço” is examined only with an
explicit denominator. Numerators/range endpoints must be within 1–5; an explicit
denominator must be 5; a parenthesized named scale after a reading must be 1–5. Heart rate,
pace, distances, dates and percentages keep their own units; the word RPE alone
is allowed. Matching normalizes an in-memory copy for case/accents only; it
never changes persisted/displayed content or converts between effort scales.

The guard is deliberately **not** a general language interpreter. It does not
prove physiological suitability or all semantic correctness, resolve arbitrary
paraphrases/numbers spelled out in words, or interpret negation. Explicit
incompatible references remain rejected even when quoted as an example. Unlabeled
numbers are not assumed to be RPE. A passing check is not a quality certificate.

Refusal returns **`planningRpeIncompatible`**, keeps execution `failed` and does
not populate validated response/proposal content. Existing known input/output
usage remains reconciled; there is **no automatic retry** or partial application.
The existing current-admin owner debug records domain code **`rpe_scale`** with a
schema-defined path (e.g. `$.phases[0].intensity`); no rejected values/body/credentials
enter diagnostics. PT/EN product alerts explain RPE 1–5, no new applied version
and that another generation is an explicit potentially paid action. No new client,
worker, generic interpretation engine or cost mechanism is introduced.

### Existing proposals and applied versions

An affected historical proposal receives `compatibilityError:planningRpeIncompatible`
on owner-scoped planning reads, stays readable for traceability, and has no Apply
control. An application request revalidates inside the existing transaction and
returns HTTP **409** with the same code before inserting a version. Changing the
UI cannot bypass this. Compatible historical proposals still work.

Applied versions are **never edited/deleted/converted**. An affected applied
version receives that compatibility flag and an explicit warning: the original
is retained for consultation, but its guidance will not feed later tasks. The
next workouts/analysis context keeps only its identity, dates, version and source
reference/hash, plus an explicit gap and `incompatible_rpe_scale` omission. It
excludes **all** guidance from that affected plan, including architecture,
phases, indicators, adaptations and uncertainty prose, so incompatible advice
cannot reenter through another field. Checking/consulting costs nothing.

This flag is independent of source freshness. No context-policy version bump,
blanket plan invalidation, migration, database rewrite or regeneration occurs;
compatible v5 contexts retain their content/hashes. Contexts actually changed by
exclusion naturally fail old fingerprint comparison. An idempotent repeat Apply
of an already applied proposal remains a no-op, not a new application or a way
to reenable its guidance. Replacement requires a newly validated proposal and an
explicit Apply; the earlier version remains in history.

Read-only inspection confirmed the reported real **version 1 exists only in the
isolated synthetic evaluation database**; the principal local database had zero
applied versions. The new guard identified `$.phases[0].intensity` in that saved
result and future-context inspection selected zero phase/architecture entries,
while its JSON stayed identical. The cycle/account belonging to the responsible
person and production were not modified. No real output was copied into fixtures;
synthetic cases reproduce only the notation/qualifier structure.

This correction makes **zero new paid calls**. The prior successful real v2 call
remains evidence of the earlier product path only, not of v3 compliance or this
validator. The new instruction and rejection behavior are tested with simulated
providers. Operational settings remain gpt-6.1-sol/medium/8192/120000; the evaluated
single-attempt override is still AI_RETRIES=0. See the [deployment configuration
steps](ai-foundation.md#operational-cycle-planning-settings); editing `.env.example`
does not update explicit older variables or a running container.

### Validation of the RPE correction

Synthetic regressions failed before the correction for the observed notation,
its “aproximado de” qualifier, parenthesized RPE labels and calendar values next
to RPE. The final guard rejects incompatible syntax while preserving legitimate
1–5 ranges and unrelated dates, FC, distances and percentages. Known-usage,
no-retry, HTTP 409/ownership, old-proposal revalidation, selective exclusion,
immutability and explicit replacement/version history tests pass.

Final local gates on Node 24.18.0: **82 targeted tests**, followed by
`npm test` and `npm run test:coverage`, **1,247 passed each**, zero failures/skips,
**100% Statements, Branches, Functions and Lines** in the required instrumented
scope. All 48 exact external prompt comparisons remain intact. The standalone
new guard also reaches 100% in all four metrics with synthetic syntax cases.
Final complete gates ran serially after the adversarial notation checks; an
intermediate overlapping coverage collection was not used as acceptance evidence.

Real Chrome with a **simulated** provider covers PT/EN × ordinary/admin ×
1280/390px: unit-specific refusal alert, no Apply, one simulated operation per
double click, intact applied version, localized legacy exclusion warning, Escape
and focus restoration, and no horizontal overflow. Temporary synthetic captures
were visually inspected against the existing planning modal/alert/controls;
Lucide was loaded locally for inspection and no CSS or new visual pattern was
introduced. Existing focus, quotas, context, ownership, prompt and guided-flow
suites remain green.

Isolated `npm run dev` and `npm start` return HTTP 200/version 0.21.0 without
MODULE_TYPELESS_PACKAGE_JSON, with AI disabled and temporary databases. The full
diff was critiqued for domain validation, false rejection of other units/dates,
known/uncertain accounting, ownership, atomic application, historic snapshots,
context exclusion, compatibility, accessibility and privacy; findings were fixed
in one corrective batch. `git diff --check` and `git diff main --check` pass.
No real model call, deployment, production/personal-cycle write or credential
copy occurred. Beta remains 0.21.0; PR #69 is open and no new review is requested.

## Persistence, concurrency and retention

Idempotent migration `2026-10-cycle-planning-v1`, invoked by database
initialization, adds `training_cycles.planning_revision` (initial zero) and:

- `cycle_plan_proposals`: owned cycle/execution, monotonically ordered sequence,
  base applied version, creation time and nullable validated plan JSON.
- `cycle_plan_versions`: explicitly applied proposal ID, version, accepted plan,
  originating context/cycle hashes, minimal context freshness fingerprint,
  source references and application time.

An existing database may already have the v1 marker while its original
`cycle_plan_versions` table lacks `fingerprint_json`. The follow-up
`2026-10-cycle-plan-fingerprint-v1` migration checks the actual columns on every
initialization, adds the missing column transactionally, and is safe to rerun.
Existing plan rows and JSON are preserved. Rows with no historical fingerprint
receive `{}` and are conservatively considered outdated by the existing context
freshness check; they remain readable and idempotently applied, but that missing
metadata cannot certify them as current. New applications persist the complete
fingerprint. No plan is rewritten or deleted by this repair.

No existing cycle, profile, training, session or historical execution is rewritten.
Every actual stored-value change increments its revision, even in the same
second, preventing change-and-revert from authorizing an old proposal. Source
hashes also capture other canonical changes.

The adapter's trusted enqueue/completion/cleanup callbacks run within the
existing service lifecycle. Proposal creation and quota reservation share the
enqueue transaction; validated proposal content and execution settlement share
the result transaction. Failed, refused, truncated, uncertain, cancelled or
outdated responses do not produce a usable proposal or partial application.
No transaction spans network I/O. Browser requests cannot register adapters,
choose arbitrary models/prompts, or enable tools.

Application is a separate immediate transaction: current active account,
cycle/proposal/execution ownership, active cycle state, current source fingerprint,
completed validated output, effective dates and optimistic applied version are
rechecked. The proposal's base version must match both the submitted version and
the current applied version. Double application of the same proposal is a no-op
returning its already-applied version; it never rolls a newer version back.
Concurrent different proposals cannot overwrite one another. Generation does not
change cycle status or activate another cycle. The existing one-active-cycle rule
is preserved. An execution expired under retention cannot newly authorize apply.

Applied versions persist until their cycle/account is deleted, including prior
versions for traceability. Execution/debug/usage retention stays at the existing
bounded default of 90 days. Unapplied proposals are cleaned once their retained
execution is gone; applied plans and source fingerprints remain without keeping
expired raw execution payloads. Cycle/account deletion cascades planning records.
An account deleted or suspended during generation cannot be recreated/applied.

Unexpected errors from AI routes are logged with a stable event, route template,
error class/code and bounded stack frames. Error messages, SQL, request values,
prompts, provider bodies, account identifiers and credentials are omitted; the
client continues to receive the generic `aiInternalError` for genuinely
unexpected failures. Expected ownership, freshness and version conflicts retain
their localized domain codes.

## Continuity and interpretation boundary

Context v5 marks historical v1/v2/v3/v4 snapshots outdated without rewriting them.
For future workouts/analysis it includes the active cycle's latest applied plan,
labeled `applied_planning`, versioned and dated, with an outdated-source flag.
Plan identity and provenance are mandatory. Macro architecture, near-term phase
details, indicators, adaptation rules and uncertainties are optional planning,
never completed work; they use the shared budget path after recent reports and
availability. Omitted details remain explicit. The exact priority and omission
contract is in [context v5](ai-foundation.md#context-extension-training-context-v5).
Mandatory material still refuses an insufficient budget rather than truncating
reports; extensive optional planning cannot trigger that mandatory refusal.

A–C assessments and speculative assumptions stay in the reviewable planning artifact. They are not extracted
as persistent athlete characteristics or fed back as a reusable profile. No
independent interpretations, diagnoses, confirmation editor or paid summarizer
is created. Later interpretation producers must implement the existing evidence
and confirm/correct/discard contract; an old plan is not permission to reactivate
discarded interpretations. This phase's future-facing context contains planning
recommendations/criteria, not a generated registry of athlete traits.

## Runtime configuration, provider and privacy

Backend readiness is reported safely at startup; adding the key still requires
`AI_ENABLED=true` and a backend restart. See the [configuration troubleshooting
guide](ai-foundation.md#configuration-and-deployment). No automatic provider check
or generation occurs.

Use the integrated backend `OPENAI_API_KEY`, `AI_ENABLED=true` and
`AI_MODEL_CYCLE` (default `gpt-6.1-sol`), with no fallback. No new secret or runtime
setting is introduced. Complete A–F planning defaults to **AI_MAX_OUTPUT_TOKENS=8192**
(the existing upper bound, includes reasoning) and **AI_TIMEOUT_MS=120000**.
These are the settings demonstrated in the real evaluation below and supplied
by `.env.example`. The defaults were subsequently aligned across backend and
Compose; explicitly configured older values still override them and must be
updated in the operator's environment. Review daily token/call/cost limits
first. A timeout remains uncertain, never an automatic retry. No main
environment or production configuration was changed.

Official documentation checked on 2026-10-15 confirms
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) supports
Responses, medium reasoning and structured outputs. Requests use the existing
[strict structured-output format](https://developers.openai.com/api/docs/guides/structured-outputs),
`store:false`, no tools, and runtime backend-only authentication. Model/project
access is not established by documentation or mocks. Published Sol standard
rates were $2 input / $.10 cached / $2.50 cache-write / $10 output per million;
the retained versioned phase 0 ceilings (4/.2/5/15) are conservative estimates,
not actual invoices. No premium tier, tools or silent model fallback is enabled.

Only the selected structured training context and adapted prompt are sent on an
explicit generation. No account email/name, credentials, FIT/ZIP binaries or raw
GPS are selected. Free text can contain private information entered by its owner;
do not put it in logs, fixtures or web queries. `store:false` does not promise
zero provider retention; the existing [provider data controls](https://developers.openai.com/api/docs/guides/your-data)
and local backup/retention responsibilities still apply. No Docker/CI/port/user
or deployment architecture change is required.

## API

All endpoints use the current authenticated active account; identifiers never
permit cross-account access, including for administrators.

| Endpoint | Contract |
| --- | --- |
| `GET /api/cycles/:id/prompt` | current admin only, owned cycle, free original PT/EN prompt; 401/403/404 as above |
| `GET /api/cycles/:id/planning` | availability/canGenerate, cycle revision, latest applied plan (or null), latest 20 ordered proposals and their safe execution state/result; no exact payload/model/key |
| `POST /api/ai/executions` | existing `{purpose:"cycle",resource_id,idempotency_key}`; only cycle adapter registered here |
| `GET /api/ai/executions/:id` | existing safe owner polling |
| `POST /api/ai/executions/:id/cancel` | existing empty-body local cancellation |
| `POST /api/cycles/:id/planning/:proposalId/apply` | `{expected_version:nonnegativeInteger}` → `{appliedVersion,alreadyApplied}` |
| `POST /api/ai/admin/preview` | existing free original-prompt/context preview |
| `GET /api/ai/admin/executions/:id` | existing current-admin, own-only exact debug |

Application errors: `planningConflict`, `planningOutdated`, `proposalExpired`,
`invalidPlanningResponse` (409); malformed fields/version (400); unowned/missing
cycle/proposal (404); inactive/anonymous account (401). Generation additionally
returns the specific calendar/active-state codes below (400), existing quota/concurrency
(429), disabled/invalid configuration (503), context budget (413), and sanitized
provider states. No partial plan is applied on any failure.

## Failure diagnostics and provider correlation

The product modal presents the persisted failure reason in its existing localized
alert, instead of relegating it to a muted note below planning content. A read
failure keeps its own free Retry action and never changes a completed/failed
execution into a new paid call. Opening, saving, deferring and polling remain free.
No partial/invalid/incomplete response becomes a usable proposal or applied plan.

| Stable reason | Stage / handling |
| --- | --- |
| `aiUnavailable` / `adapterUnavailable` | Local configuration or missing adapter; no provider call |
| `providerRejected` | Provider HTTP rejection; admin sees HTTP status (including auth/model-access failures), never its raw body |
| `providerRateLimited` | HTTP 429; only this condition may retry within configured limits |
| `providerOutcomeUncertain` / `providerTimeout` / `restartOutcomeUncertain` | Transport/timeout/HTTP 5xx or restart; no automatic retry, reservation preserved if usage unknown |
| `providerOutputLimit` | `incomplete_details.reason=max_output_tokens`; known usage kept; operator reviews budget before an explicit paid retry |
| `providerContentFiltered` / `providerRefused` | Policy interruption/refusal; no partial output or automatic retry |
| `providerIncomplete` / `providerFailed` | Other/legacy incomplete status or explicit failed status; no automatic retry |
| `providerInvalidResponse` | Unexpected foreground status, content shape, multiple/absent text or invalid JSON with known response envelope; no retry |
| `invalidDomainResponse` | Schema/domain refusal, with a value-free code/path in admin debug |
| `sourceChanged` | Source revalidation refused settlement; usage retained, no proposal applied |
| `resultPersistenceFailed` | Atomic proposal write rolled back; known provider usage retained and no plan applied |

Malformed transport bodies cannot yield reliable usage; their parsing-stage
metadata accompanies uncertainty, rather than promising no charge. Structured
Outputs does not mean a completed plan was returned: response status/refusal,
JSON shape and domain constraints are independent gates. The existing strict
`cycle-plan-v1` schema and dates/evidence rules are unchanged. Adapter v3 adds
explicit RPE units and the compatibility guard described below. The diagnostic validator reports only known field paths (for
example `$.phases[0].evidence`), never the rejected value or arbitrary input key.

Current administrators inspect **only their own** executions using the existing
collapsed debug action/API. New bounded diagnostics retain per-attempt correlation,
provider HTTP status/IDs, status/incomplete reason, transport reason (timeout/network), reasoning count, output-text
counts/bytes, duration/effective client timeout and validation stage/path. Admin `costBasis` distinguishes pending reservation, reported-usage estimate,
known unbilled rejection and reserved unknown usage. These are not provider
invoices; an uncertain reservation must not be presented as a confirmed charge. New configuration
snapshots record application version and timeout; the exact build SHA is not
exposed by `/api/version` and cannot be asserted retrospectively. The migration,
allowlist and retention are documented in [AI foundation](ai-foundation.md#execution-diagnostics-on-the-issue-63-branch).

### Existing failure investigated before another paid call

The localhost advertised version **0.21.0**; the checked-out branch began at
`730b86d`. There was one persisted failed cycle execution, **attempts=1**, adapter
`cycle-delivery-v2`, policy `training-context-v5`, model `gpt-6.1-sol`, medium
reasoning, **max_output_tokens=2048**, configured retries=1, duration about 55.7s.
Its known usage was **7,929 input + 2,048 output, 0 cached**, conservative cost
**USD 0.070365**, and no usable response/proposal. One dev watcher with one server
child was present. A real Chrome login to the supplied account confirmed the
persisted failure and the new visible explanation, without a new generation,
cycle write or prompt disclosure. No account identifier or credentials are
included in this evidence.

The persisted `providerIncomplete` proves rejection at response-completion
handling, before schema/domain validation could accept a plan. Output equalled
the configured ceiling; exhaustion is strongly supported, but the old client
**discarded** `incomplete_details`, reasoning details, returned-text counts and
provider request/response IDs. Therefore its exact incomplete reason, returned
text and the second provider entry cannot be reconstructed. It would be incorrect
to assert two retries/duplicate clicks or two backend executions from the reported
provider count. The owner had no request IDs available. A previous separately
documented in-memory evaluation is another known source of a provider request,
but cannot be matched to the second entry without timing/ID evidence.

Offline reproduction uses a synthetic Responses envelope with the same usage
structure: reasoning-only output, `status=incomplete`, reason `max_output_tokens`.
Before correction it lost that reason as generic `providerIncomplete`; after,
it yields `providerOutputLimit`, preserves billed usage, and records safe IDs,
reasoning/text counts and stage. Other tests cover 429 retry/cancellation,
idempotent replay/lost acknowledgements, nonretryable failures, ownership,
source changes, rollback and free recovery from a later read failure.

### Response budget and the controlled retest

[OpenAI reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning?api-mode=responses)
explains that the output allowance includes reasoning and visible answer tokens;
limit exhaustion can finish without a usable answer. The structured A–F plan
requires more than a short visible reply. **2,048 is not a validated sufficient
budget** for this operation. Based on the observed ceiling exhaustion, the
operator authorized an **8,192** budget for one isolated evaluation, within the
existing configured bounds. The live `.env`, default, model, 60s timeout and 429
retry policy are not silently changed. A larger budget is not a success guarantee;
continue to enforce input/output reservations and daily cost/call limits. Do not
repeat automatically after incomplete or uncertain output.

## Goal deadlines and calendar validation

A race is **not required**. `objective`, `primary_goal`, distance and the existing
optional event text already represent a personal distance goal, competition or
other supported training objective. No event name, signup, duplicated goal or
cycle-type selector is added. The form explains the existing target date as the
deadline for the goal. Manual registration remains usable without planning dates;
generation requires a real target date and never invents one.

`planningWindow()` requires an active cycle. Backend values are exact date-only
`YYYY-MM-DD`, not localized strings or timestamps. The existing DatePicker shows
DD/MM/YYYY in PT and MM/DD/YYYY in EN and sends unchanged canonical dates. Invalid
calendar dates (including impossible days), localized API date strings and
timestamps are refused. Missing/empty start retains the reference-date fallback;
a past start plans only the remaining period, and a future start is honored.
The effective start is `max(context.asOf, saved start)`, with the existing UTC
calendar reference used consistently by context generation. Target equal to the
effective start is **accepted**, including a one-day plan today: this was already
the `<` comparison contract, not a new relaxation. No timestamp timezone conversion
is applied to saved calendar fields.

| HTTP 400 code | Condition / correction |
| --- | --- |
| `cycleNotActive` | No active requested cycle; status must allow generation |
| `planningTargetDateRequired` | Missing/empty target; set a goal deadline in Edit cycle |
| `planningTargetDateInvalid` | Invalid/impossible/noncanonical target; correct target |
| `planningStartDateInvalid` | Invalid nonempty saved start; correct start |
| `planningTargetBeforeStart` | Target earlier than saved start; correct interval |
| `planningTargetBeforeReference` | Otherwise target earlier than current reference; select a remaining planning period |

Validation order is active state, target presence/shape, optional start shape,
saved interval, then remaining interval. Refusals happen in adapter preparation
before budget reservation, execution/proposal persistence or provider call. Legacy
`invalidPlanningDates` remains translated neutrally for historical compatibility;
new date refusals use specific stable codes. The error retains focused localized
feedback and the saved cycle; close and use its existing Edit cycle action.

Confirmed local reproduction (read-only, no personal content copied): the saved
active cycles' target dates preceded the current context reference, while their
saved starts also preceded it. v1 returned `invalidPlanningDates`, then PT wrongly
called it a required future race. There was no event-field check. Synthetic fixed
2030 tests failed before this change on the generic error, and now identify the
actual target/reference failure. Dates from real cycles are not fixtures.

## Real evaluation and local verification

Initial implementation had no authorized provider key and used simulated outputs.
A later owner-authorized single-call evaluation is recorded below. Automated suites
still use mocks and establish contracts, not physiology or provider quality.

For the first small real evaluation, using only synthetic or explicitly permitted
athlete records and a development database:

1. Install dependencies, set backend runtime key, AI_ENABLED=true,
   AI_MODEL_CYCLE=gpt-6.1-sol, AI_MAX_OUTPUT_TOKENS=8192, AI_TIMEOUT_MS=120000
   and AI_RETRIES=0 for a single-attempt evaluation; run `npm start` on Node 24.
2. Create/edit an owned active cycle with a future target and optional start date.
   Leave history absent first. The Cycle planning step opens after saving; generate once explicitly. Reload
   during processing, review A–F, uncertainty and dates, then apply explicitly.
3. As admin inspect the same execution: record model, adapter/policy versions,
   actual usage and estimated cost (not the key or personal prompt in reports).
4. Compare a second small case with synthetic recorded history/RPE and a dated
   discomfort report corrected at its original session. Verify distinct grounded
   rationale, no permanent restriction/diagnosis or invented recovery, adequate
   date organization and cautious confidence. Keep calls within configured caps.
5. Generate a new proposal and verify that the applied version remains until a
   new explicit apply. Change a source between generation/application; application
   must be refused. Verify common/admin ownership and existing manual workflows.
6. Record completeness, usefulness beyond repeating cycle fields, phase coherence,
   evidence correctness, missing-data honesty, adaptation criteria, PT/EN quality,
   usage/cost and failures. Do not infer quality from a successful schema check.

Automated validation: cyclePlanning.test.js, cyclePlanning.routes.test.js and
cyclePlanning.browser.test.js; existing foundation/prompt/context/CRUD tests,
`npm test`, `npm run test:coverage` (100% Statements/Branches/Functions/Lines in
its required backend scope), `git diff --check` and Node 24 startup without the
MODULE_TYPELESS_PACKAGE_JSON warning. Browser checks cover PT/EN desktop/mobile,
ordinary/admin, processing recovery, error, proposal/application, keyboard/focus,
scrolling and visual comparison with the existing cycle/shoe CRUD modals.

### Initial local delivery evidence

Final full gates: **`npm test`: 1,205 passed**; **`npm run test:coverage`: 1,205
passed**, zero failures/skips and **100% Statements, Branches, Functions and
Lines** in the required instrumented scope. The existing 48 external-prompt
comparisons remain exact. A final focused foundation/domain/module run passed
56 tests; the dedicated Chrome flow also passed after the final layout changes.
Real `npm run dev` and `npm start` on Node 24.18.0, isolated temporary databases
and free ports returned HTTP 200 with `--trace-warnings` and no
MODULE_TYPELESS_PACKAGE_JSON. `git diff --check` passed.

The first full run caught legacy partial-database migration handling and expected
schema table inventories; these were corrected without dropping assertions.
It also exposed an existing Chrome profile cleanup race (`ENOTEMPTY`): the
feedback browser harness now awaits Chrome exit before removing its temporary
profile. Its behavior assertions were preserved, the isolated suite passed,
and the complete gates were repeated successfully. No screenshots are committed.

The complete diff against updated main was critiqued for source/owner/account
revalidation, application atomicity, historical snapshots/retention, cancellation,
quotas, source mutation/reversion, out-of-order polling, late responses after
close, focus restoration, scrolling/mobile overflow, exact prompt adaptation,
configuration/privacy and documentation. Coordinated corrections included
expired start dates, explicit base-version conflict messaging, scope-safe async
responses and delivery phrases repeated inside user fields. Results above are
local, not GitHub checks or a real-model quality evaluation. No key was available
and no paid evaluation was performed. #64/#65 remain unimplemented.

### PR #69 context-budget review correction

Review of `1b78241` identified unconditional insertion of applied plan prose
before mandatory-report validation. Two regressions (workouts and analysis)
failed with `criticalContextTooLarge` before the correction, despite sufficient
space for their reports and required sources. Policy v5 uses the existing
budget selector for optional planning; see the continuity contract above.

Three added regressions cover extensive phase/adaptation prose, requested
resource and seven-day availability preservation, deterministic partial
architecture selection, complete dated discomfort/RPE, source deduplication,
explicit omissions, insufficient mandatory budgets and immutable v4 snapshots.
A separate synthetic check retained one complete discomfort/RPE 5 report and
seven availability rows in **5,710 / 12,000 bytes**; phase/adaptation details were
explicitly omitted. No default limit increase or paid model call was needed.

Final corrective validation on Node **24.18.0**:

- Targeted context, planning, foundation/prompt and module suites: **62 passed**.
- `npm test`: **1,208 passed**, zero failures/skips.
- `npm run test:coverage`: **1,208 passed**, **100% Statements, Branches,
  Functions and Lines** in the required backend/script scope.
- Existing 48 byte-identical external prompt comparisons and real-Chrome
  suites passed, including PT/EN memory/preview and cycle planning flows.
- Real `npm run dev` and `npm start` with temporary databases returned version
  0.21.0 (HTTP 200), with `--trace-warnings` and no typeless-module warning.
- Complete diff against main and this correction reviewed for ownership,
  transactions, quota/cancellation, selection, compatibility, accessibility,
  documentation and tests; `git diff --check` passed.

These are local software validations with simulated provider responses, not a
model-quality evaluation. Beta remains **0.21.0**; this phase remains available
on the PR #69 branch until merge. No schema/configuration/infrastructure change
or additional automatic review request is introduced by this correction.

### PR #69 presentation and prompt-access correction

Free cycle prompts now enforce the current admin role and ownership on the
backend and every frontend path. Regular creation/edit, language changes and
rerenders do not fetch or expose the prompt. Product generation remains available
to regular owners. The presentation/access contract above describes the icon,
CRUD modal layout, scrollable body and secondary technical inspection.

Local validation on Node **24.18.0**, beta **0.21.0**:

- **196 targeted tests**: cycles/domain/HTTP/UI, product routes, foundation prompt
  comparisons and explicit module boundary.
- `npm test` and `npm run test:coverage`: **1,212 passed each**, zero failures/skips;
  required backend/script coverage **100% Statements, Branches, Functions, Lines**.
  All 48 external prompt comparisons remain byte-identical.
- Real Chrome: PT/EN × regular/admin × **1280, 768 and 390px**, initial/loading,
  processing/reload, proposal/apply, errors, inactive plans, mouse/keyboard
  tooltip, Tab/Shift+Tab, Escape/backdrop, trap/inert, language/focus restoration,
  reduced motion, stale polling and no automatic generation. Regular manual
  creation/edit and forged prompt events produce no prompt request; admin free
  preview/copy does not call the provider.
- Compared rendered cycle/shoe CRUD modals and card controls. Card actions match
  **32×32px**; close controls share dimensions/styles at **30×30px**, with the
  real Lucide x at **18×18px** and calendar-range at the existing 15px icon size.
  Body/footer bounds align and long content has no horizontal overflow. The
  real Lucide **1.59.0** UMD asset was verified locally, outside Git, through
  `KINESIS_TEST_LUCIDE_FILE`; standard automated runs block external CDNs and
  require no downloaded asset. External font CDNs are blocked in the harness;
  reference and product captures use the same font fallback/computed family.
- Initial combined runs exposed test readiness races (asynchronous language and
  reference-page initialization). The harness now awaits the actual localized
  label and loaded reference form, retaining strict behavior/style assertions.
  Both complete gates were repeated successfully.
- Real `npm run dev` / `npm start` with temporary databases returned HTTP 200,
  version 0.21.0, without MODULE_TYPELESS_PACKAGE_JSON. `git diff --check` passed.

No owner screenshots of this screen were attached; visual references were the
existing cycle/shoe screens and shared components. Screenshots remain temporary,
synthetic provider responses are not a model-quality evaluation, and no paid
call or production data change was needed. The complete diff against main was
critiqued for authorization, ownership, all prompt paths, focus/concurrency,
compatibility, source/persistence invariants, presentation, documentation and
tests. This correction does not change schema, prompts, context policy, runtime
configuration or infrastructure. Phase 1 remains unmerged on PR #69.

### Guided-flow correction evidence (2026-10-17)

The approved guided flow above supersedes the earlier creation preview behavior.
Beta remains **0.21.0** and phase 1 remains on PR #69 until merge.

- The new no-op regression failed before correction (`planning_revision` advanced
  from 0 to 1 for identical values). It now preserves the entire cycle row and
  backend plan freshness, including numeric form strings, while change/reversal
  still advances twice and marks the plan outdated.
- **210 targeted tests** passed (cycle domain/HTTP/UI, planning, foundation prompt
  comparisons and module boundary). Final `npm test` and `npm run test:coverage`
  each passed **1,217 tests**, zero failures/skips; required backend/script scope
  is **100% Statements, Branches, Functions, Lines**. All 48 external prompt
  comparisons remain byte-identical.
- Three added real-Chrome regressions cover PT/EN × admin/regular × **1280, 768,
  390px**, confirmed creation, deferral, explicit generate/review/apply, failed
  generation, unchanged/current-plan edits, changed/outdated plans and Keep,
  ready/stale proposals, persisted running work and completion while closed.
  They also cover inactive saves/consultation, disabled AI, failed planning and
  late failed initial-list reads, double submits, language during pending save,
  delayed save/read responses, and lost generation acknowledgements using the
  same per-cycle key without an additional execution.
- Form keyboard checks include initial focus, Tab/Shift+Tab containment and
  Escape closing an open DatePicker before the form. Form/planning never overlap;
  trap/inert and restored focus target the matching visible card. Existing Chrome
  control/style comparisons against cycle/shoe modals, free admin prompt/copy,
  tooltip mouse/keyboard, reduced motion and old polling checks remain active.
  The inactive card's longer PT tooltip is anchored within the viewport.
- Current synthetic screenshots were visually inspected at desktop/mobile and
  intermediate widths. The local visual run uses the same real Lucide asset
  outside Git; ordinary coverage runs block CDNs and exercise the fallback.
  Shared font fallbacks are consistent with the reference screens. No owner
  screenshots were attached. Temporary captures are not committed.
- The complete diff against main was critiqued; coordinated fixes included
  DatePicker Escape priority, accessible form naming, saved-vs-read failure
  boundaries, polling invalidation and a single primary retry action.
  `git diff --check` passed. No schema migration, prompt/schema/context-policy
  change, infrastructure update, paid evaluation or production data write occurs.

Provider responses in tests are simulated, not evidence of model quality. The
new helper under `test/helpers/chrome.cjs` reuses the established Chrome/CDP
pattern without a browser dependency or CI network requirement.

### Noncompetitive-goal correction: one real evaluation

On 2026-10-17, one owner-authorized request used an isolated in-memory development
database, synthetic athlete/goal “run 10 km without participating in a race”, no
history, a 56-day window and no production records. It used the configured
`gpt-6.1-sol`, `cycle-delivery-v2`, medium reasoning, `store:false`, no tools,
60,000 ms timeout, 2,048 output-token ceiling and **zero retries** for a strict
maximum of one provider attempt. Existing consumption reservations/settlement
handled the call. The credential remained inside backend runtime, unprinted.

The provider request reached completion handling but returned `providerIncomplete`:
input **4,373**, output **2,048**, cached **0** tokens; conservative application
estimate **USD 0.052585** (not an invoice). No valid proposal or applied plan was
persisted, and no second request was made. Output reached its configured ceiling;
this run cannot establish the quality of a complete plan. The documented existing
8,192 output-token setting can be selected by the operator for a subsequent
explicit interface evaluation, within current limits; no default or live limit
was changed to conceal this result. The rejection was after the provider request,
distinct from the original pre-call date-validation failure.

Local reproduction: create a synthetic active cycle with objective “Run 10 km
without competition”, optional distance 10 km, and a target 8 weeks ahead. Save,
review the automatic planning step, then explicitly Generate. With no start, the
reference date is used; an earlier saved start also plans from the reference.
Missing/past target reports the exact correction in Edit cycle. Review and Apply
remain separate, and generation failure preserves registration.

Final correction gates on Node 24.18.0: **107 targeted regression tests**, plus the
five new date/HTTP/real-Chrome tests; `npm test` and `npm run test:coverage` each
**1,223 passed**, zero failures/skips, **100% Statements, Branches, Functions,
Lines** in the required instrumented scope. The existing 48 byte-identical prompt
comparisons and module-boundary checks pass. Chrome covers PT/EN personal goals,
canonical dates, error focus, editing, generation and explicit application at
1280/390px; the prior suite additionally checks error relocalization and focus at
768px. The first full run caught an assertion expecting the removed generic date
wording; it now asserts the exact field-specific translation in both languages.
Both complete gates were repeated successfully. The complete diff against main
was critiqued for compatibility, ownership, source freshness, date boundaries,
paid-call ordering, adapter changes, accessibility and documentation;
`git diff --check` and `git diff main --check` pass. No real cycle was changed,
no screenshots/credentials are committed, and beta remains 0.21.0 on open PR #69.

### Result of this investigation's authorized real retest

Exactly **one** new paid-provider request was attempted through one browser Generate
on an isolated temporary application and in-memory database. Authentication used
the supplied test credentials through a non-echoed input channel; credentials are
not in commands, artifacts or this document. Only a clearly marked synthetic
10 km noncompetitive goal and empty history entered context. The original
localhost active cycle, planning, account data and `.env` were not changed.
No proposal was applied. Same model/medium reasoning, `store:false`, strict schema,
60,000 ms timeout and configured retry=1; the sole authorized override was 8,192
output tokens in that instance.

There was **one execution, attempts=1, provider calls=1**. The response did not
arrive within the deadline (transport duration **60,004 ms**), yielding
`providerOutcomeUncertain`, no HTTP status/response ID, no known usage and no
usable plan. The **USD 0.236895** retained is a conservative reservation, **not a
confirmed charge**. The client correlation ID was retained to support provider
investigation. No automatic or manual retry followed. The instance was closed;
the synthetic evaluation summary contains no credentials or athlete data.

The observed deadline exposed another diagnostic gap: timeouts and other network
errors shared one code. The final client now checks the abort signal and emits
`providerTimeout`, transport reason `timeout`, including a timeout during body
receipt (retaining any HTTP/request ID already available). Both retain uncertain
billing and never retry. Simulated abort/body-deadline tests reproduce this
without more paid calls. The earlier incomplete response and this later timeout
are different failure stages; neither is a schema/domain refusal or proof of a
duplicate provider request.

For a **future, separately authorized** evaluation, the operator can consider
`AI_MAX_OUTPUT_TOKENS=8192` and `AI_TIMEOUT_MS=120000`, both within existing bounds,
with daily limits reviewed first. This is justified by observed exhaustion at
2,048 and the subsequent 60s deadline, not a claim that 120s guarantees a valid or
useful plan. No live/default limit or retry rule was changed. No second paid test
is performed in this investigation. Real generation **did not pass**; quality of
a complete plan remains unvalidated.

### Final validation of the diagnostic correction

On Node 24.18.0, **69 targeted backend/foundation/module tests** passed; additional
Chrome diagnostics cover PT/EN, admin/regular, 1280/390px, one call per explicit
click, exact limit/timeout alerts, protected metadata, retained applied version,
and a failed subsequent read recovered without a new generation. The existing
lost-acknowledgement/idempotency, 429/cancellation, ownership and prompt suites
remain active. A real read-only login to the supplied localhost account and the
single isolated paid browser evaluation are distinguished from simulated tests.

Final `npm test` and `npm run test:coverage` each passed **1,236 tests**, zero
failures/skips; instrumented scope is **100% Statements, Branches, Functions,
Lines**, with all 48 exact external prompt comparisons. `git diff --check` and
`git diff main --check` passed. Current screenshots were inspected using the
existing modal/error styles, without new CSS; standard harness runs block external
fonts/icons, as in prior visual checks. Captures remain temporary and synthetic.

Earlier runs exposed temporary Chrome-profile cleanup contention and a fixture
starting another adapter before stopping its previous worker; cleanup now retries
bounded filesystem removal after process exit and the fixture stops its worker.
A Request Workouts focus assertion also failed once under concurrent runs; its
unchanged isolated suite passed, and the complete final gates passed. No assertion
was removed. The new browser test now waits for persisted language and the new
terminal action, rather than mistaking a previous failure for the new result.
The product hides the old terminal alert while an action is pending and uses its
existing Loading state. The complete diff was critiqued for authorization,
privacy, accounting/rollback, retries/concurrency, migration/retention,
accessibility, compatibility and documentation, with findings corrected together.
Beta remains **0.21.0**; PR #69 stays open and unmerged. No new automatic review
request or further paid call is made.


## End-to-end real evaluation (2026-10-18)

This supersedes the earlier **evaluation result**, not its historical evidence or
accounting. The runtime code evaluated was `8912104` (beta 0.21.0); this follow-up
changes only the configuration example, its regression test and documentation.
PR #69 remains unmerged. No second new call was needed.

### Isolation, preflight and effective configuration

A temporary development application used a separate SQLite file and the supplied
test login solely for authentication, with synthetic account presentation and an
empty training history. Through real Chrome, an active cycle was saved with the
goal of running 10 km **without competition**, no start date and target 2026-12-13.
The effective inclusive window was 2026-10-18–2026-12-13. The real/personal cycle,
main `.env` and production were untouched; no credentials or captures are committed.

Before Generate, the actual context, unchanged external prompt, adapter and strict
payload were built offline. The complete input byte bound plus protocol allowance
was 22,833; the existing conservative rate ceiling reserved **USD 0.237045**, below
the authorized USD 1.00 total. Saving/opening produced **zero executions/calls**.
The application reserved consumption atomically before dispatch.

| Effective setting | Value |
| --- | --- |
| Model / reasoning | `gpt-6.1-sol` / `medium` |
| Output / timeout | 8192 tokens / 120000ms |
| Retries / provider attempts | 0 / 1 maximum |
| Concurrency user/global | 1 / 1 |
| Daily USD user/global | 1 / 1 |
| Daily call user/global | 2 / 2 |
| Daily tokens user/global | 100000 / 500000 |
| Context budget | 12000 conservative bytes |
| Adapter / context / schema | cycle-delivery-v2 / training-context-v5 / cycle-plan-v1 |
| API | foreground Responses, `store:false`, strict JSON schema, no tools |

Current [model](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[reasoning](https://developers.openai.com/api/docs/guides/reasoning?api-mode=responses)
and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
documentation was checked before spending. Medium reasoning and strict output
are supported; the output limit includes reasoning and visible content. Limits
were selected from the two earlier failures, not increased indefinitely. The
existing conservative rates were retained; no fallback or schema change was made.

### Actual result and accounting

One explicit Generate created **one execution, one attempt and one provider call**:
`024da62e-f4d4-4e32-bf82-e27acc5b2121`, client correlation
`kin_024da62e-f4d4-4e32-bf82-e27acc5b2121_1`. Provider request/response IDs were
retained in the isolated execution's protected diagnostics, not generic logs.
HTTP 200, provider `completed`, duration **78,479ms**, one JSON text of 13,008 bytes.
Parsing, strict shape, cycle identity, dates, continuity and source-reference
validation passed; the proposal appeared in the product modal.

Known provider usage: **4,409 input, 2,989 output, 0 cached tokens**. The output
already includes **165 reasoning tokens**; they are not counted twice. The
application reconciled its reservation to **USD 0.06688 estimated cost** using the
saved conservative rate ceiling. This is a reported-usage estimate, **not a
confirmed provider invoice**. There were no new uncertain attempts in this run;
the preceding investigation's USD 0.236895 uncertain reservation remains a
separate historical amount, not an additional known charge or a refund.

The complete proposal was read before explicit application. Four phases cover
the whole inclusive window without gaps/overlap: verify current capacity, build
conditionally, approach 10 km, then assess readiness for the personal goal.
Each cites the selected cycle. The proposal acknowledges absent history and
availability, uses `insufficient_data` confidence and conditional checkpoints,
never invents a race, completed sessions, prior volume or recovery. It supplies
adaptation criteria and questions instead of distant fixed weekly mileage.

**Observed quality limitation:** one phase expresses easy effort as RPE 2–4/10,
while Kinesis records RPE 1–5. At the time of that v2 evaluation, the free-text validator did not enforce
semantic scale consistency. The subsequent [v3 correction](#rpe-compatibility-cycle-delivery-v3)
rejects those explicit references and excludes affected saved guidance. No saved output was silently edited or converted;
application below is exclusively a synthetic persistence test, not endorsement of
this prescription. The sample therefore establishes a working product path, not
full coaching-quality acceptance. Explicit scale grounding and semantic quality
evaluation remain necessary before treating such advice as directly aligned with
Kinesis feedback; one sample cannot measure reliability across athletes/histories.

### Review, explicit application and recovery

After review, the existing **Apply proposal** action created version 1. A full
page reload followed by the cycle card action recovered the identical applied
JSON/version from SQLite. Reapplying the same proposal with the original expected
version returned `{appliedVersion:1,alreadyApplied:true}`; the database still held
exactly one version. No generation happened during apply, reload or reopening.

Both future `workouts` and `analysis` contexts recovered version 1 with
`authority:applied_planning`, current source provenance and explicit omissions for
three phases outside the near-term detail window. No training record was created
(count remained zero), and plan-local athlete assessments stayed excluded from
those contexts. This verifies the continuity contract without implementing
weekly/analysis generation.

Chrome inspection covered proposal and applied states, PT/EN UI at 1280/768/390px,
including reload, translated headings/date presentation, long-body scrolling to
the end, no horizontal overflow, Tab/Shift+Tab containment and Escape restoring
focus to the correct cycle planning card control. The generated Portuguese text remains Portuguese when
switching UI language; it is a persisted artifact, not paid translation. Ordinary
accounts have no technical prompt control. Existing Lucide was injected locally
for visual inspection (close 30×30, icon 18×18); external fonts were blocked by the
standard harness. Captures are temporary, never fixtures or PR attachments.

At the time of this evaluation, the example supplied the demonstrated
output/timeout values without enabling AI or supplying a key, while backend and
Compose fallbacks were 2048/60000. The later configuration correction below
aligns all three defaults. Existing explicit values still take precedence and
must be changed in the actual runtime environment; editing an example does not
change an existing container. Neither 8192 nor 120s guarantees success for all
input histories.


### Final verification of this follow-up

On Node 24.18.0: 56 offline planning/route/prompt tests passed before payment;
69 targeted tests passed after the example correction. The new example regression
failed before the fix (`2048 !== 8192`) and passes with evaluated settings while
keeping the feature disabled and the key empty. Final `npm test` and
`npm run test:coverage` each passed **1,237 tests**, zero failures/skips; required
Statements, Branches, Functions and Lines are **100%**. All 48 deterministic
external prompt comparisons remain exact. Automated providers are simulated;
they are separate from the single real call and proposal review above.

Real isolated `npm run dev` and `npm start` returned HTTP 200/version 0.21.0 with
`--trace-warnings`, without MODULE_TYPELESS_PACKAGE_JSON or a paid startup call.
`git diff --check` and `git diff main --check` passed. The complete PR diff and
this follow-up were critiqued against authorization, source freshness,
transactions/accounting, retries, compatibility, focus, privacy and documentation;
prior runtime corrections remain intact. This follow-up changes no runtime code,
training prompt or schema, and does not increment the same PR's beta version.
Only the public example/test/documentation are committed; private temporary
SQLite, screenshots and credentials remain outside Git. No new automatic review,
merge, deployment or additional paid generation is requested/performed.


## End-to-end final v3 evaluation (2026-10-24)

### Runtime and spending boundary

The executed runtime was **8dd42352acc145960fdc81a32ded8561f253680c**, beta
**0.21.0**, matching the open PR's HEAD before this documentation-only follow-up.
No runtime code, prompt, configuration default, schema or production setting was
changed. A temporary development process and separate SQLite file used the
authorized test login solely for authentication and synthetic account presentation.
No personal cycle/history was copied or modified. The API key stayed in backend
runtime; neither its value nor credentials, payloads, private records or captures
are versioned.

The effective persisted payload/configuration, not just `.env.example`, confirmed:

| Setting | Executed value |
| --- | --- |
| Adapter / context / schema | `cycle-delivery-v3` / `training-context-v5` / `cycle-plan-v1` |
| Model / reasoning | `gpt-6.1-sol` / `medium` |
| Output ceiling / timeout | 8192 tokens / 120000ms |
| API | Responses, `store:false`, foreground, strict JSON schema, no tools |
| Retries / concurrency user and global | 0 / 1 and 1 |
| Daily call caps user and global | 1 and 1 |
| Daily USD caps user and global | 0.50 and 0.50 |
| Context bound / daily token caps | 12000 bytes / 100000 user, 500000 global |

There was no queued/running work before this evaluation. Offline preparation
validated the adapter/window and built the exact payload, including its explicit
RPE 1–5 instruction. The conservative complete-input bound plus protocol allowance
was **23,071**; the existing execution ledger reserved **USD 0.238235** before
dispatch, below the authorized **USD 0.50** ceiling. One-attempt instrumentation
also refused any second provider invocation. The configured native client was
used unchanged; no simulated provider replaced this call. Official
[model](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
contracts were checked before the request; medium reasoning and strict output
remain supported. There was no fallback, deployment or main `.env` edit.

### Real browser sequence and result

Real Chrome created a clearly identified synthetic active cycle: **run 10 km
without competition**, no saved start, target **2026-12-19**, eight weeks after
the test. The inclusive planning window was **2026-10-24–2026-12-19** (57 days).
Saving opened planning; **Not now** closed it without undoing registration. The
card icon reopened it. At that point there were **zero executions and zero
provider calls**. One explicit Generate click created one execution:

`c6902a4b-b3b1-4f4a-a695-484362f607d8`, client correlation
`kin_c6902a4b-b3b1-4f4a-a695-484362f607d8_1`.

A full reload while its persisted state was `running` and reopening planning
recovered that same execution/polling. There was no second execution or call.
The provider returned **HTTP 200 / completed** in **61,597ms**, with one JSON
output text (13,587 bytes). Parsing, schema, cycle identity/window, contiguous
phases, source references and the current RPE/domain validator all passed.
Provider request/response IDs remain in the isolated protected diagnostics;
generic logs and public evidence contain no full prompt or response.

Known usage reported by the provider was **4,463 input + 3,148 output, 0 cached
tokens**. The output includes **151 reasoning tokens**, counted once. The ledger
reconciled the reservation to **USD 0.069535 estimated cost** under the saved
conservative rate ceiling. Reservation and usage-based estimate are distinct;
provider invoice/final billed amount was not accessed. This evaluation had
**one real call, one execution, one attempt, no retry and no uncertain outcome**.
Earlier incomplete/timeout attempts remain separate historical evidence.

### Content review and RPE

The entire real proposal was read before application. Four ordered, gapless
phases cover the exact window: identify the starting point, consolidate
continuity/endurance, conditionally approach 10 km, then adjust recovery and
decide whether to attempt the personal goal. Every phase cites the selected
cycle. The plan recognizes absent history/availability, uses `insufficient_data`
confidence and conditional progression, and does not invent completed training,
prior volume, recovery or a race. The continuous-running interpretation is an
explicit provisional assumption to confirm, not a claimed user fact.

**The model did mention numeric RPE.** Phase intensity text uses **RPE 1–2** and
optional moderate **RPE 3**, explicitly on the **1–5** scale; indicators/questions
also identify that scale. Review of all narrative fields found no RPE/10, 0–10
scale or value above 5. The same saved output passes `rpeIssue` without conversion,
rewriting or suppression. Thus this sample demonstrates compatible real numeric
references under v3, not merely absence of RPE. The bounded guard and one sample
do not prove every semantic claim, physiological suitability or reliability for
all athletes. Synthetic tests remain the evidence that incompatible outputs are
refused, known usage retained and automatic retries prevented.

### Application, recovery, continuity and interface

After review, explicit browser Apply created **version 1**. Reloading/reopening
recovered identical plan JSON and version. Repeating the authorized apply request
with the original expected version returned
`{appliedVersion:1,alreadyApplied:true}`; exactly one applied version remained.
Apply, reopen, polling, language changes and reads created no extra provider call.

Before language-variation checks, both future `workouts` and `analysis` contexts
identified this version and originating execution with `authority:applied_planning`,
correct source/hash, `outdated:false` and **no RPE compatibilityError**. Two relevant
phase details were selected; two outside the task window were explicitly omitted.
This is planning guidance, not completed work. Training/calendar record count
remained **zero**. A separate synthetic administrative ownership control did not
change the generated owner's plan; real/personal data remained outside the instance.

Saved-result inspection covered **PT/EN at 1280, 768 and 390px**, scroll to the
end, no horizontal body/page overflow, 30×30 close control / 18×18 Lucide x,
Tab/Shift+Tab containment, Escape and focus restoration to the correct planning
icon. Its translated custom tooltip appeared on focus/hover with no native title.
Labels and dates relocalize; persisted Portuguese generated prose stays Portuguese,
without a paid translation. Existing Lucide was injected locally; the standard
Chrome harness blocked external font/CDN requests. Screenshots remained temporary.

The ordinary account had no prompt action in the DOM or visible technical debug.
On the running instance its prompt, execution-debug and technical-context requests
returned **403**; anonymous prompt/debug returned **401**. A separate synthetic
admin accessed its own free prompt (**200**) but the generated owner's prompt and
execution debug returned **404**. Existing mocked route tests additionally confirm
admin own-execution inspection. No authorization check generated another plan.

### Verification and limitations

The eight targeted RPE tests passed, followed by **44** planning-route,
foundation/prompt and real-Chrome RPE-refusal tests: **52 tests total**, zero
failures/skips. The foundation comparisons preserve all **48** external prompt
outputs byte for byte. Their provider responses are simulated, distinct from the
single successful real call above. Full `npm test` and four-metric 100% coverage
results at the unchanged runtime HEAD remain the **1,247-test** gates recorded in
the preceding RPE correction; they were not rerun for this documentation-only
follow-up. `git diff --check` passed.

No functional defect or concrete blocker to the tested integration path was found.
This is one synthetic empty-history case with the explicit operational settings,
not broad coaching-quality, production deployment or performance certification.
At that point, unset legacy 2048/60000 fallbacks were still not the validated
full-plan setup. The configuration correction below supersedes that operational
guidance. No new weekly workouts/analysis generation, automatic review request
or merge was performed.

## Configuration, 429 recovery and failure UX follow-up

This follow-up is implemented on the existing #69 branch and has not been
merged. Backend parsing defaults, `.env.example`, and Compose fallbacks now agree
on `AI_MAX_OUTPUT_TOKENS=8192` and `AI_TIMEOUT_MS=120000`; AI remains disabled by
default. Explicit operator values continue to take precedence. Update the actual
dotenv/Compose/shell/hosting configuration and recreate the container; changing
`.env.example` alone does not change a running process. Model, reasoning, quotas,
reservation policy and deployment infrastructure are unchanged. No deployment
or paid model call was made in this follow-up. The successful 2026-10-18 real
evaluation remains evidence for runtime `8dd42352acc145960fdc81a32ded8561f253680c`
only, not for code changed afterward.

Only an explicit HTTP 429 can be retried, and only within the execution's saved
`AI_RETRIES` allowance. A valid `Retry-After` in seconds or HTTP-date is honored
for 1–60 seconds; a longer requested wait ends the execution with temporary
unavailability rather than retrying early. Missing/invalid headers use bounded
exponential backoff with jitter (one-second minimum, 30-second cap). The due time
is stored in the existing queued execution timestamp; no transaction remains
open during the wait. Restart resumes the remaining wait. Cancellation and the
retry decision remain transactional; before another call the worker rechecks
current account activity, ownership, source versions, adapter, quota and the
existing reservation. Reservations are held through the wait. Timeout/uncertain
transport, 5xx, refusal, incomplete/invalid/RPE-incompatible output and
persistence failure never replay automatically.

PT/EN cycle planning now explains queued/running and 429 wait without invented
progress, allows closing/reopening the same execution, and exposes cancellation
while the execution is pending. A failed progress read is distinct from a
generation failure; **Try loading again / Tentar carregar novamente** only reads
the existing execution. Temporary provider unavailability, uncertain outcomes,
invalid proposals and persistence failures have separate user-facing messages.
Applying a still-valid proposal remains retryable without calling the provider.
Identical polling updates do not rewrite the polite live region. The existing
Chrome flow and diagnostic browser suites cover PT/EN, responsive widths,
recovery and error states with simulated provider responses; this follow-up has
no real-call or coaching-quality claim.

## Per-cycle planning status (current PR branch)

The card's **Active / Ativo** badge still describes the cycle lifecycle only.
Planning appears on its own metadata row: the localized **Planning: /
Planejamento:** label uses the same strong-label style as other cycle metadata,
followed by a short state value in the existing neutral `.cycle-status` badge.
Any update or proposal note appears beneath it in the existing secondary
helper-text style. This keeps the planning state legible without changing cycle
activation. An active cycle can correctly show no plan, pending work, a
proposal, an applied plan or an issue
without changing activation or manual cycle use. The existing planning icon is
the only action and always opens the product modal; generating remains an
explicit modal action. Listing, opening, updating the status and changing locale
do not call the provider.

`GET /api/cycles` returns each owned cycle with a compact `planningSummary`:
`status`, `secondary`, `available` and `canGenerate`. It contains no plan,
response, prompt, execution context, usage or diagnostic payload. A failed
summary read is represented as `status: read_error`; the cycle is still returned.
The UI does not replace a previously confirmed state with a polling read error.
The same summary is included in the existing planning read; successful saves
also return it, while a post-save summary read failure cannot turn the saved
cycle into a failed registration.

The primary status has one deterministic priority: a persisted applied version
always wins, classified as current, outdated by source fingerprint, or
incompatible with RPE 1–5. Without an applied version, the backend scans at most
the newest 20 proposals in descending sequence and selects the first unapplied
proposal that is based on the current applied version, completed, fresh, RPE
compatible, identical to its persisted proposal JSON, and valid against its
saved context and cycle domain. That candidate remains visible if a later
attempt failed. If none is usable, pending work precedes a terminal/incompatible/
stale result; otherwise the summary reports no plan or unavailable AI. Inactive
cycles remain readable and set `canGenerate: false`.

When an applied plan exists, a pending update, a new usable proposal, a failed
update, or AI unavailability is a separate short secondary status; it never
replaces the applied plan's primary state. Source changes and RPE incompatibility
have distinct primary states. Stale, conflicting, invalid and incompatible
proposals are never selected for Apply. The modal continues to show diagnostics
and reasons; cards do not become a diagnostic panel.

The modal's existing poll updates its card. If it closes while work is pending,
the page polls the existing cycle list as one request at a time, only while the
page is visible and at least one cycle is pending; it stops when no pending state
remains. Opening the modal cancels that list poll. Stale list responses and
failed reads cannot overwrite a newer per-cycle summary. The summary does not
alter freshness, compatibility, version-base, ownership or application rules.
It summarizes current backend artifacts and makes no additional paid call.
