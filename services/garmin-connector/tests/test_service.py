import base64
import os
import tempfile
import unittest
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import main


class FakeGarmin:
    def __init__(self, result=None):
        self.result = result
        self.resumed = None

    def login(self, *_args, **_kwargs):
        return self.result

    def resume_login(self, state, code):
        self.resumed = (state, code)

    def dump(self, token_dir):
        Path(token_dir, "garmin_tokens.json").write_text('{"di_token":"synthetic"}')

    def get_workout_types(self):
        return {"workoutSportTypes": [{"workoutSportTypeKey": "running"}]}

    def get_devices(self):
        return [{"deviceId": 55, "productDisplayName": "Synthetic Forerunner"}]

    def get_user_profile(self):
        return {"private": "not returned"}

    def get_activities_by_date(self, *_args):
        return [
            {"activityId": 1, "startTimeLocal": "2026-10-02T08:00:00"},
            {"activityId": 2, "startTimeLocal": "2026-11-02T08:00:00"},
        ]

    def download_activity(self, *_args, **_kwargs):
        return b"synthetic-fit"

    def upload_running_workout(self, workout):
        self.workout = workout
        return {"workoutId": 42}

    def get_workout_by_id(self, workout_id):
        name = getattr(getattr(self, "workout", None), "workoutName", "Synthetic")
        return {"workoutName": name, "workoutSegments": [{"workoutSteps": [{}, {}]}]}

    def get_workouts(self, **_kwargs):
        return []

    def get_scheduled_workouts(self, *_args):
        return []

    def schedule_workout(self, workout_id, date_text):
        return {"workoutId": workout_id, "date": date_text}


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ["GARMIN_STORE"] = self.temp.name
        os.environ["GARMIN_ENCRYPTION_KEY"] = base64.urlsafe_b64encode(b"k" * 32).decode()
        os.environ["KINESIS_GARMIN_SERVICE_TOKEN"] = "private-key"
        os.environ["GARMIN_PILOT_ENABLED"] = "true"
        os.environ["GARMIN_PILOT_USER_ID"] = "17"
        main._challenges.clear()
        main._states.clear()
        main._locks.clear()
        self.client = TestClient(main.app)
        self.headers = {"X-Kinesis-Service-Key": "private-key"}
        self.prefix = "/v1/connections/17/pilot"

    def tearDown(self):
        self.temp.cleanup()

    def test_health_is_local_and_versioned(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.json(), {"status": "ok", "contract": "v1"})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(self.client.get("/docs").status_code, 404)

    def test_auth_and_owner_validation(self):
        self.assertEqual(self.client.get(f"{self.prefix}/status").status_code, 401)
        self.assertEqual(self.client.get("/v1/connections/../pilot/status", headers=self.headers).status_code, 404)
        self.assertEqual(self.client.get("/v1/connections/bad!/pilot/status", headers=self.headers).status_code, 403)
        self.assertEqual(self.client.get("/v1/connections/18/pilot/status", headers=self.headers).status_code, 403)
        self.assertEqual(self.client.get(f"{self.prefix}/status", headers=self.headers).json()["status"], "disconnected")

    def test_encrypted_token_round_trip_and_authentication(self):
        path = Path(self.temp.name, "17-pilot.bin")
        key = b"k" * 32
        clear = b'{"di_token":"sensitive-token"}'
        main._save_encrypted(path, key, clear)
        self.assertNotIn(b"sensitive-token", path.read_bytes())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(main._decrypt(path, key), clear)
        with self.assertRaises(Exception):
            main._decrypt(path, b"x" * 32)
        path.write_bytes(b"bad")
        with self.assertRaises(ValueError):
            main._decrypt(path, key)
        link = Path(self.temp.name, "linked.bin")
        link.symlink_to(path)
        with self.assertRaises(ValueError):
            main._decrypt(link, key)

    def test_bad_key_configuration(self):
        with patch.dict(os.environ, {"GARMIN_ENCRYPTION_KEY": "not-base64"}):
            with self.assertRaises(RuntimeError):
                main._secret("GARMIN_ENCRYPTION_KEY")
        with patch.dict(os.environ, {"KINESIS_GARMIN_SERVICE_TOKEN": ""}):
            with self.assertRaises(Exception):
                main._connection("pilot", "17", "private-key")
        with patch.dict(os.environ, {"GARMIN_PILOT_ENABLED": "false"}):
            with self.assertRaises(Exception):
                main._connection("pilot", "17", "private-key")
        with patch.dict(os.environ, {"GARMIN_ENCRYPTION_KEY": "YQ=="}):
            with self.assertRaises(RuntimeError):
                main._secret("GARMIN_ENCRYPTION_KEY")

    def test_error_mapping(self):
        self.assertEqual(main._error(Exception("HTTP 429")).detail["code"], "rate_limited")
        self.assertEqual(main._error(Exception("invalid token")).status_code, 401)
        self.assertEqual(main._error(ValueError("bad input")).detail["code"], "invalid_payload")
        self.assertEqual(main._error(RuntimeError("private stack")).detail["code"], "unavailable")

    def test_auth_start_mfa_finish_disconnect_and_expiry(self):
        fake = FakeGarmin(("needs_mfa", {"cookie": "private"}))

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            start = self.client.post(f"{self.prefix}/auth/start", headers=self.headers,
                                     json={"email": "pilot@example.test", "password": "never-log"})
            challenge = start.json()["challenge_id"]
            self.assertEqual(start.json()["status"], "mfa_required")
            self.assertGreaterEqual(len(challenge), 40)
            self.assertEqual(self.client.get(f"{self.prefix}/status", headers=self.headers).json()["status"], "mfa_required")
            with patch("garminconnect.Garmin", return_value=fake):
                finish = self.client.post(f"{self.prefix}/auth/finish", headers=self.headers,
                                          json={"challenge_id": challenge, "code": "123456"})
            self.assertEqual(finish.json()["status"], "connected")
            self.assertNotIn(challenge, main._challenges)
            self.assertEqual(fake.resumed, ({"cookie": "private"}, "123456"))
            self.assertEqual(self.client.delete(self.prefix, headers=self.headers).json()["remote_revocation"], "not_proven")
            self.assertEqual(self.client.get(f"{self.prefix}/status", headers=self.headers).json()["status"], "disconnected")

        main._challenges["expired-challenge-token-value"] = {
            "owner": "17", "connection": "pilot", "state": {}, "expires": main._clock() - 1, "attempts": 0,
        }
        self.client.get("/healthz")
        self.assertNotIn("expired-challenge-token-value", main._challenges)

    def test_mfa_attempt_limit_and_wrong_owner(self):
        challenge = "opaque-challenge-id-is-long-enough"
        main._challenges[challenge] = {
            "owner": "17", "connection": "pilot", "state": {}, "expires": main._clock() + 100, "attempts": 0,
        }
        wrong_owner = self.client.post("/v1/connections/18/pilot/auth/finish", headers=self.headers,
                                       json={"challenge_id": challenge, "code": "123456"})
        self.assertEqual(wrong_owner.status_code, 403)
        self.assertIn(challenge, main._challenges)

        class BadCode(FakeGarmin):
            def resume_login(self, _state, _code):
                raise RuntimeError("invalid MFA code")

        bad_code = BadCode()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield bad_code, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            for attempt in range(main.MAX_MFA_ATTEMPTS):
                response = self.client.post(f"{self.prefix}/auth/finish", headers=self.headers,
                                            json={"challenge_id": challenge, "code": "000000"})
                self.assertEqual(response.status_code, 401)
            self.assertNotIn(challenge, main._challenges)
            self.assertEqual(self.client.get(f"{self.prefix}/status", headers=self.headers).json()["status"],
                             "reauthentication_required")

    def test_challenge_cancel_is_scoped_and_one_use(self):
        challenge = "opaque-cancel-challenge-long-enough"
        main._challenges[challenge] = {
            "owner": "17", "connection": "pilot", "state": {}, "expires": main._clock() + 100, "attempts": 0,
        }
        response = self.client.post(f"{self.prefix}/auth/cancel", headers=self.headers,
                                    json={"challenge_id": challenge})
        self.assertEqual(response.json()["status"], "disconnected")
        self.assertNotIn(challenge, main._challenges)

    def test_payload_and_download_bounds(self):
        oversized = self.client.post(f"{self.prefix}/auth/start", headers={**self.headers, "content-length": str(main.MAX_BODY_BYTES + 1)},
                                     json={"email": "pilot@example.test", "password": "pw"})
        self.assertEqual(oversized.status_code, 413)
        unknown = self.client.post(f"{self.prefix}/auth/start", headers=self.headers,
                                   json={"email": "pilot@example.test", "password": "pw", "owner": 1})
        self.assertEqual(unknown.status_code, 400)
        self.assertNotIn('"pw"', unknown.text)
        self.assertEqual(self.client.post(f"{self.prefix}/activities", headers=self.headers,
                                          json={"start": "2026-01-01", "end": "2026-01-15"}).status_code, 401)

    def test_activity_window_and_download_validation(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            result = self.client.post(f"{self.prefix}/activities", headers=self.headers,
                                      json={"start": "2026-10-01", "end": "2026-10-31", "offset": 0, "limit": 10})
            self.assertEqual([item["activityId"] for item in result.json()["items"]], [1])
            self.assertEqual(self.client.get(f"{self.prefix}/activities/-1/original", headers=self.headers).status_code, 400)
            too_long = self.client.post(f"{self.prefix}/activities", headers=self.headers,
                                        json={"start": "2026-10-01", "end": "2026-11-02"})
            self.assertEqual(too_long.status_code, 400)

    def test_capabilities_download_and_workout_read_are_sanitized(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            capabilities = self.client.get(f"{self.prefix}/capabilities", headers=self.headers)
            self.assertEqual(capabilities.json()["devices"][0]["device_id"], "55")
            status = self.client.get(f"{self.prefix}/status", headers=self.headers)
            self.assertEqual(status.json()["status"], "connected")
            workout = self.client.get(f"{self.prefix}/workouts/42", headers=self.headers)
            self.assertEqual(workout.json()["steps"], 2)
            original = self.client.get(f"{self.prefix}/activities/42/original", headers=self.headers)
            self.assertEqual(original.content, b"synthetic-fit")

        class LargeFile(FakeGarmin):
            def download_activity(self, *_args, **_kwargs):
                return b"x" * (main.MAX_DOWNLOAD_BYTES + 1)

        @contextmanager
        def large_client(*_args, **_kwargs):
            yield LargeFile(), Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", large_client):
            too_large = self.client.get(f"{self.prefix}/activities/42/original", headers=self.headers)
        self.assertEqual(too_large.status_code, 413)

    def test_credentials_are_not_logged_or_returned(self):
        fake = FakeGarmin((None, None))

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            result = self.client.post(f"{self.prefix}/auth/start", headers=self.headers,
                                      json={"email": "pilot@example.test", "password": "secret-value"})
        self.assertNotIn("secret-value", result.text)
        self.assertEqual(result.json()["status"], "connected")

    def test_synthetic_workout_and_schedule_contract(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        workout_body = {
            "operation_id": "f51db93c-9fb5-44ea-9a4c-79758a3b10c0",
            "name": "synthetic intervals", "warmup_seconds": 300,
            "interval_seconds": 120, "recovery_seconds": 60,
            "repetitions": 4, "cooldown_seconds": 240,
            "target_lower_mps": 2.7, "target_upper_mps": 3.1,
        }
        with patch.object(main, "_client", fake_client):
            published = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=workout_body)
            self.assertEqual(published.json()["workout_id"], 42)
            self.assertEqual(published.json()["status"], "created")
            scheduled = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers,
                                         json={"workout_id": 42, "date": "2026-11-12"})
            self.assertEqual(scheduled.json()["status"], "scheduled")

            class ExistingSchedule(FakeGarmin):
                def get_scheduled_workouts(self, *_args):
                    return [{"workoutId": 42, "scheduledWorkoutId": 84, "date": "2026-11-12"}]

            @contextmanager
            def reconciled_client(*_args, **_kwargs):
                yield ExistingSchedule(), Path(self.temp.name), Path(self.temp.name, "tokens.json")

            with patch.object(main, "_client", reconciled_client):
                retry = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers,
                                         json={"workout_id": 42, "date": "2026-11-12"})
            self.assertEqual(retry.json()["status"], "reconciled")

    def test_mutation_timeout_is_uncertain(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')

        class TimeoutGarmin(FakeGarmin):
            def get_workouts(self, **_kwargs):
                raise TimeoutError("socket timed out")

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield TimeoutGarmin(), Path(self.temp.name), Path(self.temp.name, "tokens.json")

        body = {"operation_id": "f51db93c-9fb5-44ea-9a4c-79758a3b10c0", "name": "synthetic",
                "interval_seconds": 60}
        with patch.object(main, "_client", fake_client):
            response = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "outcome_unknown")


if __name__ == "__main__":
    unittest.main()
