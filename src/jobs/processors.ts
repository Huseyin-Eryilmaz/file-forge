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

import type { Job } from 'bullmq';
import type { Storage } from '../storage.js';
import type { FileRepository } from '../files/repository.js';
import type { JobPayload, Operation } from './queue.js';

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

/** Raised when a job asks for work on a file that is gone. */
export class MissingFileError extends Error {
  constructor(fileId: string) {
    super(`No stored file with id ${fileId}`);
    this.name = 'MissingFileError';
  }
}

/**
 * A stand-in that proves the machinery without doing real work yet.
 *
 * It checks the file exists — the same first step every real processor
 * takes — and reports progress along the way, so the progress plumbing is
 * exercised from the start rather than bolted on later.
 */
const placeholder: Processor = async ({ job, payload, context }) => {
  const record = await context.files.get(payload.fileId);
  if (record === null) {
    // A missing file is not worth retrying: the file will not reappear.
    throw new MissingFileError(payload.fileId);
  }

  const exists = await context.storage.exists(record.storageKey);
  if (!exists) {
    throw new MissingFileError(payload.fileId);
  }

  await job.updateProgress(25);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await job.updateProgress(75);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await job.updateProgress(100);

  return {
    outputs: [record.storageKey],
    details: {
      placeholder: true,
      operation: payload.operation,
      originalName: record.originalName,
      size: record.size,
    },
  };
};

export const processors: Record<Operation, Processor> = {
  'image.resize': placeholder,
  'image.convert': placeholder,
  'image.thumbnail': placeholder,
  'csv.validate': placeholder,
  'csv.transform': placeholder,
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
