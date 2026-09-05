#!/usr/bin/env python3
"""
Reproduce /stmast Decimal JSON failure locally (no BLADERUNNER).

Usage (from repo root):
  python scripts/test-stmast-decimal-repro.py
  python scripts/test-stmast-decimal-repro.py 8626100145

Requires SQL_PASSWORD in .env.local (same LAN SQL as bridge).
"""

from __future__ import annotations

import json
import os
import sys
from decimal import Decimal
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pyodbc

SCRIPT_DIR = Path(__file__).resolve().parent
_bridge_spec = spec_from_file_location("sql_stmast_bridge", SCRIPT_DIR / "sql-stmast-bridge.py")
if _bridge_spec is None or _bridge_spec.loader is None:
    raise RuntimeError("Unable to load sql-stmast-bridge.py")
_bridge = module_from_spec(_bridge_spec)
_bridge_spec.loader.exec_module(_bridge)
encode_json_payload = _bridge.encode_json_payload
row_to_dict = _bridge.row_to_dict
sanitize_for_json = _bridge.sanitize_for_json

STMAST_SELECT = """
    SELECT TOP 1 CODE, DESCR, PRICE_A, ONHAND, BOOKED, DEPT
    FROM dbo.STMAST
    WHERE CODE = ?
"""


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


def load_env_file(path: Path) -> None:
    for line in path.read_text(encoding="utf-8").splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        if "=" not in trimmed:
            continue
        key, val = trimmed.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and os.getenv(key) is None:
            os.environ[key] = val


def load_env() -> None:
    for name in (".env.local", ".env"):
        path = SCRIPT_DIR.parent / name
        if path.exists():
            load_env_file(path)
            print(f"Loaded env: {path}")
            return
    print("Warning: no .env.local or .env found", file=sys.stderr)


def connection_string() -> str:
    server = os.getenv("SQL_SERVER", "BLADERUNNER-PC")
    database = os.getenv("SQL_DATABASE", "POSWINSQL")
    user = os.getenv("SQL_USER", "ProtoSyncReadOnly")
    password = os.getenv("SQL_PASSWORD", "")
    if not password:
        raise SystemExit("SQL_PASSWORD required in .env.local for local SQL repro")
    return (
        "DRIVER={ODBC Driver 17 for SQL Server};"
        f"SERVER={server};"
        f"DATABASE={database};"
        f"UID={user};"
        f"PWD={password};"
        "ApplicationIntent=ReadOnly;"
        "Encrypt=no;"
    )


def fetch_pyodbc_row(sku: str):
    with pyodbc.connect(connection_string(), timeout=20) as conn:
        cur = conn.cursor()
        cur.execute(STMAST_SELECT, sku)
        row = cur.fetchone()
        if not row:
            return None, None
        cols = [c[0] for c in cur.description]
        return cols, row


def print_columns(cols, row) -> None:
    print("\n=== pyodbc row (raw SQL values) ===")
    for col, value in zip(cols, row):
        print(f"  {col!r}: repr={value!r}  type={type(value)!r}")


def main() -> int:
    sku = (sys.argv[1] if len(sys.argv) > 1 else "8626100145").strip().upper()
    load_env()

    print(f"=== /stmast Decimal repro — SKU {sku} ===")
    print(f"SQL_SERVER={os.getenv('SQL_SERVER', 'BLADERUNNER-PC')}")
    print(f"SQL_DATABASE={os.getenv('SQL_DATABASE', 'POSWINSQL')}")

    cols, row = fetch_pyodbc_row(sku)
    if not row:
        print(f"No STMAST row for {sku}")
        return 1

    print_columns(cols, row)

    legacy_row = legacy_row_dict(cols, row)
    fixed_row = row_to_dict(cols, row)
    legacy_payload = {"row": legacy_row}
    fixed_payload = {"row": fixed_row}

    print("\n=== Decimals in legacy dict(zip) payload ===")
    legacy_decimals = find_decimals(legacy_payload)
    if legacy_decimals:
        for item in legacy_decimals:
            print(f"  {item}")
    else:
        print("  (none)")

    print("\n=== Decimals after row_to_dict() ===")
    fixed_decimals = find_decimals(fixed_payload)
    if fixed_decimals:
        for item in fixed_decimals:
            print(f"  {item}")
    else:
        print("  (none)")

    print("\n=== Decimals after sanitize_for_json() ===")
    sanitized = sanitize_for_json(fixed_payload)
    sanitized_decimals = find_decimals(sanitized)
    if sanitized_decimals:
        for item in sanitized_decimals:
            print(f"  {item}")
    else:
        print("  (none)")

    print("\n=== legacy json.dumps (pre-fix bridge) ===")
    try:
        legacy_encode_json_payload(legacy_payload)
        print("  UNEXPECTED: legacy encode succeeded")
    except TypeError as exc:
        print(f"  FAIL as expected: {exc}")
        still = find_decimals(legacy_payload)
        if still:
            print(f"  Exact Decimal object(s): {still[0]}")

    print("\n=== encode_json_payload (fixed bridge _json path) ===")
    try:
        body = encode_json_payload(fixed_payload)
        parsed = json.loads(body.decode("utf-8"))
        print(f"  OK — {len(body)} bytes")
        print(f"  row keys: {list(parsed.get('row', {}).keys())}")
        row_out = parsed.get("row") or {}
        for key in ("CODE", "PRICE_A", "ONHAND", "BOOKED"):
            if key in row_out:
                val = row_out[key]
                print(f"  JSON {key}: {val!r} (type={type(val).__name__})")
        return 0
    except TypeError as exc:
        print(f"  FAIL: {exc}")
        still = find_decimals(sanitize_for_json(fixed_payload))
        for item in still:
            print(f"  Remaining Decimal: {item}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
