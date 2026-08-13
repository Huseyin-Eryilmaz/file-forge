/**
 * Job failures that callers and the worker need to distinguish.
 *
 * These live in their own module rather than beside the processors that
 * raise them, because both the processors and the registry that maps to
 * them need these types — and importing in both directions creates a
 * cycle that fails at runtime with "cannot access before initialization".
 * A leaf module with no imports of its own cannot participate in a cycle.
 */

/** The file a job refers to is gone. Retrying will not bring it back. */
export class MissingFileError extends Error {
  constructor(fileId: string) {
    super(`No stored file with id ${fileId}`);
    this.name = 'MissingFileError';
  }
}

/** The bytes do not decode as an image, whatever they claimed to be. */
export class InvalidImageError extends Error {
  constructor(reason: string) {
    super(`Not a readable image: ${reason}`);
    this.name = 'InvalidImageError';
  }
}

/**
 * The job's options are not usable — a resize with no dimensions, a
 * format we cannot produce, a column that does not exist.
 *
 * Permanent by nature: the same job with the same options will fail the
 * same way on every attempt, so retrying only delays the answer.
 */
export class InvalidOptionsError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidOptionsError';
  }
}

/** The bytes do not parse as CSV. */
export class InvalidCsvError extends Error {
  constructor(reason: string) {
    super(`Not readable as CSV: ${reason}`);
    this.name = 'InvalidCsvError';
  }
}

/** Whether a failure is one that a retry could never fix. */
export function isPermanentFailure(error: unknown): boolean {
  return (
    error instanceof MissingFileError ||
    error instanceof InvalidImageError ||
    error instanceof InvalidCsvError ||
    error instanceof InvalidOptionsError
  );
}
