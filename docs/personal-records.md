# Personal running records (#104)

Available at `/records.html` after completing the running profile (anamnesis),
with PT/EN navigation and forms. The page follows the Weight log page's shared
shell, cards, inputs, date picker, confirmation dialog and focus conventions.

Each distance (5 km, 10 km, 21.0975 km and 42.195 km) has one current best time,
selected from the athlete's original anamnesis answers, one editable manual
record per distance and all eligible stored session results. Manual records
remain editable even when another source wins. Ties prefer the manual record,
then the original anamnesis answer, then sessions in date/ID order. The page
shows the winning source and a session link where available. Editing/removing
an anamnesis source uses the questionnaire; session sources use the result page.

## Measured result eligibility

A recorded session qualifies if its measured distance reaches the target and
exceeds it by no more than 1%. Shorter distances do not qualify. The full stored
result time is used, with no adjustment for the extra distance and no pace
extrapolation. A future session, missing/invalid/nonpositive duration, a duration above seven days or result
with `none` provenance does not qualify. Known non-running FIT sports and
malformed FIT summaries are excluded. Results awaiting subjective RPE are still
recorded results and may qualify. Existing results participate without reimport.

This implementation does not extract partial-distance records from longer
sessions. Neither lap totals nor average pace are treated as proof of an exact
unrecorded split. GPS/record processing and automatic FIT downloads are not added.

## Anamnesis synchronization

Migration `2026-11-personal-records-v1` creates `personal_records` and
`anamnesis_record_sources`, with account deletion cascades. The latter retains
the original race answer separately from automatically copied marks; it cascades
also when the anamnesis is erased. Existing questionnaire answers are captured
before historical results are compared. Rerunning the migration preserves data.

An explicitly answered race question (including an empty list) receives the
current best time per standard distance automatically. Other distances remain
in the questionnaire. An unanswered/declined question stays unchanged; no other
question is filled and a draft is never completed automatically. The questionnaire
supports nine rows (four standard records plus up to five other-distance results).
Only positive whole seconds up to seven days are accepted. A missing year is
stored as null and shown explicitly; a known year is never expanded into a date.

Original self-reports are preserved when a questionnaire save sends back an
unchanged automatically copied field. Explicit edits become new self-reports.
A correction or deletion recalculates from surviving sources, so an automatic
copy cannot become evidence for itself. Actual changes increment the anamnesis
revision, preserving optimistic conflict detection in an already-open tab.

Manual record writes, result writes (manual, FIT and Garmin import), rescheduling
and session deletion synchronize inside the same transaction. Migration also
synchronizes historical results. Reads never write. Erasing the anamnesis deletes
its original source answers; independently stored manual/session records remain.

## API and planning

Authenticated, owner-scoped, `Cache-Control: no-store` endpoints:

- `GET /api/records`: current best and editable manual record for each distance.
- `PUT /api/records/:distance`: exact fields `time_seconds`, optional
  `achieved_on` (civil ISO date from 1950 through today) and optional `race_name`
  (up to 120 characters). Unknown fields are refused.
- `DELETE /api/records/:distance`: removes that manual source only, idempotently.

New cycle contexts contain the current personal records with distance, time,
origin and known date/year. Missing dates are explicit. Instructions tell the
model to treat them as historical references, considering age rather than assuming
current fitness. The `records:self` source versions that selection. New proposals
and applied plans that recorded it become outdated when it changes; older
snapshots/plans without this source retain their existing freshness rules.
Draft anamnesis answers never enter the AI record projection.
Synchronized anamnesis changes also follow its existing evidence freshness rules.
Nothing generates AI output, applies a plan or mutates Garmin automatically.
External PT/EN prompt templates are unchanged.

Validation uses synthetic data and providers: `test/personalRecords.test.js`
(domain, migration, HTTP, transactions, result replacement and AI freshness) and
`test/personalRecords.browser.test.js` (real Chrome, PT/EN, desktop/mobile,
reduced height/motion, focus, errors and escaped text).
