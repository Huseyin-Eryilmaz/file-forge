/**
 * The worker process: consume jobs, run them, shut down cleanly.
 *
 * This runs as its own container, separate from the API. The separation
 * is deliberate rather than incidental — the two have different failure
 * modes and different scaling needs. A worker busy resizing a large image
 * should never make an HTTP health check wait, and when the queue backs
 * up you want to add workers without adding API instances.
 *
 * Concurrency is capped. Image and CSV work is CPU-bound, so running an
 * unbounded number at once does not make anything faster — it just makes
 * everything slower at the same time, and risks exhausting memory.
 */

import { Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { mkdir } from 'node:fs/promises';
import { config } from '../config.js';
import { childLogger } from '../logger.js';
import { LocalStorage } from '../storage.js';
import { FileRepository } from '../files/repository.js';
import { QUEUE_NAME, type JobPayload } from './queue.js';
import { runJob, MissingFileError, type ProcessorContext } from './processors.js';

const log = childLogger('worker');

/** How many jobs this worker runs at once. */
const CONCURRENCY = 3;

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  await mkdir(config.storageDir, { recursive: true });

  // BullMQ needs a connection that never gives up on a request, because
  // its blocking commands wait for work to arrive. The API's connection
  // is configured the opposite way — fail fast — which is why the worker
  // opens its own rather than sharing.
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });

  connection.on('error', (err) => {
    log.error({ err }, 'redis_error');
  });

  const context: ProcessorContext = {
    storage: new LocalStorage(config.storageDir),
    files: new FileRepository(connection),
  };

  const worker = new Worker<JobPayload>(
    QUEUE_NAME,
    async (job: Job<JobPayload>) => {
      const start = Date.now();
      log.info(
        { jobId: job.id, operation: job.data.operation, fileId: job.data.fileId },
        'job_started',
      );

      try {
        const result = await runJob(job, context);
        log.info(
          {
            jobId: job.id,
            operation: job.data.operation,
            durationMs: Date.now() - start,
            outputs: result.outputs.length,
          },
          'job_completed',
        );
        return result;
      } catch (error) {
        log.warn(
          {
            jobId: job.id,
            operation: job.data.operation,
            attempt: job.attemptsMade + 1,
            err: error,
          },
          'job_failed',
        );
        throw error;
      }
    },
    {
      connection,
      concurrency: CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    // A job that has exhausted its attempts is done for; anything before
    // that will be retried, so the two deserve different log levels.
    const exhausted = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : true;
    const permanent = err instanceof MissingFileError;

    if (exhausted || permanent) {
      log.error({ jobId: job?.id, err }, 'job_abandoned');
    }
  });

  worker.on('error', (err) => {
    log.error({ err }, 'worker_error');
  });

  log.info({ concurrency: CONCURRENCY, queue: QUEUE_NAME }, 'worker_started');

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutdown_started');

    const forceExit = setTimeout(() => {
      log.warn('shutdown_timeout_exceeded');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // `close()` waits for jobs in flight to finish rather than killing
      // them mid-write, which would leave half-written output behind.
      await worker.close();
      await connection.quit();
      log.info('shutdown_complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown_failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err }, 'worker_startup_failed');
  process.exit(1);
});
