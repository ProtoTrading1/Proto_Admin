#!/usr/bin/env python3
"""
Folder-based product image intake for BLADERUNNER-PC.

Flow per file:
  NewImages/{CODE}.jpg → STMAST lookup → optional products insert → R2 upload
  → website_stock image_url_* → ProcessedImages (or FailedImages)

Set DRY_RUN=true to preview without uploads or DB writes.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

import pyodbc
from dotenv import load_dotenv
from PIL import Image
from supabase import Client, create_client

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

NEW_IMAGES_DIR = Path(os.getenv("IMAGE_INTAKE_FOLDER", str(BASE_DIR / "NewImages")))
PROCESSED_DIR = Path(os.getenv("IMAGE_INTAKE_PROCESSED_FOLDER", str(BASE_DIR / "ProcessedImages")))
FAILED_DIR = Path(os.getenv("IMAGE_INTAKE_FAILED_FOLDER", str(BASE_DIR / "FailedImages")))

REPORT_MD_PATH = BASE_DIR / "image_intake_run_report.md"
REPORT_JSON_PATH = BASE_DIR / "image_intake_run_report.json"
RUN_LOG_PATH = BASE_DIR / "image_intake_run.log"

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_TABLE = os.getenv("SUPABASE_TABLE", "products")
WEBSITE_STOCK_TABLE = os.getenv("WEBSITE_STOCK_TABLE", "website_stock")
SUPABASE_STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "product-images")
PAGE_SIZE = int(os.getenv("SUPABASE_PAGE_SIZE", "1000"))
DRY_RUN = os.getenv("DRY_RUN", "true").lower() == "true"
MAX_FILES = int(os.getenv("IMAGE_INTAKE_MAX_FILES", "3"))

SQL_SERVER = os.getenv("SQL_SERVER", "BLADERUNNER-PC")
SQL_DATABASE = os.getenv("SQL_DATABASE", "POSWINSQL")
SQL_USER = os.getenv("SQL_USER", "ProtoSyncReadOnly")
SQL_PASSWORD = os.getenv("SQL_PASSWORD", "")

IMAGE_COLUMNS = ["image_url_one", "image_url_two", "image_url_three", "image_url_four"]

SKU_COLUMN_CANDIDATES = ["sku", "product_sku", "product_code", "code"]
DESCRIPTION_COLUMN_CANDIDATES = ["description", "title", "name"]
PRICE_COLUMN_CANDIDATES = ["sell_price", "selling_price", "price", "website_price", "price_a"]
STOCK_COLUMN_CANDIDATES = ["stock_qty", "stock_quantity", "quantity", "qty", "onhand"]
AVAILABLE_STOCK_COLUMN_CANDIDATES = ["available_stock", "available_qty", "stock_available"]
CREATED_AT_COLUMN_CANDIDATES = ["created_at"]
UPDATED_AT_COLUMN_CANDIDATES = ["updated_at", "modified_at", "last_updated"]

FORBIDDEN_SQL_TOKENS = {
    "INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "CREATE", "MERGE",
    "TRUNCATE", "EXEC", "EXECUTE", "BACKUP",
}

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
FILENAME_WITH_IMAGE_NUMBER_PATTERN = re.compile(r"^(?P<sku>.+)-(?P<image_number>\d+)$")

RUN_LOG_LINES: list[str] = []


def log_line(section: str, message: str, *, item: dict | None = None) -> None:
    line = f"[{section}] {message}"
    RUN_LOG_LINES.append(line)
    print(line, flush=True)
    if item is not None:
        item.setdefault("log", []).append(line)


def clean_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_text(value) -> str | None:
    text = clean_text(value)
    return text or None


def to_decimal(value) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def decimal_to_float(value: Decimal | None):
    if value is None:
        return None
    return float(value.quantize(Decimal("0.01")))


def round_to_nearest_half(value: Decimal) -> Decimal:
    return (value * Decimal("2")).quantize(Decimal("1"), rounding=ROUND_HALF_UP) / Decimal("2")


def calculate_sell_price(sql_price_a) -> Decimal:
    vat_inclusive = to_decimal(sql_price_a) * Decimal("1.15")
    return round_to_nearest_half(vat_inclusive)


def calculate_available_stock(onhand, booked) -> Decimal:
    return to_decimal(onhand) - to_decimal(booked)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
        f"SERVER={SQL_SERVER};"
        f"DATABASE={SQL_DATABASE};"
        f"UID={SQL_USER};"
        f"PWD={SQL_PASSWORD};"
        "ApplicationIntent=ReadOnly;"
        "Encrypt=no;"
    )


def detect_column(available_columns: set[str], candidates: list[str]) -> str | None:
    lookup = {column.lower(): column for column in available_columns}
    for candidate in candidates:
        found = lookup.get(candidate.lower())
        if found:
            return found
    return None


def ensure_folders() -> None:
    NEW_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    FAILED_DIR.mkdir(parents=True, exist_ok=True)


def ensure_required_config() -> None:
    missing = []
    if not SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not SUPABASE_KEY:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    if not SQL_PASSWORD:
        missing.append("SQL_PASSWORD")
    if missing:
        raise RuntimeError("Missing required environment variables: " + ", ".join(missing))


def connect_sql():
    return pyodbc.connect(build_connection_string(), autocommit=False, timeout=20)


def get_supabase_client() -> Client:
    ensure_required_config()
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def fetch_supabase_rows(client: Client) -> list[dict]:
    rows = []
    start = 0
    while True:
        response = client.table(SUPABASE_TABLE).select("*").range(start, start + PAGE_SIZE - 1).execute()
        page = response.data or []
        if not page:
            break
        rows.extend(page)
        start += PAGE_SIZE
    return rows


def detect_supabase_columns(rows: list[dict]) -> dict:
    available_columns = set()
    for row in rows:
        available_columns.update(row.keys())

    detected = {
        "available_columns": sorted(available_columns),
        "sku": detect_column(available_columns, SKU_COLUMN_CANDIDATES),
        "description": detect_column(available_columns, DESCRIPTION_COLUMN_CANDIDATES),
        "price": detect_column(available_columns, PRICE_COLUMN_CANDIDATES),
        "stock": detect_column(available_columns, STOCK_COLUMN_CANDIDATES),
        "available_stock": detect_column(available_columns, AVAILABLE_STOCK_COLUMN_CANDIDATES),
        "created_at": detect_column(available_columns, CREATED_AT_COLUMN_CANDIDATES),
        "updated_at": detect_column(available_columns, UPDATED_AT_COLUMN_CANDIDATES),
    }

    missing = [name for name in ("sku", "description", "price", "stock", "available_stock") if not detected[name]]
    if missing:
        raise RuntimeError(
            "Could not confidently identify required Supabase product columns: "
            + ", ".join(missing)
            + f". Available columns: {detected['available_columns']}"
        )
    return detected


def build_supabase_context(client: Client | None = None) -> dict:
    client = client or get_supabase_client()
    rows = fetch_supabase_rows(client)
    detected = detect_supabase_columns(rows)
    sku_map = {}
    for row in rows:
        sku = normalize_text(row.get(detected["sku"]))
        if sku:
            sku_map[sku] = row
    return {
        "client": client,
        "rows": rows,
        "detected_columns": detected,
        "sku_map": sku_map,
    }


def parse_filename(filename: str) -> tuple[str, str]:
    name = Path(filename).name
    stem = Path(name).stem.strip()
    if not stem:
        raise RuntimeError(f"Could not extract SKU from filename `{name}`.")
    match = FILENAME_WITH_IMAGE_NUMBER_PATTERN.match(stem)
    if match:
        sku = match.group("sku").strip().upper()
        image_number = match.group("image_number").strip()
        if not sku or not image_number:
            raise RuntimeError(f"Could not parse SKU/image number from filename `{name}`.")
        return sku, image_number
    return stem.upper(), "1"


def image_column_for_slot(image_number: str) -> str:
    try:
        slot = max(1, min(4, int(image_number)))
    except (TypeError, ValueError):
        slot = 1
    return IMAGE_COLUMNS[slot - 1]


def get_product_from_sql(sku: str) -> dict | None:
    sql_connection = connect_sql()
    try:
        query = validate_read_only_sql(
            """
            SELECT TOP 1
                CODE,
                DESCR,
                PRICE_A,
                ONHAND,
                BOOKED,
                DEPT
            FROM dbo.STMAST
            WHERE CODE = ?
            """
        )
        cur = sql_connection.cursor()
        cur.execute(query, sku)
        row = cur.fetchone()
        if not row:
            return None
        columns = [column[0] for column in cur.description]
        return dict(zip(columns, row))
    finally:
        try:
            sql_connection.rollback()
        except Exception:
            pass
        sql_connection.close()


def build_storage_path(sku: str, image_number: str) -> str:
    return f"{sku}/{image_number}.jpg"


def validate_image_file(filepath: str | Path) -> Path:
    path = Path(filepath)
    if path.suffix.lower() not in IMAGE_EXTENSIONS:
        raise RuntimeError(f"Unsupported image type for `{path.name}`.")
    with Image.open(path) as image:
        image.verify()
    return path


def build_insert_payload(sql_row: dict, detected: dict) -> dict:
    onhand = to_decimal(sql_row.get("ONHAND"))
    available_stock = calculate_available_stock(sql_row.get("ONHAND"), sql_row.get("BOOKED"))
    payload = {
        detected["sku"]: clean_text(sql_row.get("CODE")),
        detected["description"]: clean_text(sql_row.get("DESCR")),
        detected["price"]: decimal_to_float(calculate_sell_price(sql_row.get("PRICE_A"))),
        detected["stock"]: decimal_to_float(onhand),
        detected["available_stock"]: decimal_to_float(available_stock),
    }
    if detected["created_at"]:
        payload[detected["created_at"]] = utc_now()
    if detected["updated_at"]:
        payload[detected["updated_at"]] = utc_now()
    return payload


def create_product_in_supabase(product_data: dict, client: Client | None = None) -> dict:
    client = client or get_supabase_client()
    response = client.table(SUPABASE_TABLE).insert(product_data).execute()
    return (response.data or [{}])[0]


def preview_r2_paths(storage_path: str) -> dict:
    try:
        from r2_storage import is_r2_configured, r2_display_path, r2_public_url
    except ImportError:
        return {
            "backend": "r2",
            "configured": False,
            "display_path": storage_path,
            "public_url": None,
        }

    if not is_r2_configured():
        return {
            "backend": "r2",
            "configured": False,
            "display_path": storage_path,
            "public_url": None,
        }

    return {
        "backend": "r2",
        "configured": True,
        "display_path": r2_display_path(storage_path),
        "public_url": r2_public_url(storage_path),
    }


def upload_product_image(sku: str, image_number: str, filepath: str | Path, client: Client | None = None) -> dict:
    image_path = validate_image_file(filepath)
    storage_path = build_storage_path(sku, image_number)
    content_type = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
    body = image_path.read_bytes()

    try:
        from r2_storage import is_r2_configured, upload_to_r2
    except ImportError:
        def is_r2_configured():  # type: ignore[misc]
            return False

        upload_to_r2 = None  # type: ignore[assignment]

    if is_r2_configured():
        result = upload_to_r2(storage_path, body, content_type)
        return {
            "bucket": result["bucket"],
            "storage_path": storage_path,
            "display_path": result["display_path"],
            "public_url": result["public_url"],
            "content_type": content_type,
            "backend": "r2",
        }

    client = client or get_supabase_client()
    client.storage.from_(SUPABASE_STORAGE_BUCKET).upload(
        storage_path,
        body,
        {"content-type": content_type, "upsert": "true"},
    )
    public_url = client.storage.from_(SUPABASE_STORAGE_BUCKET).get_public_url(storage_path)
    return {
        "bucket": SUPABASE_STORAGE_BUCKET,
        "storage_path": storage_path,
        "display_path": f"{SUPABASE_STORAGE_BUCKET}/{storage_path}",
        "public_url": public_url,
        "content_type": content_type,
        "backend": "supabase",
    }


def get_website_stock_rows(client: Client, barcode: str) -> list[dict]:
    cols = "sku, barcode, " + ", ".join(IMAGE_COLUMNS)
    response = (
        client.table(WEBSITE_STOCK_TABLE)
        .select(cols)
        .eq("barcode", barcode)
        .execute()
    )
    return response.data or []


def apply_image_to_website_stock(
    client: Client,
    *,
    barcode: str,
    image_column: str,
    image_url: str,
    dry_run: bool,
    item: dict,
) -> dict:
    rows = get_website_stock_rows(client, barcode)
    if not rows:
        log_line("WEBSITE", "UPDATE STATUS: skipped — no website_stock rows for barcode", item=item)
        log_line("WEBSITE", f"barcode={barcode} column={image_column}", item=item)
        return {
            "ok": False,
            "rows_updated": 0,
            "previous_values": [],
            "new_value": image_url,
            "dry_run": dry_run,
        }

    previous_values = [row.get(image_column) for row in rows]
    log_line("WEBSITE", f"matched {len(rows)} website_stock row(s) where barcode={barcode}", item=item)
    log_line("WEBSITE", f"column={image_column}", item=item)
    log_line("WEBSITE", f"previous image value(s): {previous_values}", item=item)
    log_line("WEBSITE", f"new image value: {image_url}", item=item)

    if dry_run:
        log_line("WEBSITE", "UPDATE STATUS: dry run — would update website_stock", item=item)
        return {
            "ok": True,
            "rows_updated": len(rows),
            "previous_values": previous_values,
            "new_value": image_url,
            "dry_run": True,
        }

    patch = {image_column: image_url, "updated_at": utc_now()}
    client.table(WEBSITE_STOCK_TABLE).update(patch).eq("barcode", barcode).execute()
    log_line("WEBSITE", f"UPDATE STATUS: success ({len(rows)} row(s) updated)", item=item)
    return {
        "ok": True,
        "rows_updated": len(rows),
        "previous_values": previous_values,
        "new_value": image_url,
        "dry_run": False,
    }


def move_file(path: Path, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / path.name
    if target.exists():
        target = target_dir / f"{int(time.time())}-{path.name}"
    shutil.move(str(path), str(target))


def list_image_files() -> list[Path]:
    files = sorted(
        [
            path for path in NEW_IMAGES_DIR.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS and not path.name.startswith(".")
        ],
        key=lambda item: item.name.lower(),
    )
    return files[:MAX_FILES] if MAX_FILES > 0 else files


def build_item_result(filename: str) -> dict:
    return {
        "filename": filename,
        "sku": "",
        "image_number": "",
        "description": "",
        "sql_found": "N",
        "existing_product": "N",
        "create_product": "N",
        "upload_image": "N",
        "storage_path": "",
        "storage_backend": "",
        "public_url": "",
        "website_column": "",
        "website_rows_updated": 0,
        "website_previous_values": [],
        "result": "failed",
        "final_status": "FAILED",
        "warnings": [],
        "errors": [],
        "log": [],
    }


def write_reports(report: dict) -> None:
    REPORT_JSON_PATH.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    RUN_LOG_PATH.write_text("\n".join(RUN_LOG_LINES) + "\n", encoding="utf-8")

    lines = [
        "# Image Intake Run Report",
        "",
        f"- status: `{report['status']}`",
        f"- dry_run: `{str(report['dry_run']).lower()}`",
        f"- source_sql_server: `{report['source_sql_server']}`",
        f"- source_sql_database: `{report['source_sql_database']}`",
        f"- intake_folder: `{report['intake_folder']}`",
        f"- storage_backend: `{report.get('storage_backend', '')}`",
        f"- files_found: `{report['files_found']}`",
        f"- files_processed: `{report['files_processed']}`",
        f"- files_failed: `{report['files_failed']}`",
        f"- existing_products_found: `{report['existing_products_found']}`",
        f"- products_created: `{report['products_created']}`",
        f"- images_uploaded: `{report['images_uploaded']}`",
        f"- website_rows_updated: `{report.get('website_rows_updated', 0)}`",
        "",
        "## Detected Supabase Product Columns",
    ]

    for key, value in report["detected_supabase_columns"].items():
        if key == "available_columns":
            continue
        lines.append(f"- {key}: `{value or ''}`")

    lines.extend(["", "## Items", ""])
    if report["items"]:
        lines.append(
            "| Filename | SKU | SQL | Description | R2 path | Website | Result | Final |"
        )
        lines.append("|---|---|---|---|---|---|---|---|")
        for item in report["items"]:
            lines.append(
                f"| {item['filename']} | {item['sku']} | {item['sql_found']} | "
                f"{item.get('description', '')} | {item.get('display_path') or item.get('storage_path', '')} | "
                f"{item.get('website_rows_updated', 0)} row(s) | {item['result']} | {item.get('final_status', '')} |"
            )
        lines.extend(["", "## Per-file logs", ""])
        for item in report["items"]:
            lines.append(f"### {item['filename']}")
            for entry in item.get("log", []):
                lines.append(f"- `{entry}`")
            lines.append("")
    else:
        lines.append("- No image files found in the intake folder.")

    if report["errors"]:
        lines.extend(["", "## Run Errors"])
        for error in report["errors"]:
            lines.append(f"- {error}")

    REPORT_MD_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def process_image_file(image_path: Path, supabase_context: dict) -> dict:
    item = build_item_result(image_path.name)
    client = supabase_context["client"]
    detected = supabase_context["detected_columns"]
    sku_map = supabase_context["sku_map"]

    log_line("FILE", f"Processing {image_path.name}", item=item)

    validate_image_file(image_path)
    sku, image_number = parse_filename(image_path.name)
    image_column = image_column_for_slot(image_number)
    storage_path = build_storage_path(sku, image_number)

    item["sku"] = sku
    item["image_number"] = image_number
    item["storage_path"] = storage_path
    item["website_column"] = image_column

    sql_row = get_product_from_sql(sku)
    if not sql_row:
        item["result"] = "failed_sql_not_found"
        item["final_status"] = "FAILED"
        reason = f"SKU `{sku}` was not found in POSWINSQL.dbo.STMAST."
        item["errors"].append(reason)
        log_line("FOUND", "NOT FOUND in STMAST", item=item)
        log_line("FINAL", f"FAILED — {reason}", item=item)
        return item

    description = clean_text(sql_row.get("DESCR"))
    item["description"] = description
    item["sql_found"] = "Y"
    log_line("FOUND", f"CODE: {sku}", item=item)
    log_line("FOUND", f"DESCRIPTION: {description}", item=item)
    log_line("FOUND", f"PRICE_A: {sql_row.get('PRICE_A')}", item=item)
    log_line("FOUND", f"ONHAND: {sql_row.get('ONHAND')}", item=item)

    existing = sku in sku_map
    item["existing_product"] = "Y" if existing else "N"
    item["upload_image"] = "Y"
    if not existing:
        item["create_product"] = "Y"

    if DRY_RUN:
        preview = preview_r2_paths(storage_path)
        item["storage_backend"] = preview.get("backend", "r2")
        item["display_path"] = preview.get("display_path", storage_path)
        item["public_url"] = preview.get("public_url")
        log_line(
            "R2",
            f"UPLOAD PATH (dry run): {item['display_path']}",
            item=item,
        )
        if item["public_url"]:
            log_line("R2", f"PUBLIC URL (dry run): {item['public_url']}", item=item)
        elif not preview.get("configured"):
            log_line("R2", "R2 env not configured — would fall back to Supabase storage", item=item)

        website_result = apply_image_to_website_stock(
            client,
            barcode=sku,
            image_column=image_column,
            image_url=item["public_url"] or f"(supabase://{SUPABASE_STORAGE_BUCKET}/{storage_path})",
            dry_run=True,
            item=item,
        )
        item["website_rows_updated"] = website_result.get("rows_updated", 0)
        item["website_previous_values"] = website_result.get("previous_values", [])

        item["result"] = "dry_run_would_process"
        item["final_status"] = "SUCCESS (dry run)"
        log_line("FINAL", item["final_status"], item=item)
        return item

    if not existing:
        payload = build_insert_payload(sql_row, detected)
        created_row = create_product_in_supabase(payload, client=client)
        sku_map[sku] = created_row or payload
        log_line("PRODUCTS", f"Created products row for {sku}", item=item)

    upload_result = upload_product_image(sku, image_number, image_path, client=client)
    item["storage_backend"] = upload_result.get("backend", "")
    item["display_path"] = upload_result.get("display_path", storage_path)
    item["public_url"] = upload_result.get("public_url", "")
    log_line("R2", f"UPLOAD PATH: {item['display_path']}", item=item)
    log_line("R2", f"PUBLIC URL: {item['public_url']}", item=item)

    website_result = apply_image_to_website_stock(
        client,
        barcode=sku,
        image_column=image_column,
        image_url=item["public_url"],
        dry_run=False,
        item=item,
    )
    item["website_rows_updated"] = website_result.get("rows_updated", 0)
    item["website_previous_values"] = website_result.get("previous_values", [])

    move_file(image_path, PROCESSED_DIR)
    item["result"] = "processed"
    item["final_status"] = "SUCCESS"
    log_line("FINAL", "SUCCESS — moved to ProcessedImages", item=item)
    return item


def main() -> None:
    global RUN_LOG_LINES
    RUN_LOG_LINES = []
    started = time.perf_counter()
    ensure_required_config()
    ensure_folders()

    log_line("RUN", f"Started at {utc_now()}")
    log_line("RUN", f"DRY_RUN={DRY_RUN} MAX_FILES={MAX_FILES or 'all'}")
    log_line("RUN", f"Intake folder: {NEW_IMAGES_DIR}")

    try:
        from r2_storage import is_r2_configured
        log_line("RUN", f"R2 configured: {is_r2_configured()}")
    except ImportError:
        log_line("RUN", "R2 module missing — Supabase storage fallback only")

    report = {
        "generated_at": utc_now(),
        "dry_run": DRY_RUN,
        "status": "running",
        "source_sql_server": SQL_SERVER,
        "source_sql_database": SQL_DATABASE,
        "intake_folder": str(NEW_IMAGES_DIR),
        "storage_backend": "r2" if os.getenv("R2_ACCOUNT_ID") else SUPABASE_STORAGE_BUCKET,
        "files_found": 0,
        "files_processed": 0,
        "files_failed": 0,
        "existing_products_found": 0,
        "products_created": 0,
        "images_uploaded": 0,
        "website_rows_updated": 0,
        "detected_supabase_columns": {},
        "items": [],
        "errors": [],
    }

    try:
        image_files = list_image_files()
        report["files_found"] = len(image_files)
        log_line("RUN", f"Files found: {len(image_files)}")

        supabase_context = build_supabase_context()
        report["detected_supabase_columns"] = supabase_context["detected_columns"]

        for image_path in image_files:
            try:
                item = process_image_file(image_path, supabase_context)
                if item["existing_product"] == "Y":
                    report["existing_products_found"] += 1
                if item["create_product"] == "Y" and not DRY_RUN:
                    report["products_created"] += 1
                if item["upload_image"] == "Y" and not DRY_RUN and item["result"] == "processed":
                    report["images_uploaded"] += 1
                report["website_rows_updated"] += int(item.get("website_rows_updated") or 0)

                if item["result"] in ("failed_sql_not_found", "failed"):
                    report["files_failed"] += 1
                    if not DRY_RUN and image_path.exists():
                        move_file(image_path, FAILED_DIR)
                        log_line("FILE", f"Moved to FailedImages: {image_path.name}")
                else:
                    report["files_processed"] += 1
            except Exception as exc:
                item = build_item_result(image_path.name)
                item["errors"].append(str(exc))
                item["result"] = "failed"
                item["final_status"] = "FAILED"
                log_line("FINAL", f"FAILED — {exc}", item=item)
                report["files_failed"] += 1
                if not DRY_RUN and image_path.exists():
                    move_file(image_path, FAILED_DIR)
            report["items"].append(item)

        report["status"] = "success" if report["files_failed"] == 0 else "partial_failure"
    except Exception as exc:
        report["status"] = "failed"
        report["errors"].append(str(exc))
        log_line("RUN", f"Fatal error: {exc}")
    finally:
        report["ended_at"] = utc_now()
        report["execution_time_seconds"] = round(time.perf_counter() - started, 3)
        log_line(
            "RUN",
            f"Complete — processed={report['files_processed']} failed={report['files_failed']} "
            f"website_rows_updated={report.get('website_rows_updated', 0)}",
        )
        write_reports(report)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
