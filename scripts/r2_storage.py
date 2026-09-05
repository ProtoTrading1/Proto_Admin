"""Cloudflare R2 uploads (S3-compatible). Used by product_image_intake.py when env is set."""

from __future__ import annotations

import os


def is_r2_configured() -> bool:
    return bool(
        os.getenv("R2_ACCOUNT_ID")
        and os.getenv("R2_ACCESS_KEY_ID")
        and os.getenv("R2_SECRET_ACCESS_KEY")
        and os.getenv("R2_BUCKET_NAME")
    )


def r2_public_url(object_key: str) -> str:
    base = (os.getenv("R2_PUBLIC_BASE_URL") or "").strip().rstrip("/")
    key = str(object_key or "").lstrip("/")
    if not base:
        raise RuntimeError("R2_PUBLIC_BASE_URL is required when using R2")
    return f"{base}/{key}"


def r2_display_path(object_key: str) -> str:
    bucket = os.getenv("R2_BUCKET_NAME", "proto-images")
    return f"{bucket}/{object_key.lstrip('/')}"


def upload_to_r2(object_key: str, body: bytes, content_type: str = "image/jpeg") -> dict:
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError("boto3 is required for R2 uploads: pip install boto3") from exc

    bucket = os.getenv("R2_BUCKET_NAME", "")
    account_id = os.getenv("R2_ACCOUNT_ID", "")
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
    )
    client.put_object(
        Bucket=bucket,
        Key=object_key,
        Body=body,
        ContentType=content_type or "image/jpeg",
        CacheControl="public, max-age=31536000, immutable",
    )
    return {
        "bucket": bucket,
        "object_key": object_key,
        "public_url": r2_public_url(object_key),
        "display_path": r2_display_path(object_key),
    }
