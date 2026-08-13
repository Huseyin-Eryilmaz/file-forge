/**
 * Shared test helpers.
 *
 * Two problems these solve.
 *
 * First, speed of failure: several suites need a real Redis, and without
 * a probe they each spend their full timeout retrying a connection that
 * is never going to answer — turning "Redis is not running" into a
 * two-minute wait ending in a wall of confusing errors.
 *
 * Second, isolation: Vitest runs test files in parallel, so two suites
 * sharing one Redis will delete each other's keys between tests. Rather
 * than trying to scope every cleanup by key pattern — which breaks the
 * moment two suites happen to use the same pattern — each suite gets its
 * own Redis database. Nothing one suite writes is even visible to
 * another, so no cleanup can reach across.
 */

import Redis, { type RedisOptions } from 'ioredis';

const BASE_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Database indices, one per suite that needs Redis.
 *
 * Redis offers 16 numbered databases by default. Assigning them
 * explicitly here — rather than letting each suite pick — makes a
 * collision something you can see at a glance.
 */
export const TEST_DB = {
  uploads: 1,
  jobs: 2,
  images: 3,
  csv: 4,
  sse: 5,
  hardening: 6,
} as const;

export type TestSuite = keyof typeof TEST_DB;

function optionsFor(suite: TestSuite, overrides: RedisOptions = {}): RedisOptions {
  return {
    db: TEST_DB[suite],
    maxRetriesPerRequest: 2,
    ...overrides,
  };
}

/**
 * Checks whether Redis is reachable, quickly.
 *
 * The probe is deliberately impatient: one attempt, a short timeout, no
 * retry strategy. The question is "is it there?", not "please keep
 * trying".
 */
export async function probeRedis(): Promise<boolean> {
  const probe = new Redis(BASE_URL, {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

/** A connection on the suite's own database, configured as app code uses it. */
export function testRedis(suite: TestSuite): Redis {
  return new Redis(BASE_URL, optionsFor(suite));
}

/**
 * A connection on the suite's own database, configured as BullMQ needs it.
 *
 * BullMQ's blocking reads wait for work to arrive, so a "give up after N
 * retries" policy breaks them — hence `maxRetriesPerRequest: null`.
 */
export function queueRedis(suite: TestSuite): Redis {
  return new Redis(BASE_URL, optionsFor(suite, { maxRetriesPerRequest: null }));
}
