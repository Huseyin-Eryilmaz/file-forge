/**
 * The health endpoints, over HTTP.
 *
 * The distinction under test is the one that matters operationally:
 * liveness must not depend on anything external, readiness must. A
 * liveness check that fails when Redis hiccups causes restart loops; a
 * readiness check that ignores Redis sends traffic to an instance that
 * cannot serve it.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Redis } from 'ioredis';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });

/** A stand-in Redis that answers ping the way a healthy one would. */
const healthyRedis = { ping: async () => 'PONG' } as unknown as Redis;

/** A stand-in Redis that fails, to prove readiness actually notices. */
const brokenRedis = {
  ping: async () => {
    throw new Error('connection refused');
  },
} as unknown as Redis;

describe('liveness', () => {
  it('reports ok even when Redis is broken', async () => {
    // The point of liveness: the process is running. Restarting it would
    // not fix a broken Redis, so a broken Redis must not fail this.
    const app = createApp({ config, redis: brokenRedis });

    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('reports ok with no Redis configured at all', async () => {
    const app = createApp({ config, redis: null });

    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
  });
});

describe('readiness', () => {
  it('reports ok when dependencies answer', async () => {
    const app = createApp({ config, redis: healthyRedis });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.checks.redis).toBe('ok');
  });

  it('returns 503 and names the broken dependency', async () => {
    const app = createApp({ config, redis: brokenRedis });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    // Naming it is the difference between "something is wrong" and a
    // page that tells the on-call engineer where to look.
    expect(response.body.checks.redis).toContain('connection refused');
  });

  it('is not ready when Redis is missing entirely', async () => {
    const app = createApp({ config, redis: null });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
  });
});

describe('request correlation', () => {
  it('returns a request id on every response', async () => {
    const app = createApp({ config, redis: healthyRedis });

    const response = await request(app).get('/health/ready');

    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('preserves a caller-supplied request id', async () => {
    // A caller or upstream proxy can pass its own id so a trace spans
    // more than one service; overwriting it would break the chain.
    const app = createApp({ config, redis: healthyRedis });

    const response = await request(app)
      .get('/health/ready')
      .set('X-Request-ID', 'trace-abc-123');

    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });
});

describe('error shape', () => {
  it('returns a consistent JSON body for unknown routes', async () => {
    const app = createApp({ config, redis: healthyRedis });

    const response = await request(app).get('/no-such-route');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('not_found');
    expect(response.body.message).toContain('/no-such-route');
  });
});
