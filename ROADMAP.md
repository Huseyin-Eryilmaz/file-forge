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

## Phase 3 — Image processing
- [ ] Resize, format conversion, thumbnails (sharp)

## Phase 4 — CSV processing and streams
- [ ] Stream-based parsing: large files without loading them into memory
- [ ] Validation and transformation

## Phase 5 — Job status and progress
- [ ] Status endpoint
- [ ] Live progress via Server-Sent Events

## Phase 6 — Results and lifecycle
- [ ] Download endpoint, expiring links
- [ ] Scheduled cleanup of old files

## Phase 7 — Hardening
- [ ] Rate limiting, security headers, filename sanitisation
- [ ] Observability

## Phase 8-9 — React front end
- [ ] Drag-and-drop upload, live progress, result preview

## Phase 10 — Showcase `v1.0.0`
- [ ] README, architecture diagram, screenshots, release
