/**
 * Downloading what a job produced.
 *
 * Outputs are addressed by storage key rather than by job id, because one
 * job can produce several files and a caller needs to name which. The key
 * comes back in the job's result, so the flow is: finish the job, read
 * its outputs, fetch one.
 *
 * The response is streamed straight from storage. Reading a finished file
 * into memory before sending it would undo the care taken everywhere else
 * to keep large files off the heap.
 */

import { Router, type Request, type Response } from 'express';
import { basename } from 'node:path';
import type { Storage } from '../storage.js';

export interface DownloadRouterDeps {
  storage: Storage;
}

/** Content types for the formats this service produces. */
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.tiff': 'image/tiff',
  '.csv': 'text/csv',
  // Validation reports are JSON. Without this they would be served as
  // octet-stream, which makes a browser download them instead of showing
  // them, and makes HTTP clients treat the body as binary.
  '.json': 'application/json',
  '.txt': 'text/plain',
};

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  const ext = dot === -1 ? '' : key.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export function createDownloadRouter(deps: DownloadRouterDeps): Router {
  const router = Router();

  // The key contains a slash (`outputs/name.webp`), so the route uses a
  // wildcard rather than a single segment parameter.
  router.get('/files/*splat', async (req: Request, res: Response) => {
    const params = req.params as Record<string, string | string[]>;
    const raw = params.splat ?? '';
    const key = Array.isArray(raw) ? raw.join('/') : raw;

    if (!key) {
      res.status(400).json({ error: 'no_key', message: 'Specify a file key' });
      return;
    }

    try {
      // `exists` also runs the storage layer's path check, so a key that
      // tries to escape the root is refused here rather than served.
      if (!(await deps.storage.exists(key))) {
        res.status(404).json({ error: 'not_found', message: 'No such file' });
        return;
      }
    } catch {
      // The traversal guard threw. Say "not found" rather than confirming
      // that the shape of the attack was recognised.
      res.status(404).json({ error: 'not_found', message: 'No such file' });
      return;
    }

    const size = await deps.storage.size(key);
    const stream = await deps.storage.open(key);

    res.setHeader('Content-Type', contentTypeFor(key));
    res.setHeader('Content-Length', size);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${basename(key)}"`,
    );

    stream.pipe(res);
  });

  return router;
}
