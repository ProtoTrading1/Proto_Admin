#!/usr/bin/env python3
"""
BLADERUNNER-PC image intake worker.

Flow:
  1. Claim pending rows from Supabase image_intake_queue
  2. Read SQL Server dbo.STMAST (SELECT only — never writes to SQL)
  3. Upload final image to product-images bucket
  4. Upsert public.products in Supabase
  5. Mark queue row completed / failed

Run on BLADERUNNER-PC (ODBC + network access to SQL Server and Supabase).

  pip install pyodbc supabase requests python-dotenv
  python scripts/image-intake-worker.py

Env (.env on BLADERUNNER-PC):
  SUPABASE_URL=https://yiqsvwajozafvalwcero.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=...
  SQL_SERVER=BLADERUNNER-PC
  SQL_DATABASE=POSWINSQL
  SQL_USER=ProtoSyncReadOnly
  SQL_PASSWORD=...
  WORKER_NAME=bladerunner-pc
  POLL_SECONDS=10
  BATCH_SIZE=5
"""

from __future__ import annotations

import mimetypes
import os
import re
import socket
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pyodbc
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent / ".env")

STAGING_BUCKET = "intake-staging"
LIVE_BUCKET = "product-images"
IMAGE_COLUMNS = ["image_url_one", "image_url_two", "image_url_three", "image_url_four"]
FILENAME_WITH_IMAGE_NUMBER_PATTERN = re.compile(r"^(?P<sku>.+)-(?P<image_number>\d+)$")

FORBIDDEN_SQL_TOKENS = {
    "INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "CREATE", "MERGE", "TRUNCATE", "EXEC", "EXECUTE", "BACKUP",
}


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def validate_read_only_sql(query: str) -> str:
    stripped = query.strip()
    upper = stripped.upper()
    if not upper.startswith("SELECT"):
        raise RuntimeError("Blocked SQL Server command because it is not a SELECT statement.")
    for token in FORBIDDEN_SQL_TOKENS:
        if token in upper:
            raise RuntimeError(f"Blocked SQL Server command containing forbidden token: {token}")
    return stripped


def build_connection_string() -> str:
    return (
        "DRIVER={ODBC Driver 17 for SQL Server};"
        f"SERVER={env('SQL_SERVER', 'BLADERUNNER-PC')};"
        f"DATABASE={env('SQL_DATABASE', 'POSWINSQL')};"
        f"UID={env('SQL_USER', 'ProtoSyncReadOnly')};"
        f"PWD={env('SQL_PASSWORD')};"
        "ApplicationIntent=ReadOnly;"
        "Encrypt=no;"
    )


def to_decimal(value) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class IntakeWorker:
    def __init__(self) -> None:
        url = env("SUPABASE_URL", "https://yiqsvwajozafvalwcero.supabase.co")
        key = env("SUPABASE_SERVICE_ROLE_KEY")
        if not key:
            raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is required")
        if not env("SQL_PASSWORD"):
            raise RuntimeError("SQL_PASSWORD is required for read-only SQL lookup")

        self.sb = create_client(url, key)
        self.worker_name = env("WORKER_NAME", socket.gethostname() or "bladerunner-pc")
        self.poll_seconds = max(3, int(env("POLL_SECONDS", "10")))
        self.batch_size = max(1, int(env("BATCH_SIZE", "5")))
        for bucket in (STAGING_BUCKET, LIVE_BUCKET):
            try:
                self.sb.storage.create_bucket(bucket, options={"public": True})
            except Exception:
                pass

    def fetch_sql_row(self, sku: str) -> dict | None:
        query = validate_read_only_sql(
            """
            SELECT TOP 1 CODE, DESCR, PRICE_A, ONHAND, BOOKED, DEPT
            FROM dbo.STMAST
            WHERE CODE = ?
            """
        )
        with pyodbc.connect(build_connection_string(), autocommit=False, timeout=20) as conn:
            cur = conn.cursor()
            cur.execute(query, sku)
            row = cur.fetchone()
            if not row:
                return None
            columns = [column[0] for column in cur.description]
            return dict(zip(columns, row))

    def claim_pending(self) -> list[dict]:
        res = (
            self.sb.table("image_intake_queue")
            .select("*")
            .eq("status", "pending")
            .order("created_at")
            .limit(self.batch_size)
            .execute()
        )
        claimed = []
        now = utc_now()
        for row in res.data or []:
            patch = {
                "status": "processing",
                "locked_at": now,
                "locked_by": self.worker_name,
                "updated_at": now,
            }
            upd = (
                self.sb.table("image_intake_queue")
                .update(patch)
                .eq("id", row["id"])
                .eq("status", "pending")
                .execute()
            )
            if upd.data:
                claimed.append({**row, **patch})
        return claimed

    def download_bytes(self, url: str) -> tuple[bytes, str]:
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type") or mimetypes.guess_type(url)[0] or "image/jpeg"
        return resp.content, content_type

    def publish_image(self, row: dict, sku: str) -> str:
        staging_url = row.get("staging_url") or ""
        if not staging_url:
            raise RuntimeError("Missing staging_url on queue row")
        body, content_type = self.download_bytes(staging_url)
        ext = mimetypes.guess_extension(content_type) or Path(row.get("original_filename") or "").suffix or ".jpg"
        safe_ext = ext.lstrip(".") or "jpg"
        object_name = f"{int(time.time() * 1000)}-{sku}-{row.get('image_number', 1)}.{safe_ext}"
        self.sb.storage.from_(LIVE_BUCKET).upload(
            object_name,
            body,
            file_options={"content-type": content_type, "upsert": "false"},
        )
        return self.sb.storage.from_(LIVE_BUCKET).get_public_url(object_name)

    def upsert_product(self, sku: str, sql_row: dict, image_column: str, image_url: str) -> None:
        onhand = to_decimal(sql_row.get("ONHAND"))
        booked = to_decimal(sql_row.get("BOOKED"))
        available = onhand - booked
        payload = {
            "sku": sku,
            "sell_price": float(to_decimal(sql_row.get("PRICE_A"))),
            "stock_qty": float(onhand),
            "available_stock": float(available),
            image_column: image_url,
        }
        title = str(sql_row.get("DESCR") or "").strip()
        if title:
            payload["title"] = title

        existing = self.sb.table("products").select("sku").eq("sku", sku).limit(1).execute()
        if existing.data:
            self.sb.table("products").update(payload).eq("sku", sku).execute()
        else:
            self.sb.table("products").insert(payload).execute()

    def mark_queue(self, row_id: str, patch: dict) -> None:
        patch["updated_at"] = utc_now()
        self.sb.table("image_intake_queue").update(patch).eq("id", row_id).execute()

    def process_row(self, row: dict) -> None:
        row_id = row["id"]
        sku = str(row.get("source_sku") or "").strip().upper()
        image_column = str(row.get("image_column") or IMAGE_COLUMNS[0])
        try:
            sql_row = self.fetch_sql_row(sku)
            if not sql_row:
                raise RuntimeError(f"SKU {sku} not found in SQL Server (dbo.STMAST)")

            final_url = self.publish_image(row, sku)
            self.upsert_product(sku, sql_row, image_column, final_url)

            self.mark_queue(row_id, {
                "status": "completed",
                "product_sku": sku,
                "final_image_url": final_url,
                "processed_at": utc_now(),
                "sql_code": str(sql_row.get("CODE") or sku),
                "sql_title": str(sql_row.get("DESCR") or ""),
                "sql_price": float(to_decimal(sql_row.get("PRICE_A"))),
                "sql_onhand": float(to_decimal(sql_row.get("ONHAND"))),
                "sql_dept": str(sql_row.get("DEPT") or ""),
                "error_message": None,
            })
            print(f"[ok] {sku} -> {image_column}")
        except Exception as exc:  # noqa: BLE001 — worker must continue after row failures
            msg = str(exc)
            print(f"[fail] {sku}: {msg}", file=sys.stderr)
            self.mark_queue(row_id, {
                "status": "failed",
                "error_message": msg[:500],
                "processed_at": utc_now(),
            })

    def run_once(self) -> int:
        rows = self.claim_pending()
        for row in rows:
            self.process_row(row)
        return len(rows)

    def run_forever(self) -> None:
        print(f"Image intake worker started as {self.worker_name}")
        while True:
            processed = self.run_once()
            if processed == 0:
                time.sleep(self.poll_seconds)


def main() -> None:
    worker = IntakeWorker()
    if "--once" in sys.argv:
        count = worker.run_once()
        print(f"Processed {count} queue item(s)")
        return
    worker.run_forever()


if __name__ == "__main__":
    main()
