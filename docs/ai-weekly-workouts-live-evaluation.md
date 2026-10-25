# Weekly workout proposals: controlled live evaluation

## Scope and isolation

One end-to-end evaluation ran on 2026-10-25 against the code at
`ab72f3c8eee6fd3ab8fdd2f88ae4af43cde1452c` on
`feat/issue-64-weekly-workouts`. The process and SQLite database were private
and isolated. The original account was used only to authenticate the browser;
the isolated database reused only the minimum account authentication fields
and current role/activity state. No original training, cycle, shoe, feedback,
planning, or session data was copied. The model context contained only records
created for this evaluation and the explicitly permitted public locality.

The synthetic context contained one active 10 km comfort objective with no
race, three completed synthetic sessions with reported RPE 1–5 and dated
feedback, two active synthetic shoes, and interleaved availability on Monday,
Wednesday, Friday, and Sunday with three unavailable days. The available
windows were `before_08` (50 minutes), `12_14` (45), `after_18` (40), and
`08_12` (70), at Fânzeres, Gondomar, Porto, Portugal. No AI cycle plan was
created or required. The requested week began Monday 2026-10-26 in
`Europe/Lisbon`.

## Effective request configuration

The backend startup diagnostics reported AI enabled and a configured key; the
key itself was never displayed or sent to the browser. Runtime values were
checked after overrides, not inferred from an example file:

| Setting | Effective value |
| --- | --- |
| Model / reasoning | `gpt-6.1-sol` / `medium` |
| Adapter / context / structured schema | `weekly-workouts-v3` / `training-context-v5` / `weekly_workouts` strict JSON schema |
| `store` / tools | `false` / none |
| Maximum output / timeout / retries | 8,192 tokens / 120,000 ms / 0 |
| User/global concurrency | 1 / 1 |
| User/global daily calls | 1 / 1 |
| User/global daily USD ceilings | $1.00 / $1.00 |
| Context token-bound limit | 12,000 bytes |
| Daily user/global token ceilings | 100,000 / 500,000 |

The full synthetic request payload was built locally before dispatch. Its JSON
was 21,444 bytes, the context byte bound was 10,488, and the conservative
reserved input bound (payload bytes plus the implementation's 1,024-byte
margin) was 22,468. The reserved token total was 30,660 after adding the
8,192-token output cap. At the configured conservative rate table, the
reservation was **$0.23522**, below the authorized $1.00 maximum. The schema
object placed in the strict Responses API format was the same schema used by
the local validator. The adapter included the context once, and the full
context fit its configured bound. No extra provider-access ping was made;
model and Responses/Structured Outputs support were checked against the
[official model contract](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

## Execution and usage

Saving availability, loading the page, and opening the administrator's free
external prompt left the AI execution count at zero. The external prompt
preview returned to the administrator's own account and created no execution.
One click on **Gerar proposta semanal** produced one persisted execution and
one HTTP 200 Responses API call. The persisted execution reached `completed`
with **one attempt**, no retry, and valid `weekly-workouts-v3` output. The
browser was reloaded while the accepted request was still in flight; it
recovered the same stored execution and then displayed its completed proposal.
There was no second generation.

The execution took 28.968 seconds. Provider-reported usage was 5,296 input
tokens, 1,862 output tokens, 0 cached tokens, including 139 reasoning tokens.
The reservation was reconciled to **$0.05441 estimated charged cost** using
the application's conservative rate table. This is an estimate from reported
usage, **not a confirmed invoice or billing statement**. The private isolated
database retains the execution diagnostics and synthetic result for
investigation; no payload, generated response, credential, key, or screenshot
is published here.

## Weather evidence

The backend resolved Fânzeres to coordinates and `Europe/Lisbon`, and stored
the location, resolved timezone, query URL, source, lookup time, date, selected
period, user/day binding, and availability revision with each evidence item.
The four available-day lookups used the Open-Meteo geocoding and forecast
endpoints. The forecast endpoint was unavailable or returned invalid data for
each requested window. The provider response contained no verifiable hourly
samples/timezone, so every evidence item was explicitly `unavailable` with
reason `forecast_service_unavailable`; **no temperature range or maximum was
claimed**. Later replay established that this generic reason masked an HTTP
400 caused by an invalid request (documented below). The preview and saved calendar entries both said the hourly
forecast was unavailable and that no independent hourly source was configured.
No second source, paid search, or additional weather provider was used.

Because no usable hourly payload arrived, this live run does not validate
real-hour coverage, DST repeated/missing hours, or a real weather maximum. The
issue's daylight-saving, half-open-window, partial-coverage, ambiguity,
out-of-window-high, and horizon regressions passed in the local simulated
Open-Meteo fixtures; those checks are separate from this unavailable live
forecast. No weather condition was invented or used to block generation.

## Proposal review and application

The full response validated and proposed two easy sessions: Monday 2026-10-26
at `before_08` for 20 minutes, and Sunday 2026-11-01 at `08_12` for 30 minutes.
The dates followed the requested week, independently of the unavailable
Tuesday/Thursday/Saturday rows. Both totals were calculated from five-minute
warmup, the main component (10 or 20 minutes), and five-minute cooldown, and
were below the selected day's 50/70-minute limits. Each phase had its own
execution and effort guidance; component RPE values were 1–2 on the Kinesis
1–5 scale. No pace or heart-rate metric was invented or shown as a target.
The prescribed sessions used the account-owned active synthetic shoe. Both
complete notes and contextual justifications were shown in the review before
application. The interface displayed the same materialized details later
stored in the calendar.

The sample used history and dated feedback in its justifications, respected
the synthetic cycle and exact availability, and explicitly said that missing
records do not prove rest/recovery. The generated sample contained only easy
runs; it did **not** exercise an interval, progression, or fartlek response.
Those formats remain validated by simulated adapter/schema regressions, not by
this one model sample.

The proposal was applied with the visible keyboard-accessible action. Two new
calendar rows were added to the synthetic active cycle; no pre-existing target
week rows/results were present to replace. Reload recovered the applied
state. Reapplying the same response hash returned `alreadyApplied: true` with
the original added IDs, kept the weekly row count at two, and made no new AI
execution or provider request.

## Browser and ownership checks

Chrome checks used PT and EN at 1280×800 and 390×844. The complete proposal,
multiline notes, stage instructions, and rationale remained readable; notes
used wrapping text and were not truncated. The desktop action row remained
content-sized and side by side; on mobile it wrapped naturally, with no
horizontal document overflow. The generated button rendered Lucide
`calendar-plus`; the free administrator action rendered Lucide `sparkles`.
Both final SVGs were present, decorative (`aria-hidden`), and retained after
rerender and language change. Locale labels changed while the generated
Portuguese prose remained unchanged. Keyboard Tab focus reached the
administrator action with a visible focus indicator, and Space activated the
application action. During the request the generation button was disabled.

A browser-only URL block simulated an execution-read network outage after the
run had completed. The UI ended loading, displayed its localized temporary
read error, and offered a free reread. Removing the block and activating that
action recovered the applied state without a new execution. This injected
read error is a UI/network-path check, not a simulated model result.

A second, synthetic regular account saw no external-prompt control in the DOM.
Its attempts to read or apply the other account's proposal returned 404; its
administrator-preview request returned 403. The original administrator read
its own debug record. No authorization check created an execution.

## Checks and limits

- Directed local tests before the real call: 124 passed, 0 failed across weekly
  proposal schema/materialization, execution/quota/recovery, availability,
  weather, retry policy, and database migrations. They used simulated
  providers.
- Live browser path: availability save; free admin prompt; one generation;
  processing reload and recovery; full proposal review; explicit apply;
  applied-state reload; idempotent repeat; PT/EN, desktop/mobile, read outage
  and free recovery; regular-user ownership denial.
- Actual OpenAI use: one request, one attempt. No second call was made after
  success. No change was made to `.env`, the primary database, production, or
  deployment. The isolated server was stopped after checks.
- Documentation-only changes after the evaluated code SHA do not change the
  evaluated application. The broader `npm test` and 100% coverage gates were
  not rerun for this evidence-only update; their latest branch results remain
  those recorded in the PR's implementation section.

This is one successful end-to-end sample, not a reliability or universal
quality guarantee. It does not validate an interval/progression/fartlek
generation or usable live weather. At the time, the application recorded a
generic Open-Meteo service failure and left weather unavailable; the follow-up
below identifies the actual cause as incompatible query parameters.

## Follow-up investigation: failed real proposal and weather request — 2026-10-25

The follow-up investigated the localhost code at `fd1646739d687c592cd3a7022587d554cd88c8f3` (branch `feat/issue-64-weekly-workouts`). The worktree and remote branch initially matched that SHA. A consistent SQLite backup was made before investigation; the original database was not modified. Protected diagnostics were read only from a private isolated copy. No provider generation call was made.

### Failed real weekly execution

The protected record identifies a failed `workouts` execution, adapter `weekly-workouts-v3`, schema `weekly_workouts`, model `gpt-6.1-sol`, medium reasoning, 8,192 output cap, 120,000 ms timeout, a configured retry allowance of 1, one actual attempt, HTTP 200 and provider status `completed`. Domain validation returned top-level `invalidDomainResponse`. The provider reported 5,645 input, 4,187 output, 0 cached and 191 reasoning tokens; elapsed time was 53.408 s. Reservation was 31,643 tokens / **$0.240135 reserved**. Known usage was 9,832 tokens with **$0.09103 estimated charged cost** according to the configured rate table. That is an estimate, not a billing statement. No retry or new request was made.

The exact `validation.code` and `validation.path` **are not available**: the stored diagnostic has no validation object, and both `response_json` and proposal `responseHash` are null. The invalid generated response was not retained in protected storage, so its field and content cannot be reconstructed. This is a concrete limitation, not evidence that the model made an unsuitable recommendation. The confirmed software defect was that the diagnostics allowlist recognized cycle-planning validation names and paths only, so weekly domain validation details were stripped before persistence. The correction adds a closed weekly code vocabulary and bounded `$.sessions[index].field` paths; synthetic sanitizer and persistence regressions demonstrate the stored safe code/path. It does not retroactively diagnose or alter this historical execution.

### Open-Meteo cause and correction

The six historical lookups had successful geocoding for Fanzeres at 41.16754, -8.52981 in `Europe/Lisbon`; the location was not the cause. Replaying the recorded forecast URL from the same runtime environment returned HTTP 400, JSON content type, and a JSON parameter error: `forecast_days` cannot be combined with `start_date` and `end_date`. Thus this was an invalid request, not a DNS/TLS/network restriction, timeout, provider outage, JSON parse error, or locality ambiguity. The previous generic catch incorrectly mapped the 400 to `forecast_service_unavailable`.

The code now sends explicit date parameters without `forecast_days`, retains the local 16-date horizon guard and resolved timezone, and classifies bounded transport, HTTP, JSON, and validation failures without saving provider prose. It does not add retries or change the existing 8-second request timeout/concurrency. Synthetic regressions distinguish HTTP 400/503, DNS transport, malformed JSON, and valid/partial data. An authorized public Open-Meteo request using the corrected parameters was then parsed by the changed module: HTTP 200, `Europe/Lisbon`, 8/8 distinct hourly instants for `[00:00,08:00)`, window range 10–12.5 °C. No daily maximum was requested or used. The query uses only coordinates, date, hourly variables, timezone and time format. Official current documentation describes the 16-day limit, date interval parameters, Unix timestamps and timezone handling for DST ([Forecast API](https://open-meteo.com/en/docs)); the real 400 response independently established the parameters' mutual exclusion.

The earlier successful synthetic-model sample and the later failed real execution are separate observations. This investigation did not repeat generation, apply the refused proposal, or change source records. After these code changes the model contract has only synthetic regression coverage; no real evaluation of the corrected code has occurred. A future paid model evaluation would be needed to observe the changed execution contract end to end, but it is not required to prove the corrected weather URL/parser path.
