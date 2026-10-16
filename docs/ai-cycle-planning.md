# Cycle planning — issue #63

Status: **implemented on `feat/issue-63-cycle-planning`, not integrated until its
PR merges**. Beta **0.21.0** builds on phase 0 merged in PR #67 (`648d6a0`).
Weekly generation #64 and result analysis #65 are not implemented here.

## Product flow and existing sources

Cycle registration (`src/cycles.js`, existing `/api/cycles` CRUD) still records
objective, goal, target/start dates, distance, previous experience at that distance
and other events. It works without AI. The new **Long-term planning** action on
the same cycle card opens the existing modal structure, shared controls and theme.
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
Local cancellation does not guarantee that provider billing stops. A lost POST
response reuses the same idempotency key while that action remains open; a known
new request receives a new key. No paid call runs automatically on load or restart
except untouched queued work under the existing recovery contract.

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

`cycle-delivery-v1` changes exactly three delivery spans of the original PT/EN
macrocycle prompt, leaving its 22 numbered sections and coaching content intact:

1. “Plan in detail only the current/next week” becomes architecture only for this
   operation (weekly calendars belong to #64).
2. The first-response delivery line maps A–F, in the original order, to schema fields.
3. The summary-table delivery sentence maps its columns to structured phases.

The transformations are explicit/versioned and tested as an allowlisted diff,
including user fields containing matching delivery sentences: only the final
fixed-template occurrence is changed.
The external generator is unchanged, including weekly/analysis prompts. All
external baseline comparisons remain byte-for-byte tests. Existing free external
prompt generation/copy remains available; administrators additionally inspect
only their own exact execution payload/context, original external prompt,
adapter/model versions, sanitized errors and usage/cost in the planning modal or
Training memory debug. Common accounts never receive those technical payloads.

## Persistence, concurrency and retention

Idempotent migration `2026-10-cycle-planning-v1`, invoked by database
initialization, adds `training_cycles.planning_revision` (initial zero) and:

- `cycle_plan_proposals`: owned cycle/execution, monotonically ordered sequence,
  base applied version, creation time and nullable validated plan JSON.
- `cycle_plan_versions`: explicitly applied proposal ID, version, accepted plan,
  originating context/cycle hashes, minimal context freshness fingerprint,
  source references and application time.

No existing cycle, profile, training, session or historical execution is rewritten.
Every actual cycle edit increments its revision, even for edits in the same
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

Use the integrated backend `OPENAI_API_KEY`, `AI_ENABLED=true` and
`AI_MODEL_CYCLE` (default `gpt-6.1-sol`), with no fallback. No new secret or runtime
setting is introduced. For the first real trial use **AI_MAX_OUTPUT_TOKENS=8192**
(the existing upper bound, includes reasoning); the preserved default 2048 may
be insufficient for the complete A–F plan and then fails explicitly without
application. Review the existing daily token/call/cost limits before enabling.
`AI_TIMEOUT_MS` remains bounded; a timeout is uncertain, not an automatic retry.
`.env.example` documents the trial setting without changing defaults or Compose.

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
returns `cycleNotActive`/`invalidPlanningDates` (400), existing quota/concurrency
(429), disabled/invalid configuration (503), context budget (413), and sanitized
provider states. No partial plan is applied on any failure.

## Real evaluation and local verification

No authorized provider key was present during implementation. No paid call was
made, and simulated outputs are not evidence of model quality. The browser and
automated suites exercise contracts, not physiology or provider access.

For the first small real evaluation, using only synthetic or explicitly permitted
athlete records and a development database:

1. Install dependencies, set backend runtime key, AI_ENABLED=true,
   AI_MODEL_CYCLE=gpt-6.1-sol, AI_MAX_OUTPUT_TOKENS=8192; run `npm start` on Node 24.
2. Create/edit an owned active cycle with a future target and optional start date.
   Leave history absent first. Open Long-term planning and generate once. Reload
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
scrolling and visual comparison with the existing cycle/prompt modals.

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
