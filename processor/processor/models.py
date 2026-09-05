from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal


ImageTreatment = Literal[
    "standard_opaque",
    "transparent_clear",
    "beads_fine_detail",
    "multi_piece",
    "shadow",
    "measurements",
    "custom",
    "targeted_reconstruction",
]

DETAIL_SENSITIVE_TREATMENTS = {"transparent_clear", "beads_fine_detail", "multi_piece"}


@dataclass(frozen=True)
class ProcessOptions:
    treatment: ImageTreatment = "standard_opaque"
    remove_background: bool = True
    manual_safe_cutout: bool = False
    background: Literal["white", "transparent"] = "white"
    cleanup_noise: bool = True
    crop: bool = True
    padding_ratio: float = 0.08
    width: int = 1600
    height: int = 1600
    output_format: Literal["webp", "jpeg"] = "webp"
    quality: int = 88
    instructions: str = ""

    def validate(self) -> None:
        allowed_treatments = {
            "standard_opaque", "transparent_clear", "beads_fine_detail", "multi_piece",
            "shadow", "measurements", "custom", "targeted_reconstruction",
        }
        if self.treatment not in allowed_treatments:
            raise ValueError("unsupported image treatment")
        if self.treatment in DETAIL_SENSITIVE_TREATMENTS and self.remove_background and not self.manual_safe_cutout:
            raise ValueError(f"{self.treatment} requires explicit manual_safe_cutout before background removal")
        if self.treatment in {"measurements", "custom"} and self.remove_background:
            raise ValueError(f"{self.treatment} must use the source-preserving lane")
        if self.treatment == "targeted_reconstruction":
            raise ValueError("targeted reconstruction must use the validated provider mask lane")
        if self.background not in {"white", "transparent"}:
            raise ValueError("background must be white or transparent")
        if self.output_format not in {"webp", "jpeg"}:
            raise ValueError("output_format must be webp or jpeg")
        if self.output_format == "jpeg" and self.background == "transparent":
            raise ValueError("JPEG does not support a transparent background")
        if not 0 <= self.padding_ratio <= 0.4:
            raise ValueError("padding_ratio must be between 0 and 0.4")
        if not 320 <= self.width <= 4096 or not 320 <= self.height <= 4096:
            raise ValueError("width and height must be between 320 and 4096")
        if not 60 <= self.quality <= 100:
            raise ValueError("quality must be between 60 and 100")
        if len(self.instructions) > 1000:
            raise ValueError("instructions must be 1000 characters or fewer")

    def canonical(self) -> dict:
        return asdict(self)
