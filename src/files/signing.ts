/**
 * Signed download links.
 *
 * The problem: a download URL that never expires is a permanent grant. If
 * it leaks — in a log, a shared screenshot, a chat message — it works
 * forever, and there is no way to take it back.
 *
 * The fix is the pattern behind S3 presigned URLs. The server appends an
 * expiry and a signature to the link. The signature is an HMAC of the key
 * and the expiry, computed with a secret only the server knows, so:
 *
 *   - a client cannot forge a link for a file it was not given
 *   - a client cannot extend its own link's lifetime, because changing
 *     the expiry invalidates the signature
 *   - nothing has to be stored server-side; the link carries its own
 *     proof, and verification is a hash and a comparison
 *
 * What it does *not* do is revoke early. A signed link stays valid until
 * it expires, so the expiry is the thing to keep short.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedLink {
  key: string;
  expires: number;
  signature: string;
}

/**
 * Computes the signature for a key and expiry.
 *
 * The two are joined with a character that cannot appear in a storage key,
 * so that no pair of different inputs can produce the same string to sign
 * — otherwise a key ending in a digit could be confused with an expiry.
 */
function sign(key: string, expires: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${key}\n${expires}`)
    .digest('hex');
}

export function createSignedLink(
  key: string,
  secret: string,
  ttlSeconds: number,
  now: number = Date.now(),
): SignedLink {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  return { key, expires, signature: sign(key, expires, secret) };
}

/** Builds the query string a signed link needs. */
export function signedQuery(link: SignedLink): string {
  return `expires=${link.expires}&signature=${link.signature}`;
}

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' };

/**
 * Checks a link's signature and expiry.
 *
 * The comparison is `timingSafeEqual` rather than `===`. A normal string
 * comparison returns as soon as it finds a differing byte, so how long it
 * takes leaks how much of the signature was correct — enough, with many
 * attempts, to reconstruct a valid one byte by byte. A constant-time
 * comparison takes the same time regardless.
 */
export function verifySignedLink(
  key: string,
  expires: string | undefined,
  signature: string | undefined,
  secret: string,
  now: number = Date.now(),
): VerificationResult {
  if (!expires || !signature) {
    return { ok: false, reason: 'missing' };
  }

  const expiryNumber = Number(expires);
  if (!Number.isFinite(expiryNumber)) {
    return { ok: false, reason: 'invalid' };
  }

  if (expiryNumber < Math.floor(now / 1000)) {
    return { ok: false, reason: 'expired' };
  }

  const expected = sign(key, expiryNumber, secret);
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');

  // timingSafeEqual throws on length mismatch, which is itself a signal —
  // so check length first and return the same answer either way.
  if (given.length !== wanted.length) {
    return { ok: false, reason: 'invalid' };
  }

  return timingSafeEqual(given, wanted)
    ? { ok: true }
    : { ok: false, reason: 'invalid' };
}
