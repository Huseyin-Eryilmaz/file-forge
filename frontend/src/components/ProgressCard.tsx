/**
 * The live view of a running job.
 *
 * The bar is driven by server-sent events rather than polling, so it moves
 * as the work actually happens rather than in one-second steps. The CSS
 * transition on its width does the rest: the server sends a handful of
 * discrete percentages, and the animation reads them as continuous
 * motion.
 */

import type { JobProgress } from '../useJobProgress';

const STATE_LABELS: Record<string, string> = {
  queued: 'Queued',
  processing: 'Processing',
  completed: 'Done',
  failed: 'Failed',
};

interface ProgressCardProps {
  progress: JobProgress;
}

export function ProgressCard({ progress }: ProgressCardProps) {
  if (progress.state === 'idle') return null;

  const done = progress.state === 'completed';
  const failed = progress.state === 'failed';

  const fillClasses = [
    'bar__fill',
    done && 'bar__fill--done',
    failed && 'bar__fill--failed',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="card">
      <h2>{STATE_LABELS[progress.state] ?? progress.state}</h2>

      <div className="bar">
        <div
          className={fillClasses}
          // A failed job fills the bar and turns it red: leaving it
          // part-full would suggest work still to come.
          style={{ width: `${failed ? 100 : progress.progress}%` }}
        />
      </div>

      {!done && !failed && <p className="status">{progress.progress}%</p>}
      {failed && <p className="status status--error">{progress.error}</p>}
    </section>
  );
}
