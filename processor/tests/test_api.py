from __future__ import annotations

import importlib

from fastapi.testclient import TestClient


def test_health_and_auth(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("PROCESSOR_API_KEY", "test-key-that-is-definitely-long-enough")
    monkeypatch.setenv("PROCESSOR_DATA_DIR", str(tmp_path))
    import processor.config

    importlib.reload(processor.config)
    import processor.main
    module = importlib.reload(processor.main)
    client = TestClient(module.app)
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["pipeline_version"] == "proto-image-v2-treatment-safe"
    assert client.get("/v1/jobs/not-found").status_code == 401
