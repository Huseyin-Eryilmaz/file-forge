/**
 * Accepting an upload: what we allow in, and how we hold it.
 *
 * Multer parses the multipart body and writes the file to a temporary
 * directory. It lands on disk rather than in memory on purpose — buffering
 * a 50 MB upload in RAM works fine until fifty people do it at once, at
 * which point the process runs out of memory. Streaming it to a temp file
 * keeps memory flat regardless of size or concurrency.
 *
 * From there the route hands it to storage, which moves it into place.
 * The temp file is the staging area: if validation fails or the request
 * dies halfway, nothing has been committed to permanent storage.
 */

import multer from 'multer';
import { tmpdir } from 'node:os';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

/**
 * The types we are willing to process.
 *
 * An allow-list, not a block-list. A block-list is a losing game — you
 * are trying to enumerate everything dangerous — while an allow-list
 * fails closed: anything not explicitly permitted is refused.
 */
export const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  // Tabular data
  'text/csv',
  'application/csv',
  'text/plain', // browsers often send .csv as text/plain
]);

export class UnsupportedFileTypeError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported file type: ${mimeType}`);
    this.name = 'UnsupportedFileTypeError';
  }
}

/**
 * Strips a filename down to something safe to echo back and store as
 * metadata.
 *
 * The original name is never used as a path — storage keys are generated
 * — but it does get returned in API responses and could end up in a
 * Content-Disposition header, so directory separators, control characters
 * and absurd lengths are removed here rather than trusted downstream.
 */
export function sanitizeFilename(name: string): string {
  const withoutPath = name.replace(/^.*[\\/]/, '');
  const cleaned = withoutPath
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim();

  const safe = cleaned.length > 0 ? cleaned : 'unnamed';
  return safe.length > 255 ? safe.slice(0, 255) : safe;
}

/**
 * Builds the storage key for an upload.
 *
 * The key is a fresh UUID plus the original extension. Using a generated
 * name means a user cannot influence where bytes land, and cannot collide
 * with another upload; keeping the extension means the file is still
 * recognisable to tools that care about it.
 */
export function storageKeyFor(originalName: string): string {
  const ext = extname(originalName).toLowerCase().slice(0, 10);
  return `uploads/${randomUUID()}${ext}`;
}

export function createUploadMiddleware(maxBytes: number) {
  return multer({
    dest: tmpdir(),
    limits: {
      fileSize: maxBytes,
      // One file per request, and a tight cap on other form fields — an
      // upload endpoint has no reason to accept a hundred of either, and
      // the limits close off a cheap way to tie up the parser.
      files: 1,
      fields: 10,
    },
    fileFilter: (_req: Request, file, callback) => {
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        callback(new UnsupportedFileTypeError(file.mimetype));
        return;
      }
      callback(null, true);
    },
  });
}
