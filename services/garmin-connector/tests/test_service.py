import base64
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import main


class FakeGarmin:
    def __init__(self, result=None):
        self.result = result
        self.resumed = None
        self.scheduled = []
        self.workouts = []
        self.upload_calls = 0
        self.client = SimpleNamespace(is_authenticated=False, dump=self.dump_tokens,
                                      _run_request=self.run_request)

    def dump_tokens(self, token_dir):
        Path(token_dir, "garmin_tokens.json").write_text('{"di_token":"synthetic-token"}')

    def run_request(self, *_args, **_kwargs):
        return self.StreamResponse()

    def login(self, *_args, **_kwargs):
        if not (self.result and self.result[0] == "needs_mfa"):
            self.client.is_authenticated = True
        return self.result

    def resume_login(self, state, code):
        self.resumed = (state, code)
        self.client.is_authenticated = True

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

    def get_activities(self, start=0, limit=20):
        return self.get_activities_by_date("", "")[start:start + limit]

    def download_activity(self, *_args, **_kwargs):
        return b"synthetic-fit"

    garmin_connect_fit_download = "https://connect.garmin.test/download"
    garmin_connect_tcx_download = "https://connect.garmin.test/tcx"
    garmin_connect_gpx_download = "https://connect.garmin.test/gpx"
    garmin_connect_kml_download = "https://connect.garmin.test/kml"
    garmin_connect_csv_download = "https://connect.garmin.test/csv"

    class StreamResponse:
        headers = {}

        def iter_content(self, chunk_size):
            yield b"synthetic-fit"

        def close(self):
            pass


    def upload_running_workout(self, workout):
        self.workout = workout
        self.upload_calls += 1
        self.workouts.append({"workoutId": 42, "workoutName": workout.workoutName})
        return {"workoutId": 42}

    def get_workout_by_id(self, workout_id):
        name = getattr(getattr(self, "workout", None), "workoutName", "Synthetic")
        return {"workoutName": name, "workoutSegments": [{"workoutSteps": [{}, {}]}]}

    def get_workouts(self, start=0, limit=100, **_kwargs):
        return self.workouts[start:start + limit]

    def get_scheduled_workouts(self, *_args):
        return {"calendarItems": self.scheduled}

    def schedule_workout(self, workout_id, date_text):
        self.scheduled.append({"itemType": "workout", "workoutId": workout_id,
                               "date": date_text, "id": 84})
        return {"scheduledWorkoutId": 84}


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

    def _query_activity_pages(self, pages, limit=10, offset=0, clock_values=None):
        main._save_encrypted(Path(self.temp.name, "17-pilot.bin"), b"k" * 32,
                             b'{"di_token":"synthetic"}')
        calls = []

        class PagedGarmin(FakeGarmin):
            def get_activities(_self, start=0, limit=20):
                calls.append((start, limit))
                page_index = len(calls) - 1
                page = pages[page_index] if page_index < len(pages) else []
                if isinstance(page, Exception):
                    raise page
                return page

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield PagedGarmin(), Path(self.temp.name), Path(self.temp.name, "tokens.json")

        clock_context = (patch.object(main, "_clock", side_effect=clock_values)
                         if clock_values is not None else nullcontext())
        with clock_context, patch.object(main, "_client", fake_client):
            response = self.client.post(
                f"{self.prefix}/activities", headers=self.headers,
                json={"start": "2026-10-01", "end": "2026-10-31", "offset": offset,
                      "limit": limit},
            )
        return response, calls

    @staticmethod
    def _activity(activity_id, day="2026-10-12"):
        return {"activityId": activity_id, "activityName": f"run {activity_id}",
                "startTimeLocal": f"{day}T08:00:00", "distance": 5000}

    def test_activity_page_satisfying_requested_limit_is_success_not_page_exhaustion(self):
        page = [self._activity(index) for index in range(10)]
        response, calls = self._query_activity_pages([page])

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["items"]), 10)
        self.assertEqual(calls, [(0, 10)])

    def test_activity_pagination_returns_partial_and_empty_pages_as_success(self):
        partial, partial_calls = self._query_activity_pages([
            [self._activity(1), self._activity(2)],
        ])
        empty, empty_calls = self._query_activity_pages([[]])

        self.assertEqual(partial.status_code, 200, partial.text)
        self.assertEqual([item["activityId"] for item in partial.json()["items"]], [1, 2])
        self.assertEqual(partial_calls, [(0, 10)])
        self.assertEqual(empty.status_code, 200, empty.text)
        self.assertEqual(empty.json()["items"], [])
        self.assertEqual(empty_calls, [(0, 10)])

    def test_activity_pagination_continues_past_out_of_window_rows_only_as_needed(self):
        newer = [self._activity(index, "2026-11-01") for index in range(10)]
        mixed = [self._activity(index, "2026-11-01") for index in range(5)]
        mixed.extend(self._activity(index + 10) for index in range(5))
        last = [self._activity(index + 15) for index in range(5)]
        response, calls = self._query_activity_pages([newer, mixed, last])

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["activityId"] for item in response.json()["items"]],
                         [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
        self.assertEqual(calls, [(0, 10), (10, 10), (20, 10)])

        intermediate, intermediate_calls = self._query_activity_pages([
            [self._activity(index, "2026-11-01") for index in range(10)],
            [self._activity(index + 10) for index in range(10)],
            TimeoutError("must not request another page after satisfying the limit"),
        ])
        self.assertEqual(intermediate.status_code, 200, intermediate.text)
        self.assertEqual(len(intermediate.json()["items"]), 10)
        self.assertEqual(intermediate_calls, [(0, 10), (10, 10)])

    def test_activity_pagination_preserves_offset_and_stops_when_limit_is_met_mid_search(self):
        first = [self._activity(index) for index in range(10)]
        response, calls = self._query_activity_pages([first, [self._activity(99)]], offset=20)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["offset"], 20)
        self.assertEqual(response.json()["limit"], 10)
        self.assertEqual(calls, [(20, 10)])

    def test_activity_limit_reached_on_fifth_page_is_success(self):
        pages = [[self._activity(page * 10 + index, "2026-11-01") for index in range(10)]
                 for page in range(4)]
        pages.append([self._activity(index + 40) for index in range(10)])
        response, calls = self._query_activity_pages(pages)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["items"]), 10)
        self.assertEqual(calls, [(0, 10), (10, 10), (20, 10), (30, 10), (40, 10)])

    def test_short_or_empty_fifth_activity_page_proves_end_successfully(self):
        full_pages = [[self._activity(index, "2026-11-01") for index in range(page * 10, page * 10 + 10)]
                      for page in range(4)]
        partial_pages = full_pages + [[self._activity(40), self._activity(41)]]
        partial, partial_calls = self._query_activity_pages(partial_pages)
        empty, empty_calls = self._query_activity_pages(full_pages + [[]])

        self.assertEqual(partial.status_code, 200, partial.text)
        self.assertEqual([item["activityId"] for item in partial.json()["items"]], [40, 41])
        self.assertEqual(partial_calls, [(0, 10), (10, 10), (20, 10), (30, 10), (40, 10)])
        self.assertEqual(empty.status_code, 200, empty.text)
        self.assertEqual(empty.json()["items"], [])
        self.assertEqual(empty_calls, [(0, 10), (10, 10), (20, 10), (30, 10), (40, 10)])

    def test_five_full_activity_pages_without_complete_answer_fail_without_sixth_call(self):
        pages = [[self._activity(index, "2026-11-01") for index in range(page * 10, page * 10 + 10)]
                 for page in range(5)]
        response, calls = self._query_activity_pages(pages)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": {"code": "unavailable"}})
        self.assertEqual(calls, [(0, 10), (10, 10), (20, 10), (30, 10), (40, 10)])

    def test_repeated_malformed_and_timed_out_activity_pages_fail_safely(self):
        repeated_page = [self._activity(index, "2026-11-01") for index in range(10)]
        repeated, repeated_calls = self._query_activity_pages([repeated_page, repeated_page])
        malformed, malformed_calls = self._query_activity_pages([[{"activityId": 1}]])
        timed_out, timeout_calls = self._query_activity_pages(
            [[self._activity(index) for index in range(10)]], clock_values=[0, 91])

        self.assertEqual(repeated.status_code, 503)
        self.assertEqual(repeated.json(), {"detail": {"code": "unavailable"}})
        self.assertEqual(repeated_calls, [(0, 10), (10, 10)])
        self.assertEqual(malformed.status_code, 503)
        self.assertEqual(malformed.json(), {"detail": {"code": "unavailable"}})
        self.assertEqual(malformed_calls, [(0, 10)])
        self.assertEqual(timed_out.status_code, 503)
        self.assertEqual(timed_out.json(), {"detail": {"code": "unavailable"}})
        self.assertEqual(timeout_calls, [(0, 10)])

        oversized, oversized_calls = self._query_activity_pages([
            [self._activity(index) for index in range(11)],
        ])
        self.assertEqual(oversized.status_code, 503)
        self.assertEqual(oversized.json(), {"detail": {"code": "unavailable"}})
        self.assertEqual(oversized_calls, [(0, 10)])

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

    def test_token_ciphertext_is_bound_to_its_owner_and_connection_path(self):
        key = b"k" * 32
        first = Path(self.temp.name, "17-pilot.bin")
        second = Path(self.temp.name, "18-pilot.bin")
        main._save_encrypted(first, key, b'{"di_token":"owner-17"}')
        main._save_encrypted(second, key, b'{"di_token":"owner-18"}')
        self.assertEqual(main._decrypt(first, key), b'{"di_token":"owner-17"}')
        self.assertEqual(main._decrypt(second, key), b'{"di_token":"owner-18"}')
        first.write_bytes(second.read_bytes())
        with self.assertRaises(Exception):
            main._decrypt(first, key)

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
            "owner": "17", "connection": "pilot", "path": str(Path(self.temp.name, "17-pilot.bin")),
            "previous_state": "disconnected", "state": {},
            "expires": main._clock() - 1, "attempts": 0,
        }
        self.client.get("/healthz")
        self.assertNotIn("expired-challenge-token-value", main._challenges)

    def test_mfa_attempt_limit_and_wrong_owner(self):
        challenge = "opaque-challenge-id-is-long-enough"
        main._challenges[challenge] = {
            "owner": "17", "connection": "pilot", "path": str(Path(self.temp.name, "17-pilot.bin")),
            "previous_state": "disconnected", "state": {},
            "expires": main._clock() + 100, "attempts": 0,
        }
        wrong_owner = self.client.post("/v1/connections/18/pilot/auth/finish", headers=self.headers,
                                       json={"challenge_id": challenge, "code": "123456"})
        self.assertEqual(wrong_owner.status_code, 403)
        self.assertIn(challenge, main._challenges)

        class BadCode(FakeGarmin):
            def resume_login(self, _state, _code):
                from garminconnect.exceptions import GarminConnectAuthenticationError
                raise GarminConnectAuthenticationError("invalid MFA code")

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
                             "disconnected")

    def test_mfa_programming_failure_is_not_misreported_as_an_incorrect_code(self):
        challenge = "opaque-programming-error-challenge"
        main._challenges[challenge] = {
            "owner": "17", "connection": "pilot", "path": str(Path(self.temp.name, "17-pilot.bin")),
            "previous_state": "disconnected", "state": {},
            "expires": main._clock() + 100, "attempts": 0,
        }

        class BrokenGarmin(FakeGarmin):
            def resume_login(self, _state, _code):
                raise AttributeError("private programming defect")

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield BrokenGarmin(), Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            response = self.client.post(f"{self.prefix}/auth/finish", headers=self.headers,
                                        json={"challenge_id": challenge, "code": "123456"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "unavailable")
        self.assertIn(challenge, main._challenges)
        self.assertEqual(main._challenges[challenge]["attempts"], 0)
        self.assertEqual(self.client.get(f"{self.prefix}/status", headers=self.headers).json()["status"],
                         "mfa_required")

    def test_challenge_cancel_is_scoped_and_one_use(self):
        challenge = "opaque-cancel-challenge-long-enough"
        main._challenges[challenge] = {
            "owner": "17", "connection": "pilot", "path": str(Path(self.temp.name, "17-pilot.bin")),
            "previous_state": "disconnected", "state": {},
            "expires": main._clock() + 100, "attempts": 0,
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
            def run_request(self, *_args, **_kwargs):
                class LargeResponse(FakeGarmin.StreamResponse):
                    def iter_content(self, chunk_size):
                        yield b"x" * (main.MAX_DOWNLOAD_BYTES + 1)
                return LargeResponse()

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
            self.assertEqual(published.status_code, 200, published.text)
            self.assertEqual(published.json()["workout_id"], 42)
            self.assertEqual(published.json()["status"], "created")
            self.assertEqual(len(fake.workout.workoutName), 32)
            self.assertEqual(fake.workout.estimatedDurationInSecs, 1260)
            steps = fake.workout.workoutSegments[0].workoutSteps
            self.assertEqual([step.stepOrder for step in steps], [1, 2, 3])
            self.assertEqual(steps[1].numberOfIterations, 4)
            self.assertEqual([step.stepType["stepTypeKey"] for step in steps[1].workoutSteps],
                             ["interval", "recovery"])
            fake.workouts = ([{"workoutId": index + 1000, "workoutName": "older"}
                              for index in range(100)] + fake.workouts)
            reconciled = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=workout_body)
            self.assertEqual(reconciled.json()["status"], "reconciled")
            self.assertEqual(fake.upload_calls, 1)
            changed = {**workout_body, "interval_seconds": 121}
            conflict = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=changed)
            self.assertEqual(conflict.status_code, 409)
            scheduled = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers,
                                         json={"workout_id": 42, "date": "2026-11-12"})
            self.assertEqual(scheduled.json()["status"], "scheduled")

            class ExistingSchedule(FakeGarmin):
                def get_scheduled_workouts(self, *_args):
                    return {"calendarItems": [{"itemType": "workout", "workoutId": 42,
                                                "id": 84, "date": "2026-11-12"}]}

            @contextmanager
            def reconciled_client(*_args, **_kwargs):
                yield ExistingSchedule(), Path(self.temp.name), Path(self.temp.name, "tokens.json")

            with patch.object(main, "_client", reconciled_client):
                retry = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers,
                                         json={"workout_id": 42, "date": "2026-11-12"})
            self.assertEqual(retry.json()["status"], "reconciled")

    def test_uncertain_upload_is_reconciled_without_retrying_the_mutation(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()

        def ambiguous_upload(workout):
            fake.upload_calls += 1
            fake.workouts.append({"workoutId": 43, "workoutName": workout.workoutName})
            raise TimeoutError("response lost after remote create")

        fake.upload_running_workout = ambiguous_upload

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        body = {"operation_id": "f51db93c-9fb5-44ea-9a4c-79758a3b10c0",
                "name": "synthetic", "interval_seconds": 60}
        with patch.object(main, "_client", fake_client):
            uncertain = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=body)
            self.assertEqual(uncertain.json()["detail"]["code"], "outcome_unknown")
            fake.upload_running_workout = FakeGarmin.upload_running_workout.__get__(fake)
            reconciled = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=body)
        self.assertEqual(reconciled.json()["status"], "reconciled")
        self.assertEqual(fake.upload_calls, 1)

    def test_uncertain_schedule_is_reconciled_without_repeating_calendar_mutation(self):
        main._save_encrypted(Path(self.temp.name, "17-pilot.bin"), b"k" * 32,
                             b'{"di_token":"x"}')

        class AmbiguousSchedule(FakeGarmin):
            schedule_calls = 0

            def schedule_workout(self, workout_id, date_text):
                self.schedule_calls += 1
                self.scheduled.append({"itemType": "workout", "workoutId": workout_id,
                                       "date": date_text, "id": 991})
                raise TimeoutError("calendar response lost after create")

        fake = AmbiguousSchedule()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            uncertain = self.client.post(
                f"{self.prefix}/workouts/schedule", headers=self.headers,
                json={"workout_id": 42, "date": "2026-11-12"},
            )
            self.assertEqual(uncertain.json()["detail"]["code"], "outcome_unknown")
            fake.schedule_workout = FakeGarmin.schedule_workout.__get__(fake)
            reconciled = self.client.post(
                f"{self.prefix}/workouts/schedule", headers=self.headers,
                json={"workout_id": 42, "date": "2026-11-12"},
            )
        self.assertEqual(reconciled.json()["status"], "reconciled")
        self.assertEqual(fake.schedule_calls, 1)

    def test_pending_upload_journal_survives_process_state_reset_and_never_retries_mutation(self):
        main._save_encrypted(Path(self.temp.name, "17-pilot.bin"), b"k" * 32,
                             b'{"di_token":"x"}')
        fake = FakeGarmin()

        def lost_upload_response(_workout):
            fake.upload_calls += 1
            raise TimeoutError("request outcome uncertain")

        fake.upload_running_workout = lost_upload_response

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        body = {"operation_id": "f51db93c-9fb5-44ea-9a4c-79758a3b10c0",
                "name": "synthetic", "interval_seconds": 60}
        with patch.object(main, "_client", fake_client):
            first = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=body)
            self.assertEqual(first.json()["detail"]["code"], "outcome_unknown")
            self.assertTrue(Path(self.temp.name, "17-pilot.ops").exists())
            main._states.clear()
            main._challenges.clear()
            main._locks.clear()
            second = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=body)
        self.assertEqual(second.json()["detail"]["code"], "outcome_unknown")
        self.assertEqual(fake.upload_calls, 1)

    def test_concurrent_same_operation_serializes_and_creates_only_once(self):
        main._save_encrypted(Path(self.temp.name, "17-pilot.bin"), b"k" * 32,
                             b'{"di_token":"x"}')
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        body = {"operation_id": "f51db93c-9fb5-44ea-9a4c-79758a3b10c0",
                "name": "synthetic", "interval_seconds": 60}
        with patch.object(main, "_client", fake_client), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(
                self.client.post, f"{self.prefix}/workouts", headers=self.headers, json=body,
            ) for _ in range(2)]
            responses = [future.result() for future in futures]
        self.assertEqual([response.status_code for response in responses], [200, 200])
        self.assertEqual(fake.upload_calls, 1)

    def test_calendar_response_without_contract_is_unknown_and_never_mutated(self):
        main._save_encrypted(Path(self.temp.name, "17-pilot.bin"), b"k" * 32,
                             b'{"di_token":"x"}')

        class UnknownCalendar(FakeGarmin):
            schedule_calls = 0

            def get_scheduled_workouts(self, *_args):
                return {"items": []}

            def schedule_workout(self, *_args):
                self.schedule_calls += 1

        fake = UnknownCalendar()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            response = self.client.post(
                f"{self.prefix}/workouts/schedule", headers=self.headers,
                json={"workout_id": 42, "date": "2026-11-12"},
            )
        self.assertEqual(response.json()["detail"]["code"], "outcome_unknown")
        self.assertEqual(fake.schedule_calls, 0)

        class InvalidCivilDate(UnknownCalendar):
            def get_scheduled_workouts(self, *_args):
                return {"calendarItems": [{"itemType": "workout", "workoutId": 42,
                                            "date": "2026-99-99", "id": 87}]}

        malformed = InvalidCivilDate()

        @contextmanager
        def malformed_client(*_args, **_kwargs):
            yield malformed, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", malformed_client):
            response = self.client.post(
                f"{self.prefix}/workouts/schedule", headers=self.headers,
                json={"workout_id": 42, "date": "2026-11-12"},
            )
        self.assertEqual(response.json()["detail"]["code"], "outcome_unknown")
        self.assertEqual(malformed.schedule_calls, 0)

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
        self.assertEqual(response.json()["detail"]["code"], "unavailable")


if __name__ == "__main__":
    unittest.main()
