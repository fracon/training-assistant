"""Versioned, private HTTP adapter for the unofficial Garmin Connect client."""

from __future__ import annotations

import base64
import hashlib
import json
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
ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")
app = FastAPI(title="Kinesis Garmin connector", version="1",
              docs_url=None, redoc_url=None, openapi_url=None)
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
def _client(path: Path, key: bytes, *, email: str | None = None, password: str | None = None):
    """Materialize library JSON only in a private temporary directory."""
    from garminconnect import Garmin

    with tempfile.TemporaryDirectory(prefix="kgc-") as tmp:
        os.chmod(tmp, 0o700)
        token_dir = Path(tmp)
        token_file = token_dir / "garmin_tokens.json"
        client = Garmin(email, password, return_on_mfa=True)
        if path.exists():
            token_file.write_bytes(_decrypt(path, key))
            os.chmod(token_file, 0o600)
            client.login(str(token_dir))
        try:
            yield client, token_dir, token_file
        except BaseException:
            raise
        else:
            _states[str(path)] = "connected"
        finally:
            if token_file.exists():
                clear = token_file.read_bytes()
                if clear:
                    _save_encrypted(path, key, clear)
                token_file.unlink(missing_ok=True)


def _error(exc: Exception) -> HTTPException:
    text = str(exc).lower()
    if type(exc).__name__ == "GarminConnectTooManyRequestsError" or "429" in text or "rate limit" in text:
        code, status = "rate_limited", 429
    elif type(exc).__name__ == "GarminConnectAuthenticationError" or any(
        word in text for word in ("auth", "token", "login", "mfa", "credential")
    ):
        code, status = "auth_required", 401
    elif isinstance(exc, (ValueError, TypeError)):
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
        for challenge_id, challenge in list(_challenges.items()):
            if challenge["expires"] <= _clock():
                _challenges.pop(challenge_id, None)
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
        _states[str(path)] = "authenticating"
        try:
            with _client(path, key, email=body.email, password=body.password) as (
                client, token_dir, _token_file
            ):
                result = client.login(str(token_dir), return_on_mfa=True)
                if result and result[0] == "needs_mfa":
                    challenge_id = secrets.token_urlsafe(32)
                    _challenges[challenge_id] = {
                        "owner": owner_id, "connection": connection_id,
                        "state": result[1], "expires": _clock() + CHALLENGE_TTL_SECONDS,
                        "attempts": 0,
                    }
                    _states[str(path)] = "mfa_required"
                    return {"status": "mfa_required", "challenge_id": challenge_id,
                            "expires_in": CHALLENGE_TTL_SECONDS}
                _states[str(path)] = "connected"
                return {"status": "connected"}
        except Exception as exc:
            raise _record_error(path, exc) from None


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
            raise HTTPException(400, detail={"code": "auth_required"})
        try:
            with _client(path, key) as (client, token_dir, _token_file):
                client.resume_login(challenge["state"], body.code)
                client.dump(str(token_dir))
            _challenges.pop(body.challenge_id, None)
            _states[str(path)] = "connected"
            return {"status": "connected"}
        except Exception as exc:
            challenge["attempts"] += 1
            if challenge["attempts"] >= MAX_MFA_ATTEMPTS:
                _challenges.pop(body.challenge_id, None)
            raise _record_error(path, exc) from None


@app.post("/v1/connections/{owner_id}/{connection_id}/auth/cancel")
def auth_cancel(owner_id: str, connection_id: str, body: AuthCancel,
                x_kinesis_service_key: str | None = Header(default=None)):
    path, _ = _connection(connection_id, owner_id, x_kinesis_service_key)
    with _lock(str(path)):
        challenge = _challenges.get(body.challenge_id)
        if challenge and challenge["owner"] == owner_id and challenge["connection"] == connection_id:
            _challenges.pop(body.challenge_id, None)
    return {"status": "disconnected"}


@app.get("/v1/connections/{owner_id}/{connection_id}/status")
def status(owner_id: str, connection_id: str,
           x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _connection(connection_id, owner_id, x_kinesis_service_key)
    current = _states.get(str(path))
    if current == "mfa_required":
        return {"status": current}
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
        _states[str(path)] = "disconnected"
        for challenge_id, challenge in list(_challenges.items()):
            if challenge["owner"] == owner_id and challenge["connection"] == connection_id:
                _challenges.pop(challenge_id, None)
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
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                types = client.get_workout_types()
                devices = client.get_devices()
                return {
                    "running_supported": any(
                        item.get("workoutSportTypeKey") == "running"
                        for item in types.get("workoutSportTypes", [])
                    ),
                    "devices": [
                        {"device_id": str(item.get("deviceId", "")),
                         "name": str(item.get("productDisplayName", ""))[:80]}
                        for item in devices if item.get("deviceId") is not None
                    ],
                }
        except Exception as exc:
            raise _record_error(path, exc) from None


@app.post("/v1/connections/{owner_id}/{connection_id}/activities")
def activities(owner_id: str, connection_id: str, body: ActivityQuery,
               x_kinesis_service_key: str | None = Header(default=None)):
    if (body.end - body.start).days > 31 or body.end < body.start:
        raise HTTPException(400, detail={"code": "invalid_payload"})
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                rows = client.get_activities_by_date(body.start.isoformat(), body.end.isoformat())
                start_text, end_text = body.start.isoformat(), body.end.isoformat()
                filtered = [row for row in rows
                            if start_text <= str(row.get("startTimeLocal", ""))[:10] <= end_text]
                allowed = ("activityId", "activityName", "startTimeLocal", "duration", "distance",
                           "calories", "averageHR", "maxHR", "elevationGain")
                items = [{key: str(value)[:120] if key == "activityName" else value
                          for key, value in row.items() if key in allowed}
                         for row in filtered[body.offset:body.offset + body.limit]]
                return {"items": items, "offset": body.offset,
                        "limit": body.limit}
        except Exception as exc:
            raise _record_error(path, exc) from None


@app.get("/v1/connections/{owner_id}/{connection_id}/activities/{activity_id}/original")
def activity_original(owner_id: str, connection_id: str, activity_id: int = PathParam(gt=0),
                      x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                data = client.download_activity(activity_id, dl_fmt="original")
                if len(data) > MAX_DOWNLOAD_BYTES:
                    raise HTTPException(413, detail={"code": "invalid_payload"})
                return Response(data, media_type="application/octet-stream",
                                headers={"Content-Disposition": 'attachment; filename="activity.zip"'})
        except HTTPException:
            raise
        except Exception as exc:
            raise _record_error(path, exc) from None


@app.post("/v1/connections/{owner_id}/{connection_id}/workouts")
def publish_workout(owner_id: str, connection_id: str, body: WorkoutPayload,
                    x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    with _lock(str(path)):
        try:
            from garminconnect.workout import (
                PaceTarget, RunningWorkout, WorkoutSegment, create_cooldown_step,
                create_interval_step, create_recovery_step, create_repeat_group,
                create_targeted_interval_step, create_warmup_step,
            )
            if (body.target_lower_mps is None) != (body.target_upper_mps is None):
                raise ValueError("Both pace bounds are required")
            if body.target_lower_mps is not None and body.target_lower_mps > body.target_upper_mps:
                raise ValueError("Pace bounds are invalid")
            marker = f"Kinesis POC {body.operation_id}"
            fingerprint = hashlib.sha256(body.model_dump_json().encode()).hexdigest()[:11]
            expected_name = f"{marker}-{fingerprint}"
            with _client(path, key) as (client, _, _):
                existing = client.get_workouts(start=0, limit=100, my_workouts_only=True)
                entries = existing if isinstance(existing, list) else existing.get("workouts", [])
                prior = next((item for item in entries
                              if marker in str(item.get("workoutName", ""))), None)
                if prior:
                    if prior.get("workoutName") != expected_name:
                        raise HTTPException(409, detail={"code": "invalid_payload"})
                    workout_id = int(prior["workoutId"])
                    return {"operation_id": str(body.operation_id),
                            "workout_id": workout_id, "created": False,
                            "status": "reconciled"}
                target = None
                if body.target_lower_mps is not None:
                    target = PaceTarget(lower_limit=body.target_lower_mps,
                                        upper_limit=body.target_upper_mps)
                interval = (create_targeted_interval_step(
                    body.interval_seconds, step_order=1, target=target
                ) if target else create_interval_step(body.interval_seconds, step_order=1))
                repeated_steps = [interval]
                if body.repetitions > 1:
                    if body.recovery_seconds < 1:
                        raise ValueError("Recovery is required for repeats")
                    repeated_steps.append(create_recovery_step(body.recovery_seconds, step_order=2))
                    interval_group = create_repeat_group(body.repetitions, repeated_steps, step_order=2)
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
                result = client.upload_running_workout(workout)
                workout_id = result.get("workoutId") if isinstance(result, dict) else None
                if not isinstance(workout_id, int):
                    raise RuntimeError("remote workout result not confirmed")
                confirmed = client.get_workout_by_id(workout_id)
                return {"operation_id": str(body.operation_id),
                        "workout_id": workout_id, "created": True, "status": "created",
                        "workout": {"name": confirmed.get("workoutName", ""),
                                    "steps": len(confirmed.get("workoutSegments", [{}])[0].get("workoutSteps", []))}}
        except HTTPException:
            raise
        except Exception as exc:
            error = _record_error(path, exc)
            if error.status_code in (429, 401, 400):
                raise error from None
            raise HTTPException(503, detail={"code": "outcome_unknown"}) from None


@app.post("/v1/connections/{owner_id}/{connection_id}/workouts/schedule")
def schedule_workout(owner_id: str, connection_id: str, body: WorkoutSchedule,
                     x_kinesis_service_key: str | None = Header(default=None)):
    path, key = _authenticated_client(owner_id, connection_id, x_kinesis_service_key)
    with _lock(str(path)):
        try:
            with _client(path, key) as (client, _, _):
                scheduled = client.get_scheduled_workouts(body.date.year, body.date.month)
                entries = scheduled if isinstance(scheduled, list) else scheduled.get("scheduledWorkouts", [])
                prior = next((item for item in entries
                              if str(item.get("workoutId")) == str(body.workout_id)
                              and str(item.get("date", ""))[:10] == body.date.isoformat()), None)
                if prior:
                    return {"scheduled": True, "status": "reconciled",
                            "scheduled_workout_id": prior.get("scheduledWorkoutId")}
                result = client.schedule_workout(body.workout_id, body.date.isoformat())
                return {"scheduled": True, "status": "scheduled",
                        "scheduled_workout_id": result.get("scheduledWorkoutId")
                        if isinstance(result, dict) else None}
        except Exception as exc:
            error = _record_error(path, exc)
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
