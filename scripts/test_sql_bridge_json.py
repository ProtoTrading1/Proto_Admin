#!/usr/bin/env python3
"""Unit tests for the self-contained SQL bridge JSON path."""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from decimal import Decimal
from importlib.util import module_from_spec, spec_from_file_location
from http.server import HTTPServer
from pathlib import Path
from urllib.request import urlopen

SCRIPT_DIR = Path(__file__).resolve().parent

for _env_name in (".env.local", ".env"):
    _env_path = SCRIPT_DIR.parent / _env_name
    if _env_path.exists():
        for _line in _env_path.read_text(encoding="utf-8").splitlines():
            _trimmed = _line.strip()
            if not _trimmed or _trimmed.startswith("#") or "=" not in _trimmed:
                continue
            _key, _val = _trimmed.split("=", 1)
            _key = _key.strip()
            _val = _val.strip().strip('"').strip("'")
            if _key and os.getenv(_key) is None:
                os.environ[_key] = _val
        break

_bridge_spec = spec_from_file_location("sql_stmast_bridge", SCRIPT_DIR / "sql-stmast-bridge.py")
if _bridge_spec is None or _bridge_spec.loader is None:
    raise RuntimeError("Unable to load sql-stmast-bridge.py")
_bridge = module_from_spec(_bridge_spec)
_bridge_spec.loader.exec_module(_bridge)

_catalogue_spec = spec_from_file_location("sql_report_catalogue", SCRIPT_DIR / "sql_report_catalogue.py")
if _catalogue_spec is None or _catalogue_spec.loader is None:
    raise RuntimeError("Unable to load sql_report_catalogue.py")
_catalogue = module_from_spec(_catalogue_spec)
_catalogue_spec.loader.exec_module(_catalogue)
encode_json_payload = _bridge.encode_json_payload
row_to_dict = _bridge.row_to_dict
sanitize_for_json = _bridge.sanitize_for_json


def legacy_row_dict(columns, row) -> dict:
    """Pre-fix bridge implementation: raw pyodbc values."""
    return dict(zip(columns, row))


def legacy_encode_json_payload(payload: dict) -> bytes:
    """Pre-fix bridge implementation: bare json.dumps()."""
    return json.dumps(payload).encode("utf-8")


def find_decimals(value, path: str = "$") -> list[str]:
    if isinstance(value, Decimal):
        return [f"{path} = {value!r} ({type(value)!r})"]
    if isinstance(value, dict):
        return [
            finding
            for key, item in value.items()
            for finding in find_decimals(item, f"{path}.{key}")
        ]
    if isinstance(value, (list, tuple)):
        return [
            finding
            for index, item in enumerate(value)
            for finding in find_decimals(item, f"{path}[{index}]")
        ]
    return []

# Representative STMAST row shape from pyodbc (SKU 8626100145 class of data).
SAMPLE_COLS = ["CODE", "DESCR", "PRICE_A", "ONHAND", "BOOKED", "DEPT"]
SAMPLE_ROW = (
    "8626100145",
    "PLAYING CARDS ANIMAL",
    Decimal("12.50"),
    Decimal("67"),
    Decimal("0"),
    "STATIONERY/ART",
)


class TestLegacyBridgeJson(unittest.TestCase):
    def test_legacy_row_dict_retains_decimals(self):
        row = legacy_row_dict(SAMPLE_COLS, SAMPLE_ROW)
        decimals = find_decimals(row)
        self.assertGreaterEqual(len(decimals), 3)
        self.assertTrue(any("PRICE_A" in path for path in decimals))

    def test_legacy_json_dumps_fails(self):
        payload = {"row": legacy_row_dict(SAMPLE_COLS, SAMPLE_ROW)}
        with self.assertRaises(TypeError) as ctx:
            legacy_encode_json_payload(payload)
        self.assertIn("Decimal", str(ctx.exception))

    def test_legacy_failure_points_at_price_a(self):
        payload = {"row": legacy_row_dict(SAMPLE_COLS, SAMPLE_ROW)}
        decimals = find_decimals(payload)
        self.assertIn("$.row.PRICE_A = Decimal('12.50') (<class 'decimal.Decimal'>)", decimals[0])


class TestFixedBridgeJson(unittest.TestCase):
    def test_row_to_dict_removes_decimals(self):
        row = row_to_dict(SAMPLE_COLS, SAMPLE_ROW)
        self.assertEqual(find_decimals(row), [])
        self.assertEqual(row["PRICE_A"], 12.5)
        self.assertEqual(row["ONHAND"], 67)
        self.assertEqual(row["BOOKED"], 0)

    def test_sanitize_for_json_removes_decimals(self):
        payload = {"row": row_to_dict(SAMPLE_COLS, SAMPLE_ROW)}
        safe = sanitize_for_json(payload)
        self.assertEqual(find_decimals(safe), [])

    def test_encode_json_payload_succeeds(self):
        payload = {"row": row_to_dict(SAMPLE_COLS, SAMPLE_ROW)}
        body = encode_json_payload(payload)
        parsed = json.loads(body.decode("utf-8"))
        self.assertEqual(parsed["row"]["CODE"], "8626100145")
        self.assertEqual(parsed["row"]["PRICE_A"], 12.5)
        self.assertIsInstance(parsed["row"]["ONHAND"], int)

    def test_version_endpoint_reports_build_metadata(self):
        old_key = _bridge.BRIDGE_KEY
        old_verify = _bridge.verify_database_connection
        old_commit = os.environ.get("SQL_BRIDGE_BUILD_COMMIT")
        old_date = os.environ.get("SQL_BRIDGE_BUILD_DATE_UTC")
        _bridge.BRIDGE_KEY = ""
        _bridge.verify_database_connection = lambda: True
        os.environ["SQL_BRIDGE_BUILD_COMMIT"] = "unit-test-commit"
        os.environ["SQL_BRIDGE_BUILD_DATE_UTC"] = "2026-07-10T00:00:00Z"
        server = HTTPServer(("127.0.0.1", 0), _bridge.Handler)
        worker = threading.Thread(target=server.handle_request, daemon=True)
        worker.start()
        try:
            with urlopen(f"http://127.0.0.1:{server.server_port}/version", timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(payload["bridge"], "Apollo SQL Bridge")
            self.assertEqual(payload["version"], _bridge.BRIDGE_VERSION)
            self.assertEqual(payload["gitCommit"], "unit-test-commit")
            self.assertEqual(payload["buildDate"], "2026-07-10T00:00:00Z")
            self.assertEqual(payload["connection"], "ReadOnly")
            self.assertEqual(payload["status"], "healthy")
        finally:
            server.server_close()
            _bridge.BRIDGE_KEY = old_key
            _bridge.verify_database_connection = old_verify
            if old_commit is None:
                os.environ.pop("SQL_BRIDGE_BUILD_COMMIT", None)
            else:
                os.environ["SQL_BRIDGE_BUILD_COMMIT"] = old_commit
            if old_date is None:
                os.environ.pop("SQL_BRIDGE_BUILD_DATE_UTC", None)
            else:
                os.environ["SQL_BRIDGE_BUILD_DATE_UTC"] = old_date

    def test_health_endpoint_reports_read_only_database_status(self):
        old_key = _bridge.BRIDGE_KEY
        old_verify = _bridge.verify_database_connection
        _bridge.BRIDGE_KEY = ""
        _bridge.verify_database_connection = lambda: True
        server = HTTPServer(("127.0.0.1", 0), _bridge.Handler)
        worker = threading.Thread(target=server.handle_request, daemon=True)
        worker.start()
        try:
            with urlopen(f"http://127.0.0.1:{server.server_port}/health", timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(payload["status"], "healthy")
            self.assertEqual(payload["database"], "connected")
            self.assertTrue(payload["readOnly"])
            self.assertEqual(payload["bridge"], "running")
        finally:
            server.server_close()
            _bridge.BRIDGE_KEY = old_key
            _bridge.verify_database_connection = old_verify


class TestSqlReportCatalogue(unittest.TestCase):
    def test_lists_v43_approved_reports(self):
        report_ids = [item["id"] for item in _catalogue.list_reports()]
        self.assertEqual(report_ids, [
            "business.executive_snapshot",
            "inventory.product_lookup",
            "inventory.department_directory",
            "inventory.stock_by_department",
            "inventory.stock_health",
            "inventory.dormant_stock",
            "buying.sku_evidence",
            "system.database_capacity",
            "system.purchase_schema",
            "sales.top_products",
            "sales.product_monthly",
            "sales.invoice_lines",
            "sales.period_comparison",
            "sales.department_summary",
            "sales.daily_trend",
            "sales.returns_credits",
        ])

    def test_rejects_unknown_parameters(self):
        with self.assertRaises(_catalogue.ReportValidationError):
            _catalogue.validate_report_params("sales.product_monthly", {
                "sku": "8612200123",
                "extra": True,
            })

    def test_reports_endpoint_is_read_only(self):
        old_key = _bridge.BRIDGE_KEY
        _bridge.BRIDGE_KEY = ""
        server = HTTPServer(("127.0.0.1", 0), _bridge.Handler)
        worker = threading.Thread(target=server.handle_request, daemon=True)
        worker.start()
        try:
            with urlopen(f"http://127.0.0.1:{server.server_port}/reports", timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertTrue(payload["readOnly"])
            self.assertEqual(len(payload["reports"]), 16)
            self.assertEqual(payload["schemaVersion"], "proto.sql-report.v1")
            self.assertEqual(payload["engineVersion"], "4.3.0")
        finally:
            server.server_close()
            _bridge.BRIDGE_KEY = old_key


class TestLiveStmastSql(unittest.TestCase):
    @unittest.skipUnless(
        os.getenv("SQL_PASSWORD", "").strip(),
        "SQL_PASSWORD not set",
    )
    def test_live_stmast_row_encodes(self):
        import pyodbc

        server = os.getenv("SQL_SERVER", "BLADERUNNER-PC")
        database = os.getenv("SQL_DATABASE", "POSWINSQL")
        user = os.getenv("SQL_USER", "ProtoSyncReadOnly")
        password = os.getenv("SQL_PASSWORD", "")
        sku = os.getenv("TEST_STMAST_SKU", "8626100145")

        conn_str = (
            "DRIVER={ODBC Driver 17 for SQL Server};"
            f"SERVER={server};DATABASE={database};UID={user};PWD={password};"
            "ApplicationIntent=ReadOnly;Encrypt=no;"
        )
        with pyodbc.connect(conn_str, timeout=20) as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT TOP 1 CODE, DESCR, PRICE_A, ONHAND, BOOKED, DEPT
                FROM dbo.STMAST WHERE CODE = ?
                """,
                sku,
            )
            row = cur.fetchone()
            self.assertIsNotNone(row, f"SKU {sku} not in STMAST")
            cols = [c[0] for c in cur.description]

        legacy = {"row": legacy_row_dict(cols, row)}
        with self.assertRaises(TypeError):
            legacy_encode_json_payload(legacy)

        fixed = {"row": row_to_dict(cols, row)}
        self.assertEqual(find_decimals(fixed), [])
        body = encode_json_payload(fixed)
        parsed = json.loads(body.decode("utf-8"))
        self.assertEqual(parsed["row"]["CODE"], sku)


if __name__ == "__main__":
    unittest.main(verbosity=2)
