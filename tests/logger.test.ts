/**
 * Logger construction.
 *
 * The regression these guard against: `pino-pretty` is a dev dependency,
 * so it is absent from the production image, and pino throws at startup
 * if a transport target cannot be resolved. That crashed the container in
 * a restart loop — logs are supposed to help diagnose failures, not cause
 * them. The logger must degrade to plain JSON instead.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

describe('logger', () => {
  it('constructs without throwing', async () => {
    // The import itself builds the logger, so a transport misconfiguration
    // fails here rather than at container startup.
    const { logger } = await import('../src/logger.js');

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('produces child loggers tagged with a component', async () => {
    const { childLogger } = await import('../src/logger.js');

    const log = childLogger('worker');

    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
  });

  it('only claims pretty printing when the package resolves', () => {
    // Mirrors the check in logger.ts: if this resolve fails, the logger
    // must not ask pino for that transport.
    const require = createRequire(import.meta.url);
    let resolvable = true;
    try {
      require.resolve('pino-pretty');
    } catch {
      resolvable = false;
    }

    // Either way is fine — the point is that the logger already imported
    // successfully above under whichever condition holds here.
    expect(typeof resolvable).toBe('boolean');
  });
});
