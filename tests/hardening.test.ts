/**
 * Hardening: security headers, rate limits, and the metrics endpoints.
 *
 * The rate-limit tests deliberately use a real Redis, because the counter
 * being shared across processes is the whole reason it lives there — an
 * in-memory stand-in would test something we are not shipping.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type Redis from 'ioredis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalStorage } from '../src/storage.js';
import { FileRepository } from '../src/files/repository.js';
import { createRateLimiter } from '../src/ratelimit.js';
import { incrementCounter } from '../src/metrics.js';
import { probeRedis, testRedis } from './helpers.js';

const available = await probeRedis();
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });

let redis: Redis;
let storageRoot: string;

beforeAll(async () => {
  if (!available) return;
  redis = testRedis('hardening');
  storageRoot = await mkdtemp(join(tmpdir(), 'ff-hard-test-'));
});

afterAll(async () => {
  if (!available) return;
  await redis.quit();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!available) return;
  await redis.flushdb();
});

function buildApp(withRedis = true) {
  return createApp({
    config,
    redis: withRedis && available ? redis : null,
    storage: new LocalStorage(storageRoot || tmpdir()),
    files: withRedis && available ? new FileRepository(redis) : undefined,
  });
}

describe('security headers', () => {
  it('tells browsers not to sniff content types', async () => {
    // Without this a browser may decide an uploaded file is script,
    // whatever content type we declared.
    const response = await request(buildApp(false)).get('/health/live');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses to be framed', async () => {
    const response = await request(buildApp(false)).get('/health/live');

    expect(response.headers['x-frame-options']).toBeTruthy();
  });

  it('asks browsers to stick to HTTPS', async () => {
    const response = await request(buildApp(false)).get('/health/live');

    expect(response.headers['strict-transport-security']).toContain('max-age=');
  });

  it('does not advertise the framework', async () => {
    // Naming it only helps someone matching known exploits against it.
    const response = await request(buildApp(false)).get('/health/live');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe.skipIf(!available)('rate limiting', () => {
  it('reports the limit and what is left', async () => {
    const app = buildApp();

    const response = await request(app).get('/files/nothing');

    expect(response.headers['ratelimit-limit']).toBeTruthy();
    expect(response.headers['ratelimit-remaining']).toBeTruthy();
  });

  it('refuses once the window is full', async () => {
    // A tiny limiter, so the test does not need to send a hundred
    // requests to prove the behaviour.
    const limiter = createRateLimiter(redis, {
      limit: 3,
      windowSeconds: 60,
      bucket: 'test',
    });

    const express = (await import('express')).default;
    const app = express();
    app.use(limiter);
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await request(app).get('/x')).status);
    }

    expect(codes.filter((c) => c === 200)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });

  it('says how long to wait', async () => {
    const limiter = createRateLimiter(redis, {
      limit: 1,
      windowSeconds: 60,
      bucket: 'retry-test',
    });

    const express = (await import('express')).default;
    const app = express();
    app.use(limiter);
    app.get('/x', (_req, res) => res.json({ ok: true }));

    await request(app).get('/x');
    const blocked = await request(app).get('/x');

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
  });

  it('allows everything through when Redis is absent', async () => {
    // Failing open is the point: a limiter that takes the service down
    // when it breaks has caused more harm than the traffic it guarded
    // against.
    const limiter = createRateLimiter(null, {
      limit: 1,
      windowSeconds: 60,
      bucket: 'open',
    });

    const express = (await import('express')).default;
    const app = express();
    app.use(limiter);
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const first = await request(app).get('/x');
    const second = await request(app).get('/x');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('keeps separate counts for different buckets', async () => {
    // Uploads cost disk and jobs cost CPU, so they are limited
    // independently rather than sharing one allowance.
    const express = (await import('express')).default;
    const app = express();
    app.use(
      '/a',
      createRateLimiter(redis, { limit: 1, windowSeconds: 60, bucket: 'a' }),
    );
    app.use(
      '/b',
      createRateLimiter(redis, { limit: 1, windowSeconds: 60, bucket: 'b' }),
    );
    app.get('/a', (_req, res) => res.json({ ok: true }));
    app.get('/b', (_req, res) => res.json({ ok: true }));

    await request(app).get('/a');
    const bucketB = await request(app).get('/b');

    expect(bucketB.status).toBe(200);
  });
});

describe.skipIf(!available)('status and metrics', () => {
  it('reports service status as JSON', async () => {
    const response = await request(buildApp()).get('/status');

    expect(response.status).toBe(200);
    expect(response.body.service).toBe('file-forge');
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('includes counters in the status', async () => {
    await incrementCounter(redis, 'uploads_total', 3);

    const response = await request(buildApp()).get('/status');

    expect(response.body.totals.uploads_total).toBe(3);
  });

  it('serves Prometheus exposition format', async () => {
    const response = await request(buildApp()).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('# TYPE file_forge_uploads_total counter');
  });

  it('reflects counter values in the metrics output', async () => {
    await incrementCounter(redis, 'jobs_completed_total', 7);

    const response = await request(buildApp()).get('/metrics');

    expect(response.text).toContain('file_forge_jobs_completed_total 7');
  });

  it('is not rate limited', async () => {
    // Monitoring must keep working precisely when traffic is highest.
    const app = buildApp();
    const codes: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      codes.push((await request(app).get('/metrics')).status);
    }

    expect(codes.every((code) => code === 200)).toBe(true);
  });

  it('still answers when Redis is unavailable', async () => {
    const response = await request(buildApp(false)).get('/status');

    expect(response.status).toBe(200);
    expect(response.body.totals.uploads_total).toBe(0);
  });
});
