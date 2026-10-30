"""Regression tests use garminconnect 0.3.20's real public client types."""

import base64
import inspect
import json
import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from garminconnect import Garmin
from garminconnect.client import Client as GarminTransport

from app import main


class UpstreamContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ.update({
            "GARMIN_STORE": self.temp.name,
            "GARMIN_ENCRYPTION_KEY": base64.urlsafe_b64encode(b"u" * 32).decode(),
            "KINESIS_GARMIN_SERVICE_TOKEN": "test-service-key",
            "GARMIN_PILOT_ENABLED": "true",
            "GARMIN_PILOT_USER_ID": "31",
        })
        self.prefix = "/v1/connections/31/pilot"
        self.headers = {"X-Kinesis-Service-Key": "test-service-key"}
        self.client = TestClient(main.app)
        main._challenges.clear()
        main._states.clear()

    def tearDown(self):
        self.temp.cleanup()

    def test_pinned_login_signature_and_fresh_authentication_persist_tokens(self):
        self.assertEqual(tuple(inspect.signature(Garmin.login).parameters), ("self", "tokenstore"))

        def simulated_transport_login(transport, email, password, prompt_mfa=None, return_on_mfa=False):
            self.assertEqual((email, password), ("owner@example.test", "local-only"))
            self.assertTrue(return_on_mfa)
            transport.di_token = "synthetic-di-token"
            transport.di_refresh_token = "synthetic-refresh-token"
            return None, None

        with patch.object(GarminTransport, "login", simulated_transport_login), \
             patch.object(Garmin, "_load_profile_and_settings", return_value=None):
            response = self.client.post(
                f"{self.prefix}/auth/start", headers=self.headers,
                json={"email": "owner@example.test", "password": "local-only"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        token_path = Path(self.temp.name, "31-pilot.bin")
        self.assertTrue(token_path.exists())
        self.assertIn(b"KGC1", token_path.read_bytes())
        self.assertNotIn(b"synthetic-refresh-token", token_path.read_bytes())
        self.assertIn("di_token", json.loads(main._decrypt(token_path, b"u" * 32)))

    def test_real_garmin_original_format_is_passed_to_transport(self):
        token_path = Path(self.temp.name, "31-pilot.bin")
        main._save_encrypted(token_path, b"u" * 32, b'{"di_token":"synthetic"}')
        captured = []

        class StreamingResponse:
            headers = {"Content-Length": "18"}

            def iter_content(self, chunk_size):
                yield b"synthetic-original"

            def close(self):
                pass

        def request(transport, method, url, **kwargs):
            captured.append((url, kwargs))
            self.assertEqual(method, "GET")
            return StreamingResponse()

        with patch.object(Garmin, "_load_profile_and_settings", return_value=None), \
             patch.object(GarminTransport, "_run_request", request):
            response = self.client.get(
                f"{self.prefix}/activities/321/original", headers=self.headers,
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"synthetic-original")
        self.assertTrue(captured)
        self.assertTrue(captured[0][1]["stream"])
        self.assertEqual(captured[0][1]["timeout"], 30)

    def test_original_format_is_the_upstream_enum_and_not_a_string_alias(self):
        client = Garmin()
        original = Garmin.ActivityDownloadFormat.ORIGINAL
        self.assertEqual(main._activity_download_base(client, original),
                         client.garmin_connect_fit_download)
        with self.assertRaises(ValueError):
            main._activity_download_base(client, "original")

    def test_mfa_uses_real_garmin_wrapper_and_persists_before_success(self):
        def simulated_mfa_start(transport, email, password, prompt_mfa=None, return_on_mfa=False):
            assert return_on_mfa is True
            return "needs_mfa", {"domain": "sso.garmin.com", "cookies": []}

        with patch.object(GarminTransport, "login", simulated_mfa_start), \
             patch.object(Garmin, "_load_profile_and_settings", return_value=None):
            start = self.client.post(
                f"{self.prefix}/auth/start", headers=self.headers,
                json={"email": "owner@example.test", "password": "local-only"},
            )
        self.assertEqual(start.json()["status"], "mfa_required")
        self.assertEqual(
            self.client.get(f"{self.prefix}/status", headers=self.headers).json()["status"],
            "mfa_required",
        )
        token_path = Path(self.temp.name, "31-pilot.bin")
        self.assertFalse(token_path.exists())
        challenge_id = start.json()["challenge_id"]

        def simulated_mfa_finish(transport, state, code):
            self.assertEqual((state["domain"], code), ("sso.garmin.com", "654321"))
            transport.di_token = "mfa-di-token"
            transport.di_refresh_token = "mfa-refresh-token"
            return None, None

        with patch.object(GarminTransport, "resume_login", simulated_mfa_finish), \
             patch.object(Garmin, "_load_profile_and_settings", return_value=None):
            finish = self.client.post(
                f"{self.prefix}/auth/finish", headers=self.headers,
                json={"challenge_id": challenge_id, "code": "654321"},
            )
        self.assertEqual(finish.json(), {"status": "connected"})
        self.assertTrue(token_path.exists())
        self.assertIn("mfa-refresh-token", main._decrypt(token_path, b"u" * 32).decode())

    def test_new_mfa_challenge_invalidates_the_old_challenge_and_cancel_restores_state(self):
        sequence = iter([
            ("needs_mfa", {"domain": "first", "cookies": []}),
            ("needs_mfa", {"domain": "second", "cookies": []}),
        ])

        def simulated_login(*_args, **_kwargs):
            return next(sequence)

        with patch.object(GarminTransport, "login", simulated_login):
            first = self.client.post(
                f"{self.prefix}/auth/start", headers=self.headers,
                json={"email": "owner@example.test", "password": "first-password"},
            )
            second = self.client.post(
                f"{self.prefix}/auth/start", headers=self.headers,
                json={"email": "owner@example.test", "password": "second-password"},
            )
        first_id = first.json()["challenge_id"]
        second_id = second.json()["challenge_id"]
        self.assertNotEqual(first_id, second_id)
        self.assertNotIn(first_id, main._challenges)
        stale = self.client.post(
            f"{self.prefix}/auth/finish", headers=self.headers,
            json={"challenge_id": first_id, "code": "111111"},
        )
        self.assertEqual(stale.status_code, 400)
        self.assertEqual(self.client.get(f"{self.prefix}/status", headers=self.headers).json()["status"],
                         "mfa_required")
        canceled = self.client.post(
            f"{self.prefix}/auth/cancel", headers=self.headers,
            json={"challenge_id": second_id},
        )
        self.assertEqual(canceled.json()["status"], "disconnected")

    def test_new_instance_restores_tokens_and_persists_refresh_without_globals(self):
        token_path = Path(self.temp.name, "31-pilot.bin")
        client = Garmin()
        client.client.di_token = "before-refresh"
        client.client.di_refresh_token = "refresh-token"
        client.client.dump(str(Path(self.temp.name, "restore")))
        clear = Path(self.temp.name, "restore", "garmin_tokens.json").read_bytes()
        main._save_encrypted(token_path, b"u" * 32, clear)
        main._states.clear()
        main._challenges.clear()

        def refreshed_profile(instance):
            self.assertTrue(instance.client.is_authenticated)
            instance.client.di_token = "after-refresh"
            return {"synthetic": True}

        with patch.object(Garmin, "_load_profile_and_settings", return_value=None), \
             patch.object(Garmin, "get_user_profile", refreshed_profile):
            response = self.client.get(f"{self.prefix}/status", headers=self.headers)
        self.assertEqual(response.json()["status"], "connected")
        stored = main._decrypt(token_path, b"u" * 32)
        self.assertIn(b"after-refresh", stored)
        self.assertNotIn(b"before-refresh", stored)

    def test_fresh_login_cannot_destroy_existing_tokens_on_failure(self):
        token_path = Path(self.temp.name, "31-pilot.bin")
        main._save_encrypted(token_path, b"u" * 32, b'{"di_token":"existing-valid-token"}')
        before = token_path.read_bytes()

        def invalid_credentials(transport, email, password, prompt_mfa=None, return_on_mfa=False):
            from garminconnect.exceptions import GarminConnectAuthenticationError
            raise GarminConnectAuthenticationError("invalid credentials")

        with patch.object(GarminTransport, "login", invalid_credentials):
            response = self.client.post(
                f"{self.prefix}/auth/start", headers=self.headers,
                json={"email": "owner@example.test", "password": "wrong"},
            )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(token_path.read_bytes(), before)
        self.assertNotIn("existing-valid-token", response.text)

    def test_failed_token_persistence_never_reports_a_durable_connection_and_removes_temp(self):
        temporary_root = Path(self.temp.name, "temporary")
        temporary_root.mkdir()
        token_path = Path(self.temp.name, "31-pilot.bin")
        previous = b'{"di_token":"previous"}'
        main._save_encrypted(token_path, b"u" * 32, previous)
        before = token_path.read_bytes()
        original_temporary_directory = main.tempfile.TemporaryDirectory
        created = []

        def tracked_temporary_directory(*args, **kwargs):
            kwargs["dir"] = str(temporary_root)
            instance = original_temporary_directory(*args, **kwargs)
            created.append(Path(instance.name))
            return instance

        def simulated_login(transport, *_args, **_kwargs):
            transport.di_token = "new-di-token"
            return None, None

        with patch.object(main.tempfile, "TemporaryDirectory", tracked_temporary_directory), \
             patch.object(GarminTransport, "login", simulated_login), \
             patch.object(Garmin, "_load_profile_and_settings", return_value=None), \
             patch.object(main, "_save_encrypted", side_effect=OSError("disk unavailable")):
            response = self.client.post(
                f"{self.prefix}/auth/start", headers=self.headers,
                json={"email": "owner@example.test", "password": "local-only"},
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(token_path.read_bytes(), before)
        self.assertEqual(list(temporary_root.iterdir()), [])
        self.assertNotIn("local-only", response.text)
        self.assertEqual(main._states[str(token_path)], "connected")

    def test_calendar_items_are_reconciled_without_another_mutation(self):
        class CalendarClient:
            calls = 0

            def get_scheduled_workouts(self, year, month):
                assert (year, month) == (2026, 11)
                return {"calendarItems": [
                    {"itemType": "workout", "workoutId": 88,
                     "date": "2026-11-12", "id": 990},
                    {"itemType": "activity", "workoutId": 88,
                     "date": "2026-11-12", "id": 991},
                    {"itemType": "workout", "workoutId": 88,
                     "date": "2026-11-13", "id": 992},
                ]}

            def schedule_workout(self, *_args):
                self.calls += 1
                return {"scheduledWorkoutId": 993}

        fake = CalendarClient()

        @contextmanager
        def client_context(*_args, **_kwargs):
            yield fake, Path(self.temp.name), Path(self.temp.name, "unused.json")

        main._save_encrypted(Path(self.temp.name, "31-pilot.bin"), b"u" * 32,
                             b'{"di_token":"synthetic"}')
        with patch.object(main, "_client", client_context):
            response = self.client.post(
                f"{self.prefix}/workouts/schedule", headers=self.headers,
                json={"workout_id": 88, "date": "2026-11-12"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(response.json()["status"], "reconciled")
        self.assertEqual(response.json()["scheduled_workout_id"], 990)


if __name__ == "__main__":
    unittest.main()
