from __future__ import annotations

import hashlib
import io
import json
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageStat

from .models import DETAIL_SENSITIVE_TREATMENTS, ProcessOptions

PIPELINE_VERSION = "proto-image-v2-treatment-safe"
SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP"}


@dataclass(frozen=True)
class ProcessResult:
    output_bytes: bytes
    extension: str
    content_type: str
    width: int
    height: int
    metrics: dict
    warnings: list[str]


def job_digest(source: bytes, options: ProcessOptions) -> str:
    payload = json.dumps(options.canonical(), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(PIPELINE_VERSION.encode() + b"\0" + payload + b"\0" + source).hexdigest()


def validate_image(source: bytes) -> tuple[Image.Image, dict, list[str]]:
    if not source:
        raise ValueError("Image is empty")
    try:
        with Image.open(io.BytesIO(source)) as probe:
            probe.verify()
        image = Image.open(io.BytesIO(source))
        image.load()
    except Exception as exc:
        raise ValueError("File is not a readable image") from exc
    if image.format not in SUPPORTED_FORMATS:
        raise ValueError(f"Unsupported image format: {image.format or 'unknown'}")
    image = ImageOps.exif_transpose(image).convert("RGBA")
    sample = image.convert("RGB")
    sample.thumbnail((512, 512), Image.Resampling.LANCZOS)
    luminance = sample.convert("L")
    luminance_stats = ImageStat.Stat(luminance)
    brightness = round(luminance_stats.mean[0] / 255, 4)
    contrast = round(luminance_stats.stddev[0] / 255, 4)
    metrics = {
        "source_width": image.width,
        "source_height": image.height,
        "source_megapixels": round(image.width * image.height / 1_000_000, 3),
        "source_brightness": brightness,
        "source_contrast": contrast,
    }
    warnings: list[str] = []
    if min(image.size) < 600:
        warnings.append("source_resolution_low")
    if brightness < 0.16:
        warnings.append("lighting_too_dark")
    elif brightness > 0.94:
        warnings.append("lighting_too_bright")
    if contrast < 0.06:
        warnings.append("contrast_low")
    if image.width * image.height > 40_000_000:
        raise ValueError("Image exceeds the 40 megapixel safety limit")
    return image, metrics, warnings


def _remove_background(image: Image.Image) -> Image.Image:
    try:
        from rembg import remove
    except ImportError as exc:
        raise RuntimeError("Background removal is enabled but rembg is not installed") from exc
    result = remove(image, alpha_matting=False, post_process_mask=True)
    return result.convert("RGBA")


def _cleanup(image: Image.Image) -> Image.Image:
    # Median filtering suppresses isolated sensor/JPEG noise while preserving product edges.
    rgb = image.convert("RGB").filter(ImageFilter.MedianFilter(size=3))
    alpha = image.getchannel("A")
    return Image.merge("RGBA", (*rgb.split(), alpha))


def _subject_box(image: Image.Image, background_removed: bool) -> tuple[int, int, int, int] | None:
    if background_removed or image.getchannel("A").getextrema()[0] < 255:
        return image.getchannel("A").getbbox()
    corners = [image.getpixel((0, 0))[:3], image.getpixel((image.width - 1, 0))[:3], image.getpixel((0, image.height - 1))[:3], image.getpixel((image.width - 1, image.height - 1))[:3]]
    bg = tuple(sorted(pixel[channel] for pixel in corners)[len(corners) // 2] for channel in range(3))
    reference = Image.new("RGB", image.size, bg)
    diff = ImageChops.difference(image.convert("RGB"), reference).convert("L").point(lambda p: 255 if p > 18 else 0)
    return diff.getbbox()


def _compose(image: Image.Image, options: ProcessOptions) -> Image.Image:
    preserve_full_frame = options.treatment in DETAIL_SENSITIVE_TREATMENTS or options.treatment in {"measurements", "custom"}
    box = _subject_box(image, options.remove_background) if options.crop and not preserve_full_frame else (0, 0, image.width, image.height)
    if not box:
        raise ValueError("No visible subject detected")
    subject = image.crop(box)
    available_w = max(1, round(options.width * (1 - 2 * options.padding_ratio)))
    available_h = max(1, round(options.height * (1 - 2 * options.padding_ratio)))
    subject.thumbnail((available_w, available_h), Image.Resampling.LANCZOS)
    fill = (255, 255, 255, 255) if options.background == "white" else (0, 0, 0, 0)
    canvas = Image.new("RGBA", (options.width, options.height), fill)
    position = ((options.width - subject.width) // 2, (options.height - subject.height) // 2)
    if options.treatment == "shadow":
        # A shadow is derived only from the retained foreground alpha. It never
        # synthesizes, redraws, or changes product pixels.
        alpha = subject.getchannel("A").filter(ImageFilter.GaussianBlur(radius=max(3, round(min(options.width, options.height) * 0.012))))
        alpha = alpha.point(lambda value: round(value * 0.18))
        shadow = Image.new("RGBA", subject.size, (0, 0, 0, 0))
        shadow.putalpha(alpha)
        shadow_position = (position[0], min(options.height - subject.height, position[1] + round(options.height * 0.012)))
        canvas.alpha_composite(shadow, shadow_position)
    canvas.alpha_composite(subject, position)
    return canvas


def _quality_metrics(image: Image.Image) -> tuple[dict, list[str]]:
    gray = image.convert("L")
    edges = gray.filter(ImageFilter.FIND_EDGES)
    sharpness = round(ImageStat.Stat(edges).var[0], 2)
    alpha = image.getchannel("A")
    visible = sum(count for value, count in enumerate(alpha.histogram()) if value > 8)
    coverage = round(visible / (image.width * image.height), 4)
    warnings: list[str] = []
    if sharpness < 80:
        warnings.append("possible_blur")
    if coverage < 0.03:
        warnings.append("subject_too_small")
    if coverage > 0.92:
        warnings.append("subject_may_be_cropped")
    return {"edge_variance": sharpness, "subject_coverage": coverage}, warnings


def _detached_subject_warnings(image: Image.Image) -> list[str]:
    """Flag separated foreground pieces; never guess that a product label is disposable."""
    alpha = image.getchannel("A")
    scale = min(1.0, 256 / max(alpha.size))
    if scale < 1:
        alpha = alpha.resize((max(1, round(alpha.width * scale)), max(1, round(alpha.height * scale))), Image.Resampling.NEAREST)
    mask = alpha.point(lambda value: 255 if value > 24 else 0)
    width, height = mask.size
    pixels = mask.load()
    seen: set[tuple[int, int]] = set()
    component_sizes: list[int] = []
    for y in range(height):
        for x in range(width):
            if not pixels[x, y] or (x, y) in seen:
                continue
            queue = deque([(x, y)])
            seen.add((x, y))
            size = 0
            while queue:
                cx, cy = queue.popleft()
                size += 1
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < width and 0 <= ny < height and pixels[nx, ny] and (nx, ny) not in seen:
                        seen.add((nx, ny))
                        queue.append((nx, ny))
            component_sizes.append(size)
    component_sizes.sort(reverse=True)
    if len(component_sizes) < 2 or component_sizes[0] == 0:
        return []
    # A meaningful detached foreground object may be packaging, an attached
    # product label, or an unwanted loose sticker/barcode. Human review decides.
    if component_sizes[1] >= max(12, round(component_sizes[0] * 0.015)):
        return ["possible_detached_label_or_barcode"]
    return []


def process_image(source: bytes, options: ProcessOptions) -> ProcessResult:
    options.validate()
    image, source_metrics, warnings = validate_image(source)
    if options.remove_background:
        image = _remove_background(image)
        warnings.extend(_detached_subject_warnings(image))
    if options.cleanup_noise and options.treatment not in DETAIL_SENSITIVE_TREATMENTS:
        image = _cleanup(image)
    elif options.cleanup_noise:
        warnings.append("noise_cleanup_skipped_to_preserve_fine_detail")
    if options.treatment in DETAIL_SENSITIVE_TREATMENTS:
        if options.crop:
            warnings.append("automatic_crop_skipped_to_preserve_all_product_parts")
        warnings.append("manual_labels_text_quantity_and_parts_review_required")
    if options.treatment == "transparent_clear":
        warnings.append("transparent_edges_and_print_must_be_visually_verified")
    elif options.treatment == "beads_fine_detail":
        warnings.append("bead_holes_chains_and_fine_edges_must_be_visually_verified")
    elif options.treatment == "multi_piece":
        warnings.append("piece_count_and_arrangement_must_be_visually_verified")
    elif options.treatment == "measurements":
        warnings.append("measurement_overlay_not_generated_without_verified_manual_input")
    elif options.treatment == "custom":
        warnings.append("custom_instructions_not_generatively_applied_by_safe_local_pipeline")
    image = _compose(image, options)
    quality_metrics, quality_warnings = _quality_metrics(image)
    output = io.BytesIO()
    if options.output_format == "jpeg":
        image.convert("RGB").save(output, format="JPEG", quality=options.quality, optimize=True, progressive=True, subsampling="4:4:4")
        extension, content_type = ".jpg", "image/jpeg"
    else:
        image.save(output, format="WEBP", quality=options.quality, method=6, exact=True)
        extension, content_type = ".webp", "image/webp"
    metrics = {**source_metrics, **quality_metrics, "output_bytes": output.tell(), "pipeline_version": PIPELINE_VERSION}
    return ProcessResult(output.getvalue(), extension, content_type, image.width, image.height, metrics, warnings + quality_warnings)
