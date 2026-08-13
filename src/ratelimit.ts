/**
 * Rate limiting, backed by Redis.
 *
 * The goal is modest: stop one client — a runaway script as often as a
 * malicious one — from monopolising the service. That matters more here
 * than in a read-only API, because every upload costs disk and every job
 * costs CPU, so the damage from an unbounded caller is not just slow
 * responses but a full disk and a saturated worker.
 *
 * A fixed-window counter, which is the simplest scheme that works: count
 * a client's requests in the current minute, refuse once the count
 * crosses the limit. It allows a burst at a window boundary — twice the
 * limit across two adjacent windows — which a sliding window would not.
 * That trade is deliberate: the sliding version costs a sorted set per
 * client and several commands per request, to fix a case that does not
 * meaningfully change the load this is protecting against.
 *
 * Redis holds the counters for two reasons: the limit then applies across
 * however many API processes are running rather than per-process, and
 * Redis expires the keys itself, so old windows clean themselves up.
 *
 * The whole thing fails **open**. If Redis is unreachable the request is
 * allowed through. A rate limiter that takes the service down when it
 * breaks has done more damage than the traffic it was guarding against.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Redis } from 'ioredis';

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Distinguishes one limiter's counters from another's. */
  bucket: string;
}

/**
 * Identifies the caller.
 *
 * The client IP, taken from Express's `req.ip` — which accounts for
 * `trust proxy`, so a service behind a load balancer limits real clients
 * rather than counting every request against the proxy.
 */
function clientKey(req: Request): string {
  return req.ip ?? 'unknown';
}

export function createRateLimiter(
  redis: Redis | null,
  options: RateLimitOptions,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!redis) {
      next();
      return;
    }

    const window = Math.floor(Date.now() / 1000 / options.windowSeconds);
    const key = `ratelimit:${options.bucket}:${clientKey(req)}:${window}`;

    let count: number;
    try {
      // INCR returns the new value, so the first request in a window
      // creates the key; the expiry is set only then, which keeps this to
      // two commands rather than two on every request.
      count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, options.windowSeconds);
      }
    } catch (error) {
      req.log?.warn({ err: error }, 'rate_limit_unavailable');
      next();
      return;
    }

    const remaining = Math.max(0, options.limit - count);
    res.setHeader('RateLimit-Limit', options.limit);
    res.setHeader('RateLimit-Remaining', remaining);

    if (count > options.limit) {
      const retryAfter = options.windowSeconds;
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'rate_limited',
        message: `Too many requests. Try again in ${retryAfter} seconds.`,
      });
      return;
    }

    next();
  };
}

/**
 * Limits chosen to reflect what each kind of request costs.
 *
 * Reads are cheap and get a generous allowance. Uploads consume disk and
 * jobs consume CPU, so both are held much tighter — the point is not to
 * inconvenience a normal user, who will never come close, but to bound
 * what a single misbehaving client can consume.
 */
export const RATE_LIMITS = {
  read: { limit: 120, windowSeconds: 60, bucket: 'read' },
  upload: { limit: 20, windowSeconds: 60, bucket: 'upload' },
  /** Creating a job is expensive: it commits a worker to real work. */
  job: { limit: 40, windowSeconds: 60, bucket: 'job' },
  /**
   * Asking after a job is cheap, and clients poll.
   *
   * Holding status reads to the same allowance as job creation punishes
   * exactly the well-behaved client that checks on its work — and the
   * SSE stream exists precisely so that polling does not have to be
   * frequent, so this is generous rather than unbounded.
   */
  status: { limit: 300, windowSeconds: 60, bucket: 'status' },
} as const;
