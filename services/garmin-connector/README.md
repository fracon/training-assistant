# Private Garmin connector

Python 3.12, FastAPI/Uvicorn and `garminconnect==0.3.20` (MIT) are pinned in
`requirements.in`; transitive runtime and test dependencies plus wheel hashes
are fixed in `requirements.lock` and `requirements-dev.lock`. The upstream
library requires Python >=3.12 and no longer depends on `garth`. Read the
project's operation and security contract in `../../docs/garmin-integration.md`.

For local development without Docker, use the repository-level preparation
command once. It verifies Python 3.12+, creates/reuses `.venv-garmin`, installs
the hash-locked development dependencies, and prepares private pilot settings
after the operator selects an active Kinesis account by email:

```bash
npm run garmin:setup
```

Start `npm run dev` and `npm run garmin:connector` in separate terminals. The
local Python process uses the prepared virtualenv, listens on `127.0.0.1`,
disables access logs/reload, and receives only the runtime variables it needs.
It uses the same private configuration as `npm run garmin:pilot`. No Docker or
manual shell activation is needed. The local token store is under the ignored
`.kinesis-private/garmin-store` directory.

For ZimaOS, run Compose from the repository root as described in
`docs/garmin-integration.md`. There the service binds only inside the Compose
network on port 8080, has no published port, and runs as UID/GID 10001. The
Python image is built for the ZimaOS host architecture by the deployment helper;
the development host architecture does not establish the ZimaOS architecture.
`GET /healthz` has no Garmin side effect in either mode.

The workout catalog follows `garminconnect==0.3.20`'s
`SportTypeModel` (`sportTypeId`, `sportTypeKey`, optional `displayOrder`).
`running_catalog_status` is `available`, `absent`, or `unknown` and describes
only whether the account's returned workout-type catalog contains the exact
`sportTypeKey: "running"`; it says nothing about device transfer or sync. An
empty, absent, or malformed catalog is `unknown`, not `absent`. For a live,
read-only local diagnostic, run `npm run garmin:pilot -- capabilities-diagnose`;
it outputs a sanitized structure/count and allowlisted sport fields only.

Run automated tests without Garmin credentials or calls:

```bash
cd services/garmin-connector
PYTHONPATH=. ../../.venv-garmin/bin/python -m coverage run --branch --source=app -m pytest
../../.venv-garmin/bin/python -m coverage report -m
```

Coverage scope is `services/garmin-connector/app`; test modules are excluded.
`tests/conftest.py` blocks socket connections, so CI/local tests cannot call
Garmin. Tests use the real pinned `Garmin` wrapper and `Client` types with
simulated transport/authentication, plus narrow fake operation responses. The
coverage report measures both lines and branches; the current percentages are
recorded in `docs/garmin-integration.md` and uncovered paths remain visible in
`coverage report -m`. These figures are not the Node coverage gate. There is no
CI job or live Garmin test in this phase.

The local Node TTY adapter has its own browser-free tests and a separate
coverage command: `npm run test:garmin-pilot-coverage`. It covers the CLI, local
config loader, setup/launcher, authorization rechecks, stream handling, and
synthetic FIT parsing; its report is separate from both the required Node
backend gate and Python coverage.
