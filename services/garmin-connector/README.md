# Private Garmin connector

Python 3.12, FastAPI/Uvicorn and `garminconnect==0.3.20` (MIT) are pinned in
`requirements.in`; transitive runtime and test dependencies plus wheel hashes
are fixed in `requirements.lock` and `requirements-dev.lock`. The upstream
library requires Python >=3.12 and no longer depends on `garth`. Read the
project's operation and security contract in `../../docs/garmin-integration.md`.

Run with Docker Compose from the repository root:

```bash
docker compose build garmin-connector
docker compose up -d
docker compose ps
```

The service binds only inside the Compose network on port 8080. It runs as
UID/GID 10001 with Uvicorn access logs disabled. `GET /healthz` has no Garmin
side effect. Do not publish a connector port or add it to Cloudflare. The
Python image is built for the ZimaOS host architecture by the deployment helper;
the current development host is amd64, which is not evidence of the ZimaOS
host architecture.

Run automated tests without Garmin credentials or calls:

```bash
python3 -m venv .venv-garmin
. .venv-garmin/bin/activate
python -m pip install --require-hashes -r services/garmin-connector/requirements-dev.lock
cd services/garmin-connector
PYTHONPATH=. coverage run --source=app -m pytest
coverage report -m
```

Coverage scope is `services/garmin-connector/app`; test modules are excluded.
The current measured line coverage is 84%; uncovered paths are listed by
`coverage report -m`, so this is evidence of exercised code rather than a
complete coverage claim. The 14 tests exercise HTTP validation, mocked Garmin
methods, AES-GCM persistence, MFA lifetime/ownership, mutation reconciliation,
and payload boundaries. No CI job or live Garmin test is added in this phase.
