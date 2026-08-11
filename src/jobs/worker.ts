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

import { Worker, UnrecoverableError, type Job } from 'bullmq';
import Redis from 'ioredis';
import { mkdir } from 'node:fs/promises';
import { config } from '../config.js';
import { childLogger } from '../logger.js';
import { LocalStorage } from '../storage.js';
import { FileRepository } from '../files/repository.js';
import { QUEUE_NAME, type JobPayload } from './queue.js';
import { runJob, type ProcessorContext } from './processors.js';
import { MissingFileError, isPermanentFailure } from './errors.js';
import { publishJobEvent } from './events.js';

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

      await publishJobEvent(connection, {
        jobId: String(job.id),
        state: 'processing',
        progress: 0,
        operation: job.data.operation,
      });

      try {
        const result = await runJob(job, context);
        await publishJobEvent(connection, {
          jobId: String(job.id),
          state: 'completed',
          progress: 100,
          operation: job.data.operation,
          result,
        });
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

        // Some failures will never succeed on a retry: a file that is
        // gone stays gone, and bytes that are not an image will not
        // become one. Marking those unrecoverable stops BullMQ burning
        // two more attempts — and two more backoff delays — on a result
        // that is already known.
        const message = error instanceof Error ? error.message : String(error);
        const permanent = isPermanentFailure(error);
        const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

        // Only announce failure once it is final. Telling a watcher the
        // job failed while a retry is still pending would be a lie that
        // the next event contradicts.
        if (permanent || lastAttempt) {
          await publishJobEvent(connection, {
            jobId: String(job.id),
            state: 'failed',
            progress: 0,
            operation: job.data.operation,
            error: message,
          });
        }

        if (permanent) {
          throw new UnrecoverableError(message);
        }
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

  // Processors call `job.updateProgress(n)` as they work; BullMQ surfaces
  // that here. Forwarding it is what turns a percentage buried in the
  // worker into something a watching client actually sees.
  //
  // Progress is clamped to never decrease. The "job started" event and
  // the first `updateProgress` call race with each other, and a bar that
  // jumps forward and then back looks broken even though nothing is.
  const highWater = new Map<string, number>();

  worker.on('progress', (job, progress) => {
    const id = String(job.id);
    const value = typeof progress === 'number' ? progress : 0;
    const previous = highWater.get(id) ?? 0;
    if (value < previous) {
      return;
    }
    highWater.set(id, value);

    void publishJobEvent(connection, {
      jobId: id,
      state: 'processing',
      progress: value,
      operation: job.data?.operation,
    });
  });

  // Forget a job's high-water mark once it settles, so the map does not
  // grow for the lifetime of the process.
  worker.on('completed', (job) => highWater.delete(String(job.id)));

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
