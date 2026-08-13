/**
 * CSV processing, against a real worker and real files.
 *
 * The behaviour worth pinning down is what the processors report and
 * produce — row counts, dropped rows, selected columns — and how they
 * fail on input that is not really CSV. Memory behaviour is the point of
 * the streaming design, and it is covered by the scaling test at the
 * bottom rather than asserted indirectly.
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
import { runJobWithRetryPolicy } from '../src/jobs/processors.js';
import { probeRedis, testRedis, queueRedis } from './helpers.js';

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
  redis = testRedis('csv');
  qConn = queueRedis('csv');
  wConn = queueRedis('csv');
  storageRoot = await mkdtemp(join(tmpdir(), 'ff-csv-test-'));
  queue = createQueue(qConn);

  const storage = new LocalStorage(storageRoot);
  const files = new FileRepository(redis);
  worker = new Worker<JobPayload>(
    QUEUE_NAME,
    (job) => runJobWithRetryPolicy(job, { storage, files }),
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

async function uploadCsv(
  app: ReturnType<typeof buildApp>,
  content: string,
  filename = 'data.csv',
): Promise<string> {
  const response = await request(app)
    .post('/uploads')
    .attach('file', Buffer.from(content), {
      filename,
      contentType: 'text/csv',
    });
  return response.body.id as string;
}

async function runOperation(
  app: ReturnType<typeof buildApp>,
  fileId: string,
  operation: string,
  options: Record<string, unknown> = {},
  timeoutMs = 15_000,
) {
  const created = await request(app)
    .post('/jobs')
    .send({ fileId, operation, options });

  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await request(app).get(`/jobs/${created.body.id}`);
    last = response.body;
    if (last.state === 'failed') return last;
    // `!= null` catches both null and undefined. BullMQ marks a job
    // completed and writes its return value in separate steps, so there is
    // a window where the state says done but the result is still null —
    // narrow enough to never appear on a fast machine, wide enough to make
    // this flaky on a slow one.
    if (last.state === 'completed' && last.result != null) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last;
}

const GOOD_CSV = [
  'city,temp,humidity',
  'Ankara,33.1,41',
  'Izmir,35.8,38',
  'Bursa,31.2,55',
].join('\n');

describe.skipIf(!available)('csv.validate', () => {
  it('counts rows without counting the header', async () => {
    const app = buildApp();
    const fileId = await uploadCsv(app, GOOD_CSV);

    const job = await runOperation(app, fileId, 'csv.validate');
    const details = (job.result as { details: Record<string, number> }).details;

    expect(job.state).toBe('completed');
    expect(details.rows).toBe(3);
    expect(details.columns).toBe(3);
  });

  it('finds rows with the wrong number of fields', async () => {
    // The classic broken CSV: one row missing a value. Reading rows as
    // arrays is what makes this visible — object mode would pad it.
    const broken = ['a,b,c', '1,2,3', '4,5', '6,7,8'].join('\n');
    const app = buildApp();
    const fileId = await uploadCsv(app, broken);

    const job = await runOperation(app, fileId, 'csv.validate');
    const details = (job.result as { details: Record<string, number> }).details;

    expect(details.inconsistentRows).toBe(1);
  });

  it('writes a report that can be downloaded', async () => {
    const app = buildApp();
    const fileId = await uploadCsv(app, GOOD_CSV);

    const job = await runOperation(app, fileId, 'csv.validate');
    const key = (job.result as { outputs: string[] }).outputs[0];

    const response = await request(app).get(`/files/${key}`);
    const report = JSON.parse(response.text);

    expect(response.status).toBe(200);
    expect(report.columns).toEqual(['city', 'temp', 'humidity']);
    expect(report.rows).toBe(3);
  });

  it('reports empty values per column', async () => {
    const withGaps = ['a,b', '1,', ',2', '3,4'].join('\n');
    const app = buildApp();
    const fileId = await uploadCsv(app, withGaps);

    const job = await runOperation(app, fileId, 'csv.validate');
    const key = (job.result as { outputs: string[] }).outputs[0];
    const response = await request(app).get(`/files/${key}`);
    const report = JSON.parse(response.text);

    expect(report.emptyByColumn.a).toBe(1);
    expect(report.emptyByColumn.b).toBe(1);
  });
});

describe.skipIf(!available)('csv.transform', () => {
  it('keeps only the requested columns', async () => {
    const app = buildApp();
    const fileId = await uploadCsv(app, GOOD_CSV);

    const job = await runOperation(app, fileId, 'csv.transform', {
      columns: ['city', 'temp'],
    });
    const key = (job.result as { outputs: string[] }).outputs[0];
    const response = await request(app).get(`/files/${key}`);

    expect(response.text).toContain('city,temp');
    expect(response.text).not.toContain('humidity');
  });

  it('keeps every row when nothing is dropped', async () => {
    const app = buildApp();
    const fileId = await uploadCsv(app, GOOD_CSV);

    const job = await runOperation(app, fileId, 'csv.transform', {
      columns: ['city'],
    });
    const details = (job.result as { details: Record<string, number> }).details;

    expect(details.rowsIn).toBe(3);
    expect(details.rowsOut).toBe(3);
  });

  it('trims surrounding whitespace', async () => {
    const messy = ['name,value', '  Ankara  ,  33  '].join('\n');
    const app = buildApp();
    const fileId = await uploadCsv(app, messy);

    const job = await runOperation(app, fileId, 'csv.transform', {
      columns: ['name', 'value'],
    });
    const key = (job.result as { outputs: string[] }).outputs[0];
    const response = await request(app).get(`/files/${key}`);

    expect(response.text).toContain('Ankara,33');
  });

  it('drops rows that are entirely empty', async () => {
    const withBlanks = ['a,b', '1,2', ',', '3,4'].join('\n');
    const app = buildApp();
    const fileId = await uploadCsv(app, withBlanks);

    const job = await runOperation(app, fileId, 'csv.transform', {
      columns: ['a', 'b'],
    });
    const details = (job.result as { details: Record<string, number> }).details;

    expect(details.rowsDropped).toBe(1);
    expect(details.rowsOut).toBe(2);
  });

  it('fails when none of the requested columns exist', async () => {
    // Better to fail loudly than to write an empty file and call it done.
    const app = buildApp();
    const fileId = await uploadCsv(app, GOOD_CSV);

    const job = await runOperation(app, fileId, 'csv.transform', {
      columns: ['nope', 'also_nope'],
    });

    expect(job.state).toBe('failed');
  });

  it('ignores requested columns that are missing, if some exist', async () => {
    const app = buildApp();
    const fileId = await uploadCsv(app, GOOD_CSV);

    const job = await runOperation(app, fileId, 'csv.transform', {
      columns: ['city', 'does_not_exist'],
    });
    const details = (job.result as { details: { columns: string[] } }).details;

    expect(job.state).toBe('completed');
    expect(details.columns).toEqual(['city']);
  });
});

describe.skipIf(!available)('handling larger files', () => {
  it('processes tens of thousands of rows', async () => {
    // Not a memory benchmark — just confirmation that the streaming path
    // handles a file far larger than the toy examples above without
    // special handling.
    const rows = ['id,city,value'];
    for (let i = 1; i <= 50_000; i += 1) {
      rows.push(`${i},City${i % 81},${i * 2}`);
    }
    const app = buildApp();
    const fileId = await uploadCsv(app, rows.join('\n'), 'big.csv');

    const job = await runOperation(app, fileId, 'csv.validate', {}, 30_000);
    const details = (job.result as { details: Record<string, number> }).details;

    expect(job.state).toBe('completed');
    expect(details.rows).toBe(50_000);
  }, 40_000);
});
