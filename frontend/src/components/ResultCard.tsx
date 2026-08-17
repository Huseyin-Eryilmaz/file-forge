/**
 * What the job produced.
 *
 * Download URLs are fetched from the server rather than built here. The
 * server decides whether downloads are signed, so asking it means this
 * component works unchanged in both configurations — with a secret set it
 * gets a signed, expiring link, and without one it gets the plain path.
 * Constructing `/files/<key>` here would work locally and quietly break
 * the moment signing was turned on.
 *
 * Images are shown inline. For anything else — a CSV, a JSON report —
 * there is nothing useful to render in a preview, so it offers the
 * download and says what it is.
 */

import { useState, useEffect } from 'react';
import { getDownloadUrl, isPreviewable } from '../api';

interface ResultCardProps {
  outputs: string[];
}

interface ResolvedOutput {
  key: string;
  url: string;
  previewable: boolean;
}

function fileNameFor(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] ?? key;
}

export function ResultCard({ outputs }: ResultCardProps) {
  const [resolved, setResolved] = useState<ResolvedOutput[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (outputs.length === 0) {
      setResolved([]);
      return;
    }

    // Guards against a slow response landing after the user has already
    // started another job, which would show the wrong result.
    let cancelled = false;

    const resolveAll = async () => {
      try {
        const links = await Promise.all(
          outputs.map(async (key) => ({
            key,
            url: (await getDownloadUrl(key)).url,
            previewable: isPreviewable(key),
          })),
        );
        if (!cancelled) {
          setResolved(links);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError('Could not prepare the download link');
        }
      }
    };

    void resolveAll();
    return () => {
      cancelled = true;
    };
  }, [outputs]);

  if (outputs.length === 0) return null;

  return (
    <section className="card">
      <h2>Result</h2>

      {error && <p className="status status--error">{error}</p>}

      {resolved.map((output) => (
        <div key={output.key} className="result">
          {output.previewable && (
            <img
              className="result__preview"
              src={output.url}
              alt={fileNameFor(output.key)}
            />
          )}
          <div className="result__row">
            <span className="result__name">{fileNameFor(output.key)}</span>
            <a
              className="button button--small"
              href={output.url}
              download={fileNameFor(output.key)}
            >
              Download
            </a>
          </div>
        </div>
      ))}
    </section>
  );
}
