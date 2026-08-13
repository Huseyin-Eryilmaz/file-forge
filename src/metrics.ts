/**
 * What the service is doing right now.
 *
 * Two endpoints over the same numbers, because two different readers want
 * them. `/status` is JSON for a person: open it in a browser and see
 * whether the queue is backing up. `/metrics` is Prometheus text format
 * for a scraper, which is what actually alerts someone at three in the
 * morning.
 *
 * The counters live in Redis rather than in process memory. An API
 * instance that restarts would otherwise report zero, and — more to the
 * point — the numbers that matter are the worker's, and the worker is a
 * different process entirely.
 */

import { Router, type Request, type Response } from 'express';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobPayload } from './jobs/queue.js';

const COUNTER_PREFIX = 'metrics:';

export type CounterName =
  | 'uploads_total'
  | 'jobs_queued_total'
  | 'jobs_completed_total'
  | 'jobs_failed_total'
  | 'bytes_uploaded_total'
  | 'files_cleaned_total';

/**
 * Increments a counter. Best-effort: metrics must never fail a request.
 *
 * A missing data point is a gap in a graph. A request that fails because
 * bookkeeping failed is an outage.
 */
export async function incrementCounter(
  redis: Redis | null,
  name: CounterName,
  by = 1,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.incrby(`${COUNTER_PREFIX}${name}`, by);
  } catch {
    // Swallowed on purpose — see above.
  }
}

async function readCounters(
  redis: Redis | null,
): Promise<Record<string, number>> {
  const names: CounterName[] = [
    'uploads_total',
    'jobs_queued_total',
    'jobs_completed_total',
    'jobs_failed_total',
    'bytes_uploaded_total',
    'files_cleaned_total',
  ];

  const empty = Object.fromEntries(names.map((name) => [name, 0]));
  if (!redis) return empty;

  try {
    const values = await redis.mget(
      ...names.map((name) => `${COUNTER_PREFIX}${name}`),
    );
    return Object.fromEntries(
      names.map((name, index) => [name, Number(values[index] ?? 0)]),
    );
  } catch {
    return empty;
  }
}

interface QueueDepth {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

async function readQueueDepth(
  queue: Queue<JobPayload> | undefined,
): Promise<QueueDepth | null> {
  if (!queue) return null;
  try {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  } catch {
    return null;
  }
}

export interface MetricsRouterDeps {
  redis: Redis | null;
  queue?: Queue<JobPayload>;
  version: string;
  startedAt: number;
}

export function createMetricsRouter(deps: MetricsRouterDeps): Router {
  const router = Router();

  /** Human-readable service status. */
  router.get('/status', async (_req: Request, res: Response) => {
    const [counters, queue] = await Promise.all([
      readCounters(deps.redis),
      readQueueDepth(deps.queue),
    ]);

    res.json({
      service: 'file-forge',
      version: deps.version,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      queue: queue ?? 'unavailable',
      totals: counters,
      memory: {
        heapUsedMb:
          Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
        rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      },
    });
  });

  /**
   * The same numbers in Prometheus exposition format.
   *
   * The format is plain text and simpler than it looks: a HELP line, a
   * TYPE line, then `name value`. Counters only ever increase — a scraper
   * computes rates from the differences between scrapes — while gauges
   * are point-in-time readings that can go up or down.
   */
  router.get('/metrics', async (_req: Request, res: Response) => {
    const [counters, queue] = await Promise.all([
      readCounters(deps.redis),
      readQueueDepth(deps.queue),
    ]);

    const lines: string[] = [];

    const counter = (name: string, help: string, value: number): void => {
      lines.push(`# HELP file_forge_${name} ${help}`);
      lines.push(`# TYPE file_forge_${name} counter`);
      lines.push(`file_forge_${name} ${value}`);
    };

    const gauge = (name: string, help: string, value: number): void => {
      lines.push(`# HELP file_forge_${name} ${help}`);
      lines.push(`# TYPE file_forge_${name} gauge`);
      lines.push(`file_forge_${name} ${value}`);
    };

    counter('uploads_total', 'Files accepted for processing', counters.uploads_total);
    counter('jobs_queued_total', 'Jobs added to the queue', counters.jobs_queued_total);
    counter('jobs_completed_total', 'Jobs that finished successfully', counters.jobs_completed_total);
    counter('jobs_failed_total', 'Jobs that failed for good', counters.jobs_failed_total);
    counter('bytes_uploaded_total', 'Total bytes accepted', counters.bytes_uploaded_total);
    counter('files_cleaned_total', 'Files removed by the cleanup job', counters.files_cleaned_total);

    if (queue) {
      gauge('queue_waiting', 'Jobs waiting to be picked up', queue.waiting);
      gauge('queue_active', 'Jobs currently being processed', queue.active);
      gauge('queue_delayed', 'Jobs waiting for a retry', queue.delayed);
    }

    gauge(
      'process_heap_bytes',
      'Heap in use by this process',
      process.memoryUsage().heapUsed,
    );
    gauge(
      'process_uptime_seconds',
      'Seconds since this process started',
      Math.floor((Date.now() - deps.startedAt) / 1000),
    );

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(`${lines.join('\n')}\n`);
  });

  return router;
}
