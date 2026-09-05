# Image Intake Integration Guide

This guide is for integrating the office-machine image intake worker into the website backend.

## Purpose

The intake worker runs on the office machine because that machine can access:

- live SQL Server `BLADERUNNER-PC / MSSQLSERVER / POSWINSQL`
- Supabase cloud
- local image intake folders

The website backend should call the reusable service layer, not connect directly to SQL Server from the internet.

## Filename Format Rules

Supported:

- `TBAG91.jpg`
- `8619000833-1.jpg`
- `8619000833-2.jpg`
- `ABC123.webp`
- `ABC123-3.png`

Unsupported:

- filenames without a usable stem
- non-image files
- extensions outside `.jpg`, `.jpeg`, `.png`, `.webp`

## SKU Extraction Rules

Function:

- `parse_filename(filename)`

Rules:

1. If the filename is `SKU.jpg`, then:
   - `sku = SKU`
   - `image_number = 1`
2. If the filename is `SKU-N.jpg`, then:
   - `sku = SKU`
   - `image_number = N`
3. Parsing is based on the filename stem only.

Examples:

- `TBAG91.jpg` -> `TBAG91`, `1`
- `8619000833-1.jpg` -> `8619000833`, `1`
- `8619000833-2.jpg` -> `8619000833`, `2`

## SQL Lookup Process

Function:

- `get_product_from_sql(sku)`

Behavior:

1. Open a read-only SQL connection.
2. Query `dbo.STMAST` by `CODE = sku`.
3. Return:
   - `CODE`
   - `DESCR`
   - `PRICE_A`
   - `ONHAND`
   - `BOOKED`
   - `DEPT`
4. If not found, stop processing and report failure.

## Product Creation Process

Functions:

- `build_insert_payload(sql_row, detected_columns)`
- `create_product_in_supabase(product_data)`

Creation fields:

- `sku = CODE`
- `description = DESCR`
- `sell_price = PRICE_A * 1.15`, rounded to nearest `0.50`
- `stock_qty = ONHAND`
- `available_stock = ONHAND - BOOKED`

Optional timestamps:

- `created_at`
- `updated_at`

## Image Upload Process

Function:

- `upload_product_image(sku, image_number, filepath)`

Storage destination:

- bucket: `product-images`
- path: `{SKU}/{image_number}.jpg`

Examples:

- `TBAG91`, `1` -> `product-images/TBAG91/1.jpg`
- `8619000833`, `2` -> `product-images/8619000833/2.jpg`

## Service Layer

File:

- `image_intake_service.py`

Available functions:

### `preview_image_upload(filepath)`

Returns:

- `sku`
- `image_number`
- `description`
- `price`
- `stock`
- `available_stock`
- `department`
- `action`
- `storage_path`
- `dry_run`

Possible actions:

- `upload_to_existing_product`
- `create_product_then_upload`

### `create_product_from_image(filepath)`

Returns:

- `product_id`
- `image_path`
- `status`
- `sku`
- `image_number`

Possible statuses:

- `existing_product_image_uploaded`
- `product_created_and_image_uploaded`
- `dry_run_create_product_then_upload`

## Expected API Inputs

Recommended backend inputs:

- absolute or resolved local file path
- optional explicit dry-run flag
- optional override for intake folders if backend manages file moves

Minimal input example:

```json
{
  "filepath": "C:\\script 2\\NewImages\\8619000833-1.jpg"
}
```

## Expected API Outputs

Preview example:

```json
{
  "sku": "8619000833",
  "image_number": "1",
  "description": "SCARF IMITATION CASHMERE +-70*190CM",
  "price": 149.5,
  "stock": 24.0,
  "available_stock": 20.0,
  "department": "SCARVES",
  "action": "create_product_then_upload",
  "storage_path": "8619000833/1.jpg",
  "dry_run": true
}
```

Create example:

```json
{
  "product_id": "8619000833",
  "image_path": "8619000833/1.jpg",
  "status": "product_created_and_image_uploaded",
  "sku": "8619000833",
  "image_number": "1"
}
```

## Integration Notes For Claude

Recommended backend flow:

1. Backend receives a file path or newly uploaded image reference.
2. Call `preview_image_upload(filepath)` for validation and preview.
3. On approval or live background execution, call `create_product_from_image(filepath)`.
4. Use the returned status to update logs or job history.

Keep these boundaries:

- do not modify stock sync
- do not expose SQL to the public internet
- do not build product creation logic separately from the shared service unless needed

## Optional Image Processor Boundary

The self-hosted cleanup/background-removal worker is documented in `processor/README.md`. It is deliberately upstream of this product-creation service:

1. Admin stages an original or a read-only copy from a selected folder.
2. The processor claims the queue item and reads the signed staging URL.
3. It preserves original bytes, produces a separate deterministic staged result, and reports quality metrics.
4. Proto Admin shows the original and processed result side by side. Staff may approve, reject, or reprocess it.
5. Approval alone never publishes. Publishing to an existing SKU/image slot is a separate owner action, and a published change can restore the previous URL.

The processor is conservative around labels. Detached foreground objects can be loose stickers or barcode labels, but they can also be packaging or part of the product. Ambiguous cases are flagged `manual_label_barcode_review_required`; the worker does not decide that an attached or printed label should be removed.

For the Image Processing Centre, do not call `create_product_from_image` automatically. That legacy helper remains a separate intake path. The centre writes no product image field until the owner has reviewed and explicitly published an approved staged result.
4. Admin review chooses whether the staged result may proceed to the existing image-intake/product flow.

The processor must never write back to Nutstore, publish products, update stock, or call `create_product_from_image` itself.
