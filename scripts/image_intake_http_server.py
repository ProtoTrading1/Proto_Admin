#!/usr/bin/env python3
"""
HTTP API for admin Image Intake — runs on BLADERUNNER-PC (office machine).

Exposes George's image_intake_service.py to protoportal-admin on Vercel.

  pip install pyodbc supabase python-dotenv pillow
  python scripts/image_intake_http_server.py

Vercel env (protoportal-admin):
  IMAGE_INTAKE_SERVICE_URL=http://<office-ip>:8766
  IMAGE_INTAKE_SERVICE_KEY=<shared-secret>
"""

from __future__ import annotations

import cgi
import json
import os
import tempfile
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from image_intake_service import create_product_from_image, preview_image_upload

PORT = int(os.getenv("IMAGE_INTAKE_SERVICE_PORT", "8766"))
SERVICE_KEY = os.getenv("IMAGE_INTAKE_SERVICE_KEY", os.getenv("STOCK_SQL_BRIDGE_KEY", ""))


class Handler(BaseHTTPRequestHandler):
    def _auth_ok(self) -> bool:
        if not SERVICE_KEY:
            return True
        return self.headers.get("x-api-key") == SERVICE_KEY

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length) if length else b""

    def _save_upload(self) -> tuple[Path, str]:
        content_type = self.headers.get("Content-Type", "")
        if content_type.startswith("multipart/form-data"):
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type},
            )
            file_item = form["file"] if "file" in form else None
            if not file_item or not getattr(file_item, "filename", None):
                raise ValueError("multipart file field required")
            filename = Path(file_item.filename).name
            suffix = Path(filename).suffix or ".jpg"
            tmp = Path(tempfile.gettempdir()) / f"intake-{uuid.uuid4().hex}{suffix}"
            tmp.write_bytes(file_item.file.read())
            return tmp, filename

        raw = self._read_body()
        data = json.loads(raw.decode("utf-8") or "{}")
        filename = str(data.get("filename") or "upload.jpg")
        import base64

        b64 = data.get("base64") or ""
        if not b64:
            raise ValueError("base64 or multipart file required")
        suffix = Path(filename).suffix or ".jpg"
        tmp = Path(tempfile.gettempdir()) / f"intake-{uuid.uuid4().hex}{suffix}"
        tmp.write_bytes(base64.b64decode(b64))
        return tmp, filename

    def do_POST(self) -> None:
        if not self._auth_ok():
            self._json(401, {"error": "Unauthorized"})
            return

        path = self.path.rstrip("/")
        tmp: Path | None = None
        try:
            tmp, filename = self._save_upload()
            # Rename so parse_filename sees correct stem
            named = tmp.parent / filename
            if named != tmp:
                tmp.rename(named)
                tmp = named

            if path == "/preview":
                result = preview_image_upload(str(tmp))
                self._json(200, {"ok": True, "preview": result})
                return

            if path == "/process":
                result = create_product_from_image(str(tmp))
                self._json(200, {"ok": True, **result})
                return

            self._json(404, {"error": "Not found — use /preview or /process"})
        except Exception as exc:  # noqa: BLE001
            self._json(422, {"ok": False, "error": str(exc)[:500]})
        finally:
            if tmp and tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass

    def log_message(self, fmt: str, *args) -> None:
        print(f"[image-intake-api] {self.address_string()} - {fmt % args}")


def main() -> None:
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Image intake HTTP API on :{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
