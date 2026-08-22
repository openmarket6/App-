/**
 * The second factor.
 *
 * requireMfa existed from the beginning and read a claim only SUPABASE tokens
 * carry. The application signs in natively, so every endpoint demanding a
 * second factor was either unreachable or -- where one was moved onto the
 * native path -- silently demanding nothing. These tests exist so that cannot
 * quietly become true again.
 */
import { describe, it, expect } from 'vitest';
import {
  generateSecret, verifyTotp, base32Encode, base32Decode,
  otpauthUri, generateRecoveryCodes,
} from '../src/auth/totp.js';
import { createHmac } from 'node:crypto';

/** Generates the code an authenticator app would show, for a given moment. */
function codeAt(secretBase32: string, at: Date): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(at.getTime() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const d = createHmac('sha1', key).update(buf).digest();
  const o = d[d.length - 1]! & 0x0f;
  const bin =
    ((d[o]! & 0x7f) << 24) | ((d[o + 1]! & 0xff) << 16) |
    ((d[o + 2]! & 0xff) << 8) | (d[o + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

describe('TOTP', () => {
  it('matches the RFC 6238 test vector', () => {
    // The published vector for secret "12345678901234567890" at T=59 is
    // 94287082. Checked at six digits, which is what authenticator apps show.
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(verifyTotp(secret, '287082', new Date(59 * 1000))).toBe(true);
  });

  it('accepts the code an authenticator is showing right now', () => {
    const secret = generateSecret();
    const now = new Date();
    expect(verifyTotp(secret, codeAt(secret, now), now)).toBe(true);
  });

  it('still accepts a code from the step just gone', () => {
    // Somebody reading a code as it rolls over should not be told they are
    // wrong. One step of tolerance, no more.
    const secret = generateSecret();
    const now = new Date();
    const justBefore = new Date(now.getTime() - 30_000);
    expect(verifyTotp(secret, codeAt(secret, justBefore), now)).toBe(true);
  });

  it('refuses a code from five minutes ago', () => {
    // The window has to close. A code that stays valid is a code worth
    // intercepting.
    const secret = generateSecret();
    const now = new Date();
    const old = new Date(now.getTime() - 5 * 60_000);
    expect(verifyTotp(secret, codeAt(secret, old), now)).toBe(false);
  });

  it('refuses another account code', () => {
    const mine = generateSecret();
    const theirs = generateSecret();
    const now = new Date();
    expect(verifyTotp(mine, codeAt(theirs, now), now)).toBe(false);
  });

  it('refuses malformed input without throwing', () => {
    // These arrive from a form. A crash here is a 500 on the login page.
    const secret = generateSecret();
    for (const bad of ['', 'abcdef', '12345', '1234567', '   ', 'not-a-code']) {
      expect(verifyTotp(secret, bad), bad).toBe(false);
    }
  });

  it('round-trips base32', () => {
    const secret = generateSecret();
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });

  it('builds a URI an authenticator can scan', () => {
    const uri = otpauthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      account: 'kat@example.com',
      issuer: 'One Contractor Solutions',
    });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('issues distinct recovery codes', () => {
    // These are the way back in when a phone is lost. Duplicates would
    // silently reduce how many attempts somebody actually has.
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(c))).toBe(true);
  });
});
