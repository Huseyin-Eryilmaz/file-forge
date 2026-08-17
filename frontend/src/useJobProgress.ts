/**
 * Watching a job's progress over server-sent events.
 *
 * Written as a hook so the connection's lifetime is tied to the component
 * that needs it: React runs the cleanup when the component unmounts or the
 * job changes, and that closes the stream. Forgetting that is how these
 * leak — the user moves on, the browser holds the connection open, and the
 * server keeps a subscription alive for a listener that is no longer
 * looking.
 *
 * `EventSource` reconnects on its own if the connection drops, which is
 * the main reason the server speaks SSE rather than WebSockets: the
 * reconnection logic is the browser's problem, not ours.
 */

import { useState, useEffect } from 'react';
import { JobEventSchema, type JobEvent } from '@contract';

export interface JobProgress {
  state: JobEvent['state'] | 'idle';
  progress: number;
  /** Storage keys the job produced, once it has finished. */
  outputs: string[];
  error: string | null;
}

const IDLE: JobProgress = {
  state: 'idle',
  progress: 0,
  outputs: [],
  error: null,
};

/** Pulls the output keys out of a result whose shape we only half-know. */
function outputsFrom(result: unknown): string[] {
  if (result === null || typeof result !== 'object') return [];
  const outputs = (result as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs)) return [];
  return outputs.filter((value): value is string => typeof value === 'string');
}

export function useJobProgress(jobId: string | null): JobProgress {
  const [progress, setProgress] = useState<JobProgress>(IDLE);

  useEffect(() => {
    if (jobId === null) {
      setProgress(IDLE);
      return;
    }

    // Start clean: a previous job's final state must not linger on screen
    // while the new one is still queued.
    setProgress({ state: 'queued', progress: 0, outputs: [], error: null });

    const source = new EventSource(`/jobs/${jobId}/events`);

    source.onmessage = (message) => {
      const parsed = JobEventSchema.safeParse(JSON.parse(message.data));
      if (!parsed.success) return;

      const event = parsed.data;
      setProgress({
        state: event.state,
        progress: event.progress,
        outputs: outputsFrom(event.result),
        error: event.error ?? null,
      });

      // The server closes the stream once the job settles. Closing this
      // side too stops EventSource trying to reconnect to a job that has
      // nothing left to say.
      if (event.state === 'completed' || event.state === 'failed') {
        source.close();
      }
    };

    source.onerror = () => {
      // EventSource retries by itself, so a transient error is not worth
      // reporting — only a connection that has definitively closed is.
      if (source.readyState === EventSource.CLOSED) {
        setProgress((current) =>
          current.state === 'completed' || current.state === 'failed'
            ? current
            : { ...current, error: 'Lost connection to the server' },
        );
      }
    };

    return () => source.close();
  }, [jobId]);

  return progress;
}
