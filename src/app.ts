/**
 * The Express application: middleware, routes, error handling.
 *
 * Built by a factory rather than created at import time, so a test can
 * construct an app with its own dependencies (a fake Redis, a different
 * config) instead of inheriting whatever the module-level singletons
 * happen to be.
 *
 * Express is deliberately minimal compared to a batteries-included
 * framework: it gives routing and middleware, and everything else —
 * validation, docs, error shape — is a choice made here. The order of
 * `app.use` calls matters, because a request passes through them in the
 * order they were registered.
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from './logger.js';
import type { Config } from './config.js';
import type { Storage } from './storage.js';
import type { FileRepository } from './files/repository.js';
import { createUploadRouter, uploadErrorHandler } from './files/routes.js';
import { createJobRouter } from './jobs/routes.js';
import { createDownloadRouter } from './files/download.js';
import { createEventRouter } from './jobs/sse.js';
import type { Queue } from 'bullmq';
import type { JobPayload } from './jobs/queue.js';

export interface AppDependencies {
  config: Config;
  /** Redis handle, or null when running without one (tests, degraded mode). */
  redis: Redis | null;
  /** Where uploaded bytes go. Absent in tests that only exercise health. */
  storage?: Storage;
  /** What we remember about uploads. Absent alongside storage. */
  files?: FileRepository;
  /** The processing queue. Absent in tests that do not exercise jobs. */
  queue?: Queue<JobPayload>;
  /**
   * A Redis connection reserved for pub/sub.
   *
   * Subscribing puts a connection into a mode where it refuses ordinary
   * commands, so this must be separate from `redis`.
   */
  subscriber?: Redis;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Trust the proxy's forwarded headers when running behind one, so
  // client IPs and protocol are the real ones rather than the proxy's.
  app.set('trust proxy', true);

  // JSON body parsing. File uploads are multipart and handled separately
  // in a later phase; this covers ordinary JSON requests.
  app.use(express.json({ limit: '1mb' }));

  // Request logging with a correlation id. Every log line emitted while
  // handling a request carries the same `req.id`, so one request's whole
  // story can be pulled out of an interleaved stream. A caller-supplied
  // X-Request-ID is honoured, which lets a trace span services.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = typeof existing === 'string' && existing ? existing : randomUUID();
        res.setHeader('X-Request-ID', id);
        return id;
      },
      // Health checks would otherwise flood the log with noise.
      autoLogging: {
        ignore: (req) => req.url === '/health/live',
      },
    }),
  );

  /**
   * Liveness: is the process up?
   *
   * Deliberately checks nothing else. An orchestrator restarts a
   * container that fails this, so if it depended on Redis, a brief Redis
   * blip would restart a perfectly healthy API — turning a small outage
   * into a larger one.
   */
  app.get('/health/live', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  /**
   * Readiness: can this instance actually serve traffic?
   *
   * This one does check dependencies, and names the broken one. A load
   * balancer uses it to decide whether to send requests here, and a
   * degraded instance should be taken out of rotation rather than
   * restarted.
   */
  app.get('/health/ready', async (_req: Request, res: Response) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    if (deps.redis) {
      try {
        await deps.redis.ping();
        checks.redis = 'ok';
      } catch (error) {
        checks.redis = error instanceof Error ? error.message : 'unreachable';
        healthy = false;
      }
    } else {
      checks.redis = 'not configured';
      healthy = false;
    }

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checks,
    });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'file-forge',
      docs: '/health/ready',
    });
  });

  // File routes, when the dependencies for them are present.
  if (deps.storage && deps.files) {
    app.use(
      createUploadRouter({
        storage: deps.storage,
        files: deps.files,
        maxUploadBytes: deps.config.maxUploadBytes,
      }),
    );
    // Upload-specific error translation runs before the generic handler,
    // so a too-large file becomes a 413 rather than a 500.
    app.use(uploadErrorHandler);
  }

  if (deps.storage) {
    app.use(createDownloadRouter({ storage: deps.storage }));
  }

  if (deps.queue && deps.files) {
    app.use(createJobRouter({ queue: deps.queue, files: deps.files }));
  }

  if (deps.queue && deps.subscriber) {
    app.use(
      createEventRouter({ queue: deps.queue, subscriber: deps.subscriber }),
    );
  }

  // 404 for anything unmatched, in the same JSON shape as other errors so
  // a client never has to parse two different formats.
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'not_found',
      message: `No route for ${req.method} ${req.path}`,
    });
  });

  // The error handler. Express identifies it by its four parameters, so
  // `next` must stay even though it is unused — hence the eslint-style
  // underscore naming.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    req.log?.error({ err }, 'request_failed');
    const isProd = deps.config.nodeEnv === 'production';
    res.status(500).json({
      error: 'internal_error',
      // Leak the message only outside production; in production a stack
      // trace or internal message is information a caller should not get.
      message: isProd ? 'An unexpected error occurred' : err.message,
    });
  });

  return app;
}
