/**
 * Where files live, behind an interface.
 *
 * Today everything lands on local disk. Tomorrow it might be S3 or a
 * mounted volume shared between workers, and the difference should be one
 * new class rather than a change rippling through every module that
 * touches a file. So callers depend on `Storage`, not on `fs`.
 *
 * The interface is deliberately small — save, open, delete, exists — and
 * speaks in **keys**, not paths. A key is an opaque identifier the
 * storage layer maps to a location however it likes. That is what keeps
 * the abstraction honest: an S3 implementation has no filesystem paths to
 * hand back, so if callers were allowed to ask for paths, the interface
 * would already be leaking local-disk assumptions.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, rename } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export interface StoredFile {
  key: string;
  size: number;
}

export interface Storage {
  /** Writes a stream under `key`, returning what was stored. */
  save(key: string, source: Readable): Promise<StoredFile>;
  /**
   * Writes the output of a multi-stage pipeline.
   *
   * Prefer this over piping the stages together and passing the tail to
   * `save`: only when every stage is in one `pipeline` call does a
   * failure in any of them reject rather than hang.
   */
  saveFrom(
    key: string,
    source: Readable,
    ...stages: NodeJS.ReadWriteStream[]
  ): Promise<StoredFile>;
  /** Moves an already-written local file into storage under `key`. */
  adopt(key: string, localPath: string): Promise<StoredFile>;
  /** Opens a stored file for reading. Throws if the key is unknown. */
  open(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
}

/**
 * Local-disk storage rooted at a single directory.
 *
 * Every key is resolved against the root and then checked to still be
 * inside it. That check is the guard against path traversal: a key of
 * `../../etc/passwd` resolves outside the root, and is rejected rather
 * than obediently written there. Keys are generated internally rather
 * than taken from users, so this should never trigger — which is exactly
 * why it is worth asserting.
 */
export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolves a key to an absolute path, refusing anything outside root. */
  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Refusing key that escapes storage root: ${key}`);
    }
    return full;
  }

  async save(key: string, source: Readable): Promise<StoredFile> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });

    // `pipeline` wires the streams together and — importantly — cleans up
    // both if either fails. Piping by hand leaks file handles on error.
    //
    // Note what this does *not* cover: if a caller builds a chain with
    // `.pipe()` and hands over only its tail, a failure earlier in that
    // chain never reaches here — the tail simply stops producing and this
    // write waits for an end that never arrives. Callers that build
    // multi-stage pipelines should use `saveFrom` instead.
    await pipeline(source, createWriteStream(target));

    const { size } = await stat(target);
    return { key, size };
  }

  /**
   * Writes the result of a multi-stage pipeline.
   *
   * The stages are passed individually rather than pre-piped, so they can
   * all go into one `pipeline` call. That is what makes a failure in any
   * stage — a parser rejecting malformed input, a transform raising on a
   * missing column — surface as a rejection here, instead of hanging.
   */
  async saveFrom(
    key: string,
    source: Readable,
    ...stages: NodeJS.ReadWriteStream[]
  ): Promise<StoredFile> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });

    await pipeline(source, ...stages, createWriteStream(target));

    const { size } = await stat(target);
    return { key, size };
  }

  async adopt(key: string, localPath: string): Promise<StoredFile> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });

    try {
      // A rename is atomic and instant when both paths are on the same
      // filesystem — no copying a large upload byte by byte.
      await rename(localPath, target);
    } catch (error) {
      // Across filesystems rename fails with EXDEV; fall back to copying.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }
      await pipeline(createReadStream(localPath), createWriteStream(target));
      await rm(localPath, { force: true });
    }

    const { size } = await stat(target);
    return { key, size };
  }

  async open(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    // Confirm it exists first, so a missing key fails here with a clear
    // error rather than as a stream error mid-response.
    await stat(path);
    return createReadStream(path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    // Resolve outside the try, so a key that escapes the root propagates
    // as the security error it is. Swallowing it here would turn "this
    // key is dangerous" into the far milder "this file is missing".
    const path = this.pathFor(key);
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    const { size } = await stat(this.pathFor(key));
    return size;
  }
}
