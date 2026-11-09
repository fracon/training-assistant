"""Synthetic upstream for Node-to-connector tests; never contacts Garmin."""
import sys
import io
import os
import tempfile
import time
import zipfile
from contextlib import contextmanager
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services/garmin-connector/tests"))
from test_service import FakeGarmin  # noqa: E402
from app import main  # noqa: E402

clients = {}


class SyntheticDownload:
    status_code = 200
    headers = {"Content-Type": "application/zip"}

    def iter_content(self, chunk_size):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("activity.fit", b"synthetic-fit")
        yield buffer.getvalue()

    def close(self):
        pass


class SyntheticGarmin(FakeGarmin):
    def __init__(self, owner):
        super().__init__(result=("needs_mfa", {"owner": owner}))
        self.owner = owner

    def upload_running_workout(self, workout):
        result = super().upload_running_workout(workout)
        if self.owner == "1":
            root = Path(os.environ["GARMIN_STORE"])
            (root / "pending-a").write_text("accepted")
            deadline = time.monotonic() + 10
            while not (root / "release-a").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
        return result


@contextmanager
def synthetic_client(path, key, **options):
    owner = path.name.split("-")[0]
    client = clients.setdefault(owner, SyntheticGarmin(owner))
    client.get_user_profile = lambda: {"userData": {"id": int(owner) + 10000}}
    client.client._run_request = lambda *_args, **_kwargs: SyntheticDownload()
    if options.get("restore", True):
        client.client.is_authenticated = True
    with tempfile.TemporaryDirectory() as directory:
        token_dir = Path(directory)
        yield client, token_dir, token_dir / "garmin_tokens.json"


main._client = synthetic_client
uvicorn.run(main.app, host="127.0.0.1", port=int(sys.argv[1]), access_log=False)
