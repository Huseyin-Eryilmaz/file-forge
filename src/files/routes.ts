/**
 * Upload endpoints.
 *
 * The route is thin on purpose: multer has already parsed and validated
 * the request by the time the handler runs, storage owns where bytes go,
 * and the repository owns what we remember about them. What is left here
 * is the translation between HTTP and those three — which is all a route
 * should be.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage.js';
import type { FileRepository, FileRecord } from './repository.js';
import {
  createUploadMiddleware,
  sanitizeFilename,
  storageKeyFor,
  UnsupportedFileTypeError,
} from './upload.js';

export interface UploadRouterDeps {
  storage: Storage;
  files: FileRepository;
  maxUploadBytes: number;
}

export function createUploadRouter(deps: UploadRouterDeps): Router {
  const router = Router();
  const upload = createUploadMiddleware(deps.maxUploadBytes);

  router.post(
    '/uploads',
    // `.single('file')` means: one file, in a form field named "file".
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      if (!req.file) {
        res.status(400).json({
          error: 'no_file',
          message: 'Expected a file in the "file" field',
        });
        return;
      }

      const tempPath = req.file.path;

      try {
        const originalName = sanitizeFilename(req.file.originalname);
        const storageKey = storageKeyFor(originalName);

        // Move the staged temp file into storage. Until this succeeds,
        // nothing has been committed anywhere permanent.
        const stored = await deps.storage.adopt(storageKey, tempPath);

        const record: FileRecord = {
          id: randomUUID(),
          storageKey: stored.key,
          originalName,
          mimeType: req.file.mimetype,
          size: stored.size,
          uploadedAt: new Date().toISOString(),
        };
        await deps.files.save(record);

        req.log?.info(
          { fileId: record.id, size: record.size, type: record.mimeType },
          'file_uploaded',
        );

        res.status(201).json({
          id: record.id,
          originalName: record.originalName,
          mimeType: record.mimeType,
          size: record.size,
          uploadedAt: record.uploadedAt,
        });
      } catch (error) {
        // Do not leave the staged file behind on a failure path.
        await rm(tempPath, { force: true }).catch(() => undefined);
        next(error);
      }
    },
  );

  router.get('/uploads/:id', async (req: Request, res: Response) => {
    // Express types a route param as string | string[]; take the first
    // value so a duplicated param cannot smuggle an array through.
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const record = await deps.files.get(id);

    if (record === null) {
      res.status(404).json({
        error: 'not_found',
        message: 'No upload with that id (it may have expired)',
      });
      return;
    }

    res.json({
      id: record.id,
      originalName: record.originalName,
      mimeType: record.mimeType,
      size: record.size,
      uploadedAt: record.uploadedAt,
    });
  });

  return router;
}

/**
 * Translates upload failures into useful HTTP responses.
 *
 * Without this, a file that exceeds the size limit surfaces as a generic
 * 500, which tells the caller nothing actionable. Registered after the
 * upload router so it sees errors raised inside it.
 */
export function uploadErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof UnsupportedFileTypeError) {
    res.status(415).json({ error: 'unsupported_type', message: err.message });
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: 'file_too_large',
        message: 'The uploaded file exceeds the maximum allowed size',
      });
      return;
    }
    res.status(400).json({ error: 'upload_error', message: err.message });
    return;
  }

  next(err);
}
