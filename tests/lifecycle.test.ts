/**
 * File lifecycle: signed download links, and sweeping old files away.
 *
 * The signing tests care about the cases an attacker would try — a link
 * with no signature, one that has been edited, one whose time has passed
 * — because those are the reasons signing exists. The cleanup tests care
 * about the opposite risk: a sweep that deletes too much is far worse
 * than one that deletes too little.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm, mkdir, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalStorage } from '../src/storage.js';
import {
  createSignedLink,
  signedQuery,
  verifySignedLink,
} from '../src/files/signing.js';
import { cleanupOldFiles } from '../src/jobs/cleanup.js';

const SECRET = 'a-test-secret';

let storageRoot: string;

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'ff-life-test-'));
  await mkdir(join(storageRoot, 'outputs'), { recursive: true });
  await writeFile(join(storageRoot, 'outputs', 'demo.txt'), 'hello world');
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

function buildApp(secret: string) {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DOWNLOAD_SECRET: secret,
    DOWNLOAD_TTL_SECONDS: '900',
  });
  return createApp({
    config,
    redis: null,
    storage: new LocalStorage(storageRoot),
  });
}

describe('signature verification', () => {
  it('accepts a link it just produced', () => {
    const link = createSignedLink('outputs/a.png', SECRET, 900);

    const result = verifySignedLink(
      link.key,
      String(link.expires),
      link.signature,
      SECRET,
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const link = createSignedLink('outputs/a.png', 'other-secret', 900);

    const result = verifySignedLink(
      link.key,
      String(link.expires),
      link.signature,
      SECRET,
    );

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a link for a different key', () => {
    // The key is part of what is signed, so a signature cannot be moved
    // from one file to another.
    const link = createSignedLink('outputs/a.png', SECRET, 900);

    const result = verifySignedLink(
      'outputs/secret.png',
      String(link.expires),
      link.signature,
      SECRET,
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an extended expiry', () => {
    // The whole point: a client cannot give itself more time, because the
    // expiry is covered by the signature.
    const link = createSignedLink('outputs/a.png', SECRET, 900);

    const result = verifySignedLink(
      link.key,
      String(link.expires + 86_400),
      link.signature,
      SECRET,
    );

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports an expired link as expired, not invalid', () => {
    // Worth distinguishing: expired means "ask for a new one", invalid
    // means "something is wrong with this request".
    const past = Date.now() - 3_600_000;
    const link = createSignedLink('outputs/a.png', SECRET, 60, past);

    const result = verifySignedLink(
      link.key,
      String(link.expires),
      link.signature,
      SECRET,
    );

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a link with no signature at all', () => {
    const result = verifySignedLink(
      'outputs/a.png',
      String(Math.floor(Date.now() / 1000) + 900),
      undefined,
      SECRET,
    );

    expect(result).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('downloads with signing enabled', () => {
  it('refuses an unsigned request', async () => {
    const app = buildApp(SECRET);

    const response = await request(app).get('/files/outputs/demo.txt');

    expect(response.status).toBe(403);
  });

  it('serves a correctly signed request', async () => {
    const app = buildApp(SECRET);
    const link = createSignedLink('outputs/demo.txt', SECRET, 900);

    const response = await request(app).get(
      `/files/outputs/demo.txt?${signedQuery(link)}`,
    );

    expect(response.status).toBe(200);
    expect(response.text).toBe('hello world');
  });

  it('returns 410 for an expired link', async () => {
    const app = buildApp(SECRET);
    const link = createSignedLink(
      'outputs/demo.txt',
      SECRET,
      60,
      Date.now() - 3_600_000,
    );

    const response = await request(app).get(
      `/files/outputs/demo.txt?${signedQuery(link)}`,
    );

    expect(response.status).toBe(410);
  });

  it('mints a link for a file that exists', async () => {
    const app = buildApp(SECRET);

    const response = await request(app)
      .post('/files/links')
      .send({ key: 'outputs/demo.txt' });

    expect(response.status).toBe(200);
    expect(response.body.signed).toBe(true);
    expect(response.body.url).toContain('signature=');
  });

  it('will not mint a link for a file that does not exist', async () => {
    const app = buildApp(SECRET);

    const response = await request(app)
      .post('/files/links')
      .send({ key: 'outputs/nope.txt' });

    expect(response.status).toBe(404);
  });
});

describe('downloads with signing disabled', () => {
  it('serves without a signature', async () => {
    // The development default: needing a signature to look at your own
    // output would be friction with no benefit locally.
    const app = buildApp('');

    const response = await request(app).get('/files/outputs/demo.txt');

    expect(response.status).toBe(200);
  });

  it('returns a plain URL from the minting endpoint', async () => {
    const app = buildApp('');

    const response = await request(app)
      .post('/files/links')
      .send({ key: 'outputs/demo.txt' });

    expect(response.body.signed).toBe(false);
    expect(response.body.url).toBe('/files/outputs/demo.txt');
  });
});

describe('cleanup', () => {
  /** Backdates a file so it looks older than it is. */
  async function age(path: string, hours: number): Promise<void> {
    const when = new Date(Date.now() - hours * 3_600_000);
    await utimes(path, when, when);
  }

  it('deletes files past the retention window', async () => {
    await mkdir(join(storageRoot, 'uploads'), { recursive: true });
    const old = join(storageRoot, 'uploads', 'old.txt');
    await writeFile(old, 'old');
    await age(old, 48);

    const result = await cleanupOldFiles(storageRoot, 24);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await readdir(join(storageRoot, 'uploads'))).not.toContain('old.txt');
  });

  it('leaves recent files alone', async () => {
    // Deleting too much is far worse than deleting too little.
    await mkdir(join(storageRoot, 'uploads'), { recursive: true });
    await writeFile(join(storageRoot, 'uploads', 'fresh.txt'), 'new');

    await cleanupOldFiles(storageRoot, 24);

    expect(await readdir(join(storageRoot, 'uploads'))).toContain('fresh.txt');
  });

  it('reports how much space it freed', async () => {
    await mkdir(join(storageRoot, 'uploads'), { recursive: true });
    const old = join(storageRoot, 'uploads', 'big.txt');
    await writeFile(old, 'x'.repeat(1000));
    await age(old, 48);

    const result = await cleanupOldFiles(storageRoot, 24);

    expect(result.bytesFreed).toBeGreaterThanOrEqual(1000);
  });

  it('handles a storage directory that does not exist', async () => {
    // Before the first upload there is nothing there, and that is not an
    // error worth failing a scheduled job over.
    const result = await cleanupOldFiles(
      join(storageRoot, 'does-not-exist'),
      24,
    );

    expect(result.scanned).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('counts what it scanned even when nothing is old enough', async () => {
    await mkdir(join(storageRoot, 'uploads'), { recursive: true });
    await writeFile(join(storageRoot, 'uploads', 'a.txt'), 'a');
    await writeFile(join(storageRoot, 'uploads', 'b.txt'), 'b');

    const result = await cleanupOldFiles(storageRoot, 24);

    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.deleted).toBe(0);
  });
});
