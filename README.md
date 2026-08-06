# file-forge

A file processing service: upload a file, it gets processed in the
background, and you collect the result when it is done. Images are
resized and converted; CSVs are validated and transformed by streaming
them rather than loading them into memory.

Built with Node.js, Express and TypeScript, with Redis-backed job queues
and a React front end.

> 🚧 **Status: Phase 1 (uploads).** Files can be uploaded, validated and
> stored; background processing arrives in Phase 2. See the
> [roadmap](ROADMAP.md).

## Why this design

A file upload that is processed inside the HTTP request holds the
connection open for as long as the work takes — seconds for a large
image, longer for a big CSV — and ties up a server thread while the
caller's browser spins. So the API does the least it can: accept the
file, hand back a job id, and put the work on a queue. A separate worker
process picks it up.

That split is what makes the rest possible: progress reporting, retries
on failure, and processing several files at once without the API ever
slowing down.

## Quick start

```bash
docker compose up --build
```

- **API:** http://localhost:3000
- **Health:** http://localhost:3000/health/ready

Or run it directly:

```bash
npm install
npm run dev
```

## Development

```bash
npm run dev        # watch mode, restarts on change
npm test           # run the test suite
npm run typecheck  # TypeScript, no emit
npm run build      # compile to dist/
```

Configuration comes from the environment; copy `.env.example` to `.env`
to override defaults. Nothing reads `process.env` outside `src/config.ts`,
so every setting is validated once at startup and a bad value fails
immediately rather than at some later moment.

## Uploading

```bash
curl -F "file=@photo.png" http://localhost:3000/uploads
# -> {"id":"...","originalName":"photo.png","mimeType":"image/png","size":12345,...}

curl http://localhost:3000/uploads/<id>
```

Uploads are streamed to a temporary file rather than buffered in memory,
so a large file — or fifty concurrent ones — does not grow the heap. The
storage key is generated, never derived from the submitted filename, so a
name like `../../etc/passwd` cannot influence where bytes land; the
original name is kept as metadata only.

| Limit | Behaviour |
|---|---|
| Over `MAX_UPLOAD_BYTES` | `413 file_too_large` |
| Type outside the allow-list | `415 unsupported_type` |
| No file in the request | `400 no_file` |

## Health endpoints

Two checks, answering different questions:

| Endpoint | Question | Checks dependencies? |
|---|---|---|
| `/health/live` | Is the process running? | No — deliberately |
| `/health/ready` | Can it serve traffic? | Yes, and names what is broken |

Liveness ignores Redis on purpose: restarting the container would not fix
a broken Redis, so a Redis blip must not trigger a restart loop.

## Tech stack

Node.js 22, Express 5, TypeScript, Redis (ioredis), Zod for validation,
pino for structured logging, Vitest for tests, Docker Compose.

## License

MIT
