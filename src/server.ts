/**
 * The entry point: open connections, start listening, shut down cleanly.
 *
 * The interesting part is the shutdown. When Docker stops a container it
 * sends SIGTERM and then waits; a process that ignores it gets killed
 * mid-request. So we stop accepting new connections, let in-flight
 * requests finish, close Redis, and only then exit — with a timeout, so a
 * stuck request cannot hold the shutdown open forever.
 */

import Redis from 'ioredis';
import { mkdir } from 'node:fs/promises';
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { LocalStorage } from './storage.js';
import { FileRepository } from './files/repository.js';
import { createQueue } from './jobs/queue.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const redis = new Redis(config.redisUrl, {
    // Fail fast on a bad connection rather than retrying forever in the
    // background while requests pile up against a dead dependency.
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });

  redis.on('error', (err) => {
    // Log, but do not crash: readiness will report Redis as broken, and
    // the process stays up so it can recover when Redis returns.
    logger.error({ err }, 'redis_error');
  });

  // Make sure the storage root exists before anything tries to write to
  // it, rather than failing on the first upload.
  await mkdir(config.storageDir, { recursive: true });

  const storage = new LocalStorage(config.storageDir);
  const files = new FileRepository(redis);

  // BullMQ needs its own connection with retries disabled off the request
  // path; sharing the API's fail-fast connection breaks its blocking reads.
  const queueConnection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });
  queueConnection.on('error', (err) => logger.error({ err }, 'queue_redis_error'));
  const queue = createQueue(queueConnection);

  // A third connection, reserved for pub/sub: Redis refuses ordinary
  // commands on a connection that has subscribed to anything.
  const subscriber = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });
  subscriber.on('error', (err) => logger.error({ err }, 'subscriber_error'));

  const app = createApp({ config, redis, storage, files, queue, subscriber });

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv },
      'server_started',
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown_started');

    const forceExit = setTimeout(() => {
      logger.warn('shutdown_timeout_exceeded');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Do not let this timer itself keep the process alive.
    forceExit.unref();

    server.close(async (err) => {
      if (err) {
        logger.error({ err }, 'server_close_failed');
      }
      try {
        await queue.close();
        await subscriber.quit();
        await queueConnection.quit();
        await redis.quit();
      } catch (error) {
        logger.warn({ err: error }, 'redis_quit_failed');
      }
      logger.info('shutdown_complete');
      process.exit(err ? 1 : 0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'startup_failed');
  process.exit(1);
});
