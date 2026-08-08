/**
 * The job queue: what work looks like, and how it gets enqueued.
 *
 * The API adds jobs here and returns immediately; a separate worker
 * process consumes them. That split is the point of the whole design —
 * resizing an image or parsing a large CSV takes seconds, and doing it
 * inside the HTTP request would hold the caller's connection open, tie up
 * the server, and leave no way to retry when it fails.
 *
 * Redis holds the queue, so a job survives a worker crash: it is not lost
 * with the process that was running it, and another worker picks it up.
 */

import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';

export const QUEUE_NAME = 'file-processing';

/**
 * The kinds of work this service knows how to do.
 *
 * Kept as a schema rather than a bare string so an unknown operation is
 * rejected at the API boundary, before a job is created that no worker
 * would know what to do with.
 */
export const OperationSchema = z.enum([
  'image.resize',
  'image.convert',
  'image.thumbnail',
  'csv.validate',
  'csv.transform',
]);

export type Operation = z.infer<typeof OperationSchema>;

/**
 * What a job carries.
 *
 * Only the file id and the operation's parameters — deliberately not the
 * file contents. Job payloads live in Redis, and putting megabytes of
 * image data there would be both slow and wasteful when the bytes are
 * already sitting in storage where the worker can read them.
 */
export const JobPayloadSchema = z.object({
  fileId: z.string(),
  operation: OperationSchema,
  /** Operation-specific settings, validated per operation in later phases. */
  options: z.record(z.string(), z.unknown()).default({}),
});

export type JobPayload = z.infer<typeof JobPayloadSchema>;

/**
 * Defaults applied to every job.
 *
 * Three attempts with exponential backoff, because the failures worth
 * retrying are usually transient — a momentary disk hiccup, a lock held
 * for an instant. Retrying immediately would just hit the same condition,
 * so each attempt waits longer than the last.
 *
 * Completed and failed jobs are kept for a while rather than forever: a
 * caller needs to be able to ask "did my job finish?" after the fact, but
 * an unbounded history slowly fills Redis.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1_000,
  },
  removeOnComplete: {
    age: 24 * 60 * 60, // keep for a day
    count: 1_000,
  },
  removeOnFail: {
    age: 7 * 24 * 60 * 60, // failures are worth keeping longer
  },
};

export function createQueue(connection: Redis): Queue<JobPayload> {
  return new Queue<JobPayload>(QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}
