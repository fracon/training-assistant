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
PYTHONPATH=. coverage run --branch --source=app -m pytest
coverage report -m
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
coverage command: `npm run test:garmin-pilot-coverage`. It covers the CLI,
authorization rechecks, stream handling, and synthetic FIT parsing; its report
is separate from both the required Node backend gate and Python coverage.
