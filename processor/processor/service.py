from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath

from .callbacks import send_callback, validate_callback
from .config import Settings
from .models import ProcessOptions
from .pipeline import job_digest, process_image
from .store import JobStore

SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")


def safe_upload_path(value: str) -> str:
    path = PurePosixPath(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("relative_path must stay inside the uploaded folder")
    cleaned = [SAFE_NAME.sub("_", part).strip(" .") or "unnamed" for part in path.parts]
    return "/".join(cleaned)


class ProcessorService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = JobStore(settings.data_dir)
        self.executor = ThreadPoolExecutor(max_workers=settings.workers, thread_name_prefix="image-worker")

    def submit(self, source: bytes, filename: str, relative_path: str, options: ProcessOptions, callback_url: str | None = None) -> tuple[dict, bool]:
        if len(source) > self.settings.max_upload_bytes:
            raise ValueError("Image exceeds configured upload limit")
        options.validate()
        relative_path = safe_upload_path(relative_path or filename)
        callback_url = validate_callback(callback_url, self.settings.callback_hosts)
        suffix = Path(filename).suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png", ".webp"}:
            raise ValueError("Only JPEG, PNG, and WebP files are accepted")
        job_id = job_digest(source, options)
        job, created = self.store.create(job_id, Path(filename).name, relative_path, source, suffix, options.canonical(), callback_url)
        if created:
            self.executor.submit(self._run, job_id, source, options)
        return job, created

    def _run(self, job_id: str, source: bytes, options: ProcessOptions) -> None:
        self.store.patch(job_id, status="processing")
        try:
            result = process_image(source, options)
            output_path = self.store.outputs / f"{job_id}{result.extension}"
            temp = output_path.with_suffix(output_path.suffix + ".tmp")
            temp.write_bytes(result.output_bytes)
            temp.replace(output_path)
            job = self.store.patch(job_id, status="completed", output_path=str(output_path), output_content_type=result.content_type, metrics=result.metrics, warnings=result.warnings)
        except Exception as exc:  # worker persists errors instead of disappearing
            job = self.store.patch(job_id, status="failed", error=str(exc)[:1000])
        callback_url = job.get("callback_url")
        if callback_url:
            try:
                send_callback(callback_url, public_job(job), self.settings.callback_secret)
                self.store.patch(job_id, callback_status="delivered")
            except Exception as exc:
                self.store.patch(job_id, callback_status="failed", callback_error=str(exc)[:500])


def public_job(job: dict) -> dict:
    return {key: value for key, value in job.items() if key not in {"original_path", "output_path", "callback_url"}}
