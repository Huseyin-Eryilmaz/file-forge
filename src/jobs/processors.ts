/**
 * What actually runs when a job is picked up.
 *
 * Each operation maps to a handler. The registry shape means adding a new
 * operation is one entry here plus one schema value in `queue.ts` — the
 * worker itself never grows a switch statement, and nothing else in the
 * codebase has to know which operations exist.
 *
 * The handlers in this phase are placeholders that report progress and
 * finish. Real image and CSV work replaces their bodies in the phases
 * that follow; everything around them — queueing, retries, progress,
 * failure handling — is already what it will be.
 */

import { UnrecoverableError, type Job } from 'bullmq';
import type { Storage } from '../storage.js';
import type { FileRepository } from '../files/repository.js';
import type { JobPayload, Operation } from './queue.js';
export { MissingFileError } from './errors.js';
import { isPermanentFailure } from './errors.js';
import { resizeImage, convertImage, thumbnailImage } from './image.js';
import { validateCsv, transformCsv } from './csv.js';

export interface ProcessorContext {
  storage: Storage;
  files: FileRepository;
}

/** Everything a handler is given: the job, its payload, and the context. */
export interface ProcessorArgs {
  job: Job<JobPayload>;
  payload: JobPayload;
  context: ProcessorContext;
}

export interface ProcessorResult {
  /** Storage keys of whatever the job produced. */
  outputs: string[];
  /** Anything worth reporting back — dimensions, row counts, and so on. */
  details?: Record<string, unknown>;
}

export type Processor = (args: ProcessorArgs) => Promise<ProcessorResult>;


export const processors: Record<Operation, Processor> = {
  'image.resize': resizeImage,
  'image.convert': convertImage,
  'image.thumbnail': thumbnailImage,
  'csv.validate': validateCsv,
  'csv.transform': transformCsv,
};

/**
 * Runs the handler for a job's operation.
 *
 * The payload is re-validated here rather than trusted. A job may have
 * been enqueued by an older version of the API, or sat in Redis across a
 * deploy; parsing it at the point of use means a malformed payload fails
 * with a clear message instead of causing a confusing error deep inside a
 * handler.
 */
export async function runJob(
  job: Job<JobPayload>,
  context: ProcessorContext,
): Promise<ProcessorResult> {
  const { JobPayloadSchema } = await import('./queue.js');
  const parsed = JobPayloadSchema.safeParse(job.data);

  if (!parsed.success) {
    throw new Error(`Malformed job payload: ${parsed.error.message}`);
  }

  const processor = processors[parsed.data.operation];
  if (!processor) {
    throw new Error(`No processor for operation: ${parsed.data.operation}`);
  }

  return processor({ job, payload: parsed.data, context });
}

/**
 * Runs a job and converts failures that a retry cannot fix.
 *
 * Some failures will never succeed on a second attempt: a file that is
 * gone stays gone, and bytes that are not an image will not become one.
 * Marking those unrecoverable stops BullMQ burning two more attempts —
 * and two more backoff delays — on a result that is already known.
 *
 * This lives beside `runJob` rather than inside the worker because the
 * tests drive jobs through the same path. When the retry policy lived
 * only in the worker file, tests exercised a version of the pipeline that
 * retried permanent failures three times, which is both slower and not
 * what production does.
 */
export async function runJobWithRetryPolicy(
  job: Job<JobPayload>,
  context: ProcessorContext,
): Promise<ProcessorResult> {
  try {
    return await runJob(job, context);
  } catch (error) {
    if (isPermanentFailure(error)) {
      throw new UnrecoverableError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}
