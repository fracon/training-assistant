# Workout import compatibility (verified 2026-09-09)

Kinesis currently accepts a direct `.FIT` file or a `.ZIP` containing exactly
one `.FIT`. The in-app guide is informational only: it never logs into a
manufacturer account, calls a manufacturer API, or sends activity data away.

| Platform | Status | Formats documented by official source | Kinesis path |
| --- | --- | --- | --- |
| Garmin | direct | Original activity `.FIT`, delivered directly or in a ZIP | Export Original from Garmin Connect Web, then upload FIT/ZIP |
| COROS | direct | Individual `.FIT` export | COROS app → Workouts → activity details → options → Export Data → FIT |
| Polar | direct | Individual FIT, or a ZIP package; also GPX/TCX/CSV | Polar Flow Web → Diary → session → Export → FIT/ZIP |
| Amazfit/Zepp | unverified | No current official activity-to-FIT workflow confirmed | Check current model support; use manual entry |
| Huawei | unsupported | Official support page documents route export, not a FIT activity | Route formats are not accepted; use manual entry |
| Apple | unsupported | Apple Health exports a complete XML archive | XML is not accepted; use manual entry |
| Samsung | unsupported | Samsung documents GPX route import/export for supported devices | GPX routes are not FIT activities; use manual entry |

## Official sources

- Garmin, “How Do I Export Data Out of Garmin Connect?” — https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8 (consulted 2026-09-09; Garmin Connect Web, timed activity export).
- COROS, “Exporting Workout Data and Uploading to 3rd Party Apps” — https://support.coros.com/hc/en-us/articles/360043975752-Exporting-Workout-Data-and-Uploading-to-3rd-Party-Apps (consulted 2026-09-09; COROS app, individual activity export; choose FIT to preserve detail such as heart rate).
- Polar, “How do I export individual training sessions from Polar Flow web service?” — https://support.polar.com/us-en/export-training-sessions-flow (consulted 2026-09-09; Polar Flow Web, individual sessions and ZIP option).
- Amazfit Support — https://support.amazfit.com/en/ (consulted 2026-09-09; no current official activity FIT export path confirmed).
- Huawei, “Routes” — https://consumer.huawei.com/pt/support/content/pt-pt15893332/ (consulted 2026-09-09; Huawei Health route export).
- Apple, “Share your data in Health on iPhone” — https://support.apple.com/guide/iphone/share-your-health-data-iph5ede58c3d/26/ios/26 (consulted 2026-09-09; complete XML health export).
- Samsung, “Use GPX routes in the Samsung Health app” — https://www.samsung.com/us/support/answer/ANS10003407/ (consulted 2026-09-09; GPX route support and device limitations).

Interfaces, device support, regions, and export labels can change. Formats
other than FIT/ZIP-FIT (GPX, TCX, XML, CSV, JSON) remain future candidates and
require separate parser, metric-preservation, and regression-test work.
