# Proto Image Processor

A self-hosted worker for product-image background removal and cleanup. It uses `rembg`/ONNX and Pillow locally, so normal processing has no per-image API cost. It never updates products, Nutstore, or source objects. Originals are copied into immutable content-addressed storage; results are separate staged files for admin review.

## What it does

- validates JPEG, PNG, and WebP input (30 MB and 40 MP defaults/safety limits);
- optionally removes the background with `rembg`;
- suppresses isolated image/JPEG noise with a deterministic median filter;
- crops the visible subject and centres it with configurable padding;
- emits white-background WebP/JPEG or transparent WebP;
- reports source resolution, output size, edge-variance blur signal, subject coverage, and warnings;
- supports one file, browser folder uploads (batch + relative paths), and recursive local folders;
- offers authenticated polling and allowlisted, HMAC-signed callbacks;
- supports a configurable pull adapter for the Proto Admin queue.

The job ID is SHA-256 over the pipeline version, canonical options, and source bytes. The same source/options produce the same job and output. Original bytes are retained at `data/originals`; outputs are written separately at `data/outputs`. Atomic file replacement prevents partial results.

## Run locally

```bash
cd processor
python -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
export PROCESSOR_API_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
uvicorn processor.main:app --host 127.0.0.1 --port 8767
```

The first background-removal job downloads the open-source U2Net model into `U2NET_HOME`; retain that directory/volume to avoid repeated downloads. For a small office workload, begin with two processing threads and one container. CPU processing keeps running costs predictable; a GPU is optional, not required.

Docker:

```bash
cp .env.example .env
# Replace all example secrets and hosts; do not commit .env.
docker compose up --build -d image-processor
curl http://127.0.0.1:8767/health
```

## Upload/poll API

All `/v1/*` calls require `Authorization: Bearer <PROCESSOR_API_KEY>`. `/health` intentionally does not.

Single upload:

```bash
curl -X POST http://127.0.0.1:8767/v1/jobs \
  -H "Authorization: Bearer $PROCESSOR_API_KEY" \
  -F 'file=@8619000833-1.jpg' \
  -F 'relative_path=nutstore-export/batch-42/8619000833-1.jpg' \
  -F 'options={"background":"white","output_format":"webp","quality":88}'
```

Folder upload uses `POST /v1/jobs/batch`, repeated `files` fields, and a JSON `relative_paths` array in the same order. A browser may pass `webkitRelativePath`; paths are treated as labels only and cannot escape the worker data directory.

Poll `GET /v1/jobs/{processor_job_id}`. Once `status` is `completed`, download from `GET /v1/jobs/{processor_job_id}/output`. The response never exposes worker filesystem paths or callback secrets.

To process an already-mounted copy of a folder:

```bash
PROCESSOR_DATA_DIR=./data python -m processor.cli /safe/read-only-export-folder
```

The CLI reads source files and writes only under `PROCESSOR_DATA_DIR`. Mount a Nutstore export read-only if it is used as input; the source tree is never renamed, deleted, or overwritten.

### Processing options

```json
{
  "remove_background": true,
  "background": "white",
  "cleanup_noise": true,
  "crop": true,
  "padding_ratio": 0.08,
  "width": 1600,
  "height": 1600,
  "output_format": "webp",
  "quality": 88
}
```

JPEG cannot be transparent. Dimensions are 320–4096, quality 60–100, and padding 0–0.4.

## Admin pull transport contract

Set `PROCESSOR_TRANSPORT=admin-http` to run `python -m processor.pull_worker`. The only built-in adapter is `HttpAdminAdapter`; another adapter can implement the five-method `TransportAdapter` protocol in `processor/transport.py`. This keeps queue/storage providers out of the image pipeline.

Required configuration:

- `PROCESSOR_ADMIN_API_URL`: HTTPS admin origin;
- `PROCESSOR_ADMIN_API_TOKEN`: worker-only secret sent as `X-Image-Processor-Secret` (claim/status scope only);
- `PROCESSOR_TRANSPORT_ALLOWED_HOSTS`: comma-separated exact hosts allowed for admin, source, and result URLs;
- `PROCESSOR_WORKER_ID`: stable worker identity.

No production value is included in this repository.

### 1. Claim

Worker request:

```http
POST /api/image-processing-worker
X-Image-Processor-Secret: <worker-token>
Content-Type: application/json

{"action":"claim","workerId":"bladerunner-image-worker","capabilities":{"formats":["jpeg","png","webp"],"outputs":["jpeg"],"pipeline":"proto-image-v2-treatment-safe"}}
```

No work: HTTP `204`.

Claimed work:

```json
{
  "claimId": "opaque-claim-id",
  "jobId": "admin-manifest-id",
  "imageId": "admin-image-id",
    "source": {
      "url": "https://staging.example.invalid/signed-read-url",
      "filename": "8619000833-1.jpg"
    },
    "processing": {
      "remove_background": true,
      "background": "white",
      "cleanup_noise": true,
      "output_format": "jpeg"
    },
    "output": {
      "path": "staging/image-processing/outputs/admin-manifest-id/admin-image-id.jpg",
      "signedUploadUrl": "https://staging.example.invalid/signed-result-url",
      "headers": {"x-upsert": "true", "cache-control": "max-age=0"}
    }
}
```

The admin must lease a claim for longer than the expected processing duration. Reclaiming after lease expiry is safe because processing is content-addressed.

### 2. Fetch and process

The worker performs an HTTPS `GET` against `source.url`, enforces size and optional SHA-256, and copies those bytes to its originals store. It never sends a write/delete request to `source.url`, a Nutstore path, or the original object.

### 3. Upload staged result

The worker sends the result to `output.signedUploadUrl` with the supplied method/headers plus:

```http
Content-Type: image/jpeg
Content-Length: <bytes>
X-Content-SHA256: <result-sha256>
Idempotency-Key: image-result:<admin-job-id>:<result-sha256>
```

The destination must treat the idempotency key or deterministic job object key as an upsert of the same bytes. This is still staging: publishing to a product requires a separate admin approval/action.

### 4. Complete

```http
POST /api/image-processing-worker
X-Image-Processor-Secret: <worker-token>
Content-Type: application/json

{
  "action": "callback",
  "jobId": "admin-manifest-id",
  "imageId": "admin-image-id",
  "claimId": "opaque-claim-id",
  "outputPath": "staging/image-processing/outputs/admin-manifest-id/admin-image-id.jpg",
  "workerId": "bladerunner-image-worker",
  "model": "rembg-local",
  "costUsd": 0,
  "quality": {
    "source_width": 2000,
    "source_height": 2000,
    "source_megapixels": 4.0,
    "edge_variance": 312.4,
    "subject_coverage": 0.61,
    "output_bytes": 123456,
    "pipeline_version": "proto-image-v2-treatment-safe"
  },
  "warnings": []
}
```

The admin endpoint should compare-and-set only the claimed job and accept repeat completion with the same `processor_job_id`/result SHA as success.

### 5. Failure and retry

```http
POST /api/image-processing-worker
X-Image-Processor-Secret: <worker-token>
Content-Type: application/json

{"action":"fail","jobId":"admin-manifest-id","imageId":"admin-image-id","claimId":"opaque-claim-id","workerId":"bladerunner-image-worker","error":"bounded text","retryable":true}
```

Invalid images/options/hash mismatches are terminal (`retryable:false`). Network, timeout, and 5xx failures are retryable. The admin owns retry count/backoff/dead-letter policy. On retry, the worker reuses a completed local content-derived job, uploads identical bytes with the same idempotency key, and repeats completion safely.

## Security and operational notes

- Expose the service through a private tunnel/VPN or reverse proxy; do not publish port 8767 directly.
- Use a dedicated worker token with no customer, product-publish, migration, or Nutstore-write permissions.
- Source, upload, callback, and admin hosts are exact allowlists to limit SSRF.
- Presigned URL headers are held in memory and are not written to job JSON or logs.
- Back up `processor-data` if retaining originals/results matters. Configure lifecycle cleanup only after an agreed retention period.
- A completed quality check is advisory; admin review remains the publication gate.

## Tests

```bash
cd processor
pytest -q
```
