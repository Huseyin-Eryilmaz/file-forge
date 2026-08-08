/**
 * Jobs: queueing them, running them, and reporting on them.
 *
 * These run a real worker against a real Redis, because the behaviour
 * worth testing lives in the interaction — that a queued job actually
 * gets picked up, that progress reaches the status endpoint, that a
 * failure is recorded rather than swallowed. A mocked queue would assert
 * only that we called a function.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Worker, type Queue } from 'bullmq';
import type Redis from 'ioredis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalStorage } from '../src/storage.js';
import { FileRepository } from '../src/files/repository.js';
import { createQueue, QUEUE_NAME, type JobPayload } from '../src/jobs/queue.js';
import { runJob } from '../src/jobs/processors.js';
import { probeRedis, testRedis, queueRedis } from './helpers.js';

// Probed once at load so the suites can be skipped outright when Redis is
// absent, instead of each test individually discovering it is unusable.
const available = await probeRedis();

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });

let redis: Redis;
let qConn: Redis;
let wConn: Redis;
let queue: Queue<JobPayload>;
let worker: Worker<JobPayload> | null = null;
let storageRoot: string;

beforeAll(async () => {
  if (!available) return;

  redis = testRedis('jobs');
  qConn = queueRedis('jobs');
  wConn = queueRedis('jobs');
  storageRoot = await mkdtemp(join(tmpdir(), 'ff-jobs-test-'));
  queue = createQueue(qConn);

  const storage = new LocalStorage(storageRoot);
  const files = new FileRepository(redis);
  worker = new Worker<JobPayload>(
    QUEUE_NAME,
    (job) => runJob(job, { storage, files }),
    { connection: wConn, concurrency: 2 },
  );
});

afterAll(async () => {
  if (!available) return;
  await worker?.close();
  await queue.close();
  await Promise.all([redis.quit(), qConn.quit(), wConn.quit()]);
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!available) return;
  // Safe to flush: this suite has a Redis database to itself, so nothing
  // here belongs to another test file running in parallel.
  await redis.flushdb();
});

function buildApp() {
  return createApp({
    config,
    redis,
    storage: new LocalStorage(storageRoot),
    files: new FileRepository(redis),
    queue,
  });
}

async function uploadFile(app: ReturnType<typeof buildApp>) {
  const response = await request(app)
    .post('/uploads')
    .attach('file', Buffer.from('city,temp\nAnkara,33\n'), {
      filename: 'data.csv',
      contentType: 'text/csv',
    });
  return response.body.id as string;
}

/** Polls the status endpoint until the job settles or we give up. */
/**
 * Polls the status endpoint until the job settles or we give up.
 *
 * A job reaching `completed` and its return value being readable are not
 * quite the same instant — BullMQ marks the state and writes the result
 * in separate steps. Returning on the state alone made this flaky: the
 * test would occasionally read `result: undefined` from a job that had
 * genuinely succeeded. So a completed job is only accepted once its
 * result is actually there.
 */
async function waitForJob(
  app: ReturnType<typeof buildApp>,
  jobId: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};

  while (Date.now() < deadline) {
    const response = await request(app).get(`/jobs/${jobId}`);
    last = response.body;

    if (last.state === 'failed') {
      return last;
    }
    if (last.state === 'completed' && last.result !== undefined) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

describe.skipIf(!available)('job queueing', () => {
  it('accepts a job and returns immediately', async () => {
    const app = buildApp();
    const fileId = await uploadFile(app);

    const response = await request(app)
      .post('/jobs')
      .send({ fileId, operation: 'csv.validate' });

    // 202 Accepted, not 200: the work has been taken on, not finished.
    expect(response.status).toBe(202);
    expect(response.body.id).toBeTruthy();
    expect(response.body.state).toBe('queued');
  });

  it('refuses a job for an unknown file', async () => {
    const app = buildApp();

    const response = await request(app)
      .post('/jobs')
      .send({ fileId: 'no-such-file', operation: 'csv.validate' });

    // Checked at the boundary rather than discovered by the worker later.
    expect(response.status).toBe(404);
  });

  it('refuses an unknown operation', async () => {
    const app = buildApp();
    const fileId = await uploadFile(app);

    const response = await request(app)
      .post('/jobs')
      .send({ fileId, operation: 'image.explode' });

    expect(response.status).toBe(422);
  });

  it('refuses a request with no fileId', async () => {
    const app = buildApp();

    const response = await request(app)
      .post('/jobs')
      .send({ operation: 'csv.validate' });

    expect(response.status).toBe(422);
  });
});

describe.skipIf(!available)('job execution', () => {
  it('runs a queued job to completion', async () => {
    const app = buildApp();
    const fileId = await uploadFile(app);

    const created = await request(app)
      .post('/jobs')
      .send({ fileId, operation: 'csv.validate' });

    const final = await waitForJob(app, created.body.id);

    expect(final.state).toBe('completed');
    expect(final.progress).toBe(100);
  });

  it('reports the job result once finished', async () => {
    const app = buildApp();
    const fileId = await uploadFile(app);

    const created = await request(app)
      .post('/jobs')
      .send({ fileId, operation: 'image.resize' });

    const final = await waitForJob(app, created.body.id);
    const result = final.result as { outputs: string[] };

    expect(result.outputs.length).toBeGreaterThan(0);
  });

  it('runs several jobs for the same file', async () => {
    const app = buildApp();
    const fileId = await uploadFile(app);

    const first = await request(app)
      .post('/jobs')
      .send({ fileId, operation: 'csv.validate' });
    const second = await request(app)
      .post('/jobs')
      .send({ fileId, operation: 'csv.transform' });

    expect(first.body.id).not.toBe(second.body.id);

    const firstFinal = await waitForJob(app, first.body.id);
    const secondFinal = await waitForJob(app, second.body.id);

    expect(firstFinal.state).toBe('completed');
    expect(secondFinal.state).toBe('completed');
  });
});

describe.skipIf(!available)('job status', () => {
  it('404s for an unknown job id', async () => {
    const app = buildApp();

    const response = await request(app).get('/jobs/999999');

    expect(response.status).toBe(404);
  });

  it('reports the operation and file it was created for', async () => {
    const app = buildApp();
    const fileId = await uploadFile(app);

    const created = await request(app)
      .post('/jobs')
      .send({ fileId, operation: 'image.thumbnail' });

    const status = await request(app).get(`/jobs/${created.body.id}`);

    expect(status.body.operation).toBe('image.thumbnail');
    expect(status.body.fileId).toBe(fileId);
  });
});
