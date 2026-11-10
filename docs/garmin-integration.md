# Garmin Connect integration contract

Status: **The multiuser mode is under review; real two-account ZimaOS
acceptance and full Garmin/device homologation remain pending.** This
document separates library documentation, simulated tests, account evidence,
and device evidence. Nothing in the first two categories is a substitute for
the last two.

## Authorization and privacy boundary

The project owner explicitly authorized an unofficial Garmin Connect
integration, a private Python container in the Kinesis Compose deployment, and
a proof of concept using the owner's Garmin account and Forerunner 55. This
authorization covers the selected workout and the owner's own activity data
only. Multiuser enablement is explicitly authorized by the owner; each user
acts on their own account. It does not permit publishing another user's data, public connector
access, sending FIT/GPS to OpenAI or another service, deleting preexisting
Garmin records, or paid OpenAI calls. Real two-account and device acceptance
remains separate from the synthetic validation.

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
- In 0.3.20, `Garmin.get_user_profile()` returns the user-settings endpoint
  (`/userprofile-service/userprofile/user-settings`); the method's contract
  does not require an account ID in that payload. The library's own
  `_load_social_profile()` reads `/userprofile-service/socialProfile` and
  assigns `profileId` to `client.profile_id` when it is an integer. Kinesis
  keeps the existing `userData.id`/`userId` fingerprint path when present for
  continuity, then uses the same fixed social-profile endpoint and requires
  `profileId`; it never fabricates an identity. Authentication diagnostics
  identify the fixed operation (`read_user_settings`, `validate_user_settings`,
  `read_social_profile`, `validate_social_profile`, or `persist_tokens`) and an allowlisted exception
  class/category, without raw messages or profile content.
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
| Update workout | `PUT /v1/connections/{owner}/{connection}/workouts/{id}` | Requires a completed source operation ID, its scheduled occurrence ID, and matching encrypted schedule provenance; retains workout ID and reconciles by operation ID/fingerprint |
| Schedule workout | `POST /v1/connections/{owner}/{connection}/workouts/schedule` | Requires the completed publish operation ID and confirms a pending occurrence by that workout/date before reconciling |
| Reschedule occurrence | `PUT /v1/connections/{owner}/{connection}/workouts/schedule/{occurrence_id}` | Requires completed source-operation and schedule journal proof for the exact workout/occurrence pair; moves only that occurrence's civil date in place and records the completed reschedule as a future provenance source |
| List activities | `POST /v1/connections/{owner}/{connection}/activities` | Required date window <=31 days, offset, page size <=25; response fields are allowlisted |
| Download original | `GET /v1/connections/{owner}/{connection}/activities/{id}/original` | Max response 25 MiB; bytes are not logged or persisted by Node |

Errors include `auth_required`, `mfa_required`, `rate_limited`, `unavailable`,
`unsupported`, `invalid_payload`, and `outcome_unknown`. A timed-out upload is
reported as uncertain; it must be reconciled by querying matching workouts
before any retry. The adapter confirms a created workout by looking it up
before returning its ID. Scheduling uncertainty still requires explicit
calendar reconciliation. No delete operation is exposed for remote activities
or workouts.

### Update/reschedule recovery and provenance

The connector's encrypted operation journal is the provenance authority for
workout and occurrence ownership. Successful publish, update, and reschedule
operations are addressable by their operation UUID and record the artifact
kind, workout ID, occurrence ID (when applicable), source operation, and
request fingerprint. A later update or reschedule must cite that completed
operation and independently prove the occurrence through the completed
schedule journal entry. Matching Garmin names or IDs alone never establish
ownership.

Reschedule writes both its operation UUID alias and the historical
`reschedule:<UUID>` journal key. This keeps subsequent reschedules and updates
working after connector restart without relying on process memory. Existing
branch journals that contain only a completed legacy reschedule can be
recovered only if its stored fingerprint matches the exact occurrence/workout/
civil-date tuple and a completed schedule record binds that same occurrence to
that workout. Old pending update records can continue only when their exact
legacy request fingerprint and source occurrence proof match; the connector
preserves that old marker fingerprint while reconciling. If either proof is
missing or conflicting, the operation is refused as uncertain/invalid rather
than adopting a remote artifact or deleting data. No journal migration deletes
or rewrites existing records preemptively.

When one product update changes both structure and date, Node deliberately
sends the same stable product `operation_id` to the update and reschedule
endpoints, with the same source operation and workout/occurrence binding. The
connector represents that as one completed `artifact_kind: "composite"` root
with separate `steps.update` and `steps.reschedule` records. Each step keeps
its own fingerprint and completion evidence; the root fingerprint is derived
from both step fingerprints. The existing `update:<UUID>` and
`reschedule:<UUID>` records remain the per-step idempotency journals. This
avoids UUID churn while preventing the two different payload fingerprints
from colliding. Composite operations are valid provenance sources only after
both steps are confirmed. Follow-up update/reschedule calls still prove the
workout and exact occurrence independently.

The connector validates the prospective composite identity before dispatching
the reschedule mutation. If the update alias, source operation, workout,
occurrence, or per-step fingerprint conflicts, it refuses before touching the
remote calendar. A pending reschedule is persisted before dispatch. If the
remote date changes but its response or final journal write is lost, retry
reads that exact occurrence: the target workout/date confirms the reschedule
and completes the composite without repeating the mutation; the previous date
permits the same journaled mutation to continue; any other/divergent state
remains uncertain. An update whose response is lost is similarly reconciled
from its step marker and workout read before rescheduling can begin. These
steps are not a distributed transaction and do not claim remote rollback.

For the branch's exact legacy failure shape (completed UUID update alias plus
`reschedule:<UUID>` pending with the expected fingerprint, where Garmin may
already show the target date), the same reschedule request can repair the
root into a composite after confirming workout ID, occurrence ID and target
civil date. It records completion without resending a reschedule when that
date is already present. If the source journal, occurrence proof, or pending
fingerprint does not match, the connector leaves the old journal intact and
returns a sanitized conflict/uncertain result; it does not infer ownership
from the name or numeric IDs, discard tokens, or clear the journal.

Node persists the concrete in-flight stage before each remote mutation. An
update failure remains at `update` or `update_confirmation`; a following
reschedule remains at `reschedule`. Reconciliation reuses the same operation
UUID and connector journal. For a legacy row with `stage=unknown`, IDs do not
prove an update: Node dispatches the same idempotent update operation for
connector reconciliation and accepts completion only when the connector
returns the expected workout ID and an explicit `updated`/`reconciled` status.
The connector confirms updates by reading the workout and matching the
operation marker/fingerprint, and confirms schedule changes by reading the
specific occurrence and checking workout ID and civil date. An unavailable,
malformed, failed, or divergent confirmation remains uncertain; it never
advances based only on stored remote IDs. Once an update is confirmed, a
separate persisted reschedule stage can resume without repeating the update.

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
connection ID. It also stores an encrypted `.ops` journal for publish, schedule,
update, and reschedule idempotency;
the journal contains only operation fingerprints, states and Garmin IDs, never
FIT/GPS or credentials. `GARMIN_ENCRYPTION_KEY` is a 32-byte URL-safe base64 key supplied at
runtime, independently of the token store and image. The service key is a separate
runtime secret shared with Node. Locally both secrets are generated once by
`npm run garmin:setup`, stored in the mode-0600 ignored file
`.kinesis-private/garmin-pilot.json`, and reused on later preparations and
restarts. The private parent and local token store are mode 0700; records are
mode 0600, and replacement is atomic. The connector runs as UID/GID 10001.

Back up the encrypted token store (including `.ops` and `.auth`) and encryption key
separately using the operator's protected backup system. A restore requires
both. Locally, protect `.kinesis-private/garmin-pilot.json` and the adjacent
store separately under the same policy; never put this directory in Git or an
image. Rotate
by decrypting/re-encrypting every record with an offline maintenance tool while
the service is stopped; this tool is intentionally not part of the pilot API.
If the key is lost, encrypted tokens cannot be recovered: remove the volume,
generate a new key, and reconnect locally. Reconnecting does not promise remote
token revocation. `disconnect` deletes local token ciphertext and pending
challenges. It preserves the encrypted operation journal and its provenance;
disconnecting does not delete or change workouts, scheduled occurrences, or
activities in Garmin Connect. A confirmed disconnect clears the saved local
connection state. If cleanup cannot be confirmed, Node persists a
cleanup-pending marker and the UI keeps the dialog open for an explicit retry.
A retry after restart uses that marker and does not repeat a workout mutation.
An explicit user disconnect preserves the non-secret account identity
fingerprint and connection generation so reconnecting the same account can
retain operation provenance; a different remote identity still advances the
generation. Revocation after owner ineligibility invalidates that identity.
There is not yet a supported online
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
removes local credentials/challenges, preserves operation provenance, and does
not claim remote revocation. Garmin
password and MFA are entered only through local hidden prompts. `npm run dev`
does not load the private pilot file or enable Garmin/AI globally; normal
Kinesis and manual FIT/ZIP imports work while the connector is stopped.

For Garmin values, precedence is: an explicitly inherited environment variable
wins; otherwise private local configuration supplies pilot owner, service/key,
port, and local URL/store; without either source the pilot is disabled. Local
Garmin settings are never read from `.env`. Node snapshots shell-provided values
before loading `.env`, then applies the private Garmin config; the standalone
connector and pilot CLI resolve the same shell/private precedence. This avoids
Node silently treating stale Garmin entries in `.env` as explicit overrides
that Python does not receive. Ordinary Kinesis configuration such as
`DATABASE_FILE` uses explicit environment, then `.env`, then the project
default. After changing runtime configuration, restart both local processes;
neither process hot-reloads secrets or connection settings. The
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

The browser's connection retry performs only local-state and connector status
reads; it never publishes, schedules, reconciles, or clears Garmin tokens. The
last known connection state is retained when a refresh fails, and Garmin
re-authentication is requested only when the connector reports an expired
session. Node emits a sanitized `[kinesis-garmin]` log with a random diagnostic
ID, stage, normalized code, and HTTP status; no URL, key, token, response body,
or account data is logged. `/healthz` only proves that the Python process is
alive. A successful internal status request additionally proves that the
Node/connector address and service key match; a Garmin session can still be
disconnected or expired.

The local `garmin:pilot auth` command, `npm run dev`, and the connector launcher
all resolve shell-provided Garmin settings before the same private local config;
Garmin variables in `.env` are ignored. Authentication failures now preserve
the prior encrypted session when one exists and return a normalized code plus
diagnostic ID, stage, and operation. The connector log records only that ID,
stage, fixed operation, code, allowlisted exception class/category, and remote
HTTP status. The CLI distinguishes local
transport failures, internal service-key/configuration failures, Garmin auth,
MFA, rate limits, Garmin timeouts, and token persistence failures. An
unclassified Garmin error remains `unavailable`, but includes a diagnostic ID
so the connector log can identify its stage, operation and safe exception class
without exposing the exception message. A `persistence_error` means the prior ciphertext remains authoritative;
do not delete or regenerate local tokens/configuration to retry it.

### Login profile identity diagnosis

The login path previously treated `get_user_profile()` as an identity API and
raised a generic `RuntimeError` when its user-settings object lacked
`userData.id` or `userId`. A synthetic contract test using the real 0.3.20
`Garmin` wrapper and its real `get_user_profile()`/HTTP transport path returned
the library-compatible settings shape without either identifier; this
reproduced the old `503 unavailable` at `profile_identity`. The fix keeps those
historical identity fields first (so an existing same-account fingerprint is
stable), then uses the pinned library's fixed social-profile endpoint and
requires its integer `profileId`. Malformed settings, missing remote identity,
remote authentication failures, and local programming exceptions now remain
distinct in the normalized code/operation/allowlisted exception class.

The supplied real diagnostic (`stage=profile_identity`, `code=unavailable`,
`exception=internal`, no remote status) did not include an exception class or
operation, and the account response was not captured. It therefore cannot
prove retrospectively that the owner's particular failure was the missing-ID
case, nor rule out another local exception. The code-level contract mismatch
and regression are proven synthetically; the actual account login has not been
retried. New diagnostics are sufficient to distinguish the profile read,
identity validation, token persistence, and allowlisted exception class on a
future user-initiated attempt without recording profile contents.

### Pilot variables and production boundary

| Variable | Used by | Scope |
|---|---|---|
| `GARMIN_PILOT_ENABLED` | Node and Python | Set to `true` to enable the integration; defaults to `false` |
| `GARMIN_ACCESS_MODE` | Node and Python | `pilot` (default) restricts access; explicit `multiuser` enables active authenticated accounts |
| `GARMIN_PILOT_USER_ID` | Node authorization and Python connector | Required in pilot mode; Kinesis `users.id`, not Garmin ID; ignored in multiuser mode |
| `KINESIS_GARMIN_SERVICE_TOKEN` | Node → Python authentication | Internal operator secret, retained across updates |
| `GARMIN_ENCRYPTION_KEY` | Python token/journal encryption | Internal operator secret, backed up separately from token storage |

The local setup selects the pilot account and generates/persists both secrets.
End users will not configure any of them. For ZimaOS the operator supplies the
runtime settings once per installation and preserves both secrets during image
updates. The feature stays disabled unless `GARMIN_PILOT_ENABLED=true`.
Without `GARMIN_ACCESS_MODE`, pilot restrictions remain in effect. Only the
exact value `multiuser` enables all authenticated active Kinesis users; unknown
values fail closed. Restart both services after changing the mode. The terminal
pilot CLI still requires an explicit `GARMIN_PILOT_USER_ID`.

The encrypted `.auth` sidecar stores the current authentication fence for each
owner and connection. An interrupted authentication stays blocked in SQLite;
the next status request advances the fence and reconciles a proven remote
identity before releasing it. If the connector or identity is unavailable,
the block remains and the user can retry the status request. Back up and restore
the SQLite database and all connector files as a matched set; do not delete or
rename a fence file during recovery.

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
   builds the Python image on that host architecture, then starts both. Keep
   the connector image digest/tag with deployment records; the Compose version
   is `0.29.1`. The GitHub Actions
   workflow also publishes `ghcr.io/fracon/training-assistant` and
   `ghcr.io/fracon/kinesis-garmin-connector` with `latest` and matching
   `sha-<short-commit>` tags. For an image-based deployment, select matching
   SHA tags from a successful workflow run: the pushes are independent, so a
   failed run can leave only one image updated. Verify both images can be
   pulled using the same registry permissions as the ZimaOS installation;
   package visibility or registry credentials must allow access to both.
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

For the ZimaOS interface upgrade, first record both current image digests, the
effective Compose network, the actual Garmin storage source and the Node data
source from the existing containers' mount details. Back up SQLite consistently
with the application stopped, and back up the complete Garmin storage (including
`.bin`, `.ops` and `.auth` files); store the existing encryption key separately in the
operator's secret manager. Preserve the storage source exactly: an installation
using a bind mount must continue to use that same host path. Preserve ownership
`10001:10001` and the shared bridge network; do not substitute a new volume.

In ZimaOS, edit the existing stack, select matching Node and connector image
tags from the same successful build, and retain its existing port, network and
mount settings. To enable multiuser mode set `GARMIN_PILOT_ENABLED=true` and
`GARMIN_ACCESS_MODE=multiuser` on both services, retain the same
`KINESIS_GARMIN_SERVICE_TOKEN` on both and the same `GARMIN_ENCRYPTION_KEY` on
the connector; `GARMIN_PILOT_USER_ID` is not required for the web flow. Apply
the changes and restart both containers. Verify connector health and the existing
connection before testing with synthetic data. Do not change the key or rename
encrypted files. If rollback is needed, stop both services and restore the
matching previous images, configuration, SQLite backup and Garmin storage backup
with their original key and mount source. Real acceptance with two Garmin
accounts on ZimaOS remains an operational task, separate from simulated tests.

## Automated evidence and go/no-go

The issue #73 branch moves the Node product adapter into `src/garmin/product.js`
so the required c8 backend gate includes it. The v4 idempotent operation
identity migration preserves existing operation IDs and makes retries stable
by owner, session, connection generation, prescription revision, civil date,
action, and source operation. A generated occurrence ID is persisted as a
result and is deliberately excluded from the request identity. Connector tests
exercise the pinned `Garmin.update_workout` and `Garmin.reschedule_workout`
methods with a simulated transport; automated tests make no real Garmin or
OpenAI calls.

The current editor verification on the PR branch runs 1,465 Node tests with no
failures. The serial `npm run test:coverage` gate passes at 100% statements,
branches, functions, and lines across its required backend scope, including
`src/garmin/product.js` and the v3 workout contract. The focused
product/converter suite has 108 tests and reports 100% in all four metrics for
both product and contract. The separate Garmin local-tool and CLI coverage
command runs 138 tests (93.19% statements/lines, 90.02% branches, 88.05%
functions overall); its `src/garmin/product.js` scope is 100% in all four
metrics, while interactive local scripts are reported at 87.73%
statements/lines, 74.79% branches, and 78.94% functions. The Python connector
suite has 63 tests; `app/main.py` has 82.36% line coverage and 71.64% branch
coverage. Python and local CLI coverage are separate from
the Node backend gate and are not asserted as 100%. Browser tests use a
simulated connector. None of those checks establishes live account behavior
beyond the owner-reported evidence below.

For this correction, both versioned images were rebuilt. An isolated
Node-to-connector smoke used a temporary SQLite database, private Garmin
volume, and synthetic runtime secrets. The real Node worker called the real
Python update and reschedule endpoints with the same product operation ID;
the connector Garmin client was replaced only at the simulated transport
boundary. It observed one update and one reschedule, a completed composite
journal with both step records, and the target date. After restarting the
connector, a new Node process read the same encrypted journal and synthetic
remote state. The isolated network, containers, and volume were removed.
This smoke made no Garmin or OpenAI calls and does not establish live account
behavior.
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

## Phase 2 product pilot (#73)

The #73 branch adds a small Garmin panel to the owned training-result/session
page. It is available only when the operator pilot flag is enabled and the
authenticated Kinesis account is the configured `GARMIN_PILOT_USER_ID`; an
administrator does not bypass ownership. The page supports connect/status,
transient password entry, an MFA challenge when returned, cancellation, and
local disconnect. Password and MFA code are cleared from the form after
submission; neither enters browser storage. Connector credentials remain
server-side.

An explicit prescription is stored in `garmin_workout_prescriptions`, separate
from `trainings.detalhes`, with a content fingerprint and optimistic revision.
The v1 contract is running-only and validates unique step IDs, repeat bounds,
time/distance values, absolute heart-rate bounds, and pace units. RPE is not
converted. The editor restores and round-trips interval and recovery targets,
including stored pace units and exact integer-second bounds; changing only the
friendly name does not quantize saved durations or distances. The read-only
review is generated by the Node canonical preview contract and is returned with
the saved prescription, so reload uses the same step order, targets, units and
recovery count as the editor and payload. It shows the localized planned date
(never as already scheduled), Garmin Connect as the service, and names any
account-reported device as informational only. It never implies direct delivery
or device compatibility. A compact summary reports a total only when every
relevant step has that dimension; mixed workouts show “defined time/distance”
with a note that other units are not estimated. Durations use human units such
as `2 h 20 min`, and distance duration is never inferred from pace. Repeat
groups stay compact while showing interval and recovery targets, the exact
number of recoveries, and the final-recovery policy. Open-lap, zone targets and
nested repeats are refused before dispatch instead of flattened. Original
prose is never interpreted or rewritten.

Duration fields share one browser parser: a bare integer is minutes (`3` → 180
seconds), and `m:ss` is also accepted (`3:5` → `3:05`). Values are not
rewritten while typing; valid values normalize on blur or save. The parser
rejects empty required values, zero, negative input, seconds above 59, unsupported
syntax, and per-step durations above the contract's 120-minute limit. Saving
validates active controls before serialization, reports each error beside its
field, links a localized summary to the affected step/field, and focuses the
first invalid control. Hidden target modes and disabled optional stages do not
participate. Node still validates canonical positive integer seconds and totals
before persisting; save/review does not call Garmin.

Saving opens the review and does not mutate Garmin. The explicit **Send and
schedule in Garmin Connect** action is the publish confirmation; update and
reschedule continue to use their specific confirmation dialogs. Before any
remote mutation, the browser re-reads the local snapshot and requires its
revision, fingerprint, date, and connection generation to match the reviewed
version. A stale review is refreshed and must be acted on again. The operation
is a durable owner/session/revision/fingerprint operation.
The operation is written before network dispatch, connector calls happen
outside SQLite transactions, and status can be read after reload. A timed-out
or process-interrupted `publishing`/`scheduling` operation is changed to
`outcome_unknown` on restart and is not automatically dispatched again. The
connector's encrypted operation journal continues to reconcile the same
operation marker. Repeating the same revision/action/date/source occurrence
returns its existing operation rather than creating a second one. The v4 key
does not depend on the occurrence ID returned after mutation, so adding that
remote result cannot turn a duplicate click into a new operation. A changed
structure increments the revision and marks the previous schedule outdated.
**Update in Garmin Connect** explicitly replaces the tracked workout in place,
keeping its ID; this affects every Garmin calendar occurrence that reuses that
workout, which the confirmation states. If the planned date also changed, the
operation updates the workout and then reschedules only its linked occurrence.
**Reschedule** moves that tracked occurrence without changing the workout.
Both actions require the new saved preview and a separate confirmation. The
connector verifies the source operation and workout/occurrence journal proof
before mutation and confirms the resulting state. A matching remote name, ID,
or calendar item alone is not adopted as a Kinesis artifact; an inconclusive
pre-existing occurrence stays `outcome_unknown` and is never mutated. It never
deletes a workout or activity. If one remote step
succeeds and the next fails, the local journal keeps its stage/IDs and requires
reconciliation; it does not claim a distributed rollback or create a second
workout automatically.

The review UI treats the persisted operation as its single source of truth.
During a mutation or reconciliation, editing and all new mutations are locked;
the lock remains while an uncertain, reauthentication-required, or failed
operation still needs reconciliation. The status API includes the persisted
action and stage so the UI can distinguish workout creation from a pending
schedule/reschedule. If an HTTP response is lost after dispatch, the browser
reads the owner-scoped local operation before showing an outcome; if that read
also fails, it keeps editing/mutation locked and offers a local status check.
Reconciliation resumes the existing operation and does not publish a second
workout when creation was already confirmed. A partial schedule error says the
workout was created and identifies only scheduling as incomplete; an uncertain
result says what may already have happened and asks the user to verify before
trying again. The “Verify send result” action calls Kinesis reconciliation; it
does not open Garmin Connect.

The workout title sent to Garmin Connect is the canonical saved workout name,
unchanged and without an operation UUID or hash. The connector places its
opaque operation/fingerprint marker in the pinned library model's optional
workout `description`, while the encrypted journal remains the durable source
of operation identity. For a lost create response before Garmin returns an ID,
the marker lets the connector find and reconcile that exact operation without
creating a duplicate. If neither the marker nor a persisted remote ID can
confirm the effect, the operation remains uncertain and is never republished
automatically. Existing encrypted journals need no migration: legacy marked
titles are still recognized only when the exact operation marker, request
fingerprint, and expected title agree. Existing completed operations reconcile
through their journaled workout ID and exact title. A matching friendly name
alone is never proof of ownership. The pinned `garminconnect==0.3.20` typed
`RunningWorkout` serializes `workoutName` and optional `description` separately;
remote retention of that description has not been revalidated against the live
Garmin account in this correction.

The displayed device is informational. A completed state means Garmin Connect
confirmed the workout and scheduled occurrence; it prompts watch synchronization
and does not claim that the workout is already on the Forerunner. The connector
translates timed steps and pace/absolute-HR targets to the pinned library
contract.

Distance input follows the Kinesis preferred unit and is converted to canonical
integer meters; pace remains stored with its explicit `min_per_km` or
`min_per_mile` unit and is converted for review display to the preferred unit.
Known time/distance portions are shown separately when a complete total cannot
be calculated. The adapter uses the pinned library's real
distance-step constructor and does not invent a duration. Open-lap steps remain
rejected before dispatch; nested repeats and zone targets are outside v1.
Distance creation, workout update, and occurrence rescheduling are covered by
synthetic model/transport tests, not new live Garmin calls in this PR.

### Local UI pilot

With the local private Garmin setup already prepared, run:

1. `npm run dev`
2. `npm run garmin:connector`
3. Sign in to Kinesis as the configured pilot owner, open a planned session,
   connect/re-authenticate if requested, set its explicit structure, choose
   **Save and preview / Salvar e conferir**, review destination and civil date,
   then choose **Publish and schedule / Publicar e agendar** and confirm.
4. For an already linked workout, change the structure and use **Update in
   Garmin Connect / Atualizar no Garmin Connect** after saving a new preview.
   Change only the planned civil date and use **Reschedule / Reagendar**. If
   both changed, the explicit update operation replaces the workout and moves
   the linked occurrence; inspect its state after any partial failure.
5. Reload the page and inspect the stored operation status. After a
   `scheduled` result, synchronize Garmin Connect with the watch and inspect the
   workout there. A Connect success is not physical watch-delivery proof.
6. Disconnect from the panel to remove local Garmin tokens.

`npm run dev` reads the prepared private pilot configuration into the server
process only for the restricted local owner flow. The encryption key is not
needed by Node and is not copied into its runtime environment or browser
responses; the Python launcher reads it directly for token encryption.

Existing terminal commands remain diagnostic tools. Automated tests use
synthetic data and make no Garmin/OpenAI calls. The browser UI path and its
real-account behavior still require owner homologation; this branch does not
complete phase acceptance merely by passing mocks.

The #73 branch adds route/conversion and lifecycle tests, plus a Chrome flow
covering saved HR/pace/recovery targets, preserving a dirty form while Garmin
status is pending, complete interval preview, explicit confirmation,
polling/reload and PT/EN. Chrome captures use synthetic user/device names and a
simulated connector; they show layout only, not Garmin evidence. The new UI has
not been exercised against the owner's connection.

#### Chrome captures (synthetic connector)

| State | English | Português |
|---|---|---|
| Session editor, desktop 1280×900 | [Capture](garmin-pilot-screenshots/en-desktop.png) | [Captura](garmin-pilot-screenshots/pt-desktop.png) |
| Session editor, mobile 390×844 | [Capture](garmin-pilot-screenshots/en-mobile.png) | [Captura](garmin-pilot-screenshots/pt-mobile.png) |
| Interval preview, including recovery target/count and final-recovery policy | [Capture](garmin-pilot-screenshots/en-preview.png) | [Captura](garmin-pilot-screenshots/pt-preview.png) |
| Distance preview, preferred miles | [Capture](garmin-pilot-screenshots/en-distance-preview.png) | — |

The low-height desktop capture is [available separately](garmin-pilot-screenshots/en-low-window.png).

### Evidence and remaining boundary

Owner-reported prior CLI evidence remains: simple and interval workouts were
published and scheduled, and both appeared in Garmin Connect and reached the
Forerunner 55 after normal synchronization. These are reports about the CLI
pilot, not this new UI. The new UI requires a separate end-to-end walkthrough.
MFA was not exercised on the real account. Exact planned-workout-to-completed-
activity identity remains unproven and belongs to #74. ZimaOS deployment and
final operational validation remain tracked in #76.

At the time of the phase 2 editor delivery, activity import (#74) remained
separate. Neither the editor nor its scheduled state marks a session complete,
adds shoe mileage, generates analysis, imports FIT, or enables account-wide
synchronization. The separately delivered phase 3 behavior is described below.

## Structured workout editor v3

The product editor stores new/edited prescriptions as contract `version: 3`.
Version 1 and 2 records remain read in place and no-op review writes the
existing value unchanged, preserving their stored fingerprints. Editing an old
repeat group without recovery opens it with an empty recovery field and an
explicit explanation. The person must enter a positive recovery or explicitly
convert the repeats to simple run blocks; no recovery is invented. Existing
operation rows retain their stored `converter_version`; new operations record
converter version 3. A dispatched operation is never rewritten under its old
identity and historical v1/v2 operations remain reconcilable.

A v3 prescription is an ordered sequence of optional warm-up, running blocks,
and optional cool-down. A running block is either one timed/distance interval,
a repeat group with a required independent timed/distance recovery, or an
independent recovery after a run/repeat block. That recovery may be followed by
another running block or be the final work step immediately before an optional
cool-down (or the final step when there is no cool-down). A recovery before any
run/repeat remains invalid. Every block has its own target:
none, absolute heart-rate bounds in bpm, or pace bounds in min/km or min/mile.
This ordering is a Kinesis prescription rule; it is not asserted as a Garmin
Connect restriction. The pinned connector's workout-step mapping supports an
ordered recovery step at this position and is checked with synthetic models.
In v3 every repeat contains a positive recovery interval. The
`skip_last_rest_step` policy yields N−1 recoveries when enabled and N when
disabled. v2 remains accepted for historical operations, including groups
without recovery; those records are not silently upgraded. The preview renders
the exact validated sequence and reports known time/distance without inventing
duration for distance-based steps.

Validation keeps the stable `invalid_prescription` API code and may include a
sanitized `diagnostic.reason` (`step_position_invalid`, `step_duration_limit`,
`total_duration_limit`, `distance_limit`, `expanded_steps_limit`,
`repetition_count_invalid`, `target_invalid`, or `malformed_structure`). The
editor maps these to localized block/summary guidance. The 120-minute per-step,
24-hour total-time, 100 km distance, 50 expanded-step, and 20-repeat limits are
current Kinesis contract limits, not claims about Garmin product limits.

The Node validator and Python connector independently enforce the same v3
shape, targets, ordering, positive durations/distances, 20-repeat maximum,
50-expanded-step maximum, 24-hour timed-workout bound, and 100 km aggregate
distance bound. `garminconnect==0.3.20` models are built from this structure:
run intervals use the upstream interval helpers, repeat groups use
`create_repeat_group`, and the connector maps warm-up/recovery/cool-down
end conditions and targets to Garmin step models. These are synthetic contract
checks against the pinned library, not a new real-device homologation.

The form has explicit independent warm-up/cool-down toggles; disabled stages
are omitted, not encoded with zero. Run blocks can be added, duplicated,
removed, and moved with buttons, including while another field contains an
incomplete draft; only “Save and review” validates the full prescription.
Equal repeats always show a running interval, recovery, count, and final-
recovery policy. Missing/invalid recovery is rejected before saving or remote
mutation. Time and pace entry use `min:sec`,
heart-rate targets use integer bpm, and distance is entered in the preferred
km/mi unit and stored in meters. “Salvar e revisar / Save and review” persists
only to Kinesis and opens a read-only preview; it does not call Garmin. The
primary send-and-schedule action is explicit and does not add a redundant
confirmation dialog; update and reschedule retain their impact-specific
confirmations.

Garmin's [workout support documentation](https://support.garmin.com/en-CA/?faq=wZ52AaLbLG2GC1Lxu2l4k7&identifier=777730&tab=topics)
describes workout steps and repeat/recovery structures. Device-specific
acceptance still depends on Garmin Connect and the selected watch; the v3
converter test is not proof that every accepted structure reaches a device.
The connection remains restricted to the configured pilot owner. No multi-user
production integration is delivered by this editor.

## Activity result import (issue #74)

The session's **Result and feedback / Resultado e feedback** source selector has
an explicit Garmin Connect search path beside FIT/ZIP and manual entry. It uses
the same pilot connection and MFA controls as workout planning. Search is a
user action; opening the accordion, loading the session, previewing candidates,
and downloading an original do not update the training, conclude it, change shoe
mileage, publish anything, or call an AI provider.

Node remains the product authorization and SQLite owner. It checks the active,
configured pilot owner, authenticated session, current connection generation,
connection account fingerprint, and training ownership. Candidate IDs are
looked up again in the connected account's bounded activity listing before the
original is downloaded. The browser cannot supply a Garmin owner, remote URL,
account fingerprint, FIT bytes, or a result payload. A separate account's IDs
are not accepted as evidence. Connector traffic remains private and uses the
existing service token and pinned `garminconnect==0.3.20` adapter.

Search is limited to the 31 civil dates centered on the planned session date
(15 days before through 15 days after), with ten displayed rows per request and
an explicit bounded “load more” action. Each connector request is capped at
five upstream pages of at most 25 rows and the connector enforces the 90 second
operation deadline and rate-limit handling. Candidate data is an allowlisted,
sanitized subset of Garmin activity summaries. Its activity type, local start,
duration, distance, heart rate, calories, and elevation are descriptive only.
Known non-running sport keys are omitted; missing/malformed sport metadata is
shown as unknown and the downloaded FIT must still identify a running activity.
The list's optional pace is explicitly an estimate from Garmin summary
duration/distance and is never persisted; the preview uses FIT-derived canonical
pace.
The action “Buscar resultado deste treino / Find this workout's result” uses
that same bounded search. The pinned connector's activity-list contract exposes
an activity ID, name, local start time, sport, and summary metrics; neither that
list nor the parsed FIT contract exposes a verified Kinesis workout/occurrence
to performed-activity relation. Kinesis publication and schedule records keep
their workout and occurrence IDs, but these are not returned as an association
on activity rows. A same-day candidate is therefore suggested only when the
activity is identified as running, with both criteria shown and an explicit
statement that Garmin has not confirmed the link. No schedule time is invented.
Other dates and candidates without those criteria remain selectable but are
not given the suggestion label. Two same-day runs remain separate choices;
the user must choose and confirm one. Free runs and sessions never published
by Kinesis remain supported.

After a Garmin result is saved, its activity ID and a “Trocar atividade / Switch
activity” action appear with the result. This opens the same candidate list;
preview and back/cancel leave the saved result intact, and the existing explicit
replacement confirmation applies to a completed result as well. The schema
keeps one identity row per account/activity and a partial unique current link
per session. When an activity is replaced, its row becomes historical. If that
same activity is later selected again for the same session (A → B → A), the
existing account/activity row is reactivated in the import transaction; it is
not duplicated or blocked by history. A link to another session is still
refused while another session has it as its current activity. A retired
historical link may be reused in another session after a fresh preview; its old
session record remains intact. No Garmin-side workout or activity is changed.

Preview rechecks that the activity appears in the connected owner's bounded
window, downloads the connector's original ZIP with redirects disabled at the
Node boundary, validates its response type and 25 MiB streaming limit, extracts
exactly one FIT through `src/fitUpload.js`, and runs `src/fitParser.js` locally.
The parser's existing canonical pace, duration, calories, heart rate, elevation,
and laps are persisted without a second metrics interpretation. No original
file or GPS trace is stored on disk or in SQLite: the server keeps only the
parsed preview and hash in process memory for five minutes, scoped to the
current account, login session, training, connection generation, and result
snapshot. Reload, process restart, expiry, or a connection change requires a new
search and preview. Parser and download failures leave the previous result
untouched; diagnostics returned to the browser contain stable codes only.

The idempotent `2026-11-garmin-activity-import-v1` migration adds
`garmin_activity_imports`; `2026-11-garmin-activity-import-v2` evolves and
repairs its schema. V2 adds `is_current` with default 0, treating every row
from a legacy schema as historical. The prior schema has no evidence that can
identify a current row, so migration never guesses or assigns a current link.
All existing rows and their activity/session/account provenance are preserved;
only a newly confirmed import can create a current association. V2 validates
the table's required columns, foreign keys, duplicate identities/current rows,
and ensures the canonical indexes in one SQLite transaction. It records its
marker only after success. Unsafe legacy data fails startup with an actionable
error; no links are deleted or rewritten. An interrupted migration rolls back
its schema and index changes. It is idempotent when the v1 marker predates the
`is_current` column.

The idempotent `2026-11-garmin-activity-import-v3` migration rebuilds the import
table transactionally to remove v1's global unique account/activity constraint
while copying every row and timestamp unchanged. It adds a unique current-only
account/activity index, keeps one history row for each account/activity/session
tuple, and retains one current activity per session. It refuses duplicate
current activities or duplicate same-session history before changing the table.
The import transaction now blocks only an activity currently used by another
session. A historical row for that activity is reactivated for the same session
or kept alongside the new session's row; the partial current index still
prevents simultaneous use. No migration backfills a current link.

An activity identity is the Garmin connection's
account fingerprint plus its remote activity ID; file SHA-256 and importer
version are retained as supporting evidence. Hash alone is not treated as a
universal activity ID. Exact same-activity/same-file/same-summary reimport is a
no-op. A changed file or summary needs the same explicit replacement path.
Unique account/activity and one-current-activity-per-session constraints stop
cross-session double use and concurrent current links. Replacing the current
activity leaves its historical row, marks it non-current, and preserves it
across disconnect or account changes. Manual/FIT replacement also marks Garmin
provenance historical; result deletion follows the existing training cascade.
The session response exposes only the current activity ID and import time, not
the account fingerprint. Manual FIT uploads do not yet supply a stable Garmin
activity ID to compare, so the shared evidence table now records equality of
the validated FIT bytes for both direct FIT/ZIP uploads and the extracted FIT
inside Garmin's original ZIP. It also records a hash of the sole complete FIT
`file_id` activity tuple (manufacturer, product, serial number, and creation
time) when present. The tuple is useful when exporters rewrite bytes, but is
not a universal activity ID and may be absent or changed by an exporter. Only
exact byte hashes, this stable file-ID tuple, and the independently
account-qualified Garmin activity identity can trigger an exclusivity conflict;
similar metrics never do. A hash only proves identical bytes, so distinct FIT
exports of the same execution can still evade this evidence.

The idempotent `2026-11-training-result-evidence-v1` migration adds the shared
current/history evidence table and indexes in one transaction. It backfills
only account-qualified Garmin activity IDs from existing Garmin import rows,
preserving each row's current/history state. It does not create FIT hashes or
file IDs for old uploads because the FIT bytes are no longer available, and it
does not infer current links from summaries. Thus deduplication is not
retroactively complete for historical manual FIT/ZIP results. Current evidence
is retired and replaced with the result atomically; historic entries remain
available for a later A→B→A reactivation but do not block reuse. The original
FIT bytes are parsed in memory and are not retained.

The idempotent `2026-11-training-result-evidence-v2` migration repairs a
persisted v1 table whose UNIQUE key omitted `source`, even though the current
replacement UPSERT targets `(user_id, training_id, evidence_type,
evidence_value, source)`. It transactionally rebuilds that known table shape
with the five-column key, copying every evidence ID, value, source, current flag,
and timestamp. This also removes the old stricter four-column key, which would
otherwise block the same FIT evidence when its source changes. Before rebuilding
it validates columns, foreign keys, current-identity uniqueness, and custom
indexes; unknown or ambiguous schemas fail startup with an actionable error
and full rollback. The marker is written only after the indexes are restored.
The idempotent v3 follow-up repeats the schema check for databases where an
early v2 marker exists but the stricter key remains. The inspected database had
the v1 marker and source column, but its autoindex covered only the first four
columns; schema metadata alone cannot establish when that drift was introduced.
FIT upload, Garmin import, feedback, and shoe-mileage history are not backfilled
or rewritten by these repairs.

The activity list response carries the connector's actual next cursor and
`has_more`/budget state. `budget_exhausted` means only that the current request
used its five-page remote-call budget; it is not end-of-search. The UI offers
one explicit continuation at that cursor and keeps the cursor on recoverable
failure. The global cursor limit remains 10,000; when that limit is reached,
the API marks `limit_reached` and the UI explains the boundary without claiming
that no activity exists. A filtered page with no running activities is
announced as intermediate when continuation exists; no automatic traversal is
started. Only a completed search with no candidates is presented as no matches.

Preview and the confirmation modal make no SQLite writes. After confirmation,
Node rechecks the preview's owner/session, active state, connection identity and
generation, session date, shoe selection, and objective result snapshot inside
one immediate SQLite transaction. It writes canonical result metrics, FIT lap
summary, current provenance, and the shoe-mileage ledger delta together. A
linked activity on another session, stale preview, changed connection, removed
session, replacement without confirmation, or concurrent import returns a
conflict without partial writes. Reimporting an identical current import does
not add mileage again. Existing subjective feedback, selected shoe, and
completion state are preserved. If there is no valid saved RPE 1–5, the result
stays open and displays feedback pending; objective import never invents RPE.
Saving feedback later uses the existing completion contract, context freshness,
and analysis invalidation. Replacing a completed result requires confirmation.
No analysis or OpenAI request is started by import.

This is synthetic verification of the private Node→Python contract and local
FIT parser/persistence path. No Garmin account or watch was contacted for this
delivery. The manual owner acceptance, including a free run, a published
session, delayed Connect sync, Forerunner 55 result, feedback save, disconnect,
and reconnection/account-history review, remains an operational task in #76.
The implementation has no webhook and does not receive data directly from the
watch; Garmin Connect must first finish its normal watch synchronization.

Synthetic Chrome review captures: [PT desktop preview](garmin-activity-import-screenshots/pt-review-desktop.png), [PT low window at 200% zoom](garmin-activity-import-screenshots/pt-review-low-height-zoom-200.png), and [EN mobile with feedback pending](garmin-activity-import-screenshots/en-imported-mobile.png). These show the UI against synthetic activity data and are not Garmin homologation evidence.

The filtered-page continuation is also captured in [PT desktop](garmin-activity-import-screenshots/pt-empty-filtered-page-desktop.png), [PT mobile](garmin-activity-import-screenshots/pt-empty-filtered-page-mobile.png), and [EN desktop](garmin-activity-import-screenshots/en-empty-filtered-page-desktop.png). The empty filtered page and continuation are synthetic UI verification only.

The per-request page-budget continuation is captured in [EN desktop, empty first page](garmin-activity-import-screenshots/en-budget-exhausted-empty-desktop.png), [PT desktop, partial results](garmin-activity-import-screenshots/pt-budget-exhausted-partial-desktop.png), [PT mobile](garmin-activity-import-screenshots/pt-budget-exhausted-partial-mobile.png), and [EN mobile](garmin-activity-import-screenshots/en-budget-exhausted-partial-mobile.png). These simulated pages show manual continuation after each five-page request budget; they do not represent live Garmin data.

Cross-path exact-identity conflicts are captured in [PT desktop](garmin-activity-import-screenshots/pt-duplicate-activity-conflict.png), [EN desktop](garmin-activity-import-screenshots/en-duplicate-activity-conflict.png), [PT mobile](garmin-activity-import-screenshots/pt-duplicate-activity-conflict-mobile.png), and [EN mobile](garmin-activity-import-screenshots/en-duplicate-activity-conflict-mobile.png). The screenshots show the previous result retained after the explicit replacement was refused; they use synthetic FIT and Garmin transport data.
