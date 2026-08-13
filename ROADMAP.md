# Roadmap

## Phase 0 — Skeleton `v0.0.1` ✅
- [x] TypeScript + Express project, strict compiler settings
- [x] Validated configuration (Zod), nothing reads `process.env` directly
- [x] Structured logging with request correlation ids
- [x] Liveness vs readiness health checks
- [x] Graceful shutdown on SIGTERM/SIGINT
- [x] Docker Compose (api + redis), multi-stage image

**Acceptance:** `docker compose up` serves health checks; tests pass.

## Phase 1 — Uploads `v0.1.0` ✅
- [x] Multipart upload (multer), streamed to a temp file — never buffered
- [x] Size limit, MIME allow-list, filename sanitisation
- [x] Storage abstraction with a local-disk implementation
- [x] Generated storage keys: users never influence where bytes land
- [x] Upload metadata in Redis with a TTL

**Acceptance:** a file uploads and returns an id; oversized files get 413,
unsupported types 415, and a traversal-shaped key is refused outright.

## Phase 2 — Queue and worker `v0.2.0` ✅
- [x] BullMQ job queue on Redis
- [x] Separate worker process, capped concurrency
- [x] Retries with exponential backoff, permanent vs transient failures
- [x] `POST /jobs` (202 Accepted) and `GET /jobs/:id` with progress
- [x] Processor registry: adding an operation is one entry, not a switch
- [x] Tests skip quickly and visibly when Redis is unavailable

**Acceptance:** a queued job is picked up by the worker, reports progress,
and its result is readable from the status endpoint.

## Phase 3 — Image processing `v0.3.0` ✅
- [x] Resize, format conversion, thumbnails (sharp / libvips)
- [x] Stream-based: images are never held in memory in full
- [x] Content validation — a file that only claims to be an image fails here
- [x] Extension fallback when the declared MIME type is generic
- [x] Bounded output dimensions
- [x] Download endpoint for processed results

**Acceptance:** a 1200x800 PNG resizes to 400x267, converts to WebP, and
yields a 128px thumbnail; the output downloads and decodes as a real
image; a fake image is rejected at processing time.

## Phase 4 — CSV processing and streams `v0.4.0` ✅
- [x] Stream-based parsing: memory stays flat regardless of file size
- [x] `csv.validate` — row counts, inconsistent rows, empty-value report
- [x] `csv.transform` — column selection, trimming, empty-row removal
- [x] `saveFrom` so a failure in any pipeline stage rejects, never hangs
- [x] Permanent failures marked unrecoverable instead of retried
- [x] Errors extracted to their own module, breaking an import cycle

**Measured:** processing a 126 MB / 3M-row CSV peaks at ~13 MB of heap —
the same as a 8 MB file, because nothing is ever held in full.

## Phase 5 — Job status and progress `v0.5.0` ✅
- [x] Live progress via Server-Sent Events (`GET /jobs/:id/events`)
- [x] Redis pub/sub carrying events from the worker to the API
- [x] Immediate first event, so a late subscriber is not left waiting
- [x] Stream closes once the job settles; keep-alive and connection cap
- [x] Progress never goes backwards

**Acceptance:** connecting to a running job's stream shows progress
arriving live and the connection closing on completion.

## Phase 6 — Results and lifecycle `v0.6.0` ✅
- [x] HMAC-signed download links with an expiry, off by default
- [x] `POST /files/links` mints one; tampering or expiry is rejected
- [x] Constant-time signature comparison
- [x] Scheduled cleanup as a repeatable job, so several workers do not
      sweep the same directory at once
- [x] Retention and sweep interval configurable

**Acceptance:** with a secret set, an unsigned download is 403, a tampered
one 403, an expired one 410, a valid one 200; files past the retention
window are removed and recent ones are not.

## Phase 7 — Hardening `v0.7.0` ✅
- [x] Rate limiting per endpoint class, backed by Redis, failing open
- [x] Security headers via helmet, with the reasoning documented
- [x] `/status` (JSON) and `/metrics` (Prometheus), never rate limited
- [x] Counters in Redis, so API restarts do not lose the worker's numbers
- [x] Retry policy shared between worker and tests, so both exercise the
      same behaviour — invalid options and unreadable files now fail once
      instead of three times

**Acceptance:** 24 rapid uploads yield 429s after the limit; `/metrics`
still answers while a client is throttled; a permanently-failing job
settles on its first attempt.

## Phase 8-9 — React front end
- [ ] Drag-and-drop upload, live progress, result preview

## Phase 10 — Showcase `v1.0.0`
- [ ] README, architecture diagram, screenshots, release
