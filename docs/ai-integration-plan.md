# Kinesis AI integration plan

Status: documentation integrated via PRs #66 and #68; phase 0 implemented on branch
`feat/ai-phase-0-foundation`, validated locally, pending PR review and merge.
Phases 1–3 remain planned. This branch is not integrated into main.
Owner-approved direction: 2026-10-14; memory correction approved 2026-10-15 (#68).
Baseline reviewed: main application version 0.19.6.

This is the shared implementation contract for integrating OpenAI into Kinesis.
Read [README](../README.md) and [AGENTS](../AGENTS.md) in full before work.
The issues specify phase deliverables; this document owns cross-phase decisions.
Do not change this plan to justify an implementation deviation. Product,
privacy, training-prompt or architectural changes require an explicit owner
decision. Ordinary implementation choices within these boundaries may be made
and documented by the implementing agent.

## Delivery order and tracking

| Phase | Issue | Dependency | Status |
| --- | --- | --- | --- |
| 0: API foundation and training memory | [#62](https://github.com/fracon/training-assistant/issues/62) | Documentation plan/correction merged (#66/#68) | Implemented in [open PR #67](https://github.com/fracon/training-assistant/pull/67); not integrated |
| 1: Cycle planning | [#63](https://github.com/fracon/training-assistant/issues/63) | Phase 0 merged | Planned |
| 2: Weekly workout requests | [#64](https://github.com/fracon/training-assistant/issues/64) | Phase 1 merged | Planned |
| 3: Contextual workout analysis | [#65](https://github.com/fracon/training-assistant/issues/65) | Phase 2 merged | Planned |

Implement sequentially. Each agent must inspect local changes/worktrees, fetch
the remote, safely fast-forward local main after prerequisite merges, and create
a dedicated branch from that updated main. Never discard existing work,
untracked files or personal attachments. Never force-push to work around a
divergence. Open a separate PR against main and leave it open for owner review.
A large phase may use smaller dependent PRs within its issue.

Mark status as planned, implemented in an open PR, or integrated, with evidence.
An open PR or passing local tests is not a completed merge. Functional releases
stay in beta 0.x and follow AGENTS SemVer rules against the actual main version.
The documentation-only PR left application version unchanged. The functional
phase 0 branch increments beta to 0.20.0.

## Intended experience

Users act in the existing cycle, Request Workouts and training-result screens.
Do not introduce a generic chatbot, MCP server or new visual system.

1. Generate a cycle proposal, review it, then apply it to the owned cycle.
2. Generate a weekly proposal using the cycle and actual training history,
   review it, then add workouts to the calendar.
3. Save a workout result and obtain an analysis linked to that session.

Applying a plan is distinct from generating it. No model directly writes to the
database, modifies results, grants permissions or overwrites a calendar.
Generating an analysis must not automatically alter future workouts.

## Shared architecture

Use the OpenAI Responses API from the Node/Fastify backend with
`store: false`. Kinesis/SQLite is the source of truth for context, plans,
responses and execution history. Do not assume access to a user's ChatGPT
conversations or implicit provider memory. An SDK may be added when justified;
no frontend framework, vector database or external queue service is required.

The request pipeline is:

1. Authenticate and load current account/owner-scoped records.
2. Build a versioned context snapshot and render the existing training prompt.
3. Apply the explicit API output/delivery adapter.
4. Reserve usage allowance and persist an execution.
5. Call OpenAI outside any SQLite write transaction.
6. Validate the complete response and persist the outcome.
7. Return/poll the outcome and explicitly apply proposals where applicable.

Use durable execution states and a bounded worker/polling mechanism compatible
with the current single-container deployment and Cloudflare Tunnel. A browser
reload must recover progress/results. Define restart recovery, timeouts,
terminal failures and uncertain provider outcomes; never blindly replay a
possibly completed paid request. Do not promise exactly-once provider billing.
Local application of a result must be idempotent.

Recheck current account activity, ownership and relevant source versions at
dispatch, result access and application. Deletion or revocation during a network
call must not recreate records or authorize a stale operation. No long-running
network call may hold a database write lock.

Treat athlete notes, external weather data and model text as untrusted data,
not instructions that override application rules. Do not expose an arbitrary
prompt/model/tool proxy. Render model responses safely.

## Runtime configuration and data boundary

Phase 0 configuration is implemented on this branch; see the complete settings,
defaults and bounds in [AI foundation](ai-foundation.md). Paid product adapters
remain unregistered until their individual phases:

- `OPENAI_API_KEY`: server-only secret injected into the running container.
- `AI_ENABLED`: explicit feature switch.
- `AI_MODEL_CYCLE`, `AI_MODEL_WORKOUTS`, `AI_MODEL_ANALYSIS`: configurable,
  server-validated model choices.
- Bounded output, concurrency, per-user/global usage and timeout settings,
  whose final names/defaults must be documented in phase 0.

The key must not be baked into an image, Dockerfile ARG/ENV, frontend bundle,
committed .env, response or log. Compose may pass runtime environment values;
.env.example contains placeholders only. Preserve host 8081 -> container 3000,
the non-root runtime user and the persistent data volume. Missing key or disabled
AI must not break ordinary account, calendar, import or result operations.

The owner authorizes a narrow future exception to local-first privacy: selected
structured training context and prompts may be sent to OpenAI for these three
user-triggered operations. FIT/ZIP binaries, raw GPS tracks, credentials and
unnecessary identifiers must remain excluded. FIT decoding, metrics and
aggregations remain local. Keep weather queries limited to the location/time
information required by the provider; other integrations retain their current
limits. Do not send private athlete context to web-search queries.

Document actual data transmission before enabling each operation, without
inventing repeated consent dialogs. `store: false` is not a promise of zero
provider retention; link current provider policy. Local prompt/debug snapshots
also contain personal data: protect them, define retention and cleanup, and
remove owned AI/profile data on account deletion. A deleted account's in-flight
work must not recreate its data.

## Training memory: a transparent, evolving view

Owner correction, 2026-10-15: memory is a readable and correctable view of the
athlete context assembled from application use, not a second profile form.
This replaces the original requirement for manually maintained goals,
preferences, limitations and generic dated observations. The revised phase 0 implementation in open PR #67 applies this correction;
it remains subject to review and is not integrated into main.

Before adding any field, inventory existing sources, their owner, update flow,
temporal meaning and consumers. Reuse that source. Document a concrete missing
need before proposing a new field. Do not create parallel facts that can
contradict an existing cycle, availability record or workout feedback.

| Information shown | Authoritative source | Correction path |
| --- | --- | --- |
| Goals and target event | Current cycle; applied plan when available | Open/edit the cycle |
| Available days, preferred period, maximum duration and place | Request Workouts availability | Open/edit availability |
| Recorded metrics and execution | Saved sessions and canonical results | Open the corresponding session |
| Discomfort and subjective feedback | Dated session feedback | Open/edit the feedback at its source |
| Previous running experience | Optional user-supplied background not available in Kinesis | Edit this supplemental field directly |
| Trends and totals | Deterministic computations over source records | Inspect/correct supporting records |
| AI patterns and recommendations (later phases) | Versioned model interpretation with evidence | Confirm, correct or dismiss the interpretation |

All three operations share one context service. The user-facing memory page
may remain, but must become a useful consolidated view, not an empty form
requiring the athlete to repeat information. Use clear localized explanations:
training history is assembled automatically; prior experience is optional.
Each displayed item has an origin, relevant date/range, update/version and a
link to its source where applicable. Empty states say what is missing and link
to the existing workflow; they never imply model knowledge that does not exist.

Ordinary users can inspect their own consolidated profile/context. This is
distinct from the exact purpose-specific payload of an execution, available
only through administrator debug. Explain that actual selection depends on
the task and budget; the overview is not a promise that every record is sent.
Build both from the same source mapping, so the overview does not become another
independently maintained memory.

### Phase 0 boundary and correction

- Keep the API foundation, store:false, prompt preservation, execution controls,
  provenance and historical-context selection.
- Remove duplicate manual goals, generic preferences and limitations fields
  from the new memory UI and API contracts. Do not simply hide active duplicate
  sources behind the same context builder.
- Remove generic manual CRUD for restrictions, milestones, interruptions and
  performed actions from this phase. Reuse actual cycles, sessions and feedback.
  A gap in recorded workouts does not supply an interruption reason.
- Keep only optional previous-running-experience input, with ownership and
  version checks. The page otherwise reads current source data and directs
  corrections back to the relevant existing screen.
- Do not create paid background summarization, generated profile narratives,
  an AI interpretation editor or new inferred diagnoses in phase 0.
- Keep administrator technical debug visually separate from the athlete view.
- Preserve existing development/test records safely: inspect schema/data usage
  and document compatibility or migration before removing fields/endpoints.
  Do not drop user-entered data silently or reinterpret old duplicate fields
  as authoritative facts. Existing stored values must not keep influencing new
  contexts unnoticed. Historical execution snapshots remain traceable.

### Evidence and evolution

Facts, user reports, AI interpretations, recommendations and actual execution
remain distinguishable. A suggestion to rest is not evidence of rest.
An unrecorded session is not proof of rest; absence of a discomfort report is
not proof of recovery. A dated discomfort report is not a permanent limitation
or diagnosis. Present date and uncertainty; do not invent an active/resolved
status from age or silence.

The profile evolves as source records change. Refresh/rebuild derived context
from those records without a paid model call. Correcting cycle or feedback
updates future context and invalidates stale derived views as needed, while
past execution snapshots retain the inputs actually used.

When phases 1-3 produce interpretations, keep them dated, versioned and linked
to evidence and originating execution. Display them as interpretations, not
facts, and provide owner-scoped confirm/correct/dismiss actions with concurrency
protection. Confirmation means user endorsement, not objective measurement.
A correction is a dated user statement attached to that interpretation; it
must not rewrite underlying measurements or silently become a permanent rule.

Corrected or dismissed interpretations must not re-enter active context merely
because an older response or summary repeats them. Keep the original snapshot
for traceability but apply the current disposition when building future inputs,
including retrieval from historical analyses. New evidence may support a new
explicitly distinguished interpretation; it must not silently reactivate the
old one. Define/test evidence identity and supersession when the first such
producer is implemented. No separate paid calls solely to maintain memory.

### Context selection

Initial selection policy:

- Approximately two weeks of detailed sessions.
- Eight to twelve weeks of computed weekly aggregates and relevant events.
- Older milestones/target events and dated reports relevant to the task.
- Comparable sessions, such as earlier long runs, with condition differences.

These are evaluation starting points, not medical or retention rules. Use a
documented deterministic policy and token budget. Prioritize relevant user
corrections, cycle objectives and source-backed recent concerns; disclose
omissions, missing coverage and historical cutoffs. Never silently discard
critical context or double-count detailed and aggregated records.

Compute totals/trends locally from canonical units. Narrative interpretations
must retain sources and labels. Do not recursively summarize summaries into
untraceable facts. Start without embeddings or separate retrieval infrastructure.

Save each execution's selected source IDs/versions, date ranges, derived facts,
omissions and exact rendered input. Source edits affect future inputs and mark
outdated responses appropriately. No source edit triggers an automatic paid
regeneration.

## Prompt preservation and API output

Existing prompts are core product behavior. Inventory all weekly, cycle and
analysis generators, including frontend and backend variants. Capture stable
PT/EN examples, extract reusable pure generators, and prove byte-identical
external prompt output for equivalent inputs during refactoring.

Do not silently rewrite coaching instructions, examples, numbering, language,
RPE rules, units or the existing hill guidance. Separate presentation copy from
prompt copy. Kinesis supplies context explicitly instead of assuming an external
chat knows the athlete.

The API needs a separate, versioned delivery adapter:

- Preserve the external prompt for administrator inspection/copying.
- For integrated plans, replace only conflicting delivery instructions such as
  producing a downloadable Excel link with a defined structured response.
- In phase 2, explicitly adapt weather execution instructions to consume verified
  backend forecast evidence and bounded fallback research; preserve all forecast
  verification requirements and expose this difference in debug.
- Show the exact model input, including context and adapter, in protected debug.
- Test an allowlisted/deterministic diff for permitted delivery changes; do not
  hide conflicting instructions by appending unrelated JSON instructions.

Use structured outputs where useful, followed by domain validation.
A schema-valid response can still have wrong dates, unavailable training days,
invalid units or unsupported claims. Handle refusal, incomplete/truncated
responses and provider errors without partial application or retry loops.

## Administrator debug and authorization

Admins must retain free local generation, reading and copying of prompts in all
three workflows. Also allow inspection of their own execution's exact prompt,
context, adapter/version, model/settings, token usage, estimated cost and
sanitized errors. Ordinary users receive the product result, not debug payloads.

Enforce the current database role and ownership in the backend, not only the UI.
Admin debug grants no cross-user training access. Keep credential values out of
debug entirely. Avoid introducing a broad administration dashboard in this plan.

Phase 0 must not prematurely remove existing prompt workflows. Each functional
phase introduces its replacement user flow and keeps the admin debug action.

## Models, cost and evaluation

Initial candidate: `gpt-6.1-sol` with medium reasoning for all three operations,
if supported/available in the configured API project. Verify current official
model capabilities and pricing at implementation time. Do not silently choose a
more expensive fallback. After measuring quality, compare `gpt-6-luna` for
cost-sensitive work and `gpt-6-astra` as a quality reference, not as automatic
production escalation.

Earlier budget examples are estimates, not benchmarks of the current prompts.
Measure full input, cached input, output/reasoning and tool usage from real
executions. Store rate/version information so estimated historical cost is
explainable. No fixed monthly amount or model price is a product contract.

Enforce bounded output, per-user limits, global limits and concurrency. Reserve
allowance atomically for concurrent work and reconcile known usage afterward.
Track uncertain attempts conservatively. Free prompt preview must not invoke
the model or trigger paid tools. Never retry indefinitely.

Use deterministic tests for context and validation plus a small controlled
evaluation corpus for real model quality. Include:

- Same workout with different histories and justified different guidance.
- New athlete with no history; incomplete records with explicit uncertainty.
- Elevated reported effort and dated discomfort without inferred permanent limitations.
- Source edits reflected in memory and future inputs without duplicate profiles.
- Corrected/dismissed interpretations not resurrected by old responses.
- Recommendation that was not followed; changed feedback after an analysis.
- Similar workouts under different terrain/weather conditions.
- PT/EN and unit preferences; cycle-to-week-to-analysis continuity.

Model evaluation is distinct from mock-based tests. Record rubric, failures,
model/configuration and actual cost. No paid provider calls in routine CI.
Do not claim 100% code coverage establishes the quality of training advice.

## Phase-specific contracts

### Phase 0: foundation

Deliver API/configuration, reusable prompts, a source-backed athlete-context
view with correction links and optional prior-experience input, execution
persistence, cost controls, protected debug foundation and evaluation fixtures.
Do not build duplicate personal-field or generic observation CRUD. Choose the smallest compatible schema and
modules after inspecting the existing code. Migrations must be idempotent and
preserve existing user data. Leave feature-specific generation for later phases.

### Phase 1: generate cycles

Use cycle goals/target event, optional prior experience, saved availability,
dated session feedback and history to generate a cycle proposal. Keep cycle identity/status separate from
generated planning versions. Validate phase dates and domain values; show a
proposal before explicit atomic application. Preserve one active cycle and
manual cycle creation. Regeneration must not overwrite an applied plan silently.

Persist the accepted planning/rationale for weekly context. Old cycles without
an AI plan remain supported and must not receive fabricated backfill.
Any reusable athlete interpretation produced here must follow the correction
and disposition contract above; implement the shared minimal lifecycle when
first needed, rather than defer the user's ability to correct it.

### Phase 2: request weekly workouts

Use the applied cycle plan where present, recent execution, feedback,
availability, shoes and forecast evidence. Respect the current disposition of
prior interpretations and user corrections. Keep Solicitar Treinos / Request
Workouts labels and existing technical routes stable. Explain maintenance,
progression or recovery using available evidence.

Dates derive from Monday plus weekday offset, never row position. Multiple
sessions on one day share its date and must respect the total daily session
budget. The preferred time window is not the session duration.

Return validated structured records for preview and explicit calendar
application. Reuse import/domain normalization and the existing deduplication
signature (date + training name + details), plus execution/application
idempotency. Revalidate cycle/availability/calendar changes before application;
never overwrite completed results. Preserve the 12-column XLSX/XLS import
contract. Local XLSX download is optional follow-up scope, not a requirement
to deliver integrated calendar generation.

Forecast requirements:

- Extend/reuse geocoding without changing its context/ambiguity protections.
- Introduce hourly forecast handling distinct from current daily result autofill.
- Verify place, date, timezone/DST and coverage using source data.
- Local half-open windows: 00:00-08:00, 08:00-12:00, 12:00-14:00,
  14:00-18:00, 18:00-24:00. Europe/Lisbon is not a global default.
- Use range and highest verified temperature within the selected window.
  Never substitute the daily maximum or imply partial coverage is complete.
- Record source/link, lookup timestamp/timezone, coverage and limitations.
- Try a second hourly source when the first is insufficient and access exists.
  Select/document that provider or bounded web-search mechanism and its costs
  in phase 2. Do not claim research occurred if no tool was called.
- Unavailable, ambiguous or out-of-horizon data are explicit; continue planning.
  Do not ask the user to confirm weather details or authorize each lookup.

### Phase 3: analyze workouts

Save result/feedback successfully before generating analysis from canonical
stored values. Preserve RPE 1-5, FIT/manual provenance, pace, positive ascent and
two-foot cadence normalization. Manual results must not acquire invented laps.

Include cycle/weekly intent, actual result, subjective feedback, recent history
and relevant comparable sessions. Distinguish facts, hypotheses, limitations and
recommendations. Do not automatically change metrics, cycle or calendar.

Persist analysis with input versions; edits make prior analysis visibly outdated.
Regeneration is explicit, not a hidden paid side effect. Feed recommendations
into future contexts as dated interpretations, not as facts or permanent rules.
Expose source-backed patterns in the memory view using the shared
confirm/correct/dismiss lifecycle; old analyses cannot resurrect a dismissed
interpretation. Reuse or complete that lifecycle rather than duplicate it.
IA failure must never undo a successfully saved result or shoe-mileage update.

## Documentation and completion gate

Every implementation PR must:

1. Read and comply with README, AGENTS/GOLDEN RULES and this plan.
2. Update README, AGENTS and this plan for delivered behavior and phase progress.
3. Update .env.example and API/schema/migration/deployment/privacy documentation
   when affected; never document planned configuration as already available.
4. Identify the documents updated and explain any relevant unchanged reference.
5. Run pertinent tests, npm test, npm run test:coverage with all four metrics at
   the required 100% instrumented scope, and git diff --check.
6. Inspect changed UI in real Chrome PT/EN desktop/mobile, including keyboard,
   focus, loading/error states and comparison with an established component.
7. Critique the complete diff before review, fix findings in a coordinated pass,
   and distinguish local results from GitHub checks. Resolved threads are not
   evidence of validation. Follow AGENTS review flow without repeated automatic
   review requests after every corrective commit.
8. Leave the PR open, without merge, and exclude secrets/personal files.

For this initial documentation-only PR, inspect links, references and whitespace;
do not run the application suite without a concrete functional risk.

## Phase 0 implementation decisions on this branch

The [foundation contract](ai-foundation.md) records the consolidated-view placement in the
account menu; schema/modules; deterministic source selection and explicit gaps;
90-day opportunistic cleanup; transactional quotas and conservative cost rates;
uncertain restart recovery; owner-only administrator debug; and synthetic prompt
equivalence/evaluation fixtures. The source inventory maps cycles (`objective`, goals, target/start dates) to
`/cycles.html`; structured weekly availability to `/ai-coach.html`; bounded
sessions/feedback and canonical aggregates to calendar/result screens. Only
previous running experience uses the supplemental editor. The UI is a product
projection of context policy `training-context-v3`, with no raw debug for ordinary
users. Existing profile duplicate keys and generic memory rows remain in a
read-only owner archive and are excluded from new selection. No schema deletion
or reinterpretation occurs; exact historical execution snapshots stay intact.
Weekly comparable lookup uses both type and workout-name long-run labels.
The 429 retry/cancellation decision is atomic, including reservation settlement.
Recent-context priority, compact planning, mandatory reports and final-budget
refusal follow the [effective selection policy](ai-foundation.md#effective-selection-policy-training-context-v3).
A scoped shared ES-module manifest resolves backend loading without changing
the CommonJS root or external prompt output; see the same foundation contract.
Native fetch implements Responses with no SDK
retry side effects. There are no registered paid product adapters in phase 0.
Functional cycle, weekly and analysis adapters remain in their planned phases.
Mock tests are separate from real model quality/access evaluation.

## Implementation decisions to record

The approved boundaries above are fixed. Agents should record concrete choices
and evidence for these remaining details in the relevant phase:

- Phase 0: source inventory and consolidated-view placement; compatibility with
  PR #67's original data/schema; schema/module names; context
  limits/selection algorithm; retention/cleanup defaults; execution recovery;
  quota settings; verified model access and price references.
- Phase 1: structured planning schema and compatibility with current cycle CRUD.
- Phase 2: hourly provider/second-source mechanism, cache freshness, output schema
  and conflict policy consistent with existing import/calendar contracts.
- First interpretation-producing phase (1-3): evidence identity, disposition and
  supersession semantics for confirmed/corrected/dismissed interpretations.
- Phase 3: analysis structure and outdated-context criteria with traceability.

Escalate genuinely new product/security decisions; do not turn routine choices
already covered by this plan into repeated approval requests.

## Official technical references

Recheck provider-specific behavior when implementing:

- [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Models](https://developers.openai.com/api/docs/models)
- [Pricing](https://developers.openai.com/api/docs/pricing)
- [Data controls](https://developers.openai.com/api/docs/guides/your-data)
