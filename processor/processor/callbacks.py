from __future__ import annotations

import hashlib
import hmac
import json
import urllib.request
from urllib.parse import urlparse


def validate_callback(url: str | None, allowed_hosts: tuple[str, ...]) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("callback_url must be an HTTPS URL without embedded credentials")
    if parsed.hostname.lower() not in allowed_hosts:
        raise ValueError("callback_url host is not allowlisted")
    return url


def send_callback(url: str, payload: dict, secret: str) -> None:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", "X-Proto-Signature": f"sha256={signature}", "User-Agent": "proto-image-processor/1"})
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"Callback returned HTTP {response.status}")
