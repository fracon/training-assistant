"""Regression tests use garminconnect 0.3.20's real public client types."""

import base64
import io
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
from requests import Response, Timeout
from requests.structures import CaseInsensitiveDict

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

    def _stream_response(self, status=200, body=b"PK\x03\x04synthetic-original", headers=None):
        response = Response()
        response.status_code = status
        response.url = "https://connect.garmin.test/download"
        response.headers = CaseInsensitiveDict(headers or {
            "Content-Type": "application/zip",
        })
        response._content = False
        response.raw = io.BytesIO(body)
        return response

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
        client = Garmin()
        client.client.di_token = "synthetic-bearer"
        original = b"PK\x03\x04synthetic-original"
        captured = []

        def request(method, url, **kwargs):
            captured.append((method, url, kwargs))
            self.assertEqual(method, "GET")
            response = self._stream_response(body=original, headers={
                "Content-Length": str(len(original)),
                "Content-Type": "application/zip",
            })
            response.url = url
            return response

        @contextmanager
        def real_client(*_args, **_kwargs):
            yield client, Path(self.temp.name), Path(self.temp.name, "tokens.json")

        with patch.object(main, "_client", real_client), \
             patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
             patch.object(client.client._api_session, "request", request):
            response = self.client.get(
                f"{self.prefix}/activities/321/original", headers=self.headers,
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, original)
        self.assertEqual(response.headers["content-type"], "application/octet-stream")
        self.assertRegex(response.headers["x-kinesis-diagnostic-id"], r"^[a-f0-9]{32}$")
        self.assertEqual(len(captured), 1)
        method, url, kwargs = captured[0]
        self.assertEqual(method, "GET")
        self.assertEqual(url, client.client._resolve_url(
            f"{client.garmin_connect_fit_download}/321"
        ))
        self.assertTrue(kwargs["stream"])
        self.assertEqual(kwargs["timeout"], 30)
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual(kwargs["headers"]["Accept"], "*/*")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer synthetic-bearer")

    def test_real_transport_rejects_remote_errors_and_unexpected_content_safely(self):
        cases = ((403, 503, "unavailable"), (404, 400, "invalid_payload"),
                 (429, 429, "rate_limited"), (503, 503, "unavailable"))
        for remote_status, expected_status, expected_code in cases:
            with self.subTest(remote_status=remote_status):
                client = Garmin()
                client.client.di_token = "synthetic-bearer"
                response = self._stream_response(remote_status, b'{"message":"private"}', {
                    "Content-Type": "application/json",
                })
                closed = []
                close = response.close
                response.close = lambda: (closed.append(True), close())[1]
                with patch.object(main, "_client", self._client_context(client)), \
                     patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
                     patch.object(client.client._api_session, "request", return_value=response):
                    result = self.client.get(
                        f"{self.prefix}/activities/321/original", headers=self.headers,
                    )
                self.assertEqual(result.status_code, expected_status)
                self.assertEqual(result.json()["detail"]["code"], expected_code)
                self.assertTrue(closed)
                self.assertRegex(result.headers["x-kinesis-diagnostic-id"], r"^[a-f0-9]{32}$")
                self.assertNotIn("private", result.text)

        for content_type in ("text/html", "application/json"):
            with self.subTest(content_type=content_type):
                client = Garmin()
                client.client.di_token = "synthetic-bearer"
                response = self._stream_response(headers={"Content-Type": content_type})
                with patch.object(main, "_client", self._client_context(client)), \
                     patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
                     patch.object(client.client._api_session, "request", return_value=response):
                    result = self.client.get(
                        f"{self.prefix}/activities/321/original", headers=self.headers,
                    )
                self.assertEqual(result.status_code, 422)
                self.assertEqual(result.json()["detail"]["code"], "invalid_payload")

    def test_real_stream_accepts_missing_or_false_small_length_and_stops_on_oversize_header(self):
        for headers in (
            {"Content-Type": "application/zip"},
            {"Content-Type": "application/zip", "Content-Length": "1"},
        ):
            with self.subTest(headers=headers):
                client = Garmin()
                client.client.di_token = "synthetic-bearer"
                original = b"PK\x03\x04synthetic-stream"
                response = self._stream_response(body=original, headers=headers)
                with patch.object(main, "_client", self._client_context(client)), \
                     patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
                     patch.object(client.client._api_session, "request", return_value=response) as request:
                    result = self.client.get(
                        f"{self.prefix}/activities/321/original", headers=self.headers,
                    )
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(result.content, original)
                self.assertEqual(request.call_count, 1)

        client = Garmin()
        client.client.di_token = "synthetic-bearer"
        response = self._stream_response(headers={
            "Content-Type": "application/zip",
            "Content-Length": str(main.MAX_DOWNLOAD_BYTES + 1),
        })
        consumed = []
        response.iter_content = lambda **_kwargs: consumed.append(True)
        with patch.object(main, "_client", self._client_context(client)), \
             patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
             patch.object(client.client._api_session, "request", return_value=response):
            result = self.client.get(
                f"{self.prefix}/activities/321/original", headers=self.headers,
            )
        self.assertEqual(result.status_code, 413)
        self.assertEqual(result.json()["detail"]["code"], "invalid_payload")
        self.assertEqual(consumed, [])

    def test_real_transport_redirects_only_inside_origin_and_never_sends_credentials_elsewhere(self):
        client = Garmin()
        client.client.di_token = "synthetic-bearer"
        redirect = self._stream_response(302, headers={
            "Location": "https://connectapi.garmin.com/download-service/redirected",
        })
        redirect_closed = []
        redirect.close = lambda: redirect_closed.append(True)
        final = self._stream_response(body=b"PK\x03\x04redirected", headers={
            "Content-Type": "application/zip",
        })
        requests_seen = []

        def same_origin_request(method, url, **kwargs):
            requests_seen.append((url, kwargs))
            return redirect if len(requests_seen) == 1 else final

        with patch.object(main, "_client", self._client_context(client)), \
             patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
             patch.object(client.client._api_session, "request", same_origin_request):
            result = self.client.get(
                f"{self.prefix}/activities/321/original", headers=self.headers,
            )
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(requests_seen), 2)
        self.assertTrue(redirect_closed)
        self.assertTrue(all(call[1]["allow_redirects"] is False for call in requests_seen))

        client = Garmin()
        client.client.di_token = "synthetic-bearer"
        external = self._stream_response(302, headers={
            "Location": "https://elsewhere.invalid/original",
        })
        external_calls = []
        with patch.object(main, "_client", self._client_context(client)), \
             patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
             patch.object(client.client._api_session, "request",
                          lambda *args, **kwargs: (external_calls.append((args, kwargs)), external)[1]):
            result = self.client.get(
                f"{self.prefix}/activities/321/original", headers=self.headers,
            )
        self.assertEqual(result.status_code, 502)
        self.assertEqual(result.json()["detail"]["code"], "unsupported")
        self.assertEqual(len(external_calls), 1)
        self.assertTrue(external_calls[0][1]["allow_redirects"] is False)

    def test_network_timeout_is_sanitized_and_read_failure_closes_without_masking(self):
        client = Garmin()
        client.client.di_token = "synthetic-bearer"
        with patch.object(main, "_client", self._client_context(client)), \
             patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
             patch.object(client.client._api_session, "request", side_effect=Timeout("private timeout")):
            before_body = self.client.get(
                f"{self.prefix}/activities/321/original", headers=self.headers,
            )
        self.assertEqual(before_body.status_code, 503)
        self.assertNotIn("private timeout", before_body.text)

        client = Garmin()
        client.client.di_token = "synthetic-bearer"
        response = self._stream_response()
        closed = []
        response.iter_content = lambda **_kwargs: (_ for _ in ()).throw(Timeout("private stream timeout"))
        response.close = lambda: (closed.append(True), (_ for _ in ()).throw(OSError("private close error")))[1]
        with patch.object(main, "_client", self._client_context(client)), \
             patch.object(GarminTransport, "_token_expires_soon", return_value=False), \
             patch.object(client.client._api_session, "request", return_value=response):
            during_body = self.client.get(
                f"{self.prefix}/activities/321/original", headers=self.headers,
            )
        self.assertEqual(during_body.status_code, 503)
        self.assertEqual(during_body.json()["detail"]["code"], "unavailable")
        self.assertNotIn("private", during_body.text)
        self.assertEqual(len(closed), 1)

    def _client_context(self, client):
        token_path = Path(self.temp.name, "31-pilot.bin")
        if not token_path.exists():
            main._save_encrypted(token_path, b"u" * 32, b'{"di_token":"synthetic"}')
        @contextmanager
        def real_client(*_args, **_kwargs):
            yield client, Path(self.temp.name), Path(self.temp.name, "tokens.json")
        return real_client

    def test_original_format_is_the_upstream_enum_and_not_a_string_alias(self):
        client = Garmin()
        original = Garmin.ActivityDownloadFormat.ORIGINAL
        self.assertEqual(main._activity_download_base(client, original),
                         client.garmin_connect_fit_download)
        with self.assertRaises(ValueError):
            main._activity_download_base(client, "original")

    def test_real_get_workout_types_contract_is_parsed_using_sport_type_key(self):
        # Exercise garminconnect's real method while replacing only its transport.
        response = {
            "workoutSportTypes": [{
                "sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1,
            }],
            "workoutStepTypes": [],
        }
        client = Garmin()
        with patch.object(Garmin, "connectapi", return_value=response) as connectapi:
            parsed = main._workout_catalog_summary(client.get_workout_types())
        connectapi.assert_called_once_with(
            f"{client.garmin_connect_workout_service_url}/workout/types"
        )
        self.assertEqual(parsed["status"], "available")
        self.assertEqual(parsed["sport_types"][0]["sport_type_key"], "running")

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
