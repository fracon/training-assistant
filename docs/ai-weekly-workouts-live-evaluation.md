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
claimed**. The preview and saved calendar entries both said the hourly
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
generation or usable live weather. The Open-Meteo service failure left weather
unavailable, as designed, while the synthetic proposal remained reviewable
and applicable.
