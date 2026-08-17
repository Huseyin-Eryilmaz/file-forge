/**
 * The whole flow, in one screen: drop a file, pick what to do with it,
 * watch it happen, collect the result.
 *
 * State lives here rather than in the components because the steps are
 * connected — an upload resets any previous job, a running job disables
 * the dropzone. Pushing that coordination down into the children would
 * mean each of them knowing about the others.
 */

import { useState } from 'react';
import { DropZone } from './components/DropZone';
import { OperationPicker } from './components/OperationPicker';
import { ProgressCard } from './components/ProgressCard';
import { ResultCard } from './components/ResultCard';
import { useJobProgress } from './useJobProgress';
import { uploadFile, createJob, formatBytes, ApiRequestError } from './api';
import { kindForMimeType, type Operation, type UploadResponse } from '@contract';
import './App.css';

function App() {
  const [upload, setUpload] = useState<UploadResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const progress = useJobProgress(jobId);
  const running =
    progress.state === 'queued' || progress.state === 'processing';

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);
    // A new file means any previous job's progress and result are stale.
    setJobId(null);
    try {
      setUpload(await uploadFile(file));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
      setUpload(null);
    } finally {
      setUploading(false);
    }
  };

  const handleRun = async (
    operation: Operation,
    options: Record<string, unknown>,
  ) => {
    if (!upload) return;
    setError(null);
    try {
      const job = await createJob(upload.id, operation, options);
      setJobId(job.id);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Could not start the job',
      );
    }
  };

  const kind = upload ? kindForMimeType(upload.mimeType) : null;

  return (
    <div className="container">
      <header className="header">
        <h1>file-forge</h1>
        <p>
          Upload an image or CSV. The work happens in the background, and you
          can watch it as it goes.
        </p>
      </header>

      <DropZone onFile={handleFile} disabled={uploading || running} />

      {uploading && <p className="status">Uploading…</p>}
      {error && <p className="status status--error">{error}</p>}

      {upload && (
        <section className="card">
          <h2>{upload.originalName}</h2>
          <dl className="facts">
            <div>
              <dt>Type</dt>
              <dd>{upload.mimeType}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(upload.size)}</dd>
            </div>
          </dl>
        </section>
      )}

      {upload && kind && (
        <OperationPicker
          // Remounts the picker when the file kind changes, so its selected
          // operation and option fields reset. Without this, switching from an
          // image to a CSV leaves the previous image operation selected — the
          // state was initialised once and prop changes do not revisit it.
          key={kind}
          kind={kind}
          disabled={running}
          onRun={handleRun}
        />
      )}

      <ProgressCard progress={progress} />
      <ResultCard outputs={progress.outputs} />
    </div>
  );
}

export default App;
