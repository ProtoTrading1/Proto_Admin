from __future__ import annotations

import hmac
import json
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

from . import __version__
from .config import Settings
from .models import ProcessOptions
from .pipeline import PIPELINE_VERSION
from .service import ProcessorService, public_job

settings = Settings()
settings.validate()
service = ProcessorService(settings)
app = FastAPI(title="Proto Image Processor", version=__version__, docs_url=None, redoc_url=None)


def authenticate(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {settings.api_key}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def parse_options(raw: str) -> ProcessOptions:
    try:
        values = json.loads(raw or "{}")
        allowed = set(ProcessOptions.__dataclass_fields__)
        unknown = set(values) - allowed
        if unknown:
            raise ValueError(f"Unknown options: {', '.join(sorted(unknown))}")
        options = ProcessOptions(**values)
        options.validate()
        return options
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/health")
def health() -> dict:
    return {"status": "healthy", "service_version": __version__, "pipeline_version": PIPELINE_VERSION}


@app.post("/v1/jobs", dependencies=[Depends(authenticate)], status_code=202)
async def create_job(file: UploadFile = File(...), relative_path: str = Form(""), options: str = Form("{}"), callback_url: str | None = Form(None)) -> dict:
    source = await file.read(settings.max_upload_bytes + 1)
    try:
        job, created = service.submit(source, file.filename or "upload.jpg", relative_path, parse_options(options), callback_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"created": created, "job": public_job(job)}


@app.post("/v1/jobs/batch", dependencies=[Depends(authenticate)], status_code=202)
async def create_batch(files: list[UploadFile] = File(...), relative_paths: str = Form("[]"), options: str = Form("{}"), callback_url: str | None = Form(None)) -> dict:
    try:
        paths = json.loads(relative_paths)
        if not isinstance(paths, list) or (paths and len(paths) != len(files)):
            raise ValueError("relative_paths must be an empty array or match files length")
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    parsed_options = parse_options(options)
    jobs = []
    for index, file in enumerate(files):
        source = await file.read(settings.max_upload_bytes + 1)
        try:
            job, created = service.submit(source, file.filename or "upload.jpg", paths[index] if paths else (file.filename or "upload.jpg"), parsed_options, callback_url)
            jobs.append({"created": created, "job": public_job(job)})
        except ValueError as exc:
            jobs.append({"created": False, "error": str(exc), "filename": file.filename})
    return {"count": len(jobs), "jobs": jobs}


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(authenticate)])
def get_job(job_id: str) -> dict:
    job = service.store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return public_job(job)


@app.get("/v1/jobs/{job_id}/output", dependencies=[Depends(authenticate)])
def get_output(job_id: str):
    job = service.store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "completed" or not job.get("output_path"):
        raise HTTPException(status_code=409, detail=f"Job is {job['status']}")
    extension = Path(job["output_path"]).suffix
    download_name = f"{Path(job['original_filename']).stem}-processed{extension}"
    return FileResponse(job["output_path"], media_type=job["output_content_type"], filename=download_name)
