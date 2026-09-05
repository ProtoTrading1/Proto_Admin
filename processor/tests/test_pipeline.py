from __future__ import annotations

import io
import sys
import types

from PIL import Image

from processor.models import ProcessOptions
from processor.pipeline import job_digest, process_image


def source_image() -> bytes:
    image = Image.new("RGB", (900, 700), "white")
    for x in range(220, 680):
        for y in range(120, 600):
            image.putpixel((x, y), (80, 20, 130))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_processing_is_deterministic_and_sized() -> None:
    source = source_image()
    options = ProcessOptions(remove_background=False, width=800, height=800, output_format="webp")
    first = process_image(source, options)
    second = process_image(source, options)
    assert first.output_bytes == second.output_bytes
    assert first.width == first.height == 800
    assert first.content_type == "image/webp"
    assert first.metrics["subject_coverage"] > 0.1
    assert job_digest(source, options) == job_digest(source, options)


def test_jpeg_rejects_transparency() -> None:
    options = ProcessOptions(remove_background=False, background="transparent", output_format="jpeg")
    try:
        process_image(source_image(), options)
    except ValueError as exc:
        assert "JPEG" in str(exc)
    else:
        raise AssertionError("transparent JPEG should fail validation")


def test_background_removal_adapter_is_used(monkeypatch) -> None:
    calls = []

    def fake_remove(image, **kwargs):
        calls.append(kwargs)
        return image.convert("RGBA")

    monkeypatch.setitem(sys.modules, "rembg", types.SimpleNamespace(remove=fake_remove))
    result = process_image(source_image(), ProcessOptions(remove_background=True, width=600, height=600))
    assert result.width == 600
    assert calls == [{"alpha_matting": False, "post_process_mask": True}]


def test_detail_sensitive_treatments_require_explicit_manual_safe_cutout() -> None:
    for treatment in ("transparent_clear", "beads_fine_detail", "multi_piece"):
        try:
            process_image(source_image(), ProcessOptions(treatment=treatment, remove_background=True))
        except ValueError as exc:
            assert "manual_safe_cutout" in str(exc)
        else:
            raise AssertionError(f"destructive removal accepted for {treatment}")


def test_detail_sensitive_source_lane_skips_crop_and_noise_cleanup() -> None:
    result = process_image(source_image(), ProcessOptions(
        treatment="beads_fine_detail",
        remove_background=False,
        cleanup_noise=True,
        crop=True,
        width=800,
        height=800,
    ))
    assert "noise_cleanup_skipped_to_preserve_fine_detail" in result.warnings
    assert "automatic_crop_skipped_to_preserve_all_product_parts" in result.warnings
    assert "manual_labels_text_quantity_and_parts_review_required" in result.warnings


def test_measurement_and_custom_lanes_never_generate_unverified_content() -> None:
    measurement = process_image(source_image(), ProcessOptions(
        treatment="measurements", remove_background=False, width=800, height=800,
    ))
    custom = process_image(source_image(), ProcessOptions(
        treatment="custom", remove_background=False, width=800, height=800,
        instructions="Make it look better but preserve all product content",
    ))
    assert "measurement_overlay_not_generated_without_verified_manual_input" in measurement.warnings
    assert "custom_instructions_not_generatively_applied_by_safe_local_pipeline" in custom.warnings


def test_targeted_reconstruction_is_rejected_outside_validated_provider_lane() -> None:
    try:
        process_image(source_image(), ProcessOptions(treatment="targeted_reconstruction", remove_background=False))
    except ValueError as exc:
        assert "validated provider mask lane" in str(exc)
    else:
        raise AssertionError("local pipeline must not guess targeted reconstruction")


def test_detached_foreground_is_flagged_for_label_barcode_review(monkeypatch) -> None:
    def fake_remove(image, **kwargs):
        result = Image.new("RGBA", image.size, (0, 0, 0, 0))
        product = Image.new("RGBA", (420, 420), (80, 20, 130, 255))
        label = Image.new("RGBA", (100, 70), (245, 245, 245, 255))
        result.alpha_composite(product, (200, 120))
        result.alpha_composite(label, (700, 560))
        return result

    monkeypatch.setitem(sys.modules, "rembg", types.SimpleNamespace(remove=fake_remove))
    result = process_image(source_image(), ProcessOptions(remove_background=True, width=800, height=800))
    assert "possible_detached_label_or_barcode" in result.warnings


def test_low_light_source_is_reported_for_website_readiness() -> None:
    image = Image.new("RGB", (900, 900), (12, 12, 12))
    for x in range(250, 650):
        for y in range(180, 720):
            image.putpixel((x, y), (45, 35, 50))
    output = io.BytesIO()
    image.save(output, format="JPEG")
    result = process_image(output.getvalue(), ProcessOptions(remove_background=False, width=800, height=800))
    assert "lighting_too_dark" in result.warnings
    assert result.metrics["source_brightness"] < 0.16
