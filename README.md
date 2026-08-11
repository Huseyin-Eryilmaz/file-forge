# file-forge

A file processing service: upload a file, it gets processed in the
background, and you collect the result when it is done. Images are
resized and converted; CSVs are validated and transformed by streaming
them rather than loading them into memory.

Built with Node.js, Express and TypeScript, with Redis-backed job queues
and a React front end.

> 🚧 **Status: Phase 5 (live progress).** Job progress streams to
> connected clients over Server-Sent Events. File lifecycle and the React
> front end come next. See the [roadmap](ROADMAP.md).

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

## Processing a file

Upload first, then ask for work. The two are separate so a file can be
processed more than once, with different settings each time.

```bash
# 1. upload
curl -F "file=@photo.png" http://localhost:3000/uploads
# -> {"id":"abc123",...}

# 2. queue some work — returns immediately with 202 Accepted
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"fileId":"abc123","operation":"image.resize"}'
# -> {"id":"1","state":"queued",...}

# 3. check on it
curl http://localhost:3000/jobs/1
# -> {"id":"1","state":"completed","progress":100,"result":{...}}
```

Then download what it produced — the key comes back in `result.outputs`:

```bash
curl -o resized.png http://localhost:3000/files/outputs/<key>
```

### Operations

| Operation | Options | Produces |
|---|---|---|
| `image.resize` | `width` and/or `height`, `fit`, `withoutEnlargement` | same format, scaled |
| `image.convert` | `format` (jpeg/png/webp/avif), `quality` | converted image |
| `image.thumbnail` | `size` (16–512) | square WebP preview |
| `csv.validate` | `hasHeader`, `delimiter` | JSON report |
| `csv.transform` | `columns`, `trim`, `dropEmptyRows` | cleaned CSV |

Aspect ratio is preserved by default and images are never enlarged.
Output dimensions are capped, because an unbounded resize is a cheap way
to exhaust memory.

### Streaming, and why it matters

CSV work never holds the file in memory. Rows arrive one at a time from
the parser, pass through a transform, and leave through the stringifier
to storage — so at any instant only a handful of rows exist. Measured on
this machine:

```
rows         file size    peak heap
   10,000       0.4 MB       4.8 MB
  200,000       8.0 MB      12.7 MB
1,000,000      40.7 MB      12.5 MB
3,000,000     126.3 MB      12.9 MB
```

The file grows by a factor of 300; the heap does not move. The obvious
implementation — read it, parse it into an array, work on the array —
would have needed several times the file size, and died somewhere around
the third row of that table.

**Validation happens twice.** The upload endpoint checks the declared
type and, when that is generic, the file extension — both of which a
caller controls. The real check is at processing time: sharp either
decodes the bytes as an image or the job fails. A `.png` that is actually
something else gets through the first check and fails the second.

### Watching a job live

Polling works, but the server can push instead:

```bash
curl -N http://localhost:3000/jobs/1/events
```

```
data: {"jobId":"1","state":"processing","progress":10}

data: {"jobId":"1","state":"processing","progress":80}

data: {"jobId":"1","state":"completed","progress":100,"result":{...}}
```

Server-Sent Events rather than WebSockets, because updates only travel one
way — and browsers reconnect dropped SSE streams on their own. The worker
publishes to Redis, the API subscribes and forwards, so the two processes
never need to talk directly. The stream opens with the job's current
state (a client joining late still learns the outcome) and closes once
the job settles.

States are `queued`, `processing`, `retrying`, `completed`, `failed`.
Failed jobs are retried three times with exponential backoff; a failure
that will never succeed — a file that no longer exists — is not retried.

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
