/**
 * Time-based one-time passwords (RFC 6238).
 *
 * Implemented against node:crypto rather than pulled from a package. This is
 * forty lines of well-specified arithmetic sitting directly on the
 * authentication path, and a dependency there is a supply-chain question every
 * time it updates. The specification has not changed since 2011.
 *
 * Compatible with Google Authenticator, 1Password, Authy and the rest: SHA-1,
 * six digits, thirty-second steps. SHA-1 is not a weakness here -- HOTP uses it
 * as an HMAC, where collision resistance is not what is being relied on -- and
 * every authenticator app in circulation assumes it.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGITS = 6;
const STEP_SECONDS = 30;

/**
 * How many steps either side of now to accept.
 *
 * One step, so a code entered as it rolls over is still taken. Wider would be
 * friendlier and would also widen the window an intercepted code stays usable
 * in, which is the whole thing this is defending.
 */
const WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret. 20 bytes is the RFC 4226 recommendation. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // Counter is 64-bit big-endian. Written as two 32-bit halves because a
  // JavaScript number cannot hold the full range exactly.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Is this the code the authenticator is showing?
 *
 * Compared with timingSafeEqual. A plain === leaks, through how long it takes
 * to fail, roughly how many leading digits were right -- which turns a million
 * guesses into far fewer.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now: Date = new Date(),
): boolean {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== DIGITS) return false;

  const secret = base32Decode(secretBase32);
  if (secret.length === 0) return false;

  const counter = Math.floor(now.getTime() / 1000 / STEP_SECONDS);
  const supplied = Buffer.from(clean);

  let matched = false;
  for (let drift = -WINDOW; drift <= WINDOW; drift += 1) {
    const expected = Buffer.from(hotp(secret, counter + drift));
    // Every candidate is compared, with no early exit, so the time taken does
    // not reveal which step matched.
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
      matched = true;
    }
  }
  return matched;
}

/** The URI an authenticator app scans. */
export function otpauthUri(params: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * Recovery codes, for the phone that goes in a swimming pool.
 *
 * Without these, losing a device means an administrator locked out of the
 * system that administers administrators. Single-use, and stored hashed like
 * any other credential.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
