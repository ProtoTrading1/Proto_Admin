#!/usr/bin/env python3
"""
Minimal read-only SQL API for Vercel admin (STMAST + Positill sales aggregates).

**READ ONLY — SELECT queries only. Never add write endpoints.**

Run on BLADERUNNER-PC:
  pip install pyodbc
  python scripts/sql-stmast-bridge.py

Set on Vercel (protoportal-admin):
  STOCK_SQL_BRIDGE_URL=http://<bladerunner-host>:8765
  STOCK_SQL_BRIDGE_KEY=<shared secret>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pyodbc

from sql_report_catalogue import (
    ReportValidationError,
    list_reports,
    run_report,
    validate_report_params,
)

BRIDGE_VERSION = "1.4.0"
BUILD_GIT_COMMIT = "not-stamped"
BUILD_DATE_UTC = "not-stamped"
STARTED_AT_UTC = datetime.now(timezone.utc)
LAST_QUERY_AT_UTC: datetime | None = None


def load_env_file(path: Path) -> None:
    """Minimal .env reader so the deployed bridge has no helper dependency."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(Path(__file__).resolve().parent.parent / ".env")

SQL_SERVER = os.getenv("SQL_SERVER", "BLADERUNNER-PC")
SQL_DATABASE = os.getenv("SQL_DATABASE", "POSWINSQL")
SQL_USER = os.getenv("SQL_USER", "ProtoSyncReadOnly")
SQL_PASSWORD = os.getenv("SQL_PASSWORD", "")
BRIDGE_KEY = os.getenv("STOCK_SQL_BRIDGE_KEY", "")
PORT = int(os.getenv("STOCK_SQL_BRIDGE_PORT", "8765"))

SAST = timezone(timedelta(hours=2))

ALLOWED_PERIODS = frozenset({"today", "yesterday", "last_week", "general"})
ALLOWED_SCOPES = frozenset({"top_sellers", "worst_sellers", "revenue"})

STMAST_SELECT = """
    SELECT TOP 1 CODE, DESCR, PRICE_A, ONHAND, BOOKED, DEPT
    FROM dbo.STMAST
    WHERE CODE = ?
"""


def json_safe_value(value: Any) -> Any:
    """Convert pyodbc values to JSON-native scalars."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        numeric = float(value)
        return int(numeric) if numeric.is_integer() else numeric
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "isoformat"):  # SQL date values
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    return value


def row_to_dict(columns, row) -> dict:
    return {column: json_safe_value(value) for column, value in zip(columns, row)}


def sanitize_for_json(value: Any) -> Any:
    """Recursively remove SQL/Python values that JSON cannot encode."""
    if isinstance(value, dict):
        return {str(key): sanitize_for_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_for_json(item) for item in value]
    return json_safe_value(value)


def json_default_handler(value: Any) -> Any:
    converted = json_safe_value(value)
    if converted is value:
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")
    return converted


def encode_json_payload(payload: dict) -> bytes:
    return json.dumps(
        sanitize_for_json(payload),
        default=json_default_handler,
        ensure_ascii=False,
    ).encode("utf-8")


def build_info() -> dict[str, str]:
    return {
        "bridge": "Apollo SQL Bridge",
        "version": BRIDGE_VERSION,
        "gitCommit": os.getenv("SQL_BRIDGE_BUILD_COMMIT", BUILD_GIT_COMMIT),
        "buildDate": os.getenv("SQL_BRIDGE_BUILD_DATE_UTC", BUILD_DATE_UTC),
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "sqlServer": SQL_SERVER,
        "database": SQL_DATABASE,
        "connection": "ReadOnly",
        "reportSchemaVersion": "proto.sql-report.v1",
        "reportEngineVersion": "4.3.0",
    }


def connection_string() -> str:
    return (
        "DRIVER={ODBC Driver 17 for SQL Server};"
        f"SERVER={SQL_SERVER};"
        f"DATABASE={SQL_DATABASE};"
        f"UID={SQL_USER};"
        f"PWD={SQL_PASSWORD};"
        "ApplicationIntent=ReadOnly;"
        "Encrypt=no;"
    )


def utc_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def uptime_string() -> str:
    elapsed_seconds = max(0, int((datetime.now(timezone.utc) - STARTED_AT_UTC).total_seconds()))
    hours, remainder = divmod(elapsed_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def verify_database_connection() -> bool:
    """Health check only: run a read-only scalar query against POSWINSQL."""
    global LAST_QUERY_AT_UTC
    with pyodbc.connect(connection_string(), timeout=10) as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1")
        is_connected = cur.fetchone()[0] == 1
    if is_connected:
        LAST_QUERY_AT_UTC = datetime.now(timezone.utc)
    return is_connected


def health_info() -> dict[str, Any]:
    try:
        connected = verify_database_connection()
    except Exception:  # noqa: BLE001
        connected = False

    return {
        "status": "healthy" if connected else "unhealthy",
        "database": "connected" if connected else "unavailable",
        "readOnly": True,
        "bridge": "running",
        "lastQuery": utc_iso(LAST_QUERY_AT_UTC),
        "uptime": uptime_string(),
    }


def sast_period_bounds(period: str, now: datetime | None = None) -> tuple[datetime, datetime, str]:
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(SAST)
    day_start = local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)

    if period == "today":
        return day_start, now, "today (Positill · SAST)"
    if period == "yesterday":
        y_start = day_start - timedelta(days=1)
        return y_start, day_start, "yesterday (Positill · SAST)"
    if period == "last_week":
        return day_start - timedelta(days=7), now, "last 7 days (Positill)"
    return now - timedelta(days=30), now, "last 30 days (Positill)"


def order_clause(scope: str) -> str:
    safe = scope if scope in ALLOWED_SCOPES else "top_sellers"
    if safe == "worst_sellers":
        return "SUM(CAST(d.QTY AS float)) ASC"
    if safe == "revenue":
        return "SUM(CAST(d.TOTAL AS float)) DESC"
    return "SUM(CAST(d.QTY AS float)) DESC"


def connect_read_only(_catalogue_connection_string: str | None = None, timeout: int = 20):
    """Open the fixed read-only POSWINSQL connection.

    The approved report catalogue calls its connector with a connection-string
    argument plus ``timeout``. The bridge deliberately ignores that supplied
    string and always uses its own read-only connection configuration.
    """
    return pyodbc.connect(connection_string(), timeout=timeout)


def fetch_row(sku: str) -> dict | None:
    global LAST_QUERY_AT_UTC
    with connect_read_only(timeout=20) as conn:
        cur = conn.cursor()
        cur.execute(STMAST_SELECT, sku)
        row = cur.fetchone()
        LAST_QUERY_AT_UTC = datetime.now(timezone.utc)
        if not row:
            return None
        cols = [c[0] for c in cur.description]
        return row_to_dict(cols, row)


def fetch_top_sellers(period: str, scope: str, limit: int) -> dict:
    global LAST_QUERY_AT_UTC
    safe_period = period if period in ALLOWED_PERIODS else "today"
    safe_scope = scope if scope in ALLOWED_SCOPES else "top_sellers"
    start, end, label = sast_period_bounds(safe_period)
    order = order_clause(safe_scope)
    limit = max(1, min(int(limit or 10), 25))

    top_sql = f"""
        SELECT TOP ({limit})
            d.PRODUCT AS code,
            MAX(d.DESCR) AS title,
            SUM(CAST(d.QTY AS float)) AS totalQty,
            SUM(CAST(d.TOTAL AS float)) AS totalValue,
            COUNT(DISTINCT h.INV_NO) AS invoiceCount
        FROM dbo.DBINVDT d
        INNER JOIN dbo.DBINVHD h ON h.INV_NO = d.INV_NO AND h.TYPE = d.TYPE
        WHERE h.DATE >= ? AND h.DATE < ?
          AND d.PRODUCT IS NOT NULL AND LTRIM(RTRIM(d.PRODUCT)) <> ''
        GROUP BY d.PRODUCT
        ORDER BY {order}
    """
    count_sql = """
        SELECT COUNT(*) AS invoiceCount
        FROM dbo.DBINVHD
        WHERE DATE >= ? AND DATE < ?
    """

    with connect_read_only(timeout=25) as conn:
        cur = conn.cursor()
        cur.execute(count_sql, start, end)
        cnt_row = cur.fetchone()
        invoice_header_count = int(cnt_row[0]) if cnt_row else 0

        cur.execute(top_sql, start, end)
        cols = [c[0] for c in cur.description]
        items = [row_to_dict(cols, row) for row in cur.fetchall()]
        LAST_QUERY_AT_UTC = datetime.now(timezone.utc)

    return {
        "items": items,
        "invoiceHeaderCount": invoice_header_count,
        "periodLabel": label,
    }


class Handler(BaseHTTPRequestHandler):
    def _auth_ok(self) -> bool:
        if not BRIDGE_KEY:
            return True
        return self.headers.get("x-api-key") == BRIDGE_KEY

    def _json(self, code: int, payload: dict) -> None:
        body = encode_json_payload(payload)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _version(self) -> None:
        health = health_info()
        status_code = 200 if health["status"] == "healthy" else 503
        self._json(status_code, {**build_info(), "status": health["status"], "uptime": health["uptime"]})

    def _health(self) -> None:
        health = health_info()
        self._json(200 if health["status"] == "healthy" else 503, health)

    def do_GET(self) -> None:
        path = self.path.rstrip("/")
        if path not in ("/version", "/health", "/reports"):
            self._json(404, {"error": "Not found"})
            return
        if not self._auth_ok():
            self._json(401, {"error": "Unauthorized"})
            return
        if path == "/version":
            self._version()
        elif path == "/health":
            self._health()
        else:
            self._json(200, {
                "reports": list_reports(),
                "readOnly": True,
                "schemaVersion": "proto.sql-report.v1",
                "engineVersion": "4.3.0",
            })

    def do_POST(self) -> None:
        path = self.path.rstrip("/")
        if path not in ("/stmast", "/top-sellers", "/reports/run", "/version", "/health"):
            self._json(404, {"error": "Not found"})
            return
        if not self._auth_ok():
            self._json(401, {"error": "Unauthorized"})
            return
        if path == "/version":
            self._version()
            return
        if path == "/health":
            self._health()
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "Invalid JSON"})
            return

        try:
            if path == "/reports/run":
                report_id = str(data.get("reportId") or data.get("report") or "").strip()
                params = data.get("params") or data.get("parameters") or {}
                result = run_report(
                    report_id,
                    params,
                    connect=connect_read_only,
                    row_to_dict=row_to_dict,
                )
                LAST_QUERY_AT_UTC = datetime.now(timezone.utc)
                self._json(200, result)
                return

            if path == "/stmast":
                sku = str(data.get("sku") or "").strip().upper()
                if not sku:
                    self._json(400, {"error": "sku required"})
                    return
                row = fetch_row(sku)
                self._json(200, {"row": row})
                return

            period = str(data.get("period") or "today")
            scope = str(data.get("scope") or "top_sellers")
            limit = int(data.get("limit") or 10)
            payload = fetch_top_sellers(period, scope, limit)
            self._json(200, payload)
        except ReportValidationError as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": str(exc)[:500]})

    def log_message(self, fmt: str, *args) -> None:
        print(f"[sql-bridge] {self.address_string()} - {fmt % args}")


def run_cli() -> int:
    parser = argparse.ArgumentParser(description="Proto SQL bridge utilities")
    parser.add_argument("--list-reports", action="store_true", help="Print approved SQL report catalogue")
    parser.add_argument("--report", help="Run an approved report id")
    parser.add_argument("--params", help="JSON object of report parameters")
    args = parser.parse_args()

    if args.list_reports:
        print(json.dumps({"reports": list_reports(), "readOnly": True}, indent=2))
        return 0

    if args.report:
        raw_params = json.loads(args.params or "{}")
        result = run_report(
            args.report,
            raw_params,
            connect=connect_read_only,
            row_to_dict=row_to_dict,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0

    return 1


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1].startswith("-"):
        if not SQL_PASSWORD and "--list-reports" not in sys.argv:
            raise SystemExit("SQL_PASSWORD required")
        raise SystemExit(run_cli())

    if not SQL_PASSWORD:
        raise SystemExit("SQL_PASSWORD required")

    server = HTTPServer(("0.0.0.0", PORT), Handler)
    info = build_info()
    print(
        "Proto SQL Bridge "
        f"version={info['version']} gitCommit={info['gitCommit']} buildDate={info['buildDate']}",
        flush=True,
    )
    print(
        f"SQL bridge listening on :{PORT} "
        "(/version, /health, /reports, /reports/run, /stmast, /top-sellers)",
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
