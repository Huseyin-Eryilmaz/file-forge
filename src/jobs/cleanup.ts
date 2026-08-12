/**
 * Removing files that have outlived their purpose.
 *
 * Uploads here are transient: a file arrives, is processed, is collected.
 * Nothing collects it a week later. Without a sweep, though, the disk
 * grows forever — and the growth is invisible until it is a problem,
 * because nothing in normal operation ever looks at old files.
 *
 * The metadata in Redis already expires on its own, which creates the
 * asymmetry this job exists to fix: after a day the record is gone but
 * the bytes remain, unreferenced and unidentifiable. Age on disk is
 * therefore the thing to sweep by, not the presence of a record.
 */

import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';

export interface CleanupResult {
  scanned: number;
  deleted: number;
  bytesFreed: number;
  /** Files that could not be removed; logged, not fatal. */
  errors: number;
}

/**
 * Deletes files older than `maxAgeHours` under `root`.
 *
 * Walks one directory level deep, which matches how storage lays files
 * out (`uploads/`, `outputs/`). Deliberately not recursive: an unbounded
 * walk over a directory an operator has pointed at the wrong place is a
 * destructive mistake waiting to happen.
 */
export async function cleanupOldFiles(
  root: string,
  maxAgeHours: number,
  now: number = Date.now(),
  logger?: Logger,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    scanned: 0,
    deleted: 0,
    bytesFreed: 0,
    errors: 0,
  };
  const cutoff = now - maxAgeHours * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // No storage directory yet — nothing to clean, and not an error.
    return result;
  }

  for (const entry of entries) {
    const directory = join(root, entry);

    let stats;
    try {
      stats = await stat(directory);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) {
      continue;
    }

    let files: string[];
    try {
      files = await readdir(directory);
    } catch {
      continue;
    }

    for (const name of files) {
      const path = join(directory, name);
      result.scanned += 1;

      try {
        const fileStats = await stat(path);
        if (!fileStats.isFile()) {
          continue;
        }
        // mtime, not birthtime: some filesystems do not record creation
        // time reliably, and for files that are written once they are the
        // same thing anyway.
        if (fileStats.mtimeMs >= cutoff) {
          continue;
        }

        await rm(path, { force: true });
        result.deleted += 1;
        result.bytesFreed += fileStats.size;
      } catch (error) {
        // One unremovable file must not stop the sweep — the next run
        // will try again, and the rest of the directory still gets freed.
        result.errors += 1;
        logger?.warn({ path, err: error }, 'cleanup_file_failed');
      }
    }
  }

  return result;
}
