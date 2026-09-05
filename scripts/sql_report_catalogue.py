"""Shared approved read-only POSWINSQL catalogue for standalone and Apollo."""

from __future__ import annotations

import os
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any

REPORTS: dict[str, dict[str, Any]] = {
    "business.executive_snapshot": {
        "name": "Executive snapshot",
        "description": "A compact sales and inventory pulse for the selected number of days.",
        "max_rows": 1,
        "params": {"days": {"type": "integer", "min": 1, "max": 365}},
    },
    "inventory.product_lookup": {
        "name": "Product stock lookup",
        "description": "Current stock, booked quantity, available stock, Price A and department for one SKU.",
        "max_rows": 1,
        "params": {"sku": {"required": True, "type": "string"}},
    },
    "inventory.department_directory": {
        "name": "Department directory",
        "description": "Valid STMAST department codes with product and stock counts.",
        "max_rows": 500,
        "params": {},
    },
    "inventory.stock_by_department": {
        "name": "Stock by department",
        "description": "Stock position for one exact STMAST department or all departments.",
        "max_rows": 500,
        "params": {
            "department": {"type": "string"},
            "stock_state": {"type": "enum", "values": ["all", "positive", "zero", "negative", "non_positive"]},
            "limit": {"type": "integer", "min": 1, "max": 500},
        },
    },
    "inventory.stock_health": {
        "name": "Stock health and cover",
        "description": "Available stock, recent sales velocity and estimated days of cover by SKU.",
        "max_rows": 500,
        "params": {
            "department": {"type": "string"},
            "days": {"type": "integer", "min": 7, "max": 365},
            "health_status": {"type": "enum", "values": ["all", "negative", "out_of_stock", "low_cover", "healthy", "overstock", "no_sales"]},
            "limit": {"type": "integer", "min": 1, "max": 500},
        },
    },
    "inventory.dormant_stock": {
        "name": "Dormant stock",
        "description": "Positive stock with no recorded sales during the selected lookback period.",
        "max_rows": 500,
        "params": {
            "department": {"type": "string"},
            "days": {"type": "integer", "min": 30, "max": 1095},
            "minimum_onhand": {"type": "number", "min": 0},
            "limit": {"type": "integer", "min": 1, "max": 500},
        },
    },
    "buying.sku_evidence": {
        "name": "Buying evidence batch",
        "description": "Current stock and 3/6/12-month unit sales for an approved bounded SKU list.",
        "max_rows": 300,
        "internal": True,
        "params": {
            "skus": {"required": True, "type": "sku_list", "max": 300},
            "as_of": {"type": "date"},
        },
    },
    "system.database_capacity": {
        "name": "Database capacity",
        "description": "POSWINSQL data/log file size, internal free space and growth settings.",
        "max_rows": 10,
        "internal": True,
        "params": {},
    },
    "system.purchase_schema": {
        "name": "Purchase/GRV schema diagnostic",
        "description": "Confirmed column metadata for POSWINSQL purchase and goods-received tables.",
        "max_rows": 300,
        "internal": True,
        "params": {},
    },
    "sales.top_products": {
        "name": "Top or worst-selling products",
        "description": "Units, sales value and invoice count by SKU for a selected period.",
        "max_rows": 100,
        "params": {
            "date_from": {"type": "date"},
            "date_to": {"type": "date"},
            "sort": {"type": "enum", "values": ["quantity", "revenue", "worst"]},
            "limit": {"type": "integer", "min": 1, "max": 100},
        },
    },
    "sales.product_monthly": {
        "name": "Monthly sales by product",
        "description": "Monthly units, sales value and invoice count for one SKU.",
        "max_rows": 60,
        "params": {
            "sku": {"required": True, "type": "string"},
            "date_from": {"type": "date"},
            "date_to": {"type": "date"},
        },
    },
    "sales.invoice_lines": {
        "name": "Invoice-line evidence",
        "description": "Read-only invoice lines for a selected period and optional SKU.",
        "max_rows": 500,
        "params": {
            "sku": {"type": "string"},
            "date_from": {"type": "date"},
            "date_to": {"type": "date"},
            "limit": {"type": "integer", "min": 1, "max": 500},
        },
    },
    "sales.period_comparison": {
        "name": "Sales period comparison",
        "description": "Compare a selected sales period with the immediately preceding period of equal length.",
        "max_rows": 2,
        "params": {"date_from": {"type": "date"}, "date_to": {"type": "date"}},
    },
    "sales.department_summary": {
        "name": "Sales by department",
        "description": "Units, sales value and invoice count grouped by STMAST department.",
        "max_rows": 100,
        "params": {
            "date_from": {"type": "date"}, "date_to": {"type": "date"},
            "sort": {"type": "enum", "values": ["quantity", "revenue"]},
            "limit": {"type": "integer", "min": 1, "max": 100},
        },
    },
    "sales.daily_trend": {
        "name": "Daily sales trend",
        "description": "Daily units, sales value and invoice count across the selected period.",
        "max_rows": 366,
        "params": {"date_from": {"type": "date"}, "date_to": {"type": "date"}},
    },
    "sales.returns_credits": {
        "name": "Returns and credit lines",
        "description": "Invoice lines with negative quantity or value for review.",
        "max_rows": 500,
        "params": {
            "date_from": {"type": "date"}, "date_to": {"type": "date"},
            "sku": {"type": "string"},
            "limit": {"type": "integer", "min": 1, "max": 500},
        },
    },
}

REPORT_SCHEMA_VERSION = "proto.sql-report.v1"
REPORT_ENGINE_VERSION = "4.3.0"

FORBIDDEN_SQL = ("INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "CREATE", "MERGE", "TRUNCATE", "EXEC", "GRANT", "REVOKE")


class ReportError(ValueError):
    pass


# Compatibility name used by the protected Apollo SQL bridge.  Keep one
# explicit error type for invalid report IDs and parameters; the bridge maps
# this to HTTP 400 and never exposes a SQL execution endpoint.
ReportValidationError = ReportError


def list_reports() -> list[dict[str, Any]]:
    """Return public metadata for the explicit v4.3 report allow-list."""
    return [
        {
            "id": report_id,
            "title": spec["name"],
            "description": spec["description"],
            "category": report_id.split(".", 1)[0],
            "maxRows": spec["max_rows"],
            "parameters": spec["params"],
            "internal": bool(spec.get("internal")),
        }
        for report_id, spec in REPORTS.items()
    ]


def assert_read_only(sql: str) -> None:
    upper = " ".join(str(sql).upper().split())
    if not upper.startswith("SELECT"):
        raise ReportError("Only SELECT reports are permitted")
    for token in FORBIDDEN_SQL:
        if token in upper:
            raise ReportError(f"Forbidden SQL token: {token}")


def _iso_date(value: Any, fallback: date) -> date:
    if value in (None, ""):
        return fallback
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise ReportError(f"Invalid date {value!r}; use YYYY-MM-DD") from exc


def _limit(value: Any, default: int, maximum: int) -> int:
    try:
        parsed = int(default if value in (None, "") else value)
    except (TypeError, ValueError) as exc:
        raise ReportError("Limit must be a whole number") from exc
    if parsed < 1:
        raise ReportError("Limit must be at least 1")
    return min(parsed, maximum)


def _sku(value: Any, required: bool = False) -> str:
    cleaned = str(value or "").strip().upper()
    if required and not cleaned:
        raise ReportError("SKU is required")
    if len(cleaned) > 64:
        raise ReportError("SKU is too long")
    return cleaned


def _sku_list(value: Any, maximum: int = 300) -> list[str]:
    if not isinstance(value, (list, tuple)):
        raise ReportError("SKUs must be supplied as a list")
    cleaned = list(dict.fromkeys(_sku(item, required=True) for item in value))
    if not cleaned:
        raise ReportError("At least one SKU is required")
    if len(cleaned) > maximum:
        raise ReportError(f"A maximum of {maximum} SKUs may be analysed at once")
    return cleaned


def validate_params(report_id: str, raw: Any = None) -> dict[str, Any]:
    if report_id not in REPORTS:
        raise ReportError(f"Unknown report: {report_id}")
    params = {} if raw is None else raw
    if not isinstance(params, dict):
        raise ReportError("Report parameters must be an object")
    schema = REPORTS[report_id]["params"]
    unknown = sorted(set(params) - set(schema))
    if unknown:
        raise ReportError(f"Unknown parameter(s): {', '.join(unknown)}")
    for name, rule in schema.items():
        value = params.get(name)
        if rule.get("required") and value in (None, ""):
            raise ReportError(f"Missing required parameter: {name}")
        if value not in (None, "") and rule.get("type") == "enum" and value not in rule["values"]:
            raise ReportError(f"Invalid {name}; choose: {', '.join(rule['values'])}")
    return dict(params)


# Compatibility entrypoint used by the bridge and its JSON contract tests.
validate_report_params = validate_params


def connection_string() -> str:
    password = os.getenv("SQL_PASSWORD", "").strip()
    if not password:
        raise ReportError("SQL_PASSWORD is not set. Start the app with start_proto_sql_reports.bat and enter it when prompted.")
    driver = os.getenv("SQL_ODBC_DRIVER", "").strip()
    if not driver:
        try:
            import pyodbc
            installed = set(pyodbc.drivers())
        except (ImportError, AttributeError):
            installed = set()
        driver = next(
            (candidate for candidate in ("ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server") if candidate in installed),
            "ODBC Driver 17 for SQL Server",
        )
    server = os.getenv("SQL_SERVER", "192.168.10.10")
    database = os.getenv("SQL_DATABASE", "POSWINSQL")
    user = os.getenv("SQL_USER", "ProtoSyncReadOnly")
    return (
        f"DRIVER={{{driver}}};SERVER={server};DATABASE={database};UID={user};PWD={password};"
        "ApplicationIntent=ReadOnly;Encrypt=no;TrustServerCertificate=yes;"
    )


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        number = float(value)
        return int(number) if number.is_integer() else number
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _fetch(cursor: Any, sql: str, values: tuple[Any, ...]) -> list[dict[str, Any]]:
    assert_read_only(sql)
    cursor.execute(sql, *values)
    columns = [str(column[0]) for column in cursor.description]
    return [{column: _json_value(value) for column, value in zip(columns, row)} for row in cursor.fetchall()]


def _date_bounds(params: dict[str, Any], default_days: int) -> tuple[date, date, date]:
    today = date.today()
    start = _iso_date(params.get("date_from"), today - timedelta(days=default_days))
    end = _iso_date(params.get("date_to"), today)
    if end < start:
        raise ReportError("Date To must be on or after Date From")
    if (end - start).days > 3660:
        raise ReportError("Date range cannot exceed 10 years")
    return start, end, end + timedelta(days=1)


def _days(value: Any, default: int, minimum: int, maximum: int) -> int:
    parsed = _limit(value, default, maximum)
    if parsed < minimum:
        raise ReportError(f"Days must be at least {minimum}")
    return parsed


def _department(value: Any) -> str:
    department = str(value or "").strip()
    if len(department) > 64:
        raise ReportError("Department is too long")
    return department


def _non_negative_number(value: Any, default: float = 0) -> float:
    try:
        parsed = float(default if value in (None, "") else value)
    except (TypeError, ValueError) as exc:
        raise ReportError("Minimum on-hand quantity must be a number") from exc
    if parsed < 0:
        raise ReportError("Minimum on-hand quantity cannot be negative")
    return parsed


def run_report(
    report_id: str,
    raw_params: Any = None,
    *,
    connect: Any = None,
    row_to_dict: Any = None,
) -> dict[str, Any]:
    params = validate_params(report_id, raw_params)
    started = datetime.now(timezone.utc)
    if connect is None:
        try:
            import pyodbc
        except ModuleNotFoundError as exc:
            raise ReportError("pyodbc is not installed. Run install_proto_sql_reports.ps1 first.") from exc
        connect = pyodbc.connect

    normalized: dict[str, Any]
    with connect(connection_string(), timeout=30) as connection:
        cursor = connection.cursor()
        if report_id == "business.executive_snapshot":
            days = _days(params.get("days"), 30, 1, 365)
            end = date.today()
            start = end - timedelta(days=days - 1)
            end_exclusive = end + timedelta(days=1)
            sql = """
                SELECT
                    CAST(? AS int) AS DAYS,
                    COALESCE((SELECT SUM(CAST(d.TOTAL AS float)) FROM dbo.DBINVDT d
                        INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                        WHERE h.DATE>=? AND h.DATE<?), 0) AS SALES_VALUE,
                    COALESCE((SELECT SUM(CAST(d.QTY AS float)) FROM dbo.DBINVDT d
                        INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                        WHERE h.DATE>=? AND h.DATE<?), 0) AS UNITS_SOLD,
                    (SELECT COUNT(*) FROM dbo.DBINVHD WHERE DATE>=? AND DATE<?) AS INVOICE_COUNT,
                    (SELECT COUNT(DISTINCT d.PRODUCT) FROM dbo.DBINVDT d
                        INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                        WHERE h.DATE>=? AND h.DATE<? AND d.PRODUCT IS NOT NULL) AS ACTIVE_SKUS,
                    (SELECT COUNT(*) FROM dbo.STMAST WHERE ONHAND<0) AS NEGATIVE_STOCK_LINES,
                    (SELECT COUNT(*) FROM dbo.STMAST WHERE ONHAND=0) AS ZERO_STOCK_LINES,
                    (SELECT COUNT(*) FROM dbo.STMAST WHERE ONHAND>0) AS POSITIVE_STOCK_LINES
            """
            values = (days, start, end_exclusive, start, end_exclusive, start, end_exclusive, start, end_exclusive)
            rows = _fetch(cursor, sql, values)
            normalized = {"days": days, "date_from": start.isoformat(), "date_to": end.isoformat()}
        elif report_id == "inventory.product_lookup":
            sku = _sku(params.get("sku"), required=True)
            sql = """
                SELECT TOP 1 CODE, DESCR, PRICE_A, ONHAND, BOOKED,
                    CAST(ONHAND AS float) - CAST(BOOKED AS float) AS AVAILABLE, DEPT
                FROM dbo.STMAST WHERE CODE = ?
            """
            rows = _fetch(cursor, sql, (sku,))
            normalized = {"sku": sku}
        elif report_id == "inventory.department_directory":
            sql = """
                SELECT COALESCE(NULLIF(LTRIM(RTRIM(DEPT)),''),'UNASSIGNED') AS DEPARTMENT,
                    COUNT(*) AS PRODUCT_COUNT,
                    SUM(CASE WHEN CAST(ONHAND AS float)>0 THEN 1 ELSE 0 END) AS POSITIVE_STOCK_SKUS,
                    SUM(CASE WHEN CAST(ONHAND AS float)=0 THEN 1 ELSE 0 END) AS ZERO_STOCK_SKUS,
                    SUM(CASE WHEN CAST(ONHAND AS float)<0 THEN 1 ELSE 0 END) AS NEGATIVE_STOCK_SKUS,
                    SUM(CAST(ONHAND AS float)) AS ONHAND_UNITS,
                    SUM(CAST(ONHAND AS float)-CAST(BOOKED AS float)) AS AVAILABLE_UNITS
                FROM dbo.STMAST
                GROUP BY COALESCE(NULLIF(LTRIM(RTRIM(DEPT)),''),'UNASSIGNED')
                ORDER BY DEPARTMENT
            """
            rows = _fetch(cursor, sql, ())
            normalized = {}
        elif report_id == "inventory.stock_by_department":
            department = _department(params.get("department"))
            state = str(params.get("stock_state") or "all")
            limit = _limit(params.get("limit"), 200, 500)
            clause = {
                "all": "",
                "positive": "AND ONHAND > 0",
                "zero": "AND ONHAND = 0",
                "negative": "AND ONHAND < 0",
                "non_positive": "AND ONHAND <= 0",
            }[state]
            sql = f"""
                SELECT TOP ({limit}) CODE, DESCR, PRICE_A, ONHAND, BOOKED,
                    CAST(ONHAND AS float) - CAST(BOOKED AS float) AS AVAILABLE, DEPT
                FROM dbo.STMAST
                WHERE (? = '' OR DEPT = ?) {clause}
                ORDER BY ONHAND ASC, CODE ASC
            """
            rows = _fetch(cursor, sql, (department, department))
            normalized = {"department": department or None, "stock_state": state, "limit": limit}
        elif report_id == "inventory.stock_health":
            department = _department(params.get("department"))
            days = _days(params.get("days"), 90, 7, 365)
            status = str(params.get("health_status") or "all")
            limit = _limit(params.get("limit"), 300, 500)
            end = date.today() + timedelta(days=1)
            start = end - timedelta(days=days)
            sql = f"""
                SELECT TOP ({limit}) * FROM (
                    SELECT s.CODE, s.DESCR, s.DEPT, CAST(s.PRICE_A AS float) AS PRICE_A,
                        CAST(s.ONHAND AS float) AS ONHAND, CAST(s.BOOKED AS float) AS BOOKED,
                        CAST(s.ONHAND AS float)-CAST(s.BOOKED AS float) AS AVAILABLE,
                        COALESCE(x.UNITS_SOLD,0) AS UNITS_SOLD,
                        COALESCE(x.SALES_VALUE,0) AS SALES_VALUE,
                        COALESCE(x.INVOICE_COUNT,0) AS INVOICE_COUNT,
                        CASE WHEN COALESCE(x.UNITS_SOLD,0)>0
                            THEN ROUND((CAST(s.ONHAND AS float)-CAST(s.BOOKED AS float)) / (x.UNITS_SOLD / CAST(? AS float)), 1)
                            ELSE NULL END AS DAYS_COVER,
                        CASE
                            WHEN CAST(s.ONHAND AS float)-CAST(s.BOOKED AS float)<0 THEN 'negative'
                            WHEN CAST(s.ONHAND AS float)-CAST(s.BOOKED AS float)=0 THEN 'out_of_stock'
                            WHEN COALESCE(x.UNITS_SOLD,0)<=0 THEN 'no_sales'
                            WHEN (CAST(s.ONHAND AS float)-CAST(s.BOOKED AS float))/(x.UNITS_SOLD/CAST(? AS float))<30 THEN 'low_cover'
                            WHEN (CAST(s.ONHAND AS float)-CAST(s.BOOKED AS float))/(x.UNITS_SOLD/CAST(? AS float))>180 THEN 'overstock'
                            ELSE 'healthy' END AS HEALTH_STATUS
                    FROM dbo.STMAST s
                    LEFT JOIN (
                        SELECT d.PRODUCT, SUM(CAST(d.QTY AS float)) AS UNITS_SOLD,
                            SUM(CAST(d.TOTAL AS float)) AS SALES_VALUE,
                            COUNT(DISTINCT h.INV_NO) AS INVOICE_COUNT
                        FROM dbo.DBINVDT d
                        INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                        WHERE h.DATE>=? AND h.DATE<?
                        GROUP BY d.PRODUCT
                    ) x ON x.PRODUCT=s.CODE
                    WHERE (?='' OR s.DEPT=?)
                ) r
                WHERE (?='all' OR HEALTH_STATUS=?)
                ORDER BY CASE HEALTH_STATUS WHEN 'negative' THEN 1 WHEN 'out_of_stock' THEN 2
                    WHEN 'low_cover' THEN 3 WHEN 'no_sales' THEN 4 WHEN 'overstock' THEN 5 ELSE 6 END,
                    DAYS_COVER ASC, CODE ASC
            """
            values = (days, days, days, start, end, department, department, status, status)
            rows = _fetch(cursor, sql, values)
            normalized = {"department": department or None, "days": days, "health_status": status, "limit": limit}
        elif report_id == "inventory.dormant_stock":
            department = _department(params.get("department"))
            days = _days(params.get("days"), 180, 30, 1095)
            minimum = _non_negative_number(params.get("minimum_onhand"), 1)
            limit = _limit(params.get("limit"), 300, 500)
            end = date.today() + timedelta(days=1)
            start = end - timedelta(days=days)
            sql = f"""
                SELECT TOP ({limit}) s.CODE, s.DESCR, s.DEPT,
                    CAST(s.PRICE_A AS float) AS PRICE_A,
                    CAST(s.ONHAND AS float) AS ONHAND,
                    CAST(s.BOOKED AS float) AS BOOKED,
                    CAST(s.ONHAND AS float)-CAST(s.BOOKED AS float) AS AVAILABLE,
                    CAST(s.ONHAND AS float)*CAST(s.PRICE_A AS float) AS PRICE_A_EXTENSION,
                    x.LAST_SALE_DATE
                FROM dbo.STMAST s
                LEFT JOIN (
                    SELECT d.PRODUCT, MAX(h.DATE) AS LAST_SALE_DATE
                    FROM dbo.DBINVDT d
                    INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                    WHERE CAST(d.QTY AS float)>0
                    GROUP BY d.PRODUCT
                ) x ON x.PRODUCT=s.CODE
                WHERE CAST(s.ONHAND AS float)>=? AND (x.LAST_SALE_DATE IS NULL OR x.LAST_SALE_DATE<?)
                    AND (?='' OR s.DEPT=?)
                ORDER BY PRICE_A_EXTENSION DESC, s.ONHAND DESC
            """
            rows = _fetch(cursor, sql, (minimum, start, department, department))
            normalized = {"department": department or None, "days": days, "minimum_onhand": minimum, "limit": limit}
        elif report_id == "buying.sku_evidence":
            skus = _sku_list(params.get("skus"), 300)
            as_of = _iso_date(params.get("as_of"), date.today())
            end_exclusive = as_of + timedelta(days=1)
            start_3m = as_of - timedelta(days=90)
            start_6m = as_of - timedelta(days=180)
            start_12m = as_of - timedelta(days=365)
            markers = ",".join("?" for _ in skus)
            sql = f"""
                SELECT TOP ({len(skus)}) s.CODE, s.DESCR, s.DEPT,
                    CAST(s.ONHAND AS float) AS ONHAND,
                    CAST(s.BOOKED AS float) AS BOOKED,
                    CAST(s.ONHAND AS float)-CAST(s.BOOKED AS float) AS AVAILABLE,
                    COALESCE(x.SALES_3M,0) AS SALES_3M,
                    COALESCE(x.SALES_6M,0) AS SALES_6M,
                    COALESCE(x.SALES_12M,0) AS SALES_12M,
                    x.LAST_SALE_DATE
                FROM dbo.STMAST s
                LEFT JOIN (
                    SELECT d.PRODUCT,
                        SUM(CASE WHEN h.DATE>=? THEN CAST(d.QTY AS float) ELSE 0 END) AS SALES_3M,
                        SUM(CASE WHEN h.DATE>=? THEN CAST(d.QTY AS float) ELSE 0 END) AS SALES_6M,
                        SUM(CAST(d.QTY AS float)) AS SALES_12M,
                        MAX(h.DATE) AS LAST_SALE_DATE
                    FROM dbo.DBINVDT d
                    INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                    WHERE h.DATE>=? AND h.DATE<? AND d.PRODUCT IN ({markers})
                    GROUP BY d.PRODUCT
                ) x ON x.PRODUCT=s.CODE
                WHERE s.CODE IN ({markers})
                ORDER BY s.CODE
            """
            values = (start_3m, start_6m, start_12m, end_exclusive, *skus, *skus)
            rows = _fetch(cursor, sql, values)
            normalized = {"skus": skus, "as_of": as_of.isoformat()}
        elif report_id == "system.database_capacity":
            sql = """
                SELECT DB_NAME() AS DATABASE_NAME,
                    CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS SQL_EDITION,
                    name AS LOGICAL_FILE_NAME, type_desc AS FILE_TYPE, physical_name AS FILE_PATH,
                    CAST(size*8.0/1024 AS float) AS SIZE_MB,
                    CAST(FILEPROPERTY(name,'SpaceUsed')*8.0/1024 AS float) AS USED_MB,
                    CAST((size-FILEPROPERTY(name,'SpaceUsed'))*8.0/1024 AS float) AS FREE_INSIDE_MB,
                    CAST(CASE WHEN is_percent_growth=1 THEN growth ELSE growth*8.0/1024 END AS float) AS GROWTH_VALUE,
                    CAST(is_percent_growth AS int) AS IS_PERCENT_GROWTH
                FROM sys.database_files
                ORDER BY type_desc, name
            """
            rows = _fetch(cursor, sql, ())
            normalized = {"expressDataLimitMB": 10240}
        elif report_id == "system.purchase_schema":
            sql = """
                SELECT TABLE_NAME,ORDINAL_POSITION,COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME IN ('STGRVHD','STGRVDT','CRPURCH')
                ORDER BY TABLE_NAME,ORDINAL_POSITION
            """
            rows = _fetch(cursor, sql, ())
            normalized = {"tables": ["STGRVHD", "STGRVDT", "CRPURCH"]}
        elif report_id == "sales.top_products":
            start, end, end_exclusive = _date_bounds(params, 30)
            sort = str(params.get("sort") or "quantity")
            limit = _limit(params.get("limit"), 50, 100)
            order = {
                "quantity": "SUM(CAST(d.QTY AS float)) DESC",
                "revenue": "SUM(CAST(d.TOTAL AS float)) DESC",
                "worst": "SUM(CAST(d.QTY AS float)) ASC",
            }[sort]
            sql = f"""
                SELECT TOP ({limit}) d.PRODUCT AS CODE, MAX(d.DESCR) AS DESCRIPTION,
                    SUM(CAST(d.QTY AS float)) AS UNITS,
                    SUM(CAST(d.TOTAL AS float)) AS SALES_VALUE,
                    COUNT(DISTINCT h.INV_NO) AS INVOICE_COUNT
                FROM dbo.DBINVDT d
                INNER JOIN dbo.DBINVHD h ON h.INV_NO = d.INV_NO AND h.TYPE = d.TYPE
                WHERE h.DATE >= ? AND h.DATE < ?
                  AND d.PRODUCT IS NOT NULL AND LTRIM(RTRIM(d.PRODUCT)) <> ''
                GROUP BY d.PRODUCT ORDER BY {order}
            """
            rows = _fetch(cursor, sql, (start, end_exclusive))
            normalized = {"date_from": start.isoformat(), "date_to": end.isoformat(), "sort": sort, "limit": limit}
        elif report_id == "sales.product_monthly":
            sku = _sku(params.get("sku"), required=True)
            start, end, end_exclusive = _date_bounds(params, 365)
            sql = """
                SELECT YEAR(h.DATE) AS SALES_YEAR, MONTH(h.DATE) AS SALES_MONTH,
                    SUM(CAST(d.QTY AS float)) AS UNITS,
                    SUM(CAST(d.TOTAL AS float)) AS SALES_VALUE,
                    COUNT(DISTINCT h.INV_NO) AS INVOICE_COUNT
                FROM dbo.DBINVDT d
                INNER JOIN dbo.DBINVHD h ON h.INV_NO = d.INV_NO AND h.TYPE = d.TYPE
                WHERE h.DATE >= ? AND h.DATE < ? AND d.PRODUCT = ?
                GROUP BY YEAR(h.DATE), MONTH(h.DATE)
                ORDER BY SALES_YEAR, SALES_MONTH
            """
            rows = _fetch(cursor, sql, (start, end_exclusive, sku))
            normalized = {"sku": sku, "date_from": start.isoformat(), "date_to": end.isoformat()}
        elif report_id == "sales.invoice_lines":
            sku = _sku(params.get("sku"), required=False)
            start, end, end_exclusive = _date_bounds(params, 30)
            limit = _limit(params.get("limit"), 200, 500)
            sql = f"""
                SELECT TOP ({limit}) h.DATE AS INVOICE_DATE, h.INV_NO AS INVOICE_NUMBER,
                    d.PRODUCT AS CODE, d.DESCR AS DESCRIPTION,
                    CAST(d.QTY AS float) AS QUANTITY, CAST(d.TOTAL AS float) AS LINE_VALUE
                FROM dbo.DBINVDT d
                INNER JOIN dbo.DBINVHD h ON h.INV_NO = d.INV_NO AND h.TYPE = d.TYPE
                WHERE h.DATE >= ? AND h.DATE < ? AND (? = '' OR d.PRODUCT = ?)
                ORDER BY h.DATE DESC, h.INV_NO DESC
            """
            rows = _fetch(cursor, sql, (start, end_exclusive, sku, sku))
            normalized = {"sku": sku or None, "date_from": start.isoformat(), "date_to": end.isoformat(), "limit": limit}
        elif report_id == "sales.period_comparison":
            start, end, end_exclusive = _date_bounds(params, 30)
            length = (end - start).days + 1
            previous_end = start - timedelta(days=1)
            previous_start = previous_end - timedelta(days=length - 1)
            previous_end_exclusive = start
            sql = """
                SELECT 'Current period' AS PERIOD_LABEL, ? AS DATE_FROM, ? AS DATE_TO,
                    COALESCE(SUM(CAST(d.QTY AS float)),0) AS UNITS,
                    COALESCE(SUM(CAST(d.TOTAL AS float)),0) AS SALES_VALUE,
                    COUNT(DISTINCT h.INV_NO) AS INVOICE_COUNT,
                    COUNT(DISTINCT d.PRODUCT) AS ACTIVE_SKUS
                FROM dbo.DBINVDT d INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                WHERE h.DATE>=? AND h.DATE<?
                UNION ALL
                SELECT 'Previous period', ?, ?,
                    COALESCE(SUM(CAST(d.QTY AS float)),0), COALESCE(SUM(CAST(d.TOTAL AS float)),0),
                    COUNT(DISTINCT h.INV_NO), COUNT(DISTINCT d.PRODUCT)
                FROM dbo.DBINVDT d INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                WHERE h.DATE>=? AND h.DATE<?
            """
            values = (start, end, start, end_exclusive, previous_start, previous_end, previous_start, previous_end_exclusive)
            rows = _fetch(cursor, sql, values)
            normalized = {"date_from": start.isoformat(), "date_to": end.isoformat(), "previous_from": previous_start.isoformat(), "previous_to": previous_end.isoformat()}
        elif report_id == "sales.department_summary":
            start, end, end_exclusive = _date_bounds(params, 30)
            sort = str(params.get("sort") or "revenue")
            limit = _limit(params.get("limit"), 50, 100)
            order = "SALES_VALUE DESC" if sort == "revenue" else "UNITS DESC"
            sql = f"""
                SELECT TOP ({limit}) COALESCE(NULLIF(s.DEPT,''),'UNASSIGNED') AS DEPARTMENT,
                    SUM(CAST(d.QTY AS float)) AS UNITS,
                    SUM(CAST(d.TOTAL AS float)) AS SALES_VALUE,
                    COUNT(DISTINCT h.INV_NO) AS INVOICE_COUNT,
                    COUNT(DISTINCT d.PRODUCT) AS ACTIVE_SKUS
                FROM dbo.DBINVDT d
                INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                LEFT JOIN dbo.STMAST s ON s.CODE=d.PRODUCT
                WHERE h.DATE>=? AND h.DATE<?
                GROUP BY COALESCE(NULLIF(s.DEPT,''),'UNASSIGNED')
                ORDER BY {order}
            """
            rows = _fetch(cursor, sql, (start, end_exclusive))
            normalized = {"date_from": start.isoformat(), "date_to": end.isoformat(), "sort": sort, "limit": limit}
        elif report_id == "sales.daily_trend":
            start, end, end_exclusive = _date_bounds(params, 30)
            if (end - start).days + 1 > 366:
                raise ReportError("Daily trend cannot exceed 366 days")
            sql = """
                SELECT CAST(h.DATE AS date) AS SALES_DATE,
                    SUM(CAST(d.QTY AS float)) AS UNITS,
                    SUM(CAST(d.TOTAL AS float)) AS SALES_VALUE,
                    COUNT(DISTINCT h.INV_NO) AS INVOICE_COUNT,
                    COUNT(DISTINCT d.PRODUCT) AS ACTIVE_SKUS
                FROM dbo.DBINVDT d INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                WHERE h.DATE>=? AND h.DATE<?
                GROUP BY CAST(h.DATE AS date) ORDER BY SALES_DATE
            """
            rows = _fetch(cursor, sql, (start, end_exclusive))
            normalized = {"date_from": start.isoformat(), "date_to": end.isoformat()}
        elif report_id == "sales.returns_credits":
            sku = _sku(params.get("sku"), required=False)
            start, end, end_exclusive = _date_bounds(params, 30)
            limit = _limit(params.get("limit"), 200, 500)
            sql = f"""
                SELECT TOP ({limit}) h.DATE AS INVOICE_DATE, h.INV_NO AS INVOICE_NUMBER,
                    d.PRODUCT AS CODE, d.DESCR AS DESCRIPTION,
                    CAST(d.QTY AS float) AS QUANTITY, CAST(d.TOTAL AS float) AS LINE_VALUE
                FROM dbo.DBINVDT d INNER JOIN dbo.DBINVHD h ON h.INV_NO=d.INV_NO AND h.TYPE=d.TYPE
                WHERE h.DATE>=? AND h.DATE<? AND (?='' OR d.PRODUCT=?)
                    AND (CAST(d.QTY AS float)<0 OR CAST(d.TOTAL AS float)<0)
                ORDER BY h.DATE DESC, h.INV_NO DESC
            """
            rows = _fetch(cursor, sql, (start, end_exclusive, sku, sku))
            normalized = {"sku": sku or None, "date_from": start.isoformat(), "date_to": end.isoformat(), "limit": limit}
        else:  # pragma: no cover - report ID is validated above
            raise ReportError(f"Report is not implemented: {report_id}")

    finished = datetime.now(timezone.utc)
    maximum = REPORTS[report_id]["max_rows"]
    return {
        "ok": True,
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "engineVersion": REPORT_ENGINE_VERSION,
        "report": {"id": report_id, **REPORTS[report_id]},
        "params": normalized,
        "rows": rows[:maximum],
        "rowCount": min(len(rows), maximum),
        "meta": {
            "source": "POSWINSQL",
            "readOnly": True,
            "generatedAt": finished.isoformat().replace("+00:00", "Z"),
            "durationMs": round((finished - started).total_seconds() * 1000),
            "rowCapReached": maximum > 1 and len(rows) >= maximum,
            "backendCompatible": True,
        },
    }
