from __future__ import annotations

import time
from pathlib import Path

from processor.config import Settings
from processor.models import ProcessOptions
from processor.service import ProcessorService, safe_upload_path
from test_pipeline import source_image


def make_settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path, api_key="a" * 24, workers=1)


def wait_for(service: ProcessorService, job_id: str) -> dict:
    for _ in range(100):
        job = service.store.get(job_id)
        if job and job["status"] not in {"queued", "processing"}:
            return job
        time.sleep(0.03)
    raise AssertionError("job did not finish")


def test_original_is_preserved_and_submit_is_idempotent(tmp_path: Path) -> None:
    service = ProcessorService(make_settings(tmp_path))
    source = source_image()
    options = ProcessOptions(remove_background=False, width=600, height=600)
    first, created = service.submit(source, "SKU-1.png", "folder/SKU-1.png", options)
    assert created is True
    completed = wait_for(service, first["id"])
    original = Path(completed["original_path"])
    assert original.read_bytes() == source
    second, created_again = service.submit(source, "SKU-1.png", "folder/SKU-1.png", options)
    assert created_again is False
    assert second["id"] == first["id"]
    assert Path(completed["output_path"]).exists()


def test_folder_path_cannot_escape() -> None:
    for bad in ("../secret.jpg", "/etc/passwd", "folder/../../secret.jpg"):
        try:
            safe_upload_path(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"unsafe path accepted: {bad}")
