from __future__ import annotations

import argparse
import time
from pathlib import Path

from .config import Settings
from .models import ProcessOptions
from .service import ProcessorService


def main() -> None:
    parser = argparse.ArgumentParser(description="Submit a local folder to the Proto image processor")
    parser.add_argument("folder", type=Path)
    parser.add_argument("--transparent", action="store_true")
    parser.add_argument("--jpeg", action="store_true")
    args = parser.parse_args()
    folder = args.folder.resolve()
    if not folder.is_dir():
        parser.error("folder must be an existing directory")
    settings = Settings()
    service = ProcessorService(settings)
    options = ProcessOptions(background="transparent" if args.transparent else "white", output_format="jpeg" if args.jpeg else "webp")
    submitted = []
    for path in sorted(item for item in folder.rglob("*") if item.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}):
        job, _ = service.submit(path.read_bytes(), path.name, path.relative_to(folder).as_posix(), options)
        submitted.append(job["id"])
    while any((service.store.get(job_id) or {}).get("status") in {"queued", "processing"} for job_id in submitted):
        time.sleep(0.2)
    completed = sum((service.store.get(job_id) or {}).get("status") == "completed" for job_id in submitted)
    print(f"Completed {completed}/{len(submitted)} images. Outputs: {service.store.outputs}")


if __name__ == "__main__":
    main()
