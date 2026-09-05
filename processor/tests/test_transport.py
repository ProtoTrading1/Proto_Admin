from __future__ import annotations

from pathlib import Path

from processor.callbacks import validate_callback
from processor.config import Settings
from processor.pull_worker import PullWorker
from processor.transport import HttpAdminAdapter, RemoteJob
from test_pipeline import source_image


class FakeAdapter:
    def __init__(self):
        self.source = source_image()
        self.claimed = False
        self.upload = None
        self.completed = None
        self.failed = None

    def claim(self):
        if self.claimed:
            return None
        self.claimed = True
        return RemoteJob(
            id="remote-1~image-1",
            admin_job_id="remote-1",
            image_id="image-1",
            claim_id="claim-1",
            source_url="https://staging.test/source",
            source_sha256=None,
            filename="SKU.png",
            relative_path="batch/SKU.png",
            options={"remove_background": False, "width": 600, "height": 600},
            upload_url="https://staging.test/result",
            upload_method="PUT",
            upload_headers={},
            output_path="staging/image-processing/outputs/remote-1/image-1.jpg",
        )

    def fetch_source(self, job, limit):
        return self.source

    def upload_result(self, job, body, content_type, result_sha256):
        self.upload = (body, content_type, result_sha256)

    def complete(self, job, payload):
        self.completed = payload

    def fail(self, job, error, retryable):
        self.failed = (error, retryable)


def test_pull_worker_reports_staged_result_and_metrics(tmp_path: Path) -> None:
    adapter = FakeAdapter()
    settings = Settings(data_dir=tmp_path, api_key="a" * 24, workers=1)
    worker = PullWorker(settings, adapter=adapter)
    assert worker.process_one() is True
    assert adapter.failed is None
    assert adapter.upload[1] == "image/webp"
    assert adapter.completed["quality"]["pipeline_version"] == "proto-image-v2-treatment-safe"
    assert adapter.completed["model"] == "source-preserving-local"
    assert adapter.completed["treatment"] == "standard_opaque"
    assert adapter.completed["result"]["sha256"] == adapter.upload[2]
    assert adapter.source == source_image()

    first_digest = adapter.upload[2]
    adapter.claimed = False
    adapter.upload = None
    adapter.completed = None
    assert worker.process_one() is True
    assert adapter.upload[2] == first_digest
    assert len(list((tmp_path / "originals").iterdir())) == 1


def test_callback_requires_https_allowlisted_host() -> None:
    assert validate_callback("https://admin.test/callback", ("admin.test",)) == "https://admin.test/callback"
    for bad in ("http://admin.test/callback", "https://other.test/callback", "https://user:pass@admin.test/callback"):
        try:
            validate_callback(bad, ("admin.test",))
        except ValueError:
            pass
        else:
            raise AssertionError(f"unsafe callback accepted: {bad}")


def test_admin_adapter_matches_flat_vercel_worker_contract(tmp_path: Path, monkeypatch) -> None:
    settings = Settings(
        data_dir=tmp_path,
        api_key="a" * 24,
        transport="admin-http",
        admin_api_url="https://admin.test",
        admin_api_token="b" * 24,
        transport_allowed_hosts=("admin.test", "storage.test"),
    )
    adapter = HttpAdminAdapter(settings)
    calls = []

    def fake_request(path, payload):
        calls.append((path, payload))
        if payload["action"] == "claim":
            return {
                "claimId": "claim-1",
                "jobId": "manifest-1",
                "imageId": "image-1",
                "source": {"url": "https://storage.test/source", "filename": "ABC1.jpg"},
                "output": {"path": "staging/image-processing/outputs/manifest-1/image-1.jpg", "signedUploadUrl": "https://storage.test/output", "headers": {"x-upsert": "true"}},
                "processing": {"treatment": {"id": "standard_opaque", "removeBackground": True}, "remove_background": True, "background": "white", "width": 1600, "height": 1600, "output_format": "jpeg"},
            }
        return {"ok": True}

    monkeypatch.setattr(adapter, "_admin_request", fake_request)
    job = adapter.claim()
    assert job and job.admin_job_id == "manifest-1" and job.image_id == "image-1"
    assert job.options["treatment"] == "standard_opaque"
    assert job.options["output_format"] == "jpeg"
    assert job.upload_headers["x-upsert"] == "true"
    adapter.complete(job, {"quality": {}, "warnings": ["possible_blur"]})
    assert calls[-1][0] == "/api/image-processing-worker"
    assert calls[-1][1] == {
        "action": "callback",
        "jobId": "manifest-1",
        "imageId": "image-1",
        "claimId": "claim-1",
        "outputPath": "staging/image-processing/outputs/manifest-1/image-1.jpg",
        "workerId": "proto-image-worker",
        "model": "source-preserving-local",
        "treatment": "standard_opaque",
        "costUsd": 0,
        "processingMs": 0,
        "quality": {},
        "warnings": ["possible_blur"],
    }
