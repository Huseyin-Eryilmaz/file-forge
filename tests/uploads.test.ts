/**
 * Uploads, end to end: a real HTTP request, a real temp directory, a real
 * Redis.
 *
 * The cases worth having are the ones that protect the boundary — a file
 * that is too big, a type we do not handle, a filename designed to escape
 * the storage root. The happy path matters too, but it is the failures
 * that decide whether this endpoint is safe to expose.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type Redis from 'ioredis';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalStorage } from '../src/storage.js';
import { FileRepository } from '../src/files/repository.js';
import { sanitizeFilename, storageKeyFor } from '../src/files/upload.js';
import { probeRedis, testRedis } from './helpers.js';

// Probed once at load so the suites can be skipped outright when Redis is
// absent, instead of each test individually discovering it is unusable.
const available = await probeRedis();

let redis: Redis;
let storageRoot: string;

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  MAX_UPLOAD_BYTES: '1048576', // 1 MB, so the size test does not need a huge file
});

async function buildApp() {
  const storage = new LocalStorage(storageRoot);
  const files = new FileRepository(redis);
  return createApp({ config, redis, storage, files });
}

beforeAll(async () => {
  if (!available) return;
  redis = testRedis('uploads');
  storageRoot = await mkdtemp(join(tmpdir(), 'file-forge-test-'));
});

afterAll(async () => {
  if (!available) return;
  await redis.quit();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!available) return;
  // Safe to flush: this suite has a Redis database to itself.
  await redis.flushdb();
});

describe.skipIf(!available)('uploading a file', () => {
  it('accepts an image and returns an id', async () => {
    const app = await buildApp();

    const response = await request(app)
      .post('/uploads')
      .attach('file', Buffer.from('fake-png-bytes'), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeTruthy();
    expect(response.body.originalName).toBe('photo.png');
    expect(response.body.size).toBe('fake-png-bytes'.length);
  });

  it('accepts a CSV', async () => {
    const app = await buildApp();

    const response = await request(app)
      .post('/uploads')
      .attach('file', Buffer.from('a,b\n1,2\n'), {
        filename: 'data.csv',
        contentType: 'text/csv',
      });

    expect(response.status).toBe(201);
  });

  it('writes the bytes into storage', async () => {
    const app = await buildApp();

    await request(app).post('/uploads').attach('file', Buffer.from('hello'), {
      filename: 'note.csv',
      contentType: 'text/csv',
    });

    const uploads = await readdir(join(storageRoot, 'uploads'));
    expect(uploads.length).toBeGreaterThan(0);
  });

  it('rejects a request with no file', async () => {
    const app = await buildApp();

    const response = await request(app).post('/uploads');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('no_file');
  });

  it('rejects a type we do not handle', async () => {
    const app = await buildApp();

    const response = await request(app)
      .post('/uploads')
      .attach('file', Buffer.from('MZ\x90\x00'), {
        filename: 'thing.exe',
        contentType: 'application/x-msdownload',
      });

    // An allow-list means anything unlisted is refused, rather than us
    // trying to enumerate everything dangerous.
    expect(response.status).toBe(415);
    expect(response.body.error).toBe('unsupported_type');
  });

  it('rejects a file over the size limit', async () => {
    const app = await buildApp();
    // The configured limit above is 1 MB.
    const tooBig = Buffer.alloc(2 * 1024 * 1024, 0x41);

    const response = await request(app)
      .post('/uploads')
      .attach('file', tooBig, { filename: 'big.png', contentType: 'image/png' });

    expect(response.status).toBe(413);
    expect(response.body.error).toBe('file_too_large');
  });
});

describe.skipIf(!available)('reading upload metadata', () => {
  it('returns the record for a known id', async () => {
    const app = await buildApp();
    const created = await request(app)
      .post('/uploads')
      .attach('file', Buffer.from('x'), {
        filename: 'a.png',
        contentType: 'image/png',
      });

    const response = await request(app).get(`/uploads/${created.body.id}`);

    expect(response.status).toBe(200);
    expect(response.body.originalName).toBe('a.png');
  });

  it('404s for an unknown id', async () => {
    const app = await buildApp();

    const response = await request(app).get('/uploads/does-not-exist');

    expect(response.status).toBe(404);
  });
});

describe.skipIf(!available)('filename handling', () => {
  it('strips directory components', () => {
    // The classic path-traversal shape. The name is metadata only, but it
    // still must not carry separators into a header or a log line.
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\system32\\cmd.exe')).toBe('cmd.exe');
  });

  it('replaces characters that break filesystems and headers', () => {
    expect(sanitizeFilename('re:port<1>.csv')).toBe('re_port_1_.csv');
  });

  it('falls back to a placeholder for an empty name', () => {
    expect(sanitizeFilename('')).toBe('unnamed');
    expect(sanitizeFilename('///')).toBe('unnamed');
  });

  it('caps absurd lengths', () => {
    const long = 'a'.repeat(500) + '.png';
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(255);
  });

  it('generates a storage key that ignores the original name', () => {
    // Users control the filename; they must not control where bytes land.
    const key = storageKeyFor('../../evil.png');

    expect(key.startsWith('uploads/')).toBe(true);
    expect(key).not.toContain('..');
    expect(key.endsWith('.png')).toBe(true);
  });

  it('generates a different key every time', () => {
    expect(storageKeyFor('same.png')).not.toBe(storageKeyFor('same.png'));
  });
});

describe.skipIf(!available)('storage safety', () => {
  it('refuses a key that escapes the root', async () => {
    const storage = new LocalStorage(storageRoot);

    // Keys are generated internally so this should be unreachable — which
    // is why it is worth asserting that the guard is really there.
    await expect(storage.exists('../../../etc/passwd')).rejects.toThrow(
      /escapes storage root/,
    );
  });
});
