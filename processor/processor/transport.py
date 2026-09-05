from __future__ import annotations

import hashlib
import json
import urllib.request
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urljoin, urlparse

from .config import Settings


@dataclass(frozen=True)
class RemoteJob:
    id: str
    admin_job_id: str
    image_id: str
    claim_id: str
    source_url: str
    source_sha256: str | None
    filename: str
    relative_path: str
    options: dict
    upload_url: str
    upload_method: str
    upload_headers: dict[str, str]
    output_path: str


class TransportAdapter(Protocol):
    def claim(self) -> RemoteJob | None: ...
    def fetch_source(self, job: RemoteJob, limit: int) -> bytes: ...
    def upload_result(self, job: RemoteJob, body: bytes, content_type: str, result_sha256: str) -> None: ...
    def complete(self, job: RemoteJob, payload: dict) -> None: ...
    def fail(self, job: RemoteJob, error: str, retryable: bool) -> None: ...


class HttpAdminAdapter:
    """Pull adapter for the documented Proto Admin worker contract."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.base = settings.admin_api_url + "/"
        self.allowed_hosts = set(settings.transport_allowed_hosts)

    def _check_url(self, url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Transport URLs must be HTTPS without embedded credentials")
        if parsed.hostname.lower() not in self.allowed_hosts:
            raise ValueError(f"Transport host is not allowlisted: {parsed.hostname}")

    def _admin_request(self, path: str, payload: dict) -> dict:
        url = urljoin(self.base, path.lstrip("/"))
        self._check_url(url)
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        request = urllib.request.Request(url, data=body, method="POST", headers={"X-Image-Processor-Secret": self.settings.admin_api_token, "Content-Type": "application/json", "User-Agent": "proto-image-worker/1"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode() or "{}")

    def claim(self) -> RemoteJob | None:
        raw = self._admin_request("/api/image-processing-worker", {"action": "claim", "workerId": self.settings.worker_id, "capabilities": {"formats": ["jpeg", "png", "webp"], "outputs": ["jpeg"], "pipeline": "proto-image-v2-treatment-safe"}})
        if not raw or not raw.get("jobId"):
            return None
        source = raw.get("source") or {}
        upload = raw.get("output") or {}
        processing = raw.get("processing") or {}
        raw_treatment = processing.get("treatment") or "standard_opaque"
        treatment = raw_treatment.get("id") if isinstance(raw_treatment, dict) else str(raw_treatment)
        options = {
            "treatment": treatment or "standard_opaque",
            "remove_background": bool(processing.get("remove_background", True)),
            "manual_safe_cutout": bool(processing.get("manual_safe_cutout", False)),
            "background": str(processing.get("background") or "white"),
            "cleanup_noise": bool(processing.get("cleanup_noise", True)),
            "crop": bool(processing.get("crop", True)),
            "padding_ratio": float(processing.get("padding_ratio", 0.08)),
            "width": int(processing.get("width", 1600)),
            "height": int(processing.get("height", 1600)),
            "output_format": "jpeg",
            "quality": int(processing.get("quality", 90)),
            "instructions": str(processing.get("instructions") or "")[:1000],
        }
        public_id = f'{raw["jobId"]}~{raw["imageId"]}'
        job = RemoteJob(id=public_id, admin_job_id=str(raw["jobId"]), image_id=str(raw["imageId"]), claim_id=str(raw["claimId"]), source_url=str(source["url"]), source_sha256=source.get("sha256"), filename=str(source.get("filename") or "upload.jpg"), relative_path=str(source.get("filename") or "upload.jpg"), options=options, upload_url=str(upload["signedUploadUrl"]), upload_method="PUT", upload_headers={str(key): str(value) for key, value in (upload.get("headers") or {}).items()}, output_path=str(upload["path"]))
        self._check_url(job.source_url)
        self._check_url(job.upload_url)
        if job.upload_method not in {"PUT", "POST"}:
            raise ValueError("result_upload.method must be PUT or POST")
        return job

    def fetch_source(self, job: RemoteJob, limit: int) -> bytes:
        self._check_url(job.source_url)
        request = urllib.request.Request(job.source_url, method="GET", headers={"User-Agent": "proto-image-worker/1"})
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("Staged source exceeds configured upload limit")
        digest = hashlib.sha256(body).hexdigest()
        if job.source_sha256 and digest.lower() != job.source_sha256.lower():
            raise ValueError("Staged source SHA-256 does not match claim")
        return body

    def upload_result(self, job: RemoteJob, body: bytes, content_type: str, result_sha256: str) -> None:
        self._check_url(job.upload_url)
        headers = {**job.upload_headers, "Content-Type": content_type, "Content-Length": str(len(body)), "X-Content-SHA256": result_sha256, "Idempotency-Key": f"image-result:{job.id}:{result_sha256}"}
        request = urllib.request.Request(job.upload_url, data=body, method=job.upload_method, headers=headers)
        with urllib.request.urlopen(request, timeout=90) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"Result upload returned HTTP {response.status}")

    def complete(self, job: RemoteJob, payload: dict) -> None:
        self._admin_request("/api/image-processing-worker", {"action": "callback", "jobId": job.admin_job_id, "imageId": job.image_id, "claimId": job.claim_id, "outputPath": job.output_path, "workerId": self.settings.worker_id, "model": payload.get("model") or "source-preserving-local", "treatment": payload.get("treatment") or job.options.get("treatment") or "standard_opaque", "costUsd": 0, "processingMs": payload.get("processing_ms", 0), "quality": payload.get("quality") or {}, "warnings": payload.get("warnings") or []})

    def fail(self, job: RemoteJob, error: str, retryable: bool) -> None:
        self._admin_request("/api/image-processing-worker", {"action": "fail", "jobId": job.admin_job_id, "imageId": job.image_id, "claimId": job.claim_id, "workerId": self.settings.worker_id, "error": error[:1000], "retryable": retryable})
