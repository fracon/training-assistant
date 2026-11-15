# Personal running records (#104)

Available at `/records.html` after completing the running profile (anamnesis),
with PT/EN navigation and forms. The page follows the shared
shell, cards, inputs, date picker, confirmation dialog and focus conventions.

Each distance (5 km, 10 km, 21.0975 km and 42.195 km) has one current best time.
The current athlete declaration is the manual mark when present; otherwise it is
the anamnesis declaration. Eligible sessions compete with that declaration by
actual time. A manual mark replaces the earlier anamnesis declaration even when
it is slower: it can correct a mistaken time without leaving Recordes. Conversely,
an explicit edit in the anamnesis replaces the declaration by removing the manual
mark for that changed distance in the same transaction. Unchanged distances keep
their manual marks; eligible sessions still compete by actual time.

The manual-record action edits only that source, never a copied session. It
opens a shared modal named for its fixed distance. Fields are ordered as time,
optional date, optional race name. The clear-date action is visible only when
a date exists. The page uses the same 720 px width as Shoes and Weight log,
with a 2×2 grid on desktop and one column on mobile. Card headers hold 40×40 px
add/edit and danger-delete icons with localized custom tooltips and distance-aware
accessible names. The manual description stays in the body when a session wins.
The shared date picker opens against the viewport outside the scrolling modal
card, flips above when needed, and closes on outside scroll or resize. Numeric/text inputs and
duration-label hierarchy use shared styles. Saving is announced once through
the shared toast; there is no persistent status line. The synchronization notice
appears once above the grid. Session sources link to their result page; there
is no link asking the athlete to correct the anamnesis.

## Measured result eligibility

A recorded session qualifies if its measured distance reaches the target and
exceeds it by no more than 2%. Shorter distances do not qualify. The full stored
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
the current declared race answer separately from automatically copied marks; it cascades
also when the anamnesis is erased. Existing questionnaire answers are captured
before historical results are compared. Rerunning the migration preserves data.

An explicitly answered race question (including an empty list) receives the
current best time per standard distance automatically. Other distances remain
in the questionnaire. An unanswered/declined question stays unchanged; no other
question is filled and a draft is never completed automatically. The questionnaire
supports nine rows (four standard records plus up to five other-distance results).
Only whole seconds from one minute through seven days are accepted. A missing year is
stored as null and shown explicitly; a known year is never expanded into a date.
When synchronizing a record without a date, preserve the existing questionnaire
year for that distance. Only a nonempty incoming year replaces it; no date or
year is fabricated on the independently stored record.

Unchanged automatically copied fields never become declarations. An explicit
manual save replaces the declared answer for that distance inside the same
transaction, preserving the existing year when no date is supplied. The old
anamnesis time stops competing, including when the new manual time is slower.
When the manual mark is removed, its corresponding declaration is removed too:
the anamnesis then shows the best remaining session, or no mark at that distance.
The corrected old value is never restored. Removing a nonexistent manual mark
is a no-op and does not erase an independent anamnesis answer. Other questions
and distances are preserved; revision conflicts and account ownership remain.
A session can update the displayed best time but never the declared source.

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
- `DELETE /api/records/:distance`: removes the manual mark and its superseded declaration, idempotently.

New cycle contexts contain the current personal records with distance, time,
origin and known date/year. Missing dates are explicit. Instructions tell the
model to treat them as historical references, considering age rather than assuming
current fitness. The `records:self` source versions that selection. Training Memory projects the
same record selection only for the cycle task. The model receives the four
standard distances once, in personalRecords; the anamnesis model projection
retains only other-distance race results. New proposals become outdated when record evidence changes. Applied plans
compare only declared marks (manual and current anamnesis declaration), never session
improvements or automatic questionnaire copies; older
snapshots/plans without this source retain their existing freshness rules.
Draft anamnesis answers never enter the AI record projection.
Anamnesis evidence versions include synchronized marks, but its plan basis uses
the declared answers. Automatic synchronization increments the concurrency
revision without changing the answer-edit timestamp. Feedback-only PATCH writes
do not scan record history.
Nothing generates AI output, applies a plan or mutates Garmin automatically.
External PT/EN prompt templates are unchanged.

Validation uses synthetic data and providers: `test/personalRecords.test.js`
(domain, migration, HTTP, transactions, result replacement and AI freshness) and
`test/personalRecords.browser.test.js` (real Chrome, PT/EN, desktop/mobile,
reduced height/motion, focus, errors and escaped text).
