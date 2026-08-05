# Roadmap

## Phase 0 — Skeleton `v0.0.1` ✅
- [x] TypeScript + Express project, strict compiler settings
- [x] Validated configuration (Zod), nothing reads `process.env` directly
- [x] Structured logging with request correlation ids
- [x] Liveness vs readiness health checks
- [x] Graceful shutdown on SIGTERM/SIGINT
- [x] Docker Compose (api + redis), multi-stage image

**Acceptance:** `docker compose up` serves health checks; tests pass.

## Phase 1 — Uploads
- [ ] Multipart upload with size and type validation
- [ ] Storage abstraction (local disk now, S3-compatible later)
- [ ] Temporary file lifecycle

## Phase 2 — Queue and worker
- [ ] BullMQ job queue on Redis
- [ ] Separate worker process
- [ ] Retries, failure handling, concurrency limits

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
