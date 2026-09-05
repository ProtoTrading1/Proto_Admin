from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, data_dir: Path):
        self.root = data_dir
        self.originals = self.root / "originals"
        self.outputs = self.root / "outputs"
        self.jobs = self.root / "jobs"
        for path in (self.originals, self.outputs, self.jobs):
            path.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _job_path(self, job_id: str) -> Path:
        return self.jobs / f"{job_id}.json"

    def get(self, job_id: str) -> dict | None:
        path = self._job_path(job_id)
        if not path.exists():
            return None
        with self._lock:
            return json.loads(path.read_text(encoding="utf-8"))

    def save(self, job: dict) -> dict:
        path = self._job_path(job["id"])
        temp = path.with_suffix(".tmp")
        with self._lock:
            temp.write_text(json.dumps(job, indent=2, sort_keys=True), encoding="utf-8")
            os.replace(temp, path)
        return job

    def create(self, job_id: str, original_name: str, relative_path: str, source: bytes, extension: str, options: dict, callback_url: str | None) -> tuple[dict, bool]:
        with self._lock:
            existing = self.get(job_id)
            if existing:
                return existing, False
            original_path = self.originals / f"{job_id}{extension.lower()}"
            temp = original_path.with_suffix(original_path.suffix + ".tmp")
            temp.write_bytes(source)
            os.replace(temp, original_path)
            now = utc_now()
            job = {"id": job_id, "status": "queued", "original_filename": original_name, "relative_path": relative_path, "original_path": str(original_path), "output_path": None, "output_content_type": None, "options": options, "metrics": None, "warnings": [], "error": None, "callback_url": callback_url, "created_at": now, "updated_at": now}
            return self.save(job), True

    def patch(self, job_id: str, **values) -> dict:
        with self._lock:
            job = self.get(job_id)
            if not job:
                raise KeyError(job_id)
            job.update(values)
            job["updated_at"] = utc_now()
            return self.save(job)
