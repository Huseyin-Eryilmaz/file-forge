/**
 * Talking to the backend.
 *
 * Every response is parsed through the shared contract's schemas rather
 * than cast. A cast is a promise the compiler cannot check — it says
 * "trust me" about data that arrived over a network. Parsing actually
 * verifies, so a server that returns something unexpected fails here,
 * with a message naming the field, instead of somewhere deep in a
 * component reading `undefined`.
 *
 * URLs are relative. In development Vite proxies them to the backend; in
 * production a reverse proxy does the same. Either way the browser only
 * ever talks to its own origin, so there is no CORS to configure.
 */

import {
  UploadResponseSchema,
  CreateJobResponseSchema,
  JobStatusSchema,
  SignedLinkResponseSchema,
  ApiErrorSchema,
  type UploadResponse,
  type CreateJobResponse,
  type JobStatus,
  type SignedLinkResponse,
  type Operation,
} from '@contract';

/**
 * An error carrying what the server actually said.
 *
 * The status and code travel with it so a caller can distinguish "your
 * file was too big" from "the service is down" without string matching.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

async function handleResponse(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    throw new ApiRequestError(
      parsed.success
        ? parsed.data.message
        : `Request failed (${response.status})`,
      response.status,
      parsed.success ? parsed.data.error : undefined,
    );
  }

  return body;
}

export async function uploadFile(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);

  const response = await fetch('/uploads', { method: 'POST', body: form });
  return UploadResponseSchema.parse(await handleResponse(response));
}

export async function createJob(
  fileId: string,
  operation: Operation,
  options: Record<string, unknown> = {},
): Promise<CreateJobResponse> {
  const response = await fetch('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, operation, options }),
  });
  return CreateJobResponseSchema.parse(await handleResponse(response));
}

export async function getJob(jobId: string): Promise<JobStatus> {
  const response = await fetch(`/jobs/${jobId}`);
  return JobStatusSchema.parse(await handleResponse(response));
}

/**
 * Asks the server for a download URL.
 *
 * Going through this rather than building `/files/<key>` by hand means the
 * frontend works unchanged whether or not signed downloads are enabled:
 * with a secret configured the server returns a signed, expiring URL, and
 * without one it returns the plain path.
 */
export async function getDownloadUrl(key: string): Promise<SignedLinkResponse> {
  const response = await fetch('/files/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return SignedLinkResponseSchema.parse(await handleResponse(response));
}

/** Formats a byte count the way a person reads it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** True for keys the browser can render inline. */
export function isPreviewable(key: string): boolean {
  return /\.(png|jpe?g|webp|avif|gif)$/i.test(key);
}
