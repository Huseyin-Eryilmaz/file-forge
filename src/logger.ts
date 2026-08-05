/**
 * Structured logging.
 *
 * Logs are JSON in production, because that is what log aggregators
 * parse, and human-readable when developing, because nobody wants to read
 * raw JSON in a terminal all day. Same idea either way: every line is a
 * set of fields, not a sentence with values glued into it — so a log
 * search can filter on `jobId` rather than pattern-matching prose.
 */

import pino from 'pino';
import { createRequire } from 'node:module';
import { config, isProduction } from './config.js';

/**
 * Whether pretty-printing is available.
 *
 * `pino-pretty` is a dev dependency, so it is absent from the production
 * image — and pino throws at startup if a transport target cannot be
 * resolved. Checking for it means the same code runs in both places:
 * pretty logs when developing locally, plain JSON in a container, and
 * never a crash because a formatting nicety is missing.
 */
function prettyAvailable(): boolean {
  if (isProduction()) {
    return false;
  }
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: config.logLevel,

  transport: prettyAvailable()
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,

  // Never log these, whatever a caller passes. Belt and braces: the code
  // should not put secrets in log context in the first place, but a
  // redaction list means one careless call site cannot leak them.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password'],
    remove: true,
  },
});

/**
 * A child logger tagged with a component name.
 *
 * `const log = childLogger('worker')` gives every line from that module a
 * `component: "worker"` field, which is how you tell the API's logs from
 * the worker's when they share a stream.
 */
export function childLogger(component: string): pino.Logger {
  return logger.child({ component });
}
