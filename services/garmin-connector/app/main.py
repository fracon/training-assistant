"""Versioned, private HTTP adapter for the unofficial Garmin Connect client."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, Header, HTTPException, Path as PathParam, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

MAX_BODY_BYTES = 64 * 1024
MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
MAX_PAGE_SIZE = 25
CHALLENGE_TTL_SECONDS = 300
MAX_MFA_ATTEMPTS = 3
MAX_WORKOUT_SCAN_PAGES = 11
MAX_REMOTE_OPERATION_SECONDS = 90
MAX_ORIGINAL_REDIRECTS = 3
ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")
app = FastAPI(title="Kinesis Garmin connector", version="1",
              docs_url=None, redoc_url=None, openapi_url=None)
_logger = logging.getLogger("uvicorn.error")
_guard = threading.Lock()
_locks: dict[str, threading.RLock] = {}
_challenges: dict[str, dict[str, Any]] = {}
_states: dict[str, str] = {}
_clock = time.monotonic
_active_requests = 0
MAX_CONCURRENT_REQUESTS = 4


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class AuthStart(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=1024)


class AuthFinish(StrictModel):
    challenge_id: str = Field(min_length=20, max_length=100)
    code: str = Field(min_length=1, max_length=32)


class AuthCancel(StrictModel):
    challenge_id: str = Field(min_length=20, max_length=100)


class ActivityQuery(StrictModel):
    start: date
    end: date
    offset: int = Field(default=0, ge=0, le=10000)
    limit: int = Field(default=10, ge=1, le=MAX_PAGE_SIZE)


class WorkoutSchedule(StrictModel):
    workout_id: int = Field(gt=0)
    date: date


class WorkoutPayload(StrictModel):
    operation_id: uuid.UUID
    name: str = Field(min_length=1, max_length=32, pattern=r"^[\w .-]+$")
    warmup_seconds: int = Field(default=0, ge=0, le=3600)
    interval_seconds: int = Field(ge=1, le=7200)
    recovery_seconds: int = Field(default=0, ge=0, le=3600)
    repetitions: int = Field(default=1, ge=1, le=20)
    cooldown_seconds: int = Field(default=0, ge=0, le=3600)
    target_lower_mps: float | None = Field(default=None, ge=0.5, le=10)
    target_upper_mps: float | None = Field(default=None, ge=0.5, le=10)


def _secret(name: str) -> bytes:
    value = os.environ.get(name, "")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception as exc:
        raise RuntimeError(f"Invalid runtime setting: {name}") from exc
    if len(decoded) != 32:
        raise RuntimeError(f"Invalid runtime setting: {name}")
    return decoded


def _connection(connection_id: str, owner_id: str, owner_header: str | None) -> tuple[Path, bytes]:
    pilot_owner = os.environ.get("GARMIN_PILOT_USER_ID", "")
    if os.environ.get("GARMIN_PILOT_ENABLED") != "true" or owner_id != pilot_owner:
        raise HTTPException(403, detail={"code": "unsupported"})
    expected = os.environ.get("KINESIS_GARMIN_SERVICE_TOKEN", "")
    if not expected or not secrets.compare_digest(expected, owner_header or ""):
        raise HTTPException(401, detail={"code": "auth_required"})
    if not ID_RE.fullmatch(connection_id) or not ID_RE.fullmatch(owner_id):
        raise HTTPException(400, detail={"code": "invalid_payload"})
    root = Path(os.environ.get("GARMIN_STORE", "/var/lib/kinesis-garmin"))
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    path = root / f"{owner_id}-{connection_id}.bin"
    return path, _secret("GARMIN_ENCRYPTION_KEY")


def _lock(key: str) -> threading.RLock:
    with _guard:
        return _locks.setdefault(key, threading.RLock())


def _challenge_state(owner_id: str, connection_id: str, path: Path) -> str:
    return "connected" if path.exists() else "disconnected"


def _remove_connection_challenges(owner_id: str, connection_id: str) -> None:
    for challenge_id, challenge in list(_challenges.items()):
        if challenge["owner"] == owner_id and challenge["connection"] == connection_id:
            _challenges.pop(challenge_id, None)


def _previous_connection_state(owner_id: str, connection_id: str, path: Path) -> str:
    previous = next((challenge["previous_state"] for challenge in _challenges.values()
                     if challenge["owner"] == owner_id
                     and challenge["connection"] == connection_id), None)
    if previous is not None:
        return previous
    current = _states.get(str(path))
    if current == "mfa_required":
        return _challenge_state(owner_id, connection_id, path)
    return current or _challenge_state(owner_id, connection_id, path)


def _check_deadline(deadline: float) -> None:
    if _clock() > deadline:
        raise TimeoutError("Garmin operation exceeded its time budget")


def _expire_challenges() -> None:
    for challenge_id, challenge in list(_challenges.items()):
        with _lock(challenge["path"]):
            current = _challenges.get(challenge_id)
            if current is challenge and challenge["expires"] <= _clock():
                _challenges.pop(challenge_id, None)
                _states[challenge["path"]] = challenge["previous_state"]


def _token_bytes(client: Any, token_dir: Path) -> bytes:
    transport = getattr(client, "client", None)
    if transport is None or not transport.is_authenticated:
        raise RuntimeError("Garmin authentication did not produce a usable session")
    transport.dump(str(token_dir))
    token_file = token_dir / "garmin_tokens.json"
    clear = token_file.read_bytes()
    parsed = json.loads(clear)
    if not isinstance(parsed, dict) or not (parsed.get("di_token") or parsed.get("jwt_web")):
        raise RuntimeError("Garmin returned an incomplete token store")
    return clear


def _persist_tokens(client: Any, token_dir: Path, token_file: Path,
                    path: Path, key: bytes) -> None:
    clear = _token_bytes(client, token_dir)
    token_file.write_bytes(clear)
    os.chmod(token_file, 0o600)
    _save_encrypted(path, key, clear)


def _operation_journal(path: Path, key: bytes) -> dict[str, Any]:
    journal_path = path.with_suffix(".ops")
    if not journal_path.exists():
        return {}
    value = json.loads(_decrypt(journal_path, key))
    if not isinstance(value, dict):
        raise ValueError("invalid operation journal")
    return value


def _save_operation_journal(path: Path, key: bytes, journal: dict[str, Any]) -> None:
    journal_path = path.with_suffix(".ops")
    _save_encrypted(journal_path, key, json.dumps(journal, sort_keys=True).encode())


def _activity_download_base(client: Any, download_format: Any) -> str:
    from garminconnect import Garmin

    endpoints = {
        Garmin.ActivityDownloadFormat.ORIGINAL: client.garmin_connect_fit_download,
        Garmin.ActivityDownloadFormat.TCX: client.garmin_connect_tcx_download,
        Garmin.ActivityDownloadFormat.GPX: client.garmin_connect_gpx_download,
        Garmin.ActivityDownloadFormat.KML: client.garmin_connect_kml_download,
        Garmin.ActivityDownloadFormat.CSV: client.garmin_connect_csv_download,
    }
    try:
        return endpoints[download_format]
    except (KeyError, TypeError) as exc:
        raise ValueError("Unsupported Garmin activity format") from exc


def _save_encrypted(path: Path, key: bytes, clear: bytes) -> None:
    nonce = secrets.token_bytes(12)
    encrypted = b"KGC1" + nonce + AESGCM(key).encrypt(nonce, clear, path.name.encode())
    fd, name = tempfile.mkstemp(prefix=".token-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encrypted)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        os.chmod(path, 0o600)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _decrypt(path: Path, key: bytes) -> bytes:
    if path.is_symlink():
        raise ValueError("invalid encrypted token record")
    data = path.read_bytes()
    if len(data) < 32 or not data.startswith(b"KGC1"):
        raise ValueError("invalid encrypted token record")
    return AESGCM(key).decrypt(data[4:16], data[16:], path.name.encode())


@contextmanager
def _client(path: Path, key: bytes, *, email: str | None = None,
            password: str | None = None, restore: bool = True,
            persist_on_exit: bool = True, set_connected_on_exit: bool = True,
            stage_callback=None, diagnostic_id: str | None = None):
    """Materialize library JSON only in a private temporary directory."""
    from garminconnect import Garmin

    with tempfile.TemporaryDirectory(prefix="kgc-") as tmp:
        os.chmod(tmp, 0o700)
        token_dir = Path(tmp)
        token_file = token_dir / "garmin_tokens.json"
        client = Garmin(email, password, return_on_mfa=True)
        original_tokens = None
        successful = False
        operation_error = None
        try:
            if restore and path.exists():
                if stage_callback:
                    stage_callback("restore_session")
                original_tokens = _decrypt(path, key)
                token_file.write_bytes(original_tokens)
                os.chmod(token_file, 0o600)
                client.login(str(token_dir))
                if not client.client.is_authenticated:
                    raise RuntimeError("Stored Garmin tokens did not restore an authenticated session")
            yield client, token_dir, token_file
            successful = True
        except BaseException as exc:
            operation_error = exc
            raise
        finally:
            maintenance_error = None
            try:
                if persist_on_exit and client.client.is_authenticated:
                    if stage_callback and operation_error is None:
                        stage_callback("persist_session")
                    clear = _token_bytes(client, token_dir)
                    if successful or original_tokens is None or clear != original_tokens:
                        token_file.write_bytes(clear)
                        os.chmod(token_file, 0o600)
                        _save_encrypted(path, key, clear)
                if successful and set_connected_on_exit:
                    _states[str(path)] = "connected"
            except Exception as exc:
                maintenance_error = exc
                if operation_error is not None:
                    _logger.warning(
                        "garmin_download request_id=%s stage=persist_session "
                        "exception=%s code=unavailable",
                        diagnostic_id or "none",
                        _safe_exception_category(exc),
                    )
            finally:
                try:
                    if stage_callback and operation_error is None and maintenance_error is None:
                        stage_callback("cleanup_temp")
                    token_file.unlink(missing_ok=True)
                except Exception as exc:
                    if operation_error is None and maintenance_error is None:
                        maintenance_error = exc
                    else:
                        _logger.warning(
                            "garmin_download request_id=%s stage=cleanup_temp "
                            "exception=%s code=unavailable",
                            diagnostic_id or "none",
                            _safe_exception_category(exc),
                        )
            if operation_error is None and maintenance_error is not None:
                raise maintenance_error


def _error(exc: Exception) -> HTTPException:
    text = str(exc).lower()
    if type(exc).__name__ == "GarminConnectTooManyRequestsError" or "429" in text or "rate limit" in text:
        code, status = "rate_limited", 429
    elif type(exc).__name__ == "GarminConnectAuthenticationError" or any(
        word in text for word in ("auth", "token", "login", "mfa", "credential")
    ):
        code, status = "auth_required", 401
    elif isinstance(exc, ValueError):
        code, status = "invalid_payload", 400
    else:
        code, status = "unavailable", 503
    headers = None
    response = getattr(exc, "response", None)
    retry_after = getattr(response, "headers", {}).get("Retry-After") if response else None
    if code == "rate_limited" and retry_after and str(retry_after).isdigit():
        headers = {"Retry-After": str(min(int(retry_after), 300))}
    return HTTPException(status, detail={"code": code}, headers=headers)


def _record_error(path: Path, exc: Exception) -> HTTPException:
    error = _error(exc)
    code = error.detail.get("code") if isinstance(error.detail, dict) else None
    _states[str(path)] = (
        "reauthentication_required" if code == "auth_required"
        else "temporarily_unavailable"
    )
    return error


@app.middleware("http")
async def limit_body(request: Request, call_next):
    global _active_requests
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
        return JSONResponse(status_code=413, content={"error": {"code": "invalid_payload"}})
    if request.method in ("POST", "PUT", "PATCH") and not length:
        return JSONResponse(status_code=411, content={"error": {"code": "invalid_payload"}})
    with _guard:
        if _active_requests >= MAX_CONCURRENT_REQUESTS:
            return JSONResponse(status_code=503, content={"error": {"code": "unavailable"}})
        _active_requests += 1
    _expire_challenges()
    try:
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response
    finally:
        with _guard:
            _active_requests -= 1


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok", "contract": "v1"}


@app.post("/v1/connections/{owner_id}/{connection_id}/auth/start")
def auth_start(owner_id: str, connection_id: str, body: AuthStart,
               x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _connection(connection_id, owner_id, x_kinesis_service_key)
    with _lock(str(path)):
        previous_state = _previous_connection_state(owner_id, connection_id, path)
        _remove_connection_challenges(owner_id, connection_id)
        _states[str(path)] = "authenticating"
        try:
            with _client(path, key, email=body.email, password=body.password,
                         restore=False, persist_on_exit=False,
                         set_connected_on_exit=False) as (
                client, token_dir, token_file
            ):
                result = client.login(str(token_dir))
                if result and result[0] == "needs_mfa":
                    challenge_id = secrets.token_urlsafe(32)
                    _challenges[challenge_id] = {
                        "owner": owner_id, "connection": connection_id,
                        "path": str(path), "previous_state": previous_state,
                        "state": result[1], "expires": _clock() + CHALLENGE_TTL_SECONDS,
                        "attempts": 0,
                    }
                    _states[str(path)] = "mfa_required"
                    return {"status": "mfa_required", "challenge_id": challenge_id,
                            "expires_in": CHALLENGE_TTL_SECONDS}
                _persist_tokens(client, token_dir, token_file, path, key)
                _states[str(path)] = "connected"
                return {"status": "connected"}
        except Exception as exc:
            error = _error(exc)
            if previous_state == "connected" and path.exists():
                _states[str(path)] = previous_state
            elif error.detail.get("code") == "auth_required":
                _states[str(path)] = "reauthentication_required"
            else:
                _states[str(path)] = "temporarily_unavailable"
            raise error from None


@app.post("/v1/connections/{owner_id}/{connection_id}/auth/finish")
def auth_finish(owner_id: str, connection_id: str, body: AuthFinish,
                x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _connection(connection_id, owner_id, x_kinesis_service_key)
    with _lock(str(path)):
        challenge = _challenges.get(body.challenge_id)
        if not challenge or challenge["owner"] != owner_id or challenge["connection"] != connection_id:
            raise HTTPException(400, detail={"code": "auth_required"})
        if challenge["expires"] <= _clock() or challenge["attempts"] >= MAX_MFA_ATTEMPTS:
            _challenges.pop(body.challenge_id, None)
            _states[str(path)] = challenge["previous_state"]
            raise HTTPException(400, detail={"code": "auth_required"})
        try:
            with _client(path, key, restore=False, persist_on_exit=False,
                         set_connected_on_exit=False) as (
                client, token_dir, token_file
            ):
                client.resume_login(challenge["state"], body.code)
                if not client.client.is_authenticated:
                    raise RuntimeError("MFA did not produce a usable Garmin session")
                _persist_tokens(client, token_dir, token_file, path, key)
            _challenges.pop(body.challenge_id, None)
            _states[str(path)] = "connected"
            return {"status": "connected"}
        except Exception as exc:
            error = _error(exc)
            if error.detail.get("code") == "auth_required":
                challenge["attempts"] += 1
                if challenge["attempts"] >= MAX_MFA_ATTEMPTS:
                    _challenges.pop(body.challenge_id, None)
                    _states[str(path)] = challenge["previous_state"]
                else:
                    _states[str(path)] = "mfa_required"
                raise error from None
            if error.detail.get("code") in ("rate_limited", "invalid_payload"):
                raise error from None
            _states[str(path)] = "mfa_required"
            raise error from None


@app.post("/v1/connections/{owner_id}/{connection_id}/auth/cancel")
def auth_cancel(owner_id: str, connection_id: str, body: AuthCancel,
                x_kinesis_service_key: str | None = Header(default=None)):
    path, _ = _connection(connection_id, owner_id, x_kinesis_service_key)
    with _lock(str(path)):
        challenge = _challenges.get(body.challenge_id)
        if challenge and challenge["owner"] == owner_id and challenge["connection"] == connection_id:
            _challenges.pop(body.challenge_id, None)
            _states[str(path)] = challenge["previous_state"]
        return {"status": _states.get(str(path), _challenge_state(owner_id, connection_id, path))}


@app.get("/v1/connections/{owner_id}/{connection_id}/status")
def status(owner_id: str, connection_id: str,
           x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _connection(connection_id, owner_id, x_kinesis_service_key)
    with _lock(str(path)):
        _expire_challenges()
        if any(challenge["path"] == str(path) for challenge in _challenges.values()):
            return {"status": "mfa_required"}
    current = _states.get(str(path))
    if not path.exists():
        return {"status": current or "disconnected"}
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                client.get_user_profile()
            return {"status": "connected"}
        except Exception as exc:
            error = _record_error(path, exc)
            return {"status": _states[str(path)], "error": error.detail["code"]}


@app.delete("/v1/connections/{owner_id}/{connection_id}")
def disconnect(owner_id: str, connection_id: str,
               x_kinesis_service_key: str | None = Header(default=None)):
    path, _ = _connection(connection_id, owner_id, x_kinesis_service_key)
    with _lock(str(path)):
        path.unlink(missing_ok=True)
        path.with_suffix(".ops").unlink(missing_ok=True)
        _states[str(path)] = "disconnected"
        _remove_connection_challenges(owner_id, connection_id)
    return {"status": "disconnected", "remote_revocation": "not_proven"}


def _authenticated_client(owner_id: str, connection_id: str, service_key: str | None):
    path, key = _connection(connection_id, owner_id, service_key)
    if not path.exists():
        raise HTTPException(401, detail={"code": "auth_required"})
    return path, key


@app.get("/v1/connections/{owner_id}/{connection_id}/capabilities")
def capabilities(owner_id: str, connection_id: str,
                 x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    deadline = _clock() + MAX_REMOTE_OPERATION_SECONDS
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                types = client.get_workout_types()
                _check_deadline(deadline)
                devices = client.get_devices()
                _check_deadline(deadline)
                catalog = _workout_catalog_summary(types)
                return {
                    # This is the account's Garmin workout-type catalog, not
                    # a claim that a listed device can receive or sync workouts.
                    "running_catalog_status": catalog["status"],
                    "running_supported": (
                        True if catalog["status"] == "available"
                        else False if catalog["status"] == "absent" else None
                    ),
                    "devices": [
                        {"device_id": str(item.get("deviceId", "")),
                         "name": str(item.get("productDisplayName", ""))[:80]}
                        for item in devices if item.get("deviceId") is not None
                    ],
                }
        except Exception as exc:
            raise _record_error(path, exc) from None


_WORKOUT_TYPE_STRUCTURE_KEYS = frozenset({
    "workoutSportTypes", "workoutStepTypes", "workoutConditionTypes",
    "workoutTargetTypes", "workoutIntensityTypes", "strokeTypes",
})


def _workout_catalog_summary(types):
    """Return a bounded, personal-data-free view of the Garmin type catalog."""
    summary = {
        "response_type": type(types).__name__,
        "top_level_keys": [],
        "sport_types_type": "missing",
        "sport_type_count": None,
        "sport_types": [],
        "status": "unknown",
    }
    if not isinstance(types, dict):
        return summary
    summary["top_level_keys"] = sorted(
        key for key in types if isinstance(key, str) and key in _WORKOUT_TYPE_STRUCTURE_KEYS
    )
    sports = types.get("workoutSportTypes")
    summary["sport_types_type"] = type(sports).__name__
    if not isinstance(sports, list):
        return summary
    summary["sport_type_count"] = len(sports)
    if not sports:
        # An empty payload does not establish that Garmin's catalog is complete.
        return summary
    normalized = []
    for item in sports:
        if not isinstance(item, dict):
            return summary
        sport_id = item.get("sportTypeId")
        sport_key = item.get("sportTypeKey")
        display_order = item.get("displayOrder", 1)
        if (isinstance(sport_id, bool) or not isinstance(sport_id, int)
                or not isinstance(sport_key, str)
                or not re.fullmatch(r"[a-z0-9_]{1,80}", sport_key)
                or isinstance(display_order, bool) or not isinstance(display_order, int)):
            return summary
        normalized.append({
            "sport_type_id": sport_id,
            "sport_type_key": sport_key,
            "display_order": display_order,
        })
    summary["sport_types"] = normalized
    summary["status"] = "available" if any(
        item["sport_type_key"] == "running" for item in normalized
    ) else "absent"
    return summary


@app.get("/v1/connections/{owner_id}/{connection_id}/workout-catalog")
def workout_catalog(owner_id: str, connection_id: str,
                    x_kinesis_service_key: str | None = Header(default=None)):
    """Read only the workout-type catalog and return a safe diagnostic summary."""
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    deadline = _clock() + MAX_REMOTE_OPERATION_SECONDS
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                result = _workout_catalog_summary(client.get_workout_types())
                _check_deadline(deadline)
                return result
        except Exception as exc:
            raise _record_error(path, exc) from None


@app.post("/v1/connections/{owner_id}/{connection_id}/activities")
def activities(owner_id: str, connection_id: str, body: ActivityQuery,
               x_kinesis_service_key: str | None = Header(default=None)):
    if (body.end - body.start).days > 31 or body.end < body.start:
        raise HTTPException(400, detail={"code": "invalid_payload"})
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    deadline = _clock() + MAX_REMOTE_OPERATION_SECONDS
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                allowed = ("activityId", "activityName", "startTimeLocal", "duration", "distance",
                           "calories", "averageHR", "maxHR", "elevationGain")
                items = []
                cursor = body.offset
                page_size = max(body.limit, 1)
                previous_page_hash = None
                pages_read = 0
                search_complete = False
                while pages_read < 5:
                    rows = client.get_activities(start=cursor, limit=page_size)
                    _check_deadline(deadline)
                    if not isinstance(rows, list):
                        raise RuntimeError("Garmin activity page had an unknown shape")
                    if not rows:
                        search_complete = True
                        break
                    if len(rows) > page_size:
                        raise RuntimeError("Garmin activity page exceeded its requested size")
                    page_hash = hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()
                    if page_hash == previous_page_hash:
                        raise RuntimeError("Garmin repeated an activity page")
                    previous_page_hash = page_hash
                    pages_read += 1
                    for row in rows:
                        if not isinstance(row, dict):
                            raise RuntimeError("Garmin activity item had an unknown shape")
                        local_start = row.get("startTimeLocal")
                        if not isinstance(local_start, str) or len(local_start) < 10:
                            raise RuntimeError("Garmin activity item had an unknown date")
                        try:
                            activity_day = date.fromisoformat(local_start[:10])
                        except ValueError as exc:
                            raise RuntimeError("Garmin activity item had an invalid date") from exc
                        if body.start <= activity_day <= body.end:
                            items.append({key: str(value)[:120] if key == "activityName" else value
                                          for key, value in row.items() if key in allowed})
                            if len(items) == body.limit:
                                break
                    if len(items) >= body.limit:
                        search_complete = True
                        break
                    cursor += len(rows)
                    oldest = min(date.fromisoformat(row["startTimeLocal"][:10]) for row in rows)
                    if len(rows) < page_size or oldest < body.start:
                        search_complete = True
                        break
                if not search_complete:
                    raise RuntimeError("Activity pagination reached its request limit")
                return {"items": items, "offset": body.offset,
                        "limit": body.limit}
        except Exception as exc:
            raise _record_error(path, exc) from None


@app.get("/v1/connections/{owner_id}/{connection_id}/activities/{activity_id}/original")
def activity_original(owner_id: str, connection_id: str, activity_id: int = PathParam(gt=0),
                      x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    deadline = _clock() + MAX_REMOTE_OPERATION_SECONDS
    diagnostic_id = secrets.token_hex(16)
    stage = ["restore_session"]
    started = _clock()
    received = 0
    response = None
    response_closed = False
    content_category = "missing"
    remote_status = None
    failure = None
    data = None

    def mark_stage(value):
        stage[0] = value

    with _lock(str(path)):
        try:
            from garminconnect import Garmin

            with _client(path, key, stage_callback=mark_stage,
                         diagnostic_id=diagnostic_id) as (client, _, _):
                try:
                    stage[0] = "request_original"
                    response = _request_original_stream(
                        client, Garmin.ActivityDownloadFormat.ORIGINAL,
                        activity_id, deadline,
                    )
                    remote_status = getattr(response, "status_code", None)
                    content_category = _download_content_category(response)
                    if remote_status != 200:
                        raise _download_failure("unavailable", 502)
                    if content_category in {"html", "json"}:
                        raise _download_failure("invalid_payload", 422)
                    declared = (getattr(response, "headers", {}) or {}).get("Content-Length")
                    if declared is not None:
                        declared = str(declared).strip()
                        if not declared.isdigit() or int(declared) > MAX_DOWNLOAD_BYTES:
                            raise _download_failure("invalid_payload", 413)
                    chunks = []
                    stage[0] = "read_original"
                    for chunk in response.iter_content(chunk_size=64 * 1024):
                        _check_deadline(deadline)
                        if not chunk:
                            continue
                        received += len(chunk)
                        if received > MAX_DOWNLOAD_BYTES:
                            raise _download_failure("invalid_payload", 413)
                        chunks.append(chunk)
                    data = b"".join(chunks)
                    if not data.startswith(b"PK"):
                        raise _download_failure("invalid_payload", 422)
                except Exception as exc:
                    failure = exc
                    raise
                finally:
                    if response is not None:
                        try:
                            response.close()
                        except Exception as close_exc:
                            response_closed = True
                            if failure is None:
                                stage[0] = "close_response"
                                raise close_exc
                            _logger.warning(
                                "garmin_download request_id=%s stage=close_response "
                                "code=unavailable exception=%s remote_status=%s",
                                diagnostic_id, _safe_exception_category(close_exc),
                                remote_status if isinstance(remote_status, int) else "none",
                            )
                        else:
                            response_closed = True
                stage[0] = "persist_session"
        except Exception as exc:
            failure = exc

    duration_ms = max(0, round((_clock() - started) * 1000))
    if failure is not None:
        error = failure if isinstance(failure, HTTPException) else _error(failure)
        if not isinstance(failure, HTTPException):
            _record_error(path, failure)
        remote_status = _download_remote_status(failure, response, remote_status)
        code = error.detail.get("code", "unavailable") if isinstance(error.detail, dict) else "unavailable"
        if remote_status == 401:
            code = "auth_required"
            error = HTTPException(401, detail={"code": code})
            _states[str(path)] = "reauthentication_required"
        elif remote_status == 404:
            code = "invalid_payload"
            error = HTTPException(400, detail={"code": code})
        elif remote_status == 429:
            code = "rate_limited"
            error = HTTPException(429, detail={"code": code})
        if response is None:
            response = getattr(failure, "response", None)
        if response is not None:
            content_category = _download_content_category(response)
            if not response_closed:
                try:
                    response.close()
                except Exception as close_exc:
                    _logger.warning(
                        "garmin_download request_id=%s stage=close_response "
                        "code=unavailable exception=%s remote_status=%s",
                        diagnostic_id, _safe_exception_category(close_exc),
                        remote_status if isinstance(remote_status, int) else "none",
                    )
        _log_download_diagnostic(
            diagnostic_id, stage[0], code, failure, remote_status,
            duration_ms, received, content_category,
        )
        headers = dict(error.headers or {})
        headers["X-Kinesis-Diagnostic-Id"] = diagnostic_id
        raise HTTPException(error.status_code, detail={"code": code}, headers=headers) from None

    _log_download_diagnostic(
        diagnostic_id, "connector_response", "ok", None,
        remote_status, duration_ms, received, content_category,
    )
    return Response(
        data, media_type="application/octet-stream",
        headers={
            "Content-Disposition": 'attachment; filename="activity.zip"',
            "X-Kinesis-Diagnostic-Id": diagnostic_id,
        },
    )


def _download_failure(code: str, status_code: int):
    return HTTPException(status_code, detail={"code": code})


def _download_content_category(response) -> str:
    headers = getattr(response, "headers", {}) or {}
    raw = headers.get("Content-Type") or headers.get("content-type") or ""
    media_type = str(raw).split(";", 1)[0].strip().lower()
    if media_type in {"application/zip", "application/octet-stream", "application/x-zip-compressed"}:
        return "zip"
    if media_type in {"text/html", "application/xhtml+xml"}:
        return "html"
    if media_type == "application/json" or media_type.endswith("+json"):
        return "json"
    return "other" if media_type else "missing"


def _request_original_stream(client, download_format, activity_id: int, deadline: float):
    from garminconnect import Garmin

    request_path = f"{_activity_download_base(client, download_format)}/{activity_id}"
    url = client.client._resolve_url(request_path)
    origin = urlsplit(url)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password:
        raise _download_failure("unsupported", 502)
    current = url
    redirects = 0
    while True:
        _check_deadline(deadline)
        remaining = max(1, min(30, int(deadline - _clock())))
        response = client.client._run_request(
            "GET", current, headers={"Accept": "*/*"}, stream=True,
            timeout=remaining, allow_redirects=False,
        )
        status = getattr(response, "status_code", None)
        if status is not None and 300 <= status < 400:
            location = (getattr(response, "headers", {}) or {}).get("Location")
            try:
                response.close()
            except Exception:
                pass
            if not location or redirects >= MAX_ORIGINAL_REDIRECTS:
                raise _download_failure("unavailable", 502)
            target = urlsplit(urljoin(current, str(location)))
            if (target.scheme != "https" or target.hostname != origin.hostname
                    or (target.port or 443) != (origin.port or 443)
                    or target.username or target.password
                    or target.fragment or len(target.geturl()) > 4096):
                raise _download_failure("unsupported", 502)
            current = target.geturl()
            redirects += 1
            continue
        return response


def _download_remote_status(exc, response, current_status):
    if isinstance(current_status, int):
        return current_status
    status = getattr(response, "status_code", None)
    if not isinstance(status, int):
        status = getattr(getattr(exc, "response", None), "status_code", None)
    return status if isinstance(status, int) else None


def _safe_exception_category(exc) -> str:
    if exc is None:
        return "none"
    name = type(exc).__name__
    if isinstance(exc, TimeoutError) or "Timeout" in name:
        return "timeout"
    if name == "GarminConnectAuthenticationError":
        return "garmin_authentication"
    if name == "GarminConnectTooManyRequestsError":
        return "garmin_rate_limit"
    if name in {"GarminConnectConnectionError", "GarminConnectNotFoundError"}:
        return "garmin_remote"
    if type(exc).__module__.startswith("requests.exceptions"):
        if name in {"ConnectionError", "ChunkedEncodingError", "ContentDecodingError"}:
            return "network_read"
        return "network_transport"
    if isinstance(exc, HTTPException):
        return "connector_http"
    if isinstance(exc, ValueError):
        return "validation"
    if isinstance(exc, OSError):
        return "io"
    return "internal"


def _log_download_diagnostic(request_id, stage, code, exc, remote_status,
                             duration_ms, received, content_category):
    logger = _logger.info if code == "ok" else _logger.warning
    logger(
        "garmin_download request_id=%s stage=%s code=%s exception=%s "
        "remote_status=%s duration_ms=%d bytes_received=%d content=%s",
        request_id, stage, code, _safe_exception_category(exc),
        remote_status if isinstance(remote_status, int) else "none",
        duration_ms, received, content_category,
    )


@app.post("/v1/connections/{owner_id}/{connection_id}/workouts")
def publish_workout(owner_id: str, connection_id: str, body: WorkoutPayload,
                    x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    deadline = _clock() + MAX_REMOTE_OPERATION_SECONDS
    with _lock(str(path)):
        mutation_started = False
        try:
            from garminconnect.workout import (
                PaceTarget, RunningWorkout, WorkoutSegment, create_cooldown_step,
                create_interval_step, create_recovery_step, create_repeat_group,
                create_targeted_interval_step, create_warmup_step,
            )
            if (body.target_lower_mps is None) != (body.target_upper_mps is None):
                raise ValueError("Both pace bounds are required")
            if body.repetitions == 1 and body.recovery_seconds:
                raise ValueError("Recovery is only supported between repeated intervals")
            if body.target_lower_mps is not None and body.target_lower_mps > body.target_upper_mps:
                raise ValueError("Pace bounds are invalid")
            operation_token = base64.urlsafe_b64encode(body.operation_id.bytes).decode().rstrip("=")
            marker = f"K{operation_token}-"
            fingerprint_full = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
            fingerprint = fingerprint_full
            remote_fingerprint = fingerprint_full[:8]
            expected_name = f"{marker}{remote_fingerprint}"
            with _client(path, key) as (client, _, _):
                journal = _operation_journal(path, key)
                prior_operation = journal.get(str(body.operation_id))
                if prior_operation and prior_operation.get("fingerprint") != fingerprint:
                    raise HTTPException(409, detail={"code": "invalid_payload"})
                entries = []
                complete_scan = False
                for page in range(MAX_WORKOUT_SCAN_PAGES):
                    chunk = client.get_workouts(start=page * 100, limit=100,
                                                my_workouts_only=True)
                    _check_deadline(deadline)
                    if not isinstance(chunk, list):
                        raise RuntimeError("Garmin workout list had an unknown shape")
                    if any(not isinstance(item, dict) for item in chunk):
                        raise RuntimeError("Garmin workout entry had an unknown shape")
                    entries.extend(chunk)
                    if len(chunk) < 100:
                        complete_scan = True
                        break
                prior = next((item for item in entries
                              if marker in str(item.get("workoutName", ""))), None)
                if prior:
                    if prior.get("workoutName") != expected_name:
                        raise HTTPException(409, detail={"code": "invalid_payload"})
                    workout_id = int(prior["workoutId"])
                    journal[str(body.operation_id)] = {
                        "fingerprint": fingerprint, "status": "complete",
                        "workout_id": workout_id,
                    }
                    _save_operation_journal(path, key, journal)
                    return {"operation_id": str(body.operation_id),
                            "workout_id": workout_id, "created": False,
                            "status": "reconciled"}
                if not complete_scan or prior_operation is not None:
                    raise HTTPException(503, detail={"code": "outcome_unknown"})
                target = None
                if body.target_lower_mps is not None:
                    target = PaceTarget(lower_limit=body.target_lower_mps,
                                        upper_limit=body.target_upper_mps)
                interval_order = 2 if body.warmup_seconds else 1
                interval_step_order = 1 if body.repetitions > 1 else interval_order
                interval = (create_targeted_interval_step(
                    body.interval_seconds, step_order=interval_step_order, target=target
                ) if target else create_interval_step(body.interval_seconds, step_order=interval_step_order))
                repeated_steps = [interval]
                if body.repetitions > 1:
                    if body.recovery_seconds < 1:
                        raise ValueError("Recovery is required for repeats")
                    repeated_steps.append(create_recovery_step(body.recovery_seconds, step_order=2))
                    interval_group = create_repeat_group(body.repetitions, repeated_steps,
                                                        step_order=interval_order)
                else:
                    interval_group = repeated_steps[0]
                steps = []
                if body.warmup_seconds:
                    steps.append(create_warmup_step(body.warmup_seconds, step_order=1))
                steps.append(interval_group)
                if body.cooldown_seconds:
                    steps.append(create_cooldown_step(body.cooldown_seconds, step_order=len(steps) + 1))
            workout = RunningWorkout(
                workoutName=expected_name[:60],
                estimatedDurationInSecs=(body.warmup_seconds + body.repetitions *
                                         (body.interval_seconds + body.recovery_seconds) + body.cooldown_seconds),
                workoutSegments=[WorkoutSegment(
                    segmentOrder=1,
                    sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                    workoutSteps=steps,
                )],
            )
            with _client(path, key) as (client, _, _):
                if len(journal) >= 1000:
                    raise HTTPException(503, detail={"code": "unavailable"})
                journal[str(body.operation_id)] = {"fingerprint": fingerprint, "status": "pending"}
                _save_operation_journal(path, key, journal)
                mutation_started = True
                result = client.upload_running_workout(workout)
                _check_deadline(deadline)
                workout_id = result.get("workoutId") if isinstance(result, dict) else None
                if not isinstance(workout_id, int):
                    raise RuntimeError("remote workout result not confirmed")
                confirmed = client.get_workout_by_id(workout_id)
                _check_deadline(deadline)
                if not isinstance(confirmed, dict) or confirmed.get("workoutName") != expected_name:
                    raise RuntimeError("remote workout reconciliation did not match")
                journal[str(body.operation_id)] = {
                    "fingerprint": fingerprint, "status": "complete",
                    "workout_id": workout_id,
                }
                _save_operation_journal(path, key, journal)
                return {"operation_id": str(body.operation_id),
                        "workout_id": workout_id, "created": True, "status": "created",
                        "workout": {"name": confirmed.get("workoutName", ""),
                                    "steps": len(confirmed.get("workoutSegments", [{}])[0].get("workoutSteps", []))}}
        except HTTPException:
            raise
        except Exception as exc:
            _record_error(path, exc)
            if mutation_started:
                raise HTTPException(503, detail={"code": "outcome_unknown"}) from None
            raise _error(exc) from None


@app.post("/v1/connections/{owner_id}/{connection_id}/workouts/schedule")
def schedule_workout(owner_id: str, connection_id: str, body: WorkoutSchedule,
                     x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    deadline = _clock() + MAX_REMOTE_OPERATION_SECONDS
    with _lock(str(path)):
        mutation_started = False
        try:
            with _client(path, key) as (client, _, _):
                journal = _operation_journal(path, key)
                journal_id = f"schedule:{body.workout_id}:{body.date.isoformat()}"
                fingerprint = hashlib.sha256(journal_id.encode()).hexdigest()
                previous_operation = journal.get(journal_id)
                if previous_operation and previous_operation.get("fingerprint") != fingerprint:
                    raise HTTPException(409, detail={"code": "invalid_payload"})

                def calendar_occurrence():
                    value = client.get_scheduled_workouts(body.date.year, body.date.month)
                    _check_deadline(deadline)
                    if not isinstance(value, dict) or not isinstance(value.get("calendarItems"), list):
                        raise RuntimeError("Garmin calendar response was inconclusive")
                    matching = []
                    for item in value["calendarItems"]:
                        if not isinstance(item, dict) or "itemType" not in item:
                            raise RuntimeError("Garmin calendar item had an unknown shape")
                        if item["itemType"] != "workout":
                            continue
                        item_date = item.get("date")
                        item_workout = item.get("workoutId")
                        if not isinstance(item_date, str) or not item_date[:10]:
                            raise RuntimeError("Garmin workout occurrence lacked a date")
                        try:
                            civil_date = date.fromisoformat(item_date[:10])
                        except ValueError as exc:
                            raise RuntimeError("Garmin calendar returned an invalid civil date") from exc
                        if civil_date == body.date and item_workout is None:
                            raise RuntimeError("Garmin workout occurrence lacked its workout identity")
                        if (str(item_workout) == str(body.workout_id)
                                and civil_date == body.date):
                            matching.append(item)
                    if len(matching) > 1:
                        raise RuntimeError("Garmin calendar contains duplicate matching occurrences")
                    return matching[0] if matching else None

                prior = calendar_occurrence()
                if prior:
                    occurrence_id = prior.get("id")
                    if occurrence_id is None:
                        raise HTTPException(503, detail={"code": "outcome_unknown"})
                    journal[journal_id] = {"fingerprint": fingerprint, "status": "complete",
                                           "scheduled_workout_id": occurrence_id}
                    _save_operation_journal(path, key, journal)
                    return {"scheduled": True, "status": "reconciled",
                            "scheduled_workout_id": occurrence_id}
                if previous_operation is not None:
                    raise HTTPException(503, detail={"code": "outcome_unknown"})
                if len(journal) >= 1000:
                    raise HTTPException(503, detail={"code": "unavailable"})
                journal[journal_id] = {"fingerprint": fingerprint, "status": "pending"}
                _save_operation_journal(path, key, journal)

                mutation_started = True
                client.schedule_workout(body.workout_id, body.date.isoformat())
                _check_deadline(deadline)
                confirmed = calendar_occurrence()
                if not confirmed or confirmed.get("id") is None:
                    raise HTTPException(503, detail={"code": "outcome_unknown"})
                journal[journal_id] = {"fingerprint": fingerprint, "status": "complete",
                                       "scheduled_workout_id": confirmed["id"]}
                _save_operation_journal(path, key, journal)
                return {"scheduled": True, "status": "scheduled",
                        "scheduled_workout_id": confirmed["id"]}
        except HTTPException:
            raise
        except Exception as exc:
            error = _record_error(path, exc)
            if mutation_started:
                raise HTTPException(503, detail={"code": "outcome_unknown"}) from None
            if error.status_code in (400, 401, 429):
                raise error from None
            raise HTTPException(503, detail={"code": "outcome_unknown"}) from None


@app.get("/v1/connections/{owner_id}/{connection_id}/workouts/{workout_id}")
def read_workout(owner_id: str, connection_id: str, workout_id: int,
                 x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                workout = client.get_workout_by_id(workout_id)
                segments = workout.get("workoutSegments", [])
                return {"workout_id": workout_id,
                        "name": str(workout.get("workoutName", ""))[:60],
                        "steps": len(segments[0].get("workoutSteps", [])) if segments else 0}
        except Exception as exc:
            raise _record_error(path, exc) from None


@app.exception_handler(Exception)
async def sanitized_unexpected_error(_request: Request, _exc: Exception):
    return JSONResponse(status_code=503, content={"error": {"code": "unavailable"}},
                        headers={"Cache-Control": "no-store"})


@app.exception_handler(RequestValidationError)
async def sanitized_validation_error(_request: Request, _exc: RequestValidationError):
    return JSONResponse(status_code=400, content={"error": {"code": "invalid_payload"}},
                        headers={"Cache-Control": "no-store"})
