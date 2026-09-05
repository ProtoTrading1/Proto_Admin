from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _csv(name: str) -> tuple[str, ...]:
    return tuple(value.strip().lower() for value in os.getenv(name, "").split(",") if value.strip())


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path(os.getenv("PROCESSOR_DATA_DIR", "./data")).resolve()
    api_key: str = os.getenv("PROCESSOR_API_KEY", "")
    callback_secret: str = os.getenv("PROCESSOR_CALLBACK_SECRET", "")
    callback_hosts: tuple[str, ...] = _csv("PROCESSOR_CALLBACK_HOSTS")
    max_upload_bytes: int = int(os.getenv("PROCESSOR_MAX_UPLOAD_BYTES", str(30 * 1024 * 1024)))
    workers: int = max(1, int(os.getenv("PROCESSOR_WORKERS", "2")))
    transport: str = os.getenv("PROCESSOR_TRANSPORT", "none").strip().lower()
    admin_api_url: str = os.getenv("PROCESSOR_ADMIN_API_URL", "").rstrip("/")
    admin_api_token: str = os.getenv("PROCESSOR_ADMIN_API_TOKEN", "")
    transport_allowed_hosts: tuple[str, ...] = _csv("PROCESSOR_TRANSPORT_ALLOWED_HOSTS")
    worker_id: str = os.getenv("PROCESSOR_WORKER_ID", "proto-image-worker")
    poll_seconds: int = max(2, int(os.getenv("PROCESSOR_POLL_SECONDS", "10")))

    def validate(self) -> None:
        if not self.api_key:
            raise RuntimeError("PROCESSOR_API_KEY must be configured")
        if len(self.api_key) < 24:
            raise RuntimeError("PROCESSOR_API_KEY must be at least 24 characters")
        if self.callback_hosts and len(self.callback_secret) < 32:
            raise RuntimeError("PROCESSOR_CALLBACK_SECRET must be at least 32 characters when callbacks are enabled")
        if self.transport not in {"none", "admin-http"}:
            raise RuntimeError("PROCESSOR_TRANSPORT must be none or admin-http")
        if self.transport == "admin-http":
            if not self.admin_api_url.startswith("https://"):
                raise RuntimeError("PROCESSOR_ADMIN_API_URL must use HTTPS")
            if len(self.admin_api_token) < 24:
                raise RuntimeError("PROCESSOR_ADMIN_API_TOKEN must be at least 24 characters")
            if not self.transport_allowed_hosts:
                raise RuntimeError("PROCESSOR_TRANSPORT_ALLOWED_HOSTS is required for admin-http")
