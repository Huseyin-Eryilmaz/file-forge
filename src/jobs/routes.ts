/**
 * Job endpoints: ask for work, then ask how it is going.
 *
 * `POST /jobs` returns immediately with an id — it does not wait for the
 * work. That is the contract the queue exists to provide: the caller is
 * never held open while something slow happens, and can come back to
 * `GET /jobs/:id` whenever it suits them.
 */

import { Router, type Request, type Response } from 'express';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import type { FileRepository } from '../files/repository.js';
import { OperationSchema, type JobPayload } from './queue.js';
import { incrementCounter } from '../metrics.js';
import type { Redis } from 'ioredis';

const CreateJobSchema = z.object({
  fileId: z.string().min(1),
  operation: OperationSchema,
  options: z.record(z.string(), z.unknown()).optional(),
});

export interface JobRouterDeps {
  queue: Queue<JobPayload>;
  files: FileRepository;
  /** Used for counters only. */
  redis?: Redis | null;
}

/** Maps BullMQ's internal states onto a small, stable public vocabulary. */
function publicState(state: string): string {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'active':
      return 'processing';
    case 'delayed':
      return 'retrying';
    case 'waiting':
    case 'waiting-children':
    case 'prioritized':
      return 'queued';
    default:
      return state;
  }
}

export function createJobRouter(deps: JobRouterDeps): Router {
  const router = Router();

  router.post('/jobs', async (req: Request, res: Response) => {
    const parsed = CreateJobSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(422).json({
        error: 'invalid_request',
        message: 'Check fileId and operation',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    // Confirm the file exists before queueing. Without this the job would
    // be accepted, wait its turn, and only then fail — a slow, confusing
    // way to learn about a typo in an id.
    const record = await deps.files.get(parsed.data.fileId);
    if (record === null) {
      res.status(404).json({
        error: 'file_not_found',
        message: 'No upload with that id (it may have expired)',
      });
      return;
    }

    const job = await deps.queue.add(parsed.data.operation, {
      fileId: parsed.data.fileId,
      operation: parsed.data.operation,
      options: parsed.data.options ?? {},
    });

    req.log?.info(
      { jobId: job.id, operation: parsed.data.operation, fileId: parsed.data.fileId },
      'job_queued',
    );

    await incrementCounter(deps.redis ?? null, 'jobs_queued_total');

    res.status(202).json({
      id: job.id,
      state: 'queued',
      operation: parsed.data.operation,
      fileId: parsed.data.fileId,
    });
  });

  router.get('/jobs/:id', async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    const job = await deps.queue.getJob(id);
    if (!job) {
      res.status(404).json({
        error: 'not_found',
        message: 'No job with that id (it may have been cleaned up)',
      });
      return;
    }

    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;

    res.json({
      id: job.id,
      state: publicState(state),
      progress,
      operation: job.data.operation,
      fileId: job.data.fileId,
      attempts: job.attemptsMade,
      // Present only once the job has actually finished one way or another.
      ...(state === 'completed' ? { result: job.returnvalue } : {}),
      ...(state === 'failed' ? { error: job.failedReason } : {}),
    });
  });

  return router;
}
