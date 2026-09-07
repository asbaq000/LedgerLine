/**
 * Stripe webhook signature verification.
 *
 * Implemented directly against the documented scheme rather than delegating to
 * stripe.webhooks.constructEvent, for two reasons: the failure modes become
 * testable offline (no SDK, no network, no live secret), and the replay-window
 * check is explicit instead of implicit.
 *
 * Header format:
 *   Stripe-Signature: t=1492774577,v1=5257a869...,v1=<second during rotation>
 *
 * signed_payload = `${t}.${rawBody}`
 * expected       = HMAC-SHA256(signed_payload, endpointSecret) in hex
 *
 * Three things have to be right, and each is a real vulnerability if skipped:
 *
 *   1. Sign the RAW BODY BYTES. Verifying against re-serialised JSON is the
 *      classic break -- key order and whitespace change the bytes, so either
 *      every event fails or, worse, someone "fixes" it by disabling the check.
 *   2. Compare in constant time. A byte-by-byte early return leaks the expected
 *      signature to a patient attacker.
 *   3. Enforce a timestamp tolerance. Without it a valid old payload can be
 *      replayed forever; the signature stays valid because it always was.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_SECONDS = 300;

export class SignatureVerificationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SignatureVerificationError';
    this.code = code;
    this.statusCode = 400;
  }
}

/** Parse `t=...,v1=...,v1=...` into its parts. */
export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header.length === 0) {
    throw new SignatureVerificationError('missing Stripe-Signature header', 'missing_header');
  }

  let timestamp = null;
  const signatures = [];

  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }

  if (timestamp === null || !Number.isFinite(timestamp)) {
    throw new SignatureVerificationError('malformed Stripe-Signature: no valid timestamp', 'malformed_header');
  }
  if (signatures.length === 0) {
    throw new SignatureVerificationError('malformed Stripe-Signature: no v1 signature', 'malformed_header');
  }
  return { timestamp, signatures };
}

export function computeSignature({ payload, timestamp, secret }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(body)
    .digest('hex');
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Length is not secret here (it is a fixed-width hex digest), but bail
  // explicitly rather than letting it throw.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a webhook signature.
 *
 * @param {object} args
 * @param {Buffer|string} args.payload RAW request body, exactly as received.
 * @param {string} args.header Stripe-Signature header value.
 * @param {string} args.secret Endpoint secret (whsec_...).
 * @param {number} [args.toleranceSeconds] Replay window. 0 disables the check.
 * @param {number} [args.now] Epoch seconds, injectable for tests.
 * @returns {{timestamp: number}} on success
 * @throws {SignatureVerificationError}
 */
export function verifySignature({
  payload,
  header,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Math.floor(Date.now() / 1000),
}) {
  if (!secret) {
    throw new SignatureVerificationError('no endpoint secret configured', 'no_secret');
  }

  const { timestamp, signatures } = parseSignatureHeader(header);
  const expected = computeSignature({ payload, timestamp, secret });

  // Any v1 entry may match: Stripe sends two during endpoint secret rotation.
  const matched = signatures.some((sig) => constantTimeEquals(sig, expected));
  if (!matched) {
    throw new SignatureVerificationError('signature does not match payload', 'signature_mismatch');
  }

  if (toleranceSeconds > 0) {
    const age = now - timestamp;
    if (age > toleranceSeconds) {
      throw new SignatureVerificationError(
        `timestamp outside tolerance window (${age}s old, max ${toleranceSeconds}s)`,
        'timestamp_too_old',
      );
    }
    // Guard the future too: a far-future timestamp would otherwise stay valid
    // past the point where a replayed request should have expired.
    if (age < -toleranceSeconds) {
      throw new SignatureVerificationError(
        `timestamp is ${-age}s in the future`,
        'timestamp_in_future',
      );
    }
  }

  return { timestamp };
}

/** Build a valid header. Used by tests and by the local webhook simulator. */
export function signPayload({ payload, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  const v1 = computeSignature({ payload, timestamp, secret });
  return `t=${timestamp},v1=${v1}`;
}
