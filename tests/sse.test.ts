/**
 * Live progress over SSE.
 *
 * These use a real HTTP server rather than supertest, because supertest
 * wants a response that finishes and an event stream deliberately does
 * not. Reading the raw body as it arrives is also closer to what a
 * browser's `EventSource` actually does.
 *
 * The cases that matter are the ones about lifecycle: that a client
 * joining late still learns the outcome, and that the server closes the
 * stream once there is nothing more to say. An endpoint that holds
 * connections open forever is how these leak.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Worker, type Queue } from 'bullmq';
import type Redis from 'ioredis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalStorage } from '../src/storage.js';
import { FileRepository } from '../src/files/repository.js';
import { createQueue, QUEUE_NAME, type JobPayload } from '../src/jobs/queue.js';
import { runJob } from '../src/jobs/processors.js';
import { publishJobEvent, type JobEvent } from '../src/jobs/events.js';
import { probeRedis, testRedis, queueRedis } from './helpers.js';

const available = await probeRedis();
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });

let redis: Redis;
let qConn: Redis;
let wConn: Redis;
let subscriber: Redis;
let queue: Queue<JobPayload>;
let worker: Worker<JobPayload> | null = null;
let storageRoot: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  if (!available) return;
  redis = testRedis('sse');
  qConn = queueRedis('sse');
  wConn = queueRedis('sse');
  subscriber = queueRedis('sse');
  storageRoot = await mkdtemp(join(tmpdir(), 'ff-sse-test-'));
  queue = createQueue(qConn);

  const storage = new LocalStorage(storageRoot);
  const files = new FileRepository(redis);

  worker = new Worker<JobPayload>(
    QUEUE_NAME,
    async (job) => {
      await publishJobEvent(wConn, {
        jobId: String(job.id),
        state: 'processing',
        progress: 0,
        operation: job.data.operation,
      });
      try {
        const result = await runJob(job, { storage, files });
        await publishJobEvent(wConn, {
          jobId: String(job.id),
          state: 'completed',
          progress: 100,
          operation: job.data.operation,
          result,
        });
        return result;
      } catch (error) {
        await publishJobEvent(wConn, {
          jobId: String(job.id),
          state: 'failed',
          progress: 0,
          operation: job.data.operation,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    { connection: wConn, concurrency: 2 },
  );

  const app = createApp({ config, redis, storage, files, queue, subscriber });
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (!available) return;
  await worker?.close();
  await queue.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([redis.quit(), qConn.quit(), wConn.quit(), subscriber.quit()]);
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!available) return;
  await redis.flushdb();
});

function appForRequests() {
  return createApp({
    config,
    redis,
    storage: new LocalStorage(storageRoot),
    files: new FileRepository(redis),
    queue,
    subscriber,
  });
}

async function uploadCsv(content: string): Promise<string> {
  const response = await request(appForRequests())
    .post('/uploads')
    .attach('file', Buffer.from(content), {
      filename: 'data.csv',
      contentType: 'text/csv',
    });
  return response.body.id as string;
}

async function queueJob(fileId: string, operation: string): Promise<string> {
  const response = await request(appForRequests())
    .post('/jobs')
    .send({ fileId, operation });
  return String(response.body.id);
}

/** Reads an SSE stream until the job settles or the timeout expires. */
async function collectEvents(
  jobId: string,
  timeoutMs = 15_000,
): Promise<{ events: JobEvent[]; closedByServer: boolean }> {
  const response = await fetch(`${baseUrl}/jobs/${jobId}/events`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const events: JobEvent[] = [];
  let buffer = '';
  let closedByServer = false;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      closedByServer = true;
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      events.push(JSON.parse(line.slice(6)) as JobEvent);
    }

    const last = events.at(-1);
    if (last && (last.state === 'completed' || last.state === 'failed')) {
      // Give the server a moment to close of its own accord.
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean }>((resolve) =>
          setTimeout(() => resolve({ done: false }), 500),
        ),
      ]);
      closedByServer = next.done === true;
      break;
    }
  }

  await reader.cancel().catch(() => undefined);
  return { events, closedByServer };
}

const CSV = ['city,temp', 'Ankara,33', 'Izmir,35'].join('\n');

describe.skipIf(!available)('the event stream', () => {
  it('responds with an event-stream content type', async () => {
    const fileId = await uploadCsv(CSV);
    const jobId = await queueJob(fileId, 'csv.validate');

    const response = await fetch(`${baseUrl}/jobs/${jobId}/events`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    await response.body?.cancel();
  });

  it('404s for a job that does not exist', async () => {
    const response = await fetch(`${baseUrl}/jobs/999999/events`);

    expect(response.status).toBe(404);
  });

  it('sends the current state straight away', async () => {
    // Without an immediate first event, a client would sit staring at an
    // empty stream until the next thing happened to occur.
    const fileId = await uploadCsv(CSV);
    const jobId = await queueJob(fileId, 'csv.validate');

    const { events } = await collectEvents(jobId);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].jobId).toBe(jobId);
  });

  it('reports the job reaching completion', async () => {
    const fileId = await uploadCsv(CSV);
    const jobId = await queueJob(fileId, 'csv.validate');

    const { events } = await collectEvents(jobId);
    const last = events.at(-1);

    expect(last?.state).toBe('completed');
    expect(last?.progress).toBe(100);
  });

  it('closes the stream once the job has settled', async () => {
    // Nothing further can be said about a finished job, so holding the
    // connection open would only leak it.
    const fileId = await uploadCsv(CSV);
    const jobId = await queueJob(fileId, 'csv.validate');

    const { closedByServer } = await collectEvents(jobId);

    expect(closedByServer).toBe(true);
  });

  it('tells a late subscriber the outcome it missed', async () => {
    const fileId = await uploadCsv(CSV);
    const jobId = await queueJob(fileId, 'csv.validate');

    // Wait for the job to finish before connecting at all.
    await collectEvents(jobId);
    const { events } = await collectEvents(jobId);

    // The stream opens with the stored state rather than waiting for an
    // event that has already been and gone.
    expect(events[0]?.state).toBe('completed');
  });

  it('reports a failure with its reason', async () => {
    const fileId = await uploadCsv(CSV);
    const jobId = await queueJob(fileId, 'csv.transform');
    // csv.transform with no columns option keeps everything and succeeds,
    // so provoke a real failure instead: a job for a file that is gone.
    void jobId;

    const missing = await request(appForRequests())
      .post('/jobs')
      .send({ fileId, operation: 'image.resize' });

    const { events } = await collectEvents(String(missing.body.id));
    const last = events.at(-1);

    expect(last?.state).toBe('failed');
    expect(last?.error).toBeTruthy();
  });
});

describe.skipIf(!available)('event publishing', () => {
  it('delivers a published event to a subscriber', async () => {
    const { subscribeToJob } = await import('../src/jobs/events.js');
    const received: JobEvent[] = [];
    const listener = queueRedis('sse');

    const unsubscribe = await subscribeToJob(listener, 'test-job', (event) => {
      received.push(event);
    });

    await publishJobEvent(redis, {
      jobId: 'test-job',
      state: 'processing',
      progress: 42,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await unsubscribe();
    await listener.quit();

    expect(received).toHaveLength(1);
    expect(received[0].progress).toBe(42);
  });

  it('ignores events for other jobs', async () => {
    const { subscribeToJob } = await import('../src/jobs/events.js');
    const received: JobEvent[] = [];
    const listener = queueRedis('sse');

    const unsubscribe = await subscribeToJob(listener, 'job-a', (event) => {
      received.push(event);
    });

    await publishJobEvent(redis, {
      jobId: 'job-b',
      state: 'processing',
      progress: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await unsubscribe();
    await listener.quit();

    expect(received).toHaveLength(0);
  });
});
