/**
 * Configuration, read once from the environment and validated at startup.
 *
 * Nothing else in the codebase reads `process.env` directly. That rule is
 * what makes the settings testable (a test can build its own config) and
 * what makes a missing or malformed variable fail loudly at boot rather
 * than quietly at 3am when some code path finally touches it.
 *
 * Zod does the validating and the coercing: a port arrives from the
 * environment as the string "3000" and leaves here as the number 3000,
 * having been checked that it is actually a number in range.
 */

import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  // Which environment we are in. The value shapes logging format and
  // error verbosity, so it is constrained rather than free text.
  nodeEnv: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  port: z.coerce.number().int().min(1).max(65535).default(3000),

  redisUrl: z.string().url().default('redis://localhost:6379'),

  // Where uploaded and processed files live. Local disk for now; the
  // storage layer behind this is an interface, so swapping in S3 later
  // does not ripple through the codebase.
  storageDir: z.string().default('./storage'),

  // Upload limits. A file service without a size cap is an invitation to
  // fill the disk, so this has a default rather than being optional.
  maxUploadBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024), // 50 MB

  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Builds the config from the environment, throwing if anything is wrong.
 *
 * Exported as a function rather than a ready-made object so tests can
 * call it with their own values, and so the failure happens at a moment
 * we control rather than at import time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    redisUrl: env.REDIS_URL,
    storageDir: env.STORAGE_DIR,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    logLevel: env.LOG_LEVEL,
  });

  if (!parsed.success) {
    // Fail with a message that names the offending variables, instead of
    // a stack trace pointing at whichever line first used the bad value.
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  return parsed.data;
}

/**
 * The process-wide config, built once.
 *
 * Modules import this for convenience; anything that needs to vary in a
 * test takes a Config parameter instead.
 */
export const config = loadConfig();

export const isProduction = (c: Config = config): boolean =>
  c.nodeEnv === 'production';
