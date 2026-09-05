from __future__ import annotations

import hashlib
import sys
import time
from pathlib import Path

from .config import Settings
from .models import ProcessOptions
from .service import ProcessorService
from .transport import HttpAdminAdapter, RemoteJob, TransportAdapter


class PullWorker:
    def __init__(self, settings: Settings, adapter: TransportAdapter | None = None):
        settings.validate()
        if settings.transport != "admin-http" and adapter is None:
            raise RuntimeError("Pull worker requires PROCESSOR_TRANSPORT=admin-http")
        self.settings = settings
        self.adapter = adapter or HttpAdminAdapter(settings)
        self.processor = ProcessorService(settings)

    def process_one(self) -> bool:
        job = self.adapter.claim()
        if not job:
            return False
        try:
            source = self.adapter.fetch_source(job, self.settings.max_upload_bytes)
            options = ProcessOptions(**job.options)
            local, _ = self.processor.submit(source, job.filename, job.relative_path, options)
            while (local := self.processor.store.get(local["id"])) and local["status"] in {"queued", "processing"}:
                time.sleep(0.1)
            if not local or local["status"] != "completed":
                # A deterministic local pipeline failure will not improve on retry.
                raise ValueError((local or {}).get("error") or "Local processing failed")
            output_path = Path(local["output_path"])
            output = output_path.read_bytes()
            output_sha256 = hashlib.sha256(output).hexdigest()
            self.adapter.upload_result(job, output, local["output_content_type"], output_sha256)
            if options.treatment == "shadow":
                processor_model = "rembg-local-soft-shadow"
            elif options.remove_background:
                processor_model = "rembg-local"
            else:
                processor_model = "source-preserving-local"
            self.adapter.complete(job, {"status": "completed", "processor_job_id": local["id"], "result": {"sha256": output_sha256, "bytes": len(output), "content_type": local["output_content_type"], "filename": output_path.name}, "quality": local["metrics"], "warnings": local["warnings"], "processing_ms": 0, "model": processor_model, "treatment": options.treatment})
        except Exception as exc:
            # Validation/input failures are terminal; network and server failures remain retryable.
            terminal = isinstance(exc, (ValueError, TypeError))
            try:
                self.adapter.fail(job, str(exc), retryable=not terminal)
            except Exception:
                pass
        return True

    def run(self, once: bool = False) -> None:
        while True:
            try:
                handled = self.process_one()
            except Exception as exc:
                if once:
                    raise
                print(f"[transport] claim failed; retrying: {str(exc)[:300]}", file=sys.stderr)
                handled = False
            if once:
                return
            if not handled:
                time.sleep(self.settings.poll_seconds)


def main() -> None:
    PullWorker(Settings()).run(once="--once" in sys.argv)


if __name__ == "__main__":
    main()
