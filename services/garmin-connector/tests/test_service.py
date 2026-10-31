import base64
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
import uuid
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
        self.client = SimpleNamespace(
            is_authenticated=False, dump=self.dump_tokens,
            _run_request=self.run_request,
            _resolve_url=lambda path: path if path.startswith("https://")
            else f"https://connect.garmin.test/{path.lstrip('/')}",
        )

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
        return {"workoutSportTypes": [{"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}]}

    def get_devices(self):
        return [{"deviceId": 55, "productDisplayName": "Synthetic Forerunner"}]

    def get_user_profile(self):
        return {"userData": {"id": 17001}, "private": "not returned"}

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
        status_code = 200
        headers = {"Content-Type": "application/zip"}

        def iter_content(self, chunk_size):
            yield b"PK\x03\x04synthetic-fit"

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

    def update_workout(self, workout_id, workout_json):
        self.update_calls = getattr(self, "update_calls", 0) + 1
        self.updated = (workout_id, workout_json)
        self.workout = type("Workout", (), {"workoutName": workout_json["workoutName"]})()
        return {"workoutId": workout_id, "workoutName": self.workout.workoutName}

    def get_scheduled_workout_by_id(self, scheduled_workout_id):
        return next((item for item in self.scheduled if item.get("scheduleId", item.get("id")) == scheduled_workout_id), None)

    def reschedule_workout(self, scheduled_workout_id, date_text):
        self.reschedule_calls = getattr(self, "reschedule_calls", 0) + 1
        item = self.get_scheduled_workout_by_id(scheduled_workout_id)
        item["calendarDate"] = date_text
        return item

    def get_workouts(self, start=0, limit=100, **_kwargs):
        return self.workouts[start:start + limit]

    def get_scheduled_workouts(self, *_args):
        return {"calendarItems": self.scheduled}

    def schedule_workout(self, workout_id, date_text):
        self.schedule_calls = getattr(self, "schedule_calls", 0) + 1
        self.scheduled.append({"itemType": "workout", "workoutId": workout_id,
                               "workout": {"workoutId": workout_id},
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

    def seed_completed_workout(self, operation_id, workout_id=42):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_operation_journal(path, b"k" * 32, {
            operation_id: {"status": "complete", "workout_id": workout_id},
        })

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
            self.assertEqual(original.content, b"PK\x03\x04synthetic-fit")

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

    def test_capabilities_recognizes_running_using_pinned_garmin_sport_type_contract(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()
        # garminconnect 0.3.20's SportTypeModel uses sportTypeKey.
        fake.get_workout_types = lambda: {
            "workoutSportTypes": [{"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}]
        }

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            response = self.client.get(f"{self.prefix}/capabilities", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["running_supported"])
        self.assertEqual(response.json()["running_catalog_status"], "available")

    def test_workout_catalog_diagnostic_distinguishes_valid_absent_and_unknown(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        cases = [
            ({"workoutSportTypes": [{"sportTypeId": 1, "sportTypeKey": "cycling"}]}, "absent"),
            ({"workoutSportTypes": []}, "unknown"),
            ({}, "unknown"),
            ({"workoutSportTypes": None}, "unknown"),
            ([], "unknown"),
            ({"workoutSportTypes": [{"sportTypeId": 1, "sportTypeKey": "running"}, None]}, "unknown"),
            ({"workoutSportTypes": [{"sportTypeId": "1", "sportTypeKey": "running"}]}, "unknown"),
            ({"workoutSportTypes": [{"sportTypeId": 2, "sportTypeKey": "cycling"}]}, "absent"),
        ]
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            for catalog, expected in cases:
                with self.subTest(expected=expected, catalog_type=type(catalog).__name__):
                    fake.get_workout_types = lambda catalog=catalog: catalog
                    response = self.client.get(f"{self.prefix}/workout-catalog", headers=self.headers)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["status"], expected)
                    self.assertNotIn("email", response.text.lower())
                    self.assertNotIn("device", response.text.lower())

    def test_capabilities_unknown_catalog_is_not_reported_as_false(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()
        fake.get_workout_types = lambda: {"workoutSportTypes": []}

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            response = self.client.get(f"{self.prefix}/capabilities", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["running_supported"])
        self.assertEqual(response.json()["running_catalog_status"], "unknown")

    def test_catalog_remote_failures_keep_normalized_auth_rate_limit_and_timeout_codes(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')

        class BrokenGarmin(FakeGarmin):
            failure = None

            def get_workout_types(self):
                raise self.failure

        fake = BrokenGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        from garminconnect.exceptions import GarminConnectAuthenticationError
        cases = [
            (GarminConnectAuthenticationError("private auth detail"), 401, "auth_required"),
            (type("GarminConnectTooManyRequestsError", (Exception,), {})("private rate detail"), 429, "rate_limited"),
            (TimeoutError("private timeout detail"), 503, "unavailable"),
        ]
        with patch.object(main, "_client", fake_client):
            for error, status, code in cases:
                with self.subTest(code=code):
                    fake.failure = error
                    response = self.client.get(f"{self.prefix}/workout-catalog", headers=self.headers)
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.json(), {"detail": {"code": code}})
                    self.assertNotIn("private", response.text)

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
            "repetitions": 4, "skip_last_rest_step": False, "cooldown_seconds": 240,
            "target_lower_mps": 2.7, "target_upper_mps": 3.1,
            "recovery_target_kind": "heart_rate", "recovery_target_lower_bpm": 115,
            "recovery_target_upper_bpm": 135,
        }
        with patch.object(main, "_client", fake_client):
            published = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=workout_body)
            self.assertEqual(published.status_code, 200, published.text)
            self.assertEqual(published.json()["workout_id"], 42)
            self.assertEqual(published.json()["status"], "created")
            self.assertLessEqual(len(fake.workout.workoutName), 60)
            self.assertTrue(fake.workout.workoutName.startswith("synthetic intervals "))
            self.assertEqual(fake.workout.estimatedDurationInSecs, 1260)
            steps = fake.workout.workoutSegments[0].workoutSteps
            self.assertEqual([step.stepOrder for step in steps], [1, 2, 3])
            self.assertEqual(steps[1].numberOfIterations, 4)
            self.assertFalse(steps[1].skipLastRestStep)
            self.assertEqual([step.stepType["stepTypeKey"] for step in steps[1].workoutSteps],
                             ["interval", "recovery"])
            self.assertEqual((steps[1].workoutSteps[1].targetValueOne, steps[1].workoutSteps[1].targetValueTwo), (115, 135))
            hr_body = {**workout_body, "operation_id": "3c8b9e44-82ba-4e95-9d4c-4ae3f59ad18b",
                       "target_kind": "heart_rate", "target_lower_mps": None,
                       "target_upper_mps": None, "target_lower_bpm": 140,
                       "target_upper_bpm": 165}
            hr_result = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=hr_body)
            self.assertEqual(hr_result.status_code, 200, hr_result.text)
            hr_step = fake.workout.workoutSegments[0].workoutSteps[1].workoutSteps[0]
            self.assertEqual(hr_step.targetType["workoutTargetTypeKey"], "heart.rate.zone")
            self.assertEqual((hr_step.targetValueOne, hr_step.targetValueTwo), (140, 165))
            fake.workouts = ([{"workoutId": index + 1000, "workoutName": "older"}
                              for index in range(100)] + fake.workouts)
            reconciled = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=workout_body)
            self.assertEqual(reconciled.json()["status"], "reconciled")
            self.assertEqual(fake.upload_calls, 2)
            distance_body = {**workout_body,
                             "operation_id": "e2376b45-a2b4-4dfd-8f77-dba9508d36ab",
                             "interval_seconds": None,
                             "interval_distance_meters": 1000}
            distance_result = self.client.post(f"{self.prefix}/workouts", headers=self.headers,
                                               json=distance_body)
            self.assertEqual(distance_result.status_code, 200, distance_result.text)
            distance_workout = fake.workout
            distance_repeat = distance_workout.workoutSegments[0].workoutSteps[1]
            distance_interval = distance_repeat.workoutSteps[0]
            self.assertEqual(distance_interval.endCondition["conditionTypeId"], 3)
            self.assertEqual(distance_interval.endConditionValue, 1000)
            self.assertEqual(distance_workout.estimatedDurationInSecs, 0)
            changed = {**workout_body, "interval_seconds": 121}
            conflict = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=changed)
            self.assertEqual(conflict.status_code, 409)
            scheduled = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers,
                                         json={"operation_id": workout_body["operation_id"],
                                               "workout_id": 42, "date": "2026-11-12"})
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
                                         json={"operation_id": workout_body["operation_id"],
                                               "workout_id": 42, "date": "2026-11-12"})
            self.assertEqual(retry.json()["status"], "reconciled")

    def test_update_and_reschedule_are_scoped_to_confirmed_kinesis_artifacts(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()
        fake.workout = type("Workout", (), {"workoutName": "Kinesis old synthetic"})()
        fake.scheduled.append({"itemType": "workout", "workout": {"workoutId": 42},
                               "scheduleId": 84, "calendarDate": "2026-11-12"})
        source_id = "00000000-0000-4000-8000-000000000001"
        main._save_operation_journal(path, b"k" * 32, {
            source_id: {"status": "complete", "workout_id": 42},
            "schedule:42:2026-11-12": {"status": "complete", "workout_id": 42,
                                       "scheduled_workout_id": 84},
        })

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        update_body = {
            "operation_id": "a14b6c50-ea44-4e0b-beb1-2e3934fb8850",
            "source_operation_id": source_id,
            "source_scheduled_workout_id": 84,
            "workout_id": 42, "name": "Updated synthetic", "interval_seconds": 300,
            "repetitions": 4, "recovery_seconds": 120,
            "recovery_target_kind": "heart_rate", "recovery_target_lower_bpm": 110,
            "recovery_target_upper_bpm": 130, "skip_last_rest_step": True,
        }
        reschedule_body = {
            "operation_id": "f0743e49-001d-4de5-a6b3-53757c9fe263",
            # The update itself becomes the latest local operation identity.
            "source_operation_id": update_body["operation_id"],
            "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-13",
        }
        with patch.object(main, "_client", fake_client):
            updated = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertEqual(updated.json()["status"], "updated")
            self.assertEqual(fake.updated[0], 42)
            self.assertEqual(fake.updated[1]["workoutName"].split(" ")[0:2], ["Updated", "synthetic"])
            alias = main._operation_journal(path, b"k" * 32)[update_body["operation_id"]]
            self.assertEqual(alias["artifact_kind"], "update")
            self.assertEqual(alias["workout_id"], 42)
            # Exercise the encrypted journal as the only source of provenance after restart.
            main._states.clear()
            main._challenges.clear()
            main._locks.clear()
            repeated = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(repeated.json()["status"], "reconciled")
            moved = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json=reschedule_body)
            self.assertEqual(moved.status_code, 200, moved.text)
            self.assertEqual(moved.json()["status"], "rescheduled")
            retried = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json=reschedule_body)
            self.assertEqual(retried.json()["status"], "reconciled")
        self.assertEqual(fake.scheduled[0]["calendarDate"], "2026-11-13")

    def test_product_update_and_reschedule_share_one_operation_id_without_journal_collision(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        source_id = "00000000-0000-4000-8000-000000000071"
        product_operation_id = "00000000-0000-4000-8000-000000000072"
        with patch.object(main, "_client", fake_client):
            published = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json={
                "operation_id": source_id, "name": "composite synthetic", "interval_seconds": 300,
                "repetitions": 3, "recovery_seconds": 90,
            })
            self.assertEqual(published.status_code, 200, published.text)
            scheduled = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers, json={
                "operation_id": source_id, "workout_id": 42, "date": "2026-11-12",
            })
            self.assertEqual(scheduled.status_code, 200, scheduled.text)
            update_body = {"operation_id": product_operation_id, "source_operation_id": source_id,
                           "source_scheduled_workout_id": 84, "workout_id": 42,
                           "name": "composite changed", "interval_seconds": 360,
                           "repetitions": 4, "recovery_seconds": 120}
            updated = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(updated.status_code, 200, updated.text)
            reschedule_body = {"operation_id": product_operation_id, "source_operation_id": source_id,
                               "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-13"}
            moved = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                    json=reschedule_body)
            self.assertEqual(moved.status_code, 200, moved.text)
            self.assertEqual(moved.json()["scheduled_workout_id"], 84)
            replayed_update = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(replayed_update.status_code, 200, replayed_update.text)
            self.assertEqual(replayed_update.json()["status"], "reconciled")

            main._states.clear()
            main._challenges.clear()
            main._locks.clear()
            repeated_move = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                            json=reschedule_body)
            self.assertEqual(repeated_move.status_code, 200, repeated_move.text)
            self.assertEqual(repeated_move.json()["status"], "reconciled")
            divergent = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                        json={**reschedule_body, "date": "2026-11-14"})
            self.assertEqual(divergent.status_code, 409, divergent.text)

            second_operation_id = "00000000-0000-4000-8000-000000000073"
            second_update_body = {**update_body, "operation_id": second_operation_id,
                                  "source_operation_id": product_operation_id,
                                  "name": "second composite", "interval_seconds": 420}
            second_updated = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers,
                                             json=second_update_body)
            self.assertEqual(second_updated.status_code, 200, second_updated.text)
            second_reschedule_body = {"operation_id": second_operation_id,
                                      "source_operation_id": product_operation_id,
                                      "scheduled_workout_id": 84, "workout_id": 42,
                                      "date": "2026-11-14"}
            second_moved = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                           json=second_reschedule_body)
            self.assertEqual(second_moved.status_code, 200, second_moved.text)
            calls_before_conflicting_source = fake.reschedule_calls
            wrong_source = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                           json={**reschedule_body, "source_operation_id": second_operation_id})
            self.assertEqual(wrong_source.status_code, 409)
            self.assertEqual(fake.reschedule_calls, calls_before_conflicting_source,
                             "reusing an operation UUID with another source is rejected before mutation")
            main._states.clear()
            main._challenges.clear()
            main._locks.clear()

            after_composite_update = {**second_update_body,
                                      "operation_id": "00000000-0000-4000-8000-000000000074",
                                      "source_operation_id": second_operation_id,
                                      "name": "after composite update"}
            accepted_update = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers,
                                              json=after_composite_update)
            self.assertEqual(accepted_update.status_code, 200, accepted_update.text)
            after_composite_reschedule = {"operation_id": "00000000-0000-4000-8000-000000000075",
                                          "source_operation_id": after_composite_update["operation_id"],
                                          "scheduled_workout_id": 84, "workout_id": 42,
                                          "date": "2026-11-15"}
            accepted_move = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                            json=after_composite_reschedule)
            self.assertEqual(accepted_move.status_code, 200, accepted_move.text)

        self.assertEqual(fake.update_calls, 3)
        self.assertEqual(fake.reschedule_calls, 3)
        self.assertEqual(fake.scheduled[0]["calendarDate"], "2026-11-15")
        journal = main._operation_journal(path, b"k" * 32)
        self.assertEqual(journal[product_operation_id]["artifact_kind"], "composite")
        self.assertEqual(journal[product_operation_id]["status"], "complete")
        self.assertEqual(journal[product_operation_id]["workout_id"], 42)
        self.assertEqual(journal[product_operation_id]["occurrence_id"], 84)
        self.assertEqual(journal[product_operation_id]["source_operation_id"], source_id)
        self.assertEqual(journal[f"update:{product_operation_id}"]["status"], "complete")
        self.assertEqual(journal[f"reschedule:{product_operation_id}"]["status"], "complete")
        self.assertEqual(journal[second_operation_id]["artifact_kind"], "composite")
        self.assertEqual(journal["00000000-0000-4000-8000-000000000074"]["artifact_kind"], "update")
        self.assertEqual(journal["00000000-0000-4000-8000-000000000075"]["artifact_kind"], "reschedule")

    def test_node_worker_payload_builders_match_real_combined_connector_endpoints(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        repository_root = Path(__file__).resolve().parents[3]
        node_script = r'''const product = require('./src/garmin/product');
const operation = {
  operationId: '00000000-0000-4000-8000-000000000082', date: '2026-11-13',
  sourceOperation: { operation_id: '00000000-0000-4000-8000-000000000081',
    workout_id: '42', occurrence_id: '84', scheduled_date: '2026-11-12' },
  prescription: { version: 1, sport: 'running', name: 'combined contract', steps: [
    { id: 'run', kind: 'run', end: { type: 'time', value: 360 }, target: { type: 'none' } }
  ] }
};
process.stdout.write(JSON.stringify({
  update: product.toConnectorUpdatePayload(operation, '42'),
  reschedule: product.toConnectorReschedulePayload(operation, '42', '84')
}));'''
        completed = subprocess.run(["node", "-e", node_script], cwd=repository_root,
                                   check=True, capture_output=True, text=True, timeout=10)
        payloads = json.loads(completed.stdout)
        self.assertEqual(payloads["update"]["operation_id"], payloads["reschedule"]["operation_id"])
        self.assertEqual(payloads["update"]["source_operation_id"], payloads["reschedule"]["source_operation_id"])
        self.assertEqual(payloads["update"]["source_scheduled_workout_id"], payloads["reschedule"]["scheduled_workout_id"])

        with patch.object(main, "_client", fake_client):
            published = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json={
                "operation_id": payloads["update"]["source_operation_id"],
                "name": "source synthetic", "interval_seconds": 300,
            })
            self.assertEqual(published.status_code, 200, published.text)
            scheduled = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers, json={
                "operation_id": payloads["update"]["source_operation_id"],
                "workout_id": 42, "date": "2026-11-12",
            })
            self.assertEqual(scheduled.status_code, 200, scheduled.text)
            updated = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers,
                                      json=payloads["update"])
            self.assertEqual(updated.status_code, 200, updated.text)
            moved = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                    json=payloads["reschedule"])
            self.assertEqual(moved.status_code, 200, moved.text)
            self.assertEqual(moved.json()["status"], "rescheduled")
        self.assertEqual(fake.update_calls, 1)
        self.assertEqual(fake.reschedule_calls, 1)
        self.assertEqual(fake.scheduled[0]["calendarDate"], "2026-11-13")
        self.assertEqual(main._operation_journal(path, b"k" * 32)[payloads["update"]["operation_id"]]["artifact_kind"], "composite")

    def test_combined_operation_recovers_lost_update_and_reschedule_responses_after_restart(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()
        source_id = "00000000-0000-4000-8000-000000000091"
        operation_id = "00000000-0000-4000-8000-000000000092"
        update_body = {"operation_id": operation_id, "source_operation_id": source_id,
                       "source_scheduled_workout_id": 84, "workout_id": 42,
                       "name": "lost update response", "interval_seconds": 360,
                       "repetitions": 3, "recovery_seconds": 90}
        reschedule_body = {"operation_id": operation_id, "source_operation_id": source_id,
                           "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-13"}

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        original_update = fake.update_workout
        update_lost = True
        def update_then_lose_response(*args):
            nonlocal update_lost
            original_update(*args)
            if update_lost:
                update_lost = False
                raise TimeoutError("synthetic response lost")
        original_reschedule = fake.reschedule_workout
        reschedule_lost = True
        def reschedule_then_lose_response(*args):
            nonlocal reschedule_lost
            original_reschedule(*args)
            if reschedule_lost:
                reschedule_lost = False
                raise TimeoutError("synthetic response lost")

        with patch.object(main, "_client", fake_client):
            self.client.post(f"{self.prefix}/workouts", headers=self.headers, json={
                "operation_id": source_id, "name": "lost source", "interval_seconds": 300,
            })
            self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers, json={
                "operation_id": source_id, "workout_id": 42, "date": "2026-11-12",
            })
            fake.update_workout = update_then_lose_response
            failed_update = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(failed_update.status_code, 503)
            self.assertEqual(main._operation_journal(path, b"k" * 32)[f"update:{operation_id}"]["status"], "pending")
            fake.update_workout = original_update
            main._states.clear()
            main._challenges.clear()
            main._locks.clear()
            recovered_update = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(recovered_update.status_code, 200, recovered_update.text)
            self.assertEqual(recovered_update.json()["status"], "reconciled")
            self.assertEqual(fake.update_calls, 1)

            fake.reschedule_workout = reschedule_then_lose_response
            failed_reschedule = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                                json=reschedule_body)
            self.assertEqual(failed_reschedule.status_code, 503)
            self.assertEqual(fake.scheduled[0]["calendarDate"], "2026-11-13")
            self.assertEqual(main._operation_journal(path, b"k" * 32)[f"reschedule:{operation_id}"]["status"], "pending")
            fake.reschedule_workout = original_reschedule
            main._states.clear()
            main._challenges.clear()
            main._locks.clear()
            recovered_reschedule = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                                   json=reschedule_body)
            self.assertEqual(recovered_reschedule.status_code, 200, recovered_reschedule.text)
            self.assertEqual(recovered_reschedule.json()["status"], "reconciled")

        self.assertEqual(fake.update_calls, 1)
        self.assertEqual(fake.reschedule_calls, 1)
        composite = main._operation_journal(path, b"k" * 32)[operation_id]
        self.assertEqual(composite["artifact_kind"], "composite")
        self.assertEqual(composite["steps"]["update"]["status"], "complete")
        self.assertEqual(composite["steps"]["reschedule"]["status"], "complete")

    def test_combined_update_retries_after_failure_before_remote_mutation(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()
        source_id = "00000000-0000-4000-8000-000000000111"
        operation_id = "00000000-0000-4000-8000-000000000112"
        update_body = {"operation_id": operation_id, "source_operation_id": source_id,
                       "source_scheduled_workout_id": 84, "workout_id": 42,
                       "name": "pre-mutation failure", "interval_seconds": 360,
                       "repetitions": 3, "recovery_seconds": 90}

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            self.client.post(f"{self.prefix}/workouts", headers=self.headers, json={
                "operation_id": source_id, "name": "pre-mutation source", "interval_seconds": 300,
            })
            self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers, json={
                "operation_id": source_id, "workout_id": 42, "date": "2026-11-12",
            })
            original = fake.update_workout
            def fail_before_mutation(*_args):
                raise TimeoutError("synthetic pre-mutation failure")
            fake.update_workout = fail_before_mutation
            refused = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(refused.status_code, 503)
            self.assertEqual(getattr(fake, "update_calls", 0), 0)
            self.assertEqual(main._operation_journal(path, b"k" * 32)[f"update:{operation_id}"]["status"], "pending")
            fake.update_workout = original
            main._states.clear()
            main._locks.clear()
            completed = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(completed.status_code, 200, completed.text)
            self.assertEqual(completed.json()["status"], "updated")
        self.assertEqual(fake.update_calls, 1)
        self.assertEqual(main._operation_journal(path, b"k" * 32)[operation_id]["status"], "complete")

    def test_combined_reschedule_confirms_remote_effect_after_final_journal_write_fails(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()
        source_id = "00000000-0000-4000-8000-000000000121"
        operation_id = "00000000-0000-4000-8000-000000000122"
        update_body = {"operation_id": operation_id, "source_operation_id": source_id,
                       "source_scheduled_workout_id": 84, "workout_id": 42,
                       "name": "journal failure", "interval_seconds": 360,
                       "repetitions": 3, "recovery_seconds": 90}
        reschedule_body = {"operation_id": operation_id, "source_operation_id": source_id,
                           "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-13"}

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            self.client.post(f"{self.prefix}/workouts", headers=self.headers, json={
                "operation_id": source_id, "name": "journal source", "interval_seconds": 300,
            })
            self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers, json={
                "operation_id": source_id, "workout_id": 42, "date": "2026-11-12",
            })
            self.assertEqual(self.client.put(f"{self.prefix}/workouts/42", headers=self.headers,
                                             json=update_body).status_code, 200)
            save = main._save_operation_journal
            fail_once = True
            def fail_completed_compound_save(journal_path, key, journal):
                nonlocal fail_once
                entry = journal.get(f"reschedule:{operation_id}", {})
                if fail_once and entry.get("status") == "complete":
                    fail_once = False
                    raise OSError("synthetic local journal failure")
                return save(journal_path, key, journal)
            with patch.object(main, "_save_operation_journal", fail_completed_compound_save):
                failed = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                          json=reschedule_body)
            self.assertEqual(failed.status_code, 503)
            self.assertEqual(fake.scheduled[0]["calendarDate"], "2026-11-13")
            durable = main._operation_journal(path, b"k" * 32)
            self.assertEqual(durable[operation_id]["artifact_kind"], "update")
            self.assertEqual(durable[f"reschedule:{operation_id}"]["status"], "pending")
            main._states.clear()
            main._locks.clear()
            retry = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                    json=reschedule_body)
            self.assertEqual(retry.status_code, 200, retry.text)
            self.assertEqual(retry.json()["status"], "reconciled")
        self.assertEqual(fake.update_calls, 1)
        self.assertEqual(fake.reschedule_calls, 1)
        self.assertEqual(main._operation_journal(path, b"k" * 32)[operation_id]["artifact_kind"], "composite")

    def test_legacy_post_mutation_pending_reschedule_is_reconciled_into_composite(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()
        source_id = uuid.UUID("00000000-0000-4000-8000-000000000101")
        operation_id = uuid.UUID("00000000-0000-4000-8000-000000000102")
        update_body = {"operation_id": str(operation_id), "source_operation_id": str(source_id),
                       "source_scheduled_workout_id": 84, "workout_id": 42,
                       "name": "legacy composed", "interval_seconds": 360,
                       "repetitions": 3, "recovery_seconds": 90}
        reschedule_body = {"operation_id": str(operation_id), "source_operation_id": str(source_id),
                           "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-13"}

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            self.client.post(f"{self.prefix}/workouts", headers=self.headers, json={
                "operation_id": str(source_id), "name": "legacy source", "interval_seconds": 300,
            })
            self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers, json={
                "operation_id": str(source_id), "workout_id": 42, "date": "2026-11-12",
            })
            updated = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(updated.status_code, 200, updated.text)
            remote = fake.get_scheduled_workout_by_id(84)
            remote["calendarDate"] = "2026-11-13"  # the prior code moved it before its alias conflict
            reschedule_fingerprint = hashlib.sha256(b"84:42:2026-11-13").hexdigest()
            journal = main._operation_journal(path, b"k" * 32)
            update_fingerprint = journal[f"update:{operation_id}"]["fingerprint"]
            journal[f"reschedule:{operation_id}"] = {"fingerprint": reschedule_fingerprint,
                                                       "status": "pending", "workout_id": 42,
                                                       "scheduled_workout_id": 84,
                                                       "previous_date": "2026-11-12"}
            main._save_operation_journal(path, b"k" * 32, journal)
            main._states.clear()
            main._locks.clear()
            calls_before = getattr(fake, "reschedule_calls", 0)
            recovered = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers,
                                        json=reschedule_body)
            self.assertEqual(recovered.status_code, 200, recovered.text)
            self.assertEqual(recovered.json()["status"], "reconciled")
        self.assertEqual(getattr(fake, "reschedule_calls", 0), calls_before)
        repaired = main._operation_journal(path, b"k" * 32)
        self.assertEqual(repaired[str(operation_id)]["artifact_kind"], "composite")
        self.assertEqual(repaired[f"reschedule:{operation_id}"]["status"], "complete")

    def test_completed_reschedule_remains_a_provenance_source_for_following_operations(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        publish_id = "00000000-0000-4000-8000-000000000041"
        with patch.object(main, "_client", fake_client):
            published = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json={
                "operation_id": publish_id, "name": "synthetic chain", "interval_seconds": 300,
                "repetitions": 3, "recovery_seconds": 90,
            })
            self.assertEqual(published.status_code, 200, published.text)
            scheduled = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers, json={
                "operation_id": publish_id, "workout_id": 42, "date": "2026-11-12",
            })
            self.assertEqual(scheduled.status_code, 200, scheduled.text)
            first_id = "00000000-0000-4000-8000-000000000042"
            first = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json={
                "operation_id": first_id, "source_operation_id": publish_id,
                "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-13",
            })
            self.assertEqual(first.status_code, 200, first.text)
            main._states.clear()
            main._challenges.clear()
            main._locks.clear()
            second = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json={
                "operation_id": "00000000-0000-4000-8000-000000000043",
                "source_operation_id": first_id, "scheduled_workout_id": 84,
                "workout_id": 42, "date": "2026-11-14",
            })

        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["status"], "rescheduled")
        self.assertEqual(fake.reschedule_calls, 2)
        self.assertEqual(fake.scheduled[0]["calendarDate"], "2026-11-14")
        journal = main._operation_journal(path, b"k" * 32)
        second_id = "00000000-0000-4000-8000-000000000043"
        self.assertEqual(journal[second_id]["artifact_kind"], "reschedule")
        self.assertEqual(journal[second_id]["workout_id"], 42)
        self.assertEqual(journal[second_id]["occurrence_id"], 84)
        self.assertEqual(journal[second_id]["source_operation_id"], first_id)

        update_id = "00000000-0000-4000-8000-000000000044"
        update_body = {"operation_id": update_id, "source_operation_id": second_id,
                       "source_scheduled_workout_id": 84, "workout_id": 42,
                       "name": "updated after reschedule", "interval_seconds": 360,
                       "repetitions": 3, "recovery_seconds": 90}
        with patch.object(main, "_client", fake_client):
            updated = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertEqual(updated.json()["status"], "updated")
            divergence = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers,
                                         json={**update_body, "name": "different payload"})
            self.assertEqual(divergence.status_code, 409, divergence.text)
            self.assertEqual(fake.update_calls, 1)
            self.assertEqual(journal.get(update_id), None, "the durable encrypted journal is re-read after every request")
            journal = main._operation_journal(path, b"k" * 32)
            self.assertEqual(journal[update_id]["artifact_kind"], "update")
            self.assertEqual(journal[update_id]["occurrence_id"], 84)

            third_reschedule_id = "00000000-0000-4000-8000-000000000045"
            moved_again = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json={
                "operation_id": third_reschedule_id, "source_operation_id": update_id,
                "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-15",
            })
            self.assertEqual(moved_again.status_code, 200, moved_again.text)
            update_after_move_id = "00000000-0000-4000-8000-000000000046"
            updated_again = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json={
                "operation_id": update_after_move_id, "source_operation_id": third_reschedule_id,
                "source_scheduled_workout_id": 84, "workout_id": 42,
                "name": "updated again", "interval_seconds": 420,
                "repetitions": 2, "recovery_seconds": 60,
            })
            self.assertEqual(updated_again.status_code, 200, updated_again.text)
            self.assertEqual(fake.upload_calls, 1)
            self.assertEqual(fake.reschedule_calls, 3)

    def test_legacy_reschedule_entry_is_recovered_only_from_matching_encrypted_schedule_proof(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        legacy_id = "00000000-0000-4000-8000-000000000051"
        source_id = "00000000-0000-4000-8000-000000000052"
        occurrence_id = 84
        workout_id = 42
        date_text = "2026-11-13"
        legacy_fingerprint = hashlib.sha256(f"{occurrence_id}:{workout_id}:{date_text}".encode()).hexdigest()
        main._save_operation_journal(path, b"k" * 32, {
            source_id: {"status": "complete", "workout_id": workout_id},
            "schedule:42:2026-11-12": {"fingerprint": "synthetic-schedule-fingerprint",
                                        "status": "complete", "workout_id": workout_id,
                                        "scheduled_workout_id": occurrence_id},
            f"reschedule:{legacy_id}": {"fingerprint": legacy_fingerprint, "status": "complete",
                                         "scheduled_workout_id": occurrence_id, "date": date_text},
        })
        fake = FakeGarmin()
        fake.workout = type("Workout", (), {"workoutName": "Old Kinesis workout"})()
        fake.scheduled.append({"itemType": "workout", "workoutId": workout_id,
                               "workout": {"workoutId": workout_id}, "scheduleId": occurrence_id,
                               "calendarDate": date_text})

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        update_id = "00000000-0000-4000-8000-000000000053"
        body = {"operation_id": update_id, "source_operation_id": legacy_id,
                "source_scheduled_workout_id": occurrence_id, "workout_id": workout_id,
                "name": "Legacy source update", "interval_seconds": 300,
                "repetitions": 3, "recovery_seconds": 90}
        with patch.object(main, "_client", fake_client):
            response = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "updated")
        self.assertEqual(fake.update_calls, 1)
        journal = main._operation_journal(path, b"k" * 32)
        self.assertEqual(journal[update_id]["artifact_kind"], "update")
        self.assertEqual(journal[update_id]["occurrence_id"], occurrence_id)

    def test_legacy_pending_update_reconciles_exact_old_fingerprint_and_enriches_provenance(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        source_id = "00000000-0000-4000-8000-000000000061"
        update_id = uuid.UUID("00000000-0000-4000-8000-000000000062")
        body = {"operation_id": str(update_id), "source_operation_id": source_id,
                "source_scheduled_workout_id": 84, "workout_id": 42,
                "name": "legacy pending", "interval_seconds": 300,
                "repetitions": 3, "recovery_seconds": 90}
        model = main.WorkoutUpdate.model_validate(body)
        old_fingerprint = hashlib.sha256(
            model.model_dump_json(exclude={"source_scheduled_workout_id"}).encode()).hexdigest()
        operation_token = base64.urlsafe_b64encode(update_id.bytes).decode().rstrip("=")
        expected_name = f"legacy pending K{operation_token}-{old_fingerprint[:8]}"[:60]
        main._save_operation_journal(path, b"k" * 32, {
            source_id: {"status": "complete", "workout_id": 42},
            "schedule:42:2026-11-12": {"status": "complete", "workout_id": 42,
                                        "scheduled_workout_id": 84},
            f"update:{update_id}": {"fingerprint": old_fingerprint, "status": "pending",
                                    "workout_id": 42, "previous_name": "old tracked workout"},
        })
        fake = FakeGarmin()
        fake.workout = type("Workout", (), {"workoutName": expected_name})()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            response = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "reconciled")
        self.assertEqual(getattr(fake, "update_calls", 0), 0)
        journal = main._operation_journal(path, b"k" * 32)
        self.assertEqual(journal[str(update_id)]["artifact_kind"], "update")
        self.assertEqual(journal[str(update_id)]["fingerprint"], old_fingerprint)
        self.assertEqual(journal[str(update_id)]["occurrence_id"], 84)

    def test_update_and_reschedule_refuse_remote_objects_without_kinesis_journal_provenance(self):
        """A matching remote ID/name is not proof that Kinesis created the artifact."""
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        fake = FakeGarmin()
        fake.workout = type("Workout", (), {"workoutName": "Kinesis old synthetic"})()
        fake.scheduled.append({"itemType": "workout", "workout": {"workoutId": 42},
                               "scheduleId": 84, "calendarDate": "2026-11-12"})

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        update_body = {
            "operation_id": "a14b6c50-ea44-4e0b-beb1-2e3934fb8850",
            "source_operation_id": "00000000-0000-4000-8000-000000000099",
            "source_scheduled_workout_id": 84,
            "workout_id": 42, "name": "Updated synthetic", "interval_seconds": 300,
            "repetitions": 4, "recovery_seconds": 120,
        }
        reschedule_body = {
            "operation_id": "f0743e49-001d-4de5-a6b3-53757c9fe263",
            "source_operation_id": "00000000-0000-4000-8000-000000000099",
            "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-13",
        }
        with patch.object(main, "_client", fake_client):
            updated = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            moved = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json=reschedule_body)

        self.assertIn(updated.status_code, (403, 409))
        self.assertIn(moved.status_code, (403, 409))
        self.assertEqual(getattr(fake, "update_calls", 0), 0)
        self.assertEqual(getattr(fake, "reschedule_calls", 0), 0)
        self.assertEqual(fake.scheduled[0]["calendarDate"], "2026-11-12")

    def test_update_and_reschedule_reconcile_lost_mutation_responses_without_repeating(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"x"}')
        source_id = "00000000-0000-4000-8000-000000000001"
        main._save_operation_journal(path, b"k" * 32, {
            source_id: {"status": "complete", "workout_id": 42},
            "schedule:42:2026-11-12": {"status": "complete", "workout_id": 42,
                                       "scheduled_workout_id": 84},
        })
        fake = FakeGarmin()
        fake.workout = type("Workout", (), {"workoutName": "Original remote"})()
        fake.scheduled.append({"itemType": "workout", "workout": {"workoutId": 42},
                               "scheduleId": 84, "calendarDate": "2026-11-12"})

        def lose_update_response(workout_id, workout_json):
            fake.update_calls = getattr(fake, "update_calls", 0) + 1
            fake.workout = type("Workout", (), {"workoutName": workout_json["workoutName"]})()
            raise TimeoutError("synthetic response lost after mutation")

        def lose_reschedule_response(schedule_id, date_text):
            fake.reschedule_calls = getattr(fake, "reschedule_calls", 0) + 1
            fake.get_scheduled_workout_by_id(schedule_id)["calendarDate"] = date_text
            raise TimeoutError("synthetic response lost after mutation")

        fake.update_workout = lose_update_response
        fake.reschedule_workout = lose_reschedule_response

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        update_id = "a14b6c50-ea44-4e0b-beb1-2e3934fb8850"
        update_body = {"operation_id": update_id, "source_operation_id": source_id,
                       "source_scheduled_workout_id": 84,
                       "workout_id": 42, "name": "Updated synthetic", "interval_seconds": 300,
                       "repetitions": 4, "recovery_seconds": 120}
        with patch.object(main, "_client", fake_client):
            first_update = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(first_update.status_code, 503)
            self.assertEqual(first_update.json()["detail"]["code"], "outcome_unknown")
            replay_update = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=update_body)
            self.assertEqual(replay_update.status_code, 200, replay_update.text)
            self.assertEqual(replay_update.json()["status"], "reconciled")
            reschedule_body = {"operation_id": "f0743e49-001d-4de5-a6b3-53757c9fe263",
                               "source_operation_id": update_id, "scheduled_workout_id": 84,
                               "workout_id": 42, "date": "2026-11-13"}
            first_move = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json=reschedule_body)
            self.assertEqual(first_move.status_code, 503)
            self.assertEqual(first_move.json()["detail"]["code"], "outcome_unknown")
            replay_move = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json=reschedule_body)
            self.assertEqual(replay_move.status_code, 200, replay_move.text)
            self.assertEqual(replay_move.json()["status"], "reconciled")
            replay_journal = main._operation_journal(Path(self.temp.name, "17-pilot.bin"), b"k" * 32)
            self.assertEqual(replay_journal[reschedule_body["operation_id"]]["artifact_kind"], "reschedule")
            self.assertEqual(replay_journal[reschedule_body["operation_id"]]["occurrence_id"], 84)
            fake.reschedule_workout = FakeGarmin.reschedule_workout.__get__(fake)
            main._states.clear()
            main._challenges.clear()
            main._locks.clear()
            subsequent = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json={
                "operation_id": "00000000-0000-4000-8000-000000000054",
                "source_operation_id": reschedule_body["operation_id"],
                "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-14",
            })
            self.assertEqual(subsequent.status_code, 200, subsequent.text)
            self.assertEqual(subsequent.json()["status"], "rescheduled")
            repeated = self.client.put(f"{self.prefix}/workouts/schedule/84", headers=self.headers, json={
                "operation_id": "00000000-0000-4000-8000-000000000054",
                "source_operation_id": reschedule_body["operation_id"],
                "scheduled_workout_id": 84, "workout_id": 42, "date": "2026-11-14",
            })
            self.assertEqual(repeated.status_code, 200, repeated.text)
            self.assertEqual(repeated.json()["status"], "reconciled")
        self.assertEqual(fake.update_calls, 1)
        self.assertEqual(fake.reschedule_calls, 2)
        self.assertEqual(fake.scheduled[0]["calendarDate"], "2026-11-14")

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
        operation_id = "f51db93c-9fb5-44ea-9a4c-79758a3b10c0"
        self.seed_completed_workout(operation_id)

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
                json={"operation_id": operation_id, "workout_id": 42, "date": "2026-11-12"},
            )
            self.assertEqual(uncertain.json()["detail"]["code"], "outcome_unknown")
            fake.schedule_workout = FakeGarmin.schedule_workout.__get__(fake)
            reconciled = self.client.post(
                f"{self.prefix}/workouts/schedule", headers=self.headers,
                json={"operation_id": operation_id, "workout_id": 42, "date": "2026-11-12"},
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
        operation_id = "f51db93c-9fb5-44ea-9a4c-79758a3b10c0"
        self.seed_completed_workout(operation_id)

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
                json={"operation_id": operation_id, "workout_id": 42, "date": "2026-11-12"},
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
                json={"operation_id": operation_id, "workout_id": 42, "date": "2026-11-12"},
            )
        self.assertEqual(response.json()["detail"]["code"], "outcome_unknown")
        self.assertEqual(malformed.schedule_calls, 0)

    def test_preexisting_matching_occurrence_is_not_adopted_as_a_kinesis_schedule(self):
        main._save_encrypted(Path(self.temp.name, "17-pilot.bin"), b"k" * 32,
                             b'{"di_token":"x"}')
        operation_id = "f51db93c-9fb5-44ea-9a4c-79758a3b10c0"
        self.seed_completed_workout(operation_id)

        class ExistingCalendar(FakeGarmin):
            schedule_calls = 0

            def get_scheduled_workouts(self, *_args):
                return {"calendarItems": [{"itemType": "workout", "workoutId": 42,
                                            "date": "2026-11-12", "id": 999}]}

            def schedule_workout(self, *_args):
                self.schedule_calls += 1

        fake = ExistingCalendar()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", fake_client):
            response = self.client.post(f"{self.prefix}/workouts/schedule", headers=self.headers,
                                        json={"operation_id": operation_id, "workout_id": 42,
                                              "date": "2026-11-12"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "outcome_unknown")
        self.assertEqual(fake.schedule_calls, 0)

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

    def test_structured_v2_endpoint_builds_distinct_real_garmin_steps_and_targets(self):
        main._save_encrypted(Path(self.temp.name, "17-pilot.bin"), b"k" * 32,
                             b'{"di_token":"synthetic"}')
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        body = {
            "operation_id": "f51db93c-9fb5-44ea-9a4c-79758a3b10c0",
            "version": 2, "name": "Mixed intervals", "steps": [
                {"id": "warmup", "kind": "warmup", "end": {"type": "time", "value": 300},
                 "target": {"type": "heart_rate", "mode": "absolute", "lower_bpm": 110, "upper_bpm": 130}},
                {"id": "easy", "kind": "run", "end": {"type": "time", "value": 600},
                 "target": {"type": "none"}},
                {"id": "hill", "kind": "repeat", "repetitions": 2, "skip_last_rest_step": True,
                 "interval": {"end": {"type": "distance", "value": 400},
                              "target": {"type": "pace", "unit": "min_per_km", "slower_seconds": 330, "faster_seconds": 300}}},
                {"id": "recovery", "kind": "recovery", "end": {"type": "time", "value": 90},
                 "target": {"type": "none"}},
                {"id": "finish", "kind": "run", "end": {"type": "time", "value": 180},
                 "target": {"type": "none"}},
                {"id": "cooldown", "kind": "cooldown", "end": {"type": "distance", "value": 500},
                 "target": {"type": "heart_rate", "mode": "absolute", "lower_bpm": 90, "upper_bpm": 110}},
            ],
        }
        with patch.object(main, "_client", fake_client):
            response = self.client.post(f"{self.prefix}/workouts", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(fake.upload_calls, 1)
        workout = fake.workout.model_dump(mode="json", by_alias=True, exclude_none=True)
        steps = workout["workoutSegments"][0]["workoutSteps"]
        self.assertEqual([item["stepType"]["stepTypeKey"] for item in steps],
                         ["warmup", "interval", "repeat", "recovery", "interval", "cooldown"])
        self.assertEqual(steps[0]["endCondition"]["conditionTypeKey"], "time")
        self.assertEqual(steps[0]["targetValueOne"], 110)
        repeated = steps[2]["workoutSteps"]
        self.assertEqual(len(repeated), 1)
        self.assertEqual(repeated[0]["endConditionValue"], 400)
        self.assertEqual(repeated[0]["targetType"]["workoutTargetTypeKey"], "pace.zone")
        self.assertEqual(steps[3]["endCondition"]["conditionTypeKey"], "time")
        self.assertEqual(steps[5]["endCondition"]["conditionTypeKey"], "distance")
        self.assertEqual(steps[5]["targetValueOne"], 90)

    def test_structured_v2_update_uses_real_workout_models_and_keeps_source_identity(self):
        path = Path(self.temp.name, "17-pilot.bin")
        main._save_encrypted(path, b"k" * 32, b'{"di_token":"synthetic"}')
        source_id = "4c497608-2fc4-47e5-89a6-1e6ec315c70c"
        operation_id = "f51db93c-9fb5-44ea-9a4c-79758a3b10c0"
        main._save_operation_journal(path, b"k" * 32, {
            source_id: {"status": "complete", "workout_id": 42, "occurrence_id": 84},
            "schedule:42:2026-11-12": {"status": "complete", "workout_id": 42,
                                             "scheduled_workout_id": 84},
        })
        fake = FakeGarmin()

        @contextmanager
        def fake_client(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        body = {"operation_id": operation_id, "version": 2, "name": "Updated blocks",
                "steps": [
                    {"id": "warmup", "kind": "warmup", "end": {"type": "distance", "value": 500},
                     "target": {"type": "none"}},
                    {"id": "run-one", "kind": "run", "end": {"type": "time", "value": 300},
                     "target": {"type": "heart_rate", "mode": "absolute", "lower_bpm": 120, "upper_bpm": 140}},
                    {"id": "run-two", "kind": "run", "end": {"type": "distance", "value": 800},
                     "target": {"type": "none"}},
                    {"id": "cooldown", "kind": "cooldown", "end": {"type": "time", "value": 240},
                     "target": {"type": "none"}},
                ], "workout_id": 42, "source_operation_id": source_id,
                "source_scheduled_workout_id": 84}
        with patch.object(main, "_client", fake_client):
            response = self.client.put(f"{self.prefix}/workouts/42", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "updated")
        self.assertEqual(fake.update_calls, 1)
        self.assertEqual(fake.updated[0], 42)
        steps = fake.updated[1]["workoutSegments"][0]["workoutSteps"]
        self.assertEqual([item["endCondition"]["conditionTypeKey"] for item in steps],
                         ["distance", "time", "distance", "time"])
        self.assertEqual(steps[1]["targetValueOne"], 120)
        saved_journal = main._operation_journal(path, b"k" * 32)
        self.assertEqual(saved_journal[f"update:{operation_id}"]["status"], "complete")
        self.assertEqual(saved_journal[operation_id]["workout_id"], 42)


if __name__ == "__main__":
    unittest.main()
