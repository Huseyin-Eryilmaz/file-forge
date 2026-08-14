/**
 * The shapes the HTTP API speaks.
 *
 * This module is the contract between server and browser, and it is
 * deliberately the only thing the frontend imports from the backend. That
 * constraint is what makes sharing possible at all: everything here is
 * plain types and Zod schemas, with no import of Redis, BullMQ, Express or
 * the filesystem, so pulling it into a browser bundle drags nothing along.
 *
 * The point of sharing rather than retyping is that drift becomes a
 * compile error. Rename a field on the server and the frontend stops
 * building, instead of silently reading `undefined` at runtime — which is
 * exactly the failure that a hand-copied interface produces, and only in
 * the browser, and only once someone clicks the right thing.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------

export const OperationSchema = z.enum([
  'image.resize',
  'image.convert',
  'image.thumbnail',
  'csv.validate',
  'csv.transform',
]);

export type Operation = z.infer<typeof OperationSchema>;

/** Which operations apply to which kind of file. */
export const OPERATIONS_BY_KIND = {
  image: ['image.resize', 'image.convert', 'image.thumbnail'],
  csv: ['csv.validate', 'csv.transform'],
} as const satisfies Record<string, readonly Operation[]>;

/** Human labels, so the UI does not have to invent its own wording. */
export const OPERATION_LABELS: Record<Operation, string> = {
  'image.resize': 'Resize',
  'image.convert': 'Convert format',
  'image.thumbnail': 'Thumbnail',
  'csv.validate': 'Validate',
  'csv.transform': 'Clean up',
};

export function kindForMimeType(mimeType: string): 'image' | 'csv' | null {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.includes('csv') || mimeType === 'text/plain') return 'csv';
  return null;
}

// ---------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------

export const UploadResponseSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  uploadedAt: z.string(),
});

export type UploadResponse = z.infer<typeof UploadResponseSchema>;

// ---------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------

/**
 * The states a job can be in, as the API reports them.
 *
 * A smaller vocabulary than BullMQ's internal one on purpose: callers do
 * not need to distinguish "waiting" from "prioritized", and collapsing
 * them means the server can change queue internals without breaking the
 * client.
 */
export const JobStateSchema = z.enum([
  'queued',
  'processing',
  'retrying',
  'completed',
  'failed',
]);

export type JobState = z.infer<typeof JobStateSchema>;

export const JobResultSchema = z.object({
  outputs: z.array(z.string()),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type JobResult = z.infer<typeof JobResultSchema>;

export const JobStatusSchema = z.object({
  id: z.string(),
  state: JobStateSchema,
  progress: z.number(),
  operation: OperationSchema,
  fileId: z.string(),
  attempts: z.number().optional(),
  result: JobResultSchema.nullish(),
  error: z.string().nullish(),
});

export type JobStatus = z.infer<typeof JobStatusSchema>;

/** What `POST /jobs` accepts. */
export const CreateJobRequestSchema = z.object({
  fileId: z.string().min(1),
  operation: OperationSchema,
  options: z.record(z.string(), z.unknown()).optional(),
});

export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

/** What `POST /jobs` returns: an acknowledgement, not a result. */
export const CreateJobResponseSchema = z.object({
  id: z.string(),
  state: JobStateSchema,
  operation: OperationSchema,
  fileId: z.string(),
});

export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

// ---------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------

/** One message from `GET /jobs/:id/events`. */
export const JobEventSchema = z.object({
  jobId: z.string(),
  state: z.enum(['queued', 'processing', 'completed', 'failed']),
  progress: z.number().min(0).max(100),
  operation: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type JobEvent = z.infer<typeof JobEventSchema>;

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/**
 * The error body every failing endpoint returns.
 *
 * One shape for every failure means a client parses errors in one place
 * rather than guessing per endpoint.
 */
export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  issues: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------
// Download links
// ---------------------------------------------------------------------

export const SignedLinkResponseSchema = z.object({
  url: z.string(),
  signed: z.boolean(),
  expiresAt: z.string().optional(),
});

export type SignedLinkResponse = z.infer<typeof SignedLinkResponseSchema>;
