# Garmin Connect integration contract

Status (2026-10-29): **Phase 1 foundation implemented; real-account and
Forerunner 55 acceptance not performed. The pilot remains disabled.** This
document separates library documentation, simulated tests, account evidence,
and device evidence. Nothing in the first two categories is a substitute for
the last two.

## Authorization and privacy boundary

The project owner explicitly authorized an unofficial Garmin Connect
integration, a private Python container in the Kinesis Compose deployment, and
a proof of concept using the owner's Garmin account and Forerunner 55. This
authorization covers the selected workout and the owner's own activity data
only. It does not permit publishing another user's data, public connector
access, sending FIT/GPS to OpenAI or another service, deleting preexisting
Garmin records, paid OpenAI calls, or enabling the integration globally before
homologation.

Node remains the product authorization and canonical database boundary. The
connector has no public port, browser route, or SQLite mount; its HTTP API is
versioned under `/v1`, accepts only bounded Garmin operations, and authenticates
the Node service key on every request. The pilot CLI resolves an explicitly
configured Kinesis owner and verifies that account is active before it calls
the connector. Administrators do not gain cross-user access. `GARMIN_PILOT_ENABLED`
defaults to `false`.

FIT/ZIP bytes are returned only over the private service network. Processing
continues through the existing local Kinesis FIT/ZIP parser. No Garmin payload
is passed to OpenAI or other external processors.

## Library evaluation

Selected dependency: `garminconnect==0.3.20`, MIT, released 2026-10-23, requires
Python >=3.12. It no longer uses `garth` (since 0.3.0). The connector image is
based on Python 3.12 and installs a hash-locked dependency set. The upstream
project documents these relevant methods and behavior:

- `Garmin.login(tokenstore, return_on_mfa=True)` and
  `resume_login(client_state, mfa_code)` allow an MFA challenge to continue in
  another request/process. The client state contains SSO cookies and is treated
  as a credential.
- Typed running workout creation through `upload_running_workout`, lookup with
  `get_workout_by_id`, and calendar scheduling with `schedule_workout` are
  documented. The adapter only accepts a small allowlisted synthetic workout
  schema.
- `get_activities_by_date` lists date-bounded activities and
  `download_activity(id, dl_fmt="original")` returns the Garmin original
  archive. It is bounded further by a 31-day request window and page response.
- Device enumeration is documented by `get_devices`; this does not establish
  Forerunner 55 compatibility, transfer to a device, or successful sync.
- Tokens from the library are normally plain JSON with mode 0600. Kinesis
  materializes that JSON only in a mode-0700 temporary directory, encrypts it
  before persistent storage, and removes the temporary copy.

These are upstream documentation/code observations, not live Garmin proof.
Garmin Connect is unofficial and may change authentication, endpoints, rate
limits, account policies, or workout behavior at any time. No CAPTCHA bypass,
IP rotation, or aggressive login retry is implemented.

## Internal API v1

Every route below is private to the Compose network and requires
`X-Kinesis-Service-Key`. The owner and connection path components are supplied
by the trusted Node process; browsers never supply these values directly.
Errors use `{"detail":{"code":"…"}}`; unexpected exceptions are sanitized.

| Operation | Method and path | Scope |
|---|---|---|
| Readiness | `GET /healthz` | Local only; no credentials or Garmin request |
| Start login | `POST /v1/connections/{owner}/{connection}/auth/start` | Password is request-only and never persisted |
| Finish MFA | `POST /v1/connections/{owner}/{connection}/auth/finish` | Opaque, one-use challenge; max 3 attempts; 5-minute expiry |
| Cancel MFA | `POST /v1/connections/{owner}/{connection}/auth/cancel` | Invalidates the matching in-memory challenge |
| State | `GET /v1/connections/{owner}/{connection}/status` | Validates saved tokens using a minimal profile request; health remains local-only |
| Disconnect | `DELETE /v1/connections/{owner}/{connection}` | Deletes local tokens and challenges; remote revocation is not claimed |
| Capabilities | `GET /v1/connections/{owner}/{connection}/capabilities` | Device IDs/names and running-workout availability only |
| Publish workout | `POST /v1/connections/{owner}/{connection}/workouts` | Bounded timed running template, optional repeated interval group and pace range |
| Read workout | `GET /v1/connections/{owner}/{connection}/workouts/{id}` | Sanitized details only |
| Schedule workout | `POST /v1/connections/{owner}/{connection}/workouts/schedule` | Calendar date, after revalidation by caller |
| List activities | `POST /v1/connections/{owner}/{connection}/activities` | Required date window <=31 days, offset, page size <=25; response fields are allowlisted |
| Download original | `GET /v1/connections/{owner}/{connection}/activities/{id}/original` | Max response 25 MiB; bytes are not logged or persisted by Node |

Errors include `auth_required`, `mfa_required`, `rate_limited`, `unavailable`,
`unsupported`, `invalid_payload`, and `outcome_unknown`. A timed-out upload is
reported as uncertain; it must be reconciled by querying matching workouts
before any retry. The adapter confirms a created workout by looking it up
before returning its ID. Scheduling uncertainty still requires explicit
calendar reconciliation. No delete operation is exposed for remote activities
or workouts.

The first-phase adapter is not a product synchronization pipeline. The
authenticated Kinesis pilot entry point is the local TTY command
`npm run garmin:pilot -- <action>` executed inside the Node container. Supported
actions are `auth`, `status`, `disconnect`, `publish-simple`,
`publish-interval`, `schedule`, `activities`, `download`, and `cancel`.
Credentials and MFA codes are entered without terminal echo. Mutations require
an interactive TTY and typed confirmation; publication uses a visible
operation UUID that can be reused to reconcile an uncertain result. The
connector checks the same flag and configured pilot owner on each request. The
Node command also re-reads the configured Kinesis account and its active state
for every action. Do not pass credentials as command arguments, environment
values, shell history, chat, GitHub, or logs.

## Token custody and recovery

There is one token custodian: the Python connector. Its named Docker volume
`garmin-tokens` stores AES-GCM ciphertext, keyed by owner and opaque connection
ID. `GARMIN_ENCRYPTION_KEY` is a 32-byte URL-safe base64 key supplied at
runtime, independently of the volume and image. The service key is a separate
runtime secret shared with Node. The token directory is mode 0700, records are
mode 0600, and replacement is atomic. The connector runs as UID/GID 10001.

Back up the encrypted `garmin-tokens` volume and the encryption key separately
using the operator's protected backup system. A restore requires both. Rotate
by decrypting/re-encrypting every record with an offline maintenance tool while
the service is stopped; this tool is intentionally not part of the pilot API.
If the key is lost, encrypted tokens cannot be recovered: remove the volume,
generate a new key, and reconnect locally. Reconnecting does not promise remote
token revocation. `disconnect` deletes local ciphertext and pending challenges.

The current implementation keeps MFA challenges in volatile memory: a
connector restart invalidates them and requires starting login again. A
transient failure does not delete existing ciphertext. Passwords and MFA codes
exist only in request memory for the operation and are not written to logs or
responses. Uvicorn access logging is disabled; Garmin/library debug logging is
not enabled. The library session/cookie challenge exists only in memory and is
discarded after completion, cancel, timeout, or restart.

## Build and ZimaOS operation

The host Compose stack retains the existing public mapping `8081:3000` for
Kinesis. Python has no published port and no Cloudflare route. The default
Compose network provides Node-to-Python access and ordinary outbound network
access for Garmin. The connector has no SQLite mount and does not gate Node
startup or FIT/ZIP import.

1. Copy `.env.example` to `.env` on the ZimaOS host; restrict it to the operator
   (`chmod 600 .env`). Keep `GARMIN_PILOT_ENABLED=false` until the real pilot is
   explicitly being run. Set the owner ID from the local Kinesis database only
   after identity verification.
2. Generate two unrelated secrets locally with `openssl rand -base64 32` and
   save them directly in the protected `.env`: one for
   `KINESIS_GARMIN_SERVICE_TOKEN`, one for `GARMIN_ENCRYPTION_KEY`. Never paste
   either into chat/issue/PR or shell arguments. Restart Compose after changes.
3. Confirm the host architecture with `uname -m` and `docker info --format
   '{{.Architecture}}'`. `scripts/deploy-zimaos.sh` pulls the existing Node image,
   builds the Python image on that host architecture, then starts both. No CI
   publishing pipeline was changed. Keep the connector image digest/tag with
   deployment records; the Compose version is `0.25.0`.
4. Check `docker compose ps` and `docker compose logs --tail=50
   garmin-connector`; logs must not contain request bodies. Health is local and
   does not contact Garmin.
5. To authenticate, run
   `docker exec -it training-assistant npm run garmin:pilot -- auth`. Status and
   local disconnection use `status` and `disconnect` respectively. The command
   requires the explicit active owner and the flag. It is intentionally
   interactive; credentials are never CLI arguments.

Updating: keep the Node image SHA and connector source revision together, run
checks below, back up the encrypted token volume and key, then deploy. Rollback
to the preceding Compose/source revision and image tag. Restore matching token
volume/key backups if the rollback changed the token format; this release uses
the `KGC1` envelope. Do not restore a token backup from a different key.

## Evidence and go/no-go

| Capability | Upstream documentation/code | Automated simulation | Owner account | Forerunner 55 |
|---|---|---|---|---|
| Login and MFA resume | Documented in 0.3.20 | Covered by local tests | **Pending** | N/A |
| Encrypted token resume after restart | Kinesis implementation | Covered by local tests | **Pending** | N/A |
| Create simple/interval workout and schedule | Methods documented | Local adapter tests only | **Pending** | **Pending** |
| Push/sync and step/target/date fidelity | Not guaranteed by library method | Not proven by mocks | **Pending** | **Pending** |
| List activity and download original archive | Methods documented | Local adapter tests only | **Pending** | N/A |
| FIT validation with existing parser and exact activity link | Existing parser is local | Existing FIT suites; new integration pending | **Pending** | N/A |

No owner Garmin credentials, ZimaOS host access, or Forerunner 55 were supplied
to this implementation environment. No live Garmin request, remote mutation,
activity download, device synchronization, or cleanup was performed. Thus the
phase is **not homologated**, there is no go decision for issue #73/#74, and
there is no evidence of an exact workout occurrence-to-activity identifier.
Workout ID, title, and date alone are not treated as execution identity. A
future phase needs either a verified remote linkage or an explicit confirmation
flow with deterministic candidate evidence; a historical FIT proves download
only, not a new planned workout's execution.

No physical run is required to continue coding. Actual account login/MFA,
post-restart token resume, synthetic upload/scheduling, Forerunner 55 sync and
inspection, activity original download, isolated FIT parse/metric comparison,
and failure experiments remain manual acceptance steps. Any cleanup must
identify the exact synthetic workout and schedule created by that run; never
delete preexisting activities or workouts.

The adapter exposes no remote delete endpoint. If an operator elects to remove
a test artifact, use Garmin Connect manually and match the recorded operation
UUID and date; delete only that explicitly created synthetic workout or its
schedule. Never delete an activity. No remote cleanup has been performed.

## Future phase boundary

Phase 2 (#73) may add the user-facing publication workflow only after real
account/device capability checks and approval. Phase 3 (#74) may add activity
recovery/import only after the phase 2 execution identity and result pipeline
are proven. This phase does not add a full workout editor, automatic result
import, account-wide synchronization, health/sleep/HRV, or automatic OpenAI
analysis.
