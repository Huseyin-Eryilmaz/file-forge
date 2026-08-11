/**
 * Live job progress over Server-Sent Events.
 *
 * SSE is a plain HTTP response that never ends: the server writes events
 * into it as they happen and the client reads them as they arrive. That
 * suits this exactly — updates only ever travel server-to-client, so the
 * two-way machinery of WebSockets would be complexity bought for nothing.
 * It also comes with automatic reconnection in every browser, which a
 * WebSocket implementation would have to write itself.
 *
 * The format is as simple as it looks: `data: <json>` followed by a blank
 * line. The blank line is what marks the end of an event, and forgetting
 * it is the classic reason an SSE stream appears to hang.
 *
 * Two things get careful attention here, because both are how SSE
 * endpoints leak in production:
 *
 *   - **Cleanup.** A client that closes its tab leaves a subscription
 *     behind unless the server notices. Every exit path unsubscribes.
 *   - **Keep-alive.** Proxies and load balancers cut connections that go
 *     quiet. A periodic comment costs almost nothing and keeps the path
 *     open through them.
 */

import { Router, type Request, type Response } from 'express';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { subscribeToJob, type JobEvent } from './events.js';
import type { JobPayload } from './queue.js';

/** How often to send a keep-alive comment. */
const KEEPALIVE_MS = 15_000;

/**
 * How long a connection may stay open.
 *
 * A watcher for a job that never settles would otherwise hold a
 * connection and a Redis subscription indefinitely. The client can always
 * reconnect; an endpoint that never lets go cannot.
 */
const MAX_CONNECTION_MS = 10 * 60 * 1000;

export interface EventRouterDeps {
  queue: Queue<JobPayload>;
  /**
   * A connection dedicated to subscribing.
   *
   * Redis puts a connection into subscriber mode, after which it will not
   * answer ordinary commands — so this cannot be the same client the rest
   * of the app uses.
   */
  subscriber: Redis;
}

function writeEvent(res: Response, event: JobEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createEventRouter(deps: EventRouterDeps): Router {
  const router = Router();

  router.get('/jobs/:id/events', async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const jobId = Array.isArray(rawId) ? rawId[0] : rawId;

    const job = await deps.queue.getJob(jobId);
    if (!job) {
      res.status(404).json({
        error: 'not_found',
        message: 'No job with that id (it may have been cleaned up)',
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Nginx buffers responses by default, which would hold events back
      // until the buffer filled — defeating the point entirely.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let closed = false;
    let unsubscribe: (() => Promise<void>) | null = null;

    const keepalive = setInterval(() => {
      // A line beginning with `:` is a comment: ignored by the client,
      // but traffic as far as any proxy in between is concerned.
      res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);

    const timeout = setTimeout(() => void cleanup(), MAX_CONNECTION_MS);

    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      clearTimeout(timeout);
      if (unsubscribe) {
        await unsubscribe();
      }
      res.end();
    };

    // The client hanging up is the normal way this ends.
    req.on('close', () => void cleanup());

    unsubscribe = await subscribeToJob(deps.subscriber, jobId, (event) => {
      if (closed) return;
      writeEvent(res, event);

      // Once the job has settled there is nothing further to report, so
      // close rather than leaving the connection open forever.
      if (event.state === 'completed' || event.state === 'failed') {
        void cleanup();
      }
    });

    // Send the current state immediately. Without this, a client that
    // connects to an already-finished job would wait for an event that
    // has already been and gone.
    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;

    if (state === 'completed') {
      writeEvent(res, {
        jobId: String(job.id),
        state: 'completed',
        progress: 100,
        operation: job.data.operation,
        result: job.returnvalue,
      });
      await cleanup();
      return;
    }

    if (state === 'failed') {
      writeEvent(res, {
        jobId: String(job.id),
        state: 'failed',
        progress: 0,
        operation: job.data.operation,
        error: job.failedReason,
      });
      await cleanup();
      return;
    }

    writeEvent(res, {
      jobId: String(job.id),
      state: state === 'active' ? 'processing' : 'queued',
      progress,
      operation: job.data.operation,
    });
  });

  return router;
}
