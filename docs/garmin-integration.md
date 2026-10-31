# Garmin Connect integration contract

Status (2026-10-31): **Phase 1 foundation implemented; pilot evidence is
partial and full Garmin/device homologation remains pending. The pilot is
restricted to the explicitly selected owner.** This
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

- The pinned 0.3.20 signature is `Garmin.login(self, /, tokenstore=None)`;
  `return_on_mfa=True` belongs on the `Garmin` constructor. `resume_login` on
  its transport continues an MFA challenge. The client state contains SSO
  cookies and is treated as a credential.
- Typed running workout creation through `upload_running_workout`, lookup with
  `get_workout_by_id`, and calendar scheduling with `schedule_workout` are
  documented. The adapter only accepts a small allowlisted synthetic workout
  schema.
- `get_activities(start, limit)` reads one activity page; the adapter requests
  at most five pages and applies the date window while scanning. The library's
  `download_activity(id, dl_fmt=Garmin.ActivityDownloadFormat.ORIGINAL)`
  returns a fully materialized byte string, so the adapter instead uses the
  pinned transport's `_run_request(..., stream=True)` with the library's
  original-download endpoint and enforces 25 MiB while receiving chunks. The
  custom streaming request preserves the official `Client.download` contract
  by adding `Accept: */*` before `_run_request`; redirects are limited to the
  original HTTPS origin, and status/content category are checked before FIT/ZIP
  handling. The private `_run_request` streaming API and this header contract
  must be rechecked on upgrades.
- `get_scheduled_workouts(year, month)` returns a calendar object. The adapter
  inspects `calendarItems` and filters `itemType == "workout"`. It only
  confirms a schedule when the response also contains the exact `workoutId`,
  civil `date`, and occurrence `id`; absent or malformed identity yields
  `outcome_unknown` and blocks another mutation.
- Device enumeration is documented by `get_devices`; this does not establish
  Forerunner 55 compatibility, transfer to a device, or successful sync.
- `get_workout_types()` returns `workoutSportTypes` entries modeled in pinned
  0.3.20 as `SportTypeModel(sportTypeId, sportTypeKey, displayOrder=1)`;
  running is identified by exact `sportTypeKey == "running"`. This is the
  account's workout-type catalog, not a device capability. Kinesis reports
  `running_catalog_status` as `available`, `absent`, or `unknown`; the legacy
  `running_supported` is true/false/null for those respective states. An empty
  or malformed response is `unknown` rather than evidence of absence.
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
| Capabilities | `GET /v1/connections/{owner}/{connection}/capabilities` | Device IDs/names plus account catalog state; not device sync compatibility |
| Workout catalog diagnostic | `GET /v1/connections/{owner}/{connection}/workout-catalog` | One read-only catalog call; sanitized structure and allowlisted sport type identifiers only |
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
`npm run garmin:pilot -- <action>`; locally it calls the loopback connector,
and in ZimaOS it is run inside the Node container. Supported
actions are `auth`, `status`, `capabilities`, `capabilities-diagnose`, `disconnect`, `publish-simple`,
`publish-interval`, `schedule`, `activities`, `download`, and `cancel`.
Credentials and MFA codes are entered without terminal echo. Mutations require
an interactive TTY and typed confirmation; publication uses a visible
operation UUID that can be reused to reconcile an uncertain result. The
connector checks the same flag and configured pilot owner on each request. The
Node command also re-reads the configured Kinesis account and its active state
immediately before and after each dispatched request. If the owner becomes
inactive while a call is in flight, the CLI requests local connector
disconnection; a Garmin mutation already accepted remotely cannot be undone and
is reported as uncertain. Local disconnect/cancel remain available for an
inactive or deleted owner. Do not pass credentials as command arguments, environment
values, shell history, chat, GitHub, or logs.

## Token custody and recovery

There is one token custodian: the Python connector. Locally,
`.kinesis-private/garmin-store` stores AES-GCM ciphertext; in ZimaOS, the named
Docker volume `garmin-tokens` stores the same format, keyed by owner and opaque
connection ID. It also stores an encrypted `.ops` journal for publish/schedule idempotency;
the journal contains only operation fingerprints, states and Garmin IDs, never
FIT/GPS or credentials. `GARMIN_ENCRYPTION_KEY` is a 32-byte URL-safe base64 key supplied at
runtime, independently of the token store and image. The service key is a separate
runtime secret shared with Node. Locally both secrets are generated once by
`npm run garmin:setup`, stored in the mode-0600 ignored file
`.kinesis-private/garmin-pilot.json`, and reused on later preparations and
restarts. The private parent and local token store are mode 0700; records are
mode 0600, and replacement is atomic. The connector runs as UID/GID 10001.

Back up the encrypted token store (including `.ops`) and encryption key
separately using the operator's protected backup system. A restore requires
both. Locally, protect `.kinesis-private/garmin-pilot.json` and the adjacent
store separately under the same policy; never put this directory in Git or an
image. Rotate
by decrypting/re-encrypting every record with an offline maintenance tool while
the service is stopped; this tool is intentionally not part of the pilot API.
If the key is lost, encrypted tokens cannot be recovered: remove the volume,
generate a new key, and reconnect locally. Reconnecting does not promise remote
token revocation. `disconnect` deletes local token ciphertext, the encrypted
operation journal, and pending challenges. There is not yet a supported online
key rotation command: an operator must stop Compose, make a protected copy,
decrypt and re-encrypt both `.bin` and `.ops` records with a reviewed offline
tool, verify the replacement with the new key, then restart; if that cannot be
performed safely, preserve the backup and reconnect after clearing the volume.

The current implementation keeps MFA challenges in volatile memory: a
connector restart invalidates them and requires starting login again. A
transient failure does not delete existing ciphertext. Passwords and MFA codes
exist only in request memory for the operation and are not written to logs or
responses. Uvicorn access logging is disabled; Garmin/library debug logging is
not enabled. The library session/cookie challenge exists only in memory and is
discarded after completion, cancel, timeout, or restart.

## Local development pilot

Local preparation requires Python 3.12 or newer and an existing Kinesis
database. From the repository root, run `npm run garmin:setup` once. The command
creates/reuses `.venv-garmin`, installs `requirements-dev.lock` with
`--require-hashes`, then asks for the email of the operator's own Kinesis
account. It opens the configured database read-only, requires an exact existing
active account, shows its email/ID and asks for explicit confirmation. It never
selects the first account, creates a database, changes account data, asks for
Garmin credentials, or calls Garmin/OpenAI. Dependency installation may access
the configured package index.

Preparation generates a random 256-bit service token and a random 32-byte
encryption key, plus the default local port 8080. Subsequent runs preserve both
secrets. A port can be selected during setup, for example
`GARMIN_CONNECTOR_PORT=8123 npm run garmin:setup`; the stored setting is shared
by the CLI and connector. No shell `source`, manual virtualenv activation, or
repeated environment export is needed. Setup and pilot commands do not edit
`.env`.

Run these three terminals from the repository root:

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run garmin:connector

# Terminal 3
npm run garmin:pilot -- auth
npm run garmin:pilot -- status
npm run garmin:pilot -- capabilities
npm run garmin:pilot -- capabilities-diagnose
```

To verify token resume, restart the connector in Terminal 2, then query status
in Terminal 3. Disconnect with `npm run garmin:pilot -- disconnect`; this
removes only local tokens/journal and does not claim remote revocation. Garmin
password and MFA are entered only through local hidden prompts. `npm run dev`
does not load the private pilot file or enable Garmin/AI globally; normal
Kinesis and manual FIT/ZIP imports work while the connector is stopped.

For Garmin values, precedence is: an explicitly inherited environment variable
wins; otherwise private local configuration supplies pilot owner, service/key,
port, and local URL/store; without either source the pilot is disabled. Local
Garmin settings are never read from `.env`. Ordinary Kinesis configuration
such as `DATABASE_FILE` uses explicit environment, then `.env`, then the project
default. The
connector child receives only PATH, HOME, locale/temp paths, and required Garmin
runtime settings; it does not inherit Node options, OpenAI keys, or unrelated
variables. It runs `uvicorn app.main:app` from the connector directory on
`127.0.0.1`, without reload or access/body logging. The launcher forwards
termination signals and reports a missing virtualenv/config before starting.

The config file must be complete and valid, mode 0600; its parent is mode 0700.
The local token store is also mode 0700. Existing config is never silently
regenerated. Partial/malformed config or token files without their config cause
a safe stop and recovery guidance. Setup refuses an owner switch while tokens
or journal files exist. If the key is lost, ciphertext is unrecoverable; first
preserve a protected backup, then follow the existing disconnect/recovery
procedure. There is no improvised key rotation. The local config, virtualenv,
Python caches, and coverage artifacts are ignored by Git and excluded from
Docker build context.

### Pilot variables and production boundary

| Variable | Used by | Scope |
|---|---|---|
| `GARMIN_PILOT_USER_ID` | Node authorization and Python connector | Temporary Phase 1 restriction; Kinesis `users.id`, not Garmin ID |
| `KINESIS_GARMIN_SERVICE_TOKEN` | Node → Python authentication | Internal operator secret, retained across updates |
| `GARMIN_ENCRYPTION_KEY` | Python token/journal encryption | Internal operator secret, backed up separately from token storage |

The local setup selects the first value and generates/persists the other two.
End users will not configure any of them. For ZimaOS the operator supplies the
three runtime settings once per installation and preserves both secrets during
image updates. Future multi-user ownership should come from the authenticated
Kinesis session; that path is not implemented. This PR remains a terminal-only,
single-owner pilot without the production “Connect Garmin” interface.

## ZimaOS packaging and operation

The host Compose stack retains the existing public mapping `8081:3000` for
Kinesis. Python has no published port and no Cloudflare route. The default
Compose network provides Node-to-Python access and ordinary outbound network
access for Garmin. The connector has no SQLite mount and does not gate Node
startup or FIT/ZIP import.

1. Copy `.env.example` to `.env` on the ZimaOS host; restrict it to the operator
   (`chmod 600 .env`). Keep `GARMIN_PILOT_ENABLED=false` until the real pilot is
   explicitly being run. Set the temporary owner ID from the Kinesis database
   only after identity verification. End users do not configure these values.
2. Provision unrelated values for `KINESIS_GARMIN_SERVICE_TOKEN` and
   `GARMIN_ENCRYPTION_KEY` from the operator's protected secret manager; inject
   them directly as runtime secrets or into the mode-0600 `.env` without
   echoing them to the terminal/shell history. Keep the encryption key backed
   up separately from the token volume. Restart Compose after changes.
3. Confirm the host architecture with `uname -m` and `docker info --format
   '{{.Architecture}}'`. `scripts/deploy-zimaos.sh` pulls the existing Node image,
   builds the Python image on that host architecture, then starts both. No CI
   publishing pipeline was changed. Keep the connector image digest/tag with
   deployment records; the Compose version is `0.25.0`.
4. Check `docker compose ps` and `docker compose logs --tail=50
   garmin-connector`; logs must not contain request bodies. Health is local and
   does not contact Garmin.
5. To authenticate in the controlled ZimaOS pilot, run
   `docker exec -it training-assistant npm run garmin:pilot -- auth`. Use
   `capabilities` for the bounded device/workout read, `status` for session
   state, and `disconnect` to remove local state. The command requires the
   explicit owner and feature flag, uses a TTY, and never accepts credential
   arguments.

Updating: keep the Node image SHA and connector source revision together, run
checks below, back up the encrypted token volume and key, then deploy. Rollback
to the preceding Compose/source revision and image tag. Restore matching token
volume/key backups if the rollback changed the token format; this release uses
the `KGC1` envelope. Do not restore a token backup from a different key.

## Automated evidence and go/no-go

At this revision the connector suite has **47 passing tests**; Python coverage
(`coverage run --branch --source=app -m pytest`) measures **89.44% lines**
(745/833), **76.41% branches** (217/284), and **86.12% combined coverage** for
`app/main.py`. The browser-free Garmin CLI/setup/launcher suite has **30 passing
tests**; `npm run test:garmin-pilot-coverage` measures **87.73% statements/lines,
74.79% branches, and 78.94% functions** across the four Garmin Node scripts
(`garmin-pilot.js`, local config loader, setup and connector launcher). These
are reported measurements, not added 100% gates. The existing Node backend
coverage command retains its required 100% thresholds.
Contract tests use the actual pinned Garmin wrapper/signatures and enums with
transport/authentication patched; Python sockets are blocked. They do not
establish live Garmin or Forerunner behavior.

## Evidence and go/no-go

| Capability | Upstream documentation/code | Automated simulation | Owner account | Forerunner 55 |
|---|---|---|---|---|
| Login without MFA | Documented in 0.3.20 | Covered by local tests | **Reported and observed connected by owner** | N/A |
| MFA | Documented in 0.3.20 | Covered by local tests | **Not exercised** | N/A |
| Encrypted token resume after restart | Kinesis implementation | Covered by local tests | **Reported by owner after connector restart** | N/A |
| Forerunner 55 appears in account devices | `get_devices` documented | Contract tests | **Reported by owner** | Listed; does not prove workout delivery |
| Running workout type in account catalog | `SportTypeModel.sportTypeKey` in pinned 0.3.20 | Correct-field and unknown-state regressions | **Observed by agent with sanitized read-only catalog: 12 entries; exact `running` key present** | Does not prove compatibility or sync |
| Create simple/interval workout and schedule | Methods documented | Local adapter tests | **Reported by owner; both appeared in Garmin Connect** | **Reported by owner after normal sync** |
| Push/sync and step/target/date fidelity | Not guaranteed by library method | Not proven by mocks | **Reported by owner** | **Reported by owner**; exact fidelity not independently inspected |
| List activity | `get_activities` documented | Real pinned transport contract | **Reported by owner; listing succeeded** | N/A |
| Download original and process FIT locally | `download_activity(..., ORIGINAL)` documented; Kinesis preserves streaming limit | Real pinned `Garmin`/`requests.Response` transport plus synthetic archive/parser tests | **One read-only recovery succeeded in the owner's existing local session; the CLI completed archive resolution and FIT parsing. Output metrics were suppressed and no personal file was retained.** | N/A |
| Exact planned-workout-to-activity link | Not provided by the download method | No deterministic linkage established | **Pending** | N/A |

The owner supplied no credentials in this task. The existing encrypted local
session was reused after restarting the instrumented connector. One owner-
provided activity was downloaded and passed through the existing local archive
resolver and FIT parser; its ID and metrics were not retained in logs or
documentation. The connector's random correlation ID was
`84ef7bf6b5a57c0841222cf9a3092497`. No password or MFA was requested, no Garmin
mutation or cleanup was performed, and no original file was retained. Login,
post-restart token resume, device listing, and simple/interval publication and
sync are separately attributed to the owner's report. Thus the phase is **not
homologated**, there is no go decision for issue #73/#74, and there is no
evidence of an exact workout occurrence-to-activity identifier.

The previous download route collapsed transport and parsing failures to
`unavailable` and emitted no stage diagnostics, so the original failed attempt
cannot be assigned a remote status retrospectively. Review against pinned
`garminconnect==0.3.20` identified a concrete protocol mismatch: its official
`Client.download()` adds `Accept: */*`, while the bounded streaming path omitted
that header. The real read-only retry after restoring that contract completed
download, archive resolution, and FIT parsing. The regression test failed
before the fix because the required header was absent and passes after the fix.
New diagnostic records use only a random request ID, fixed stage/code/error
category, HTTP status, duration, byte count, and content category; no activity
ID, URL, response body, or personal metric is recorded.
Workout ID, title, and date alone are not treated as execution identity. A
future phase needs either a verified remote linkage or an explicit confirmation
flow with deterministic candidate evidence; a historical FIT proves download
only, not a new planned workout's execution.

No physical run is required to continue coding. MFA, independent inspection of
workout step/target/date fidelity on the device, FIT metric comparison against
the owner's activity, exact workout-to-activity linkage, and remaining failure
experiments remain manual acceptance steps. Any cleanup must
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
