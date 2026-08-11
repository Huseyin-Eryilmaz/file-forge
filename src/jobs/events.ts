/**
 * Carrying job progress from the worker to whoever is watching.
 *
 * The awkward fact this module exists to solve: progress is *known* in
 * the worker process and *needed* in the API process. They are separate
 * containers with no shared memory, so something has to sit between them.
 *
 * Redis pub/sub is that something. The worker publishes an event as the
 * job moves along; the API subscribes and forwards to any connected
 * client. Pub/sub rather than a list or a key: these events are only
 * interesting to whoever is listening *now*. A client that connects
 * halfway through has missed the earlier percentages, and that is fine —
 * it will get the current state from the status endpoint and every update
 * after that. Storing the history would be work nobody reads.
 *
 * Note the deliberate consequence: if nobody is watching, events go
 * nowhere and cost nothing.
 */

import type { Redis } from 'ioredis';
import { z } from 'zod';

const CHANNEL_PREFIX = 'job-events:';

export const JobEventSchema = z.object({
  jobId: z.string(),
  /** Where the job is now, in the same vocabulary the status endpoint uses. */
  state: z.enum(['queued', 'processing', 'completed', 'failed']),
  progress: z.number().min(0).max(100),
  operation: z.string().optional(),
  /** Present on completion. */
  result: z.unknown().optional(),
  /** Present on failure. */
  error: z.string().optional(),
});

export type JobEvent = z.infer<typeof JobEventSchema>;

export function channelFor(jobId: string): string {
  return `${CHANNEL_PREFIX}${jobId}`;
}

/**
 * Publishes one event. Best-effort by design.
 *
 * A failure to publish must never fail the job: the work has been done
 * either way, and losing a progress update is a cosmetic loss. The job's
 * real state is always recoverable from the status endpoint.
 */
export async function publishJobEvent(
  redis: Redis,
  event: JobEvent,
): Promise<void> {
  try {
    await redis.publish(channelFor(event.jobId), JSON.stringify(event));
  } catch {
    // Swallowed on purpose — see above.
  }
}

/**
 * A subscription to one job's events.
 *
 * Returns an unsubscribe function rather than expecting the caller to
 * remember the channel name. Every path that opens one of these must call
 * it, or the connection leaks; making it the return value is the smallest
 * nudge toward getting that right.
 */
export async function subscribeToJob(
  subscriber: Redis,
  jobId: string,
  onEvent: (event: JobEvent) => void,
): Promise<() => Promise<void>> {
  const channel = channelFor(jobId);

  const handler = (incoming: string, payload: string): void => {
    if (incoming !== channel) {
      return;
    }
    try {
      const parsed = JobEventSchema.safeParse(JSON.parse(payload));
      if (parsed.success) {
        onEvent(parsed.data);
      }
    } catch {
      // A malformed message is dropped rather than crashing the listener.
    }
  };

  subscriber.on('message', handler);
  await subscriber.subscribe(channel);

  return async () => {
    subscriber.off('message', handler);
    try {
      await subscriber.unsubscribe(channel);
    } catch {
      // The connection may already be closing; nothing useful to do.
    }
  };
}
