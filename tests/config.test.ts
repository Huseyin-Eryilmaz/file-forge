/**
 * Configuration loading and validation.
 *
 * These are pure: no server, no Redis. They check that sensible defaults
 * exist, that the environment can override them, and — the point of
 * validating at all — that bad values are rejected loudly rather than
 * silently coerced into something surprising.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  it('works with no environment variables at all', () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });

  it('reads values from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      REDIS_URL: 'redis://cache:6379',
      LOG_LEVEL: 'warn',
    });

    expect(config.nodeEnv).toBe('production');
    expect(config.port).toBe(8080);
    expect(config.redisUrl).toBe('redis://cache:6379');
  });

  it('coerces a port from string to number', () => {
    // Environment variables are always strings; the config layer is where
    // that stops being true for the rest of the codebase.
    const config = loadConfig({ PORT: '4000' });

    expect(config.port).toBe(4000);
    expect(typeof config.port).toBe('number');
  });

  it('rejects an unknown environment name', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(
      /Invalid configuration/,
    );
  });

  it('rejects a port outside the valid range', () => {
    expect(() => loadConfig({ PORT: '99999' })).toThrow(
      /Invalid configuration/,
    );
  });

  it('rejects a malformed Redis URL', () => {
    expect(() => loadConfig({ REDIS_URL: 'not-a-url' })).toThrow(
      /Invalid configuration/,
    );
  });

  it('names the offending variable in the error', () => {
    // The whole reason for validating here is that the failure message
    // points at the cause, rather than a stack trace from wherever the
    // bad value was eventually used.
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/port/);
  });

  it('has an upload size limit by default', () => {
    // A file service with no cap is an invitation to fill the disk, so
    // the limit is a default rather than something you must remember.
    const config = loadConfig({});

    expect(config.maxUploadBytes).toBeGreaterThan(0);
  });
});
