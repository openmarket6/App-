/**
 * Supabase access-token verification.
 *
 * Supports both key types Supabase issues:
 *   - asymmetric (ES256/RS256) verified against the project's published JWKS
 *   - legacy symmetric HS256 verified with SUPABASE_JWT_SECRET
 *
 * Asymmetric is preferred and tried first: the verifying side holds only a
 * public key, so a leak of this service's configuration cannot be used to mint
 * tokens. HS256 uses the same secret to sign and verify, which makes that
 * secret far more dangerous to hold.
 *
 * We verify signature, expiry, issuer and audience. Skipping any of those turns
 * "has a token" into "has a token from somewhere", which is not authentication.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  email?: string;
  /**
   * Authenticator Assurance Level. 'aal2' means the session completed a second
   * factor. Used by requireMfa() to gate sensitive operations.
   */
  aal?: string;
  /** Authentication methods used, e.g. ['password', 'totp']. */
  amr?: Array<{ method: string; timestamp: number }>;
  role?: string;
  session_id?: string;
}

const issuer = env.SUPABASE_URL ? `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1` : undefined;

const jwks =
  env.SUPABASE_URL
    ? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
        // Cache keys, but re-fetch on an unknown kid so key rotation does not
        // cause an outage.
        cacheMaxAge: 10 * 60 * 1000,
        cooldownDuration: 30 * 1000,
      })
    : undefined;

const hmacKey = env.SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET)
  : undefined;

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  if (!jwks && !hmacKey) {
    throw unauthorized('Authentication is not configured on this server');
  }

  const options = {
    audience: env.SUPABASE_JWT_AUDIENCE,
    ...(issuer ? { issuer } : {}),
    clockTolerance: 5, // seconds, for minor clock skew between hosts
  };

  if (jwks) {
    try {
      const { payload } = await jwtVerify(token, jwks, options);
      return payload as AccessTokenClaims;
    } catch (err) {
      // Fall through to HS256 only when one is configured; otherwise this is
      // simply an invalid token.
      if (!hmacKey) {
        logger.debug({ err }, 'asymmetric token verification failed');
        throw unauthorized('Invalid or expired session');
      }
    }
  }

  if (hmacKey) {
    try {
      const { payload } = await jwtVerify(token, hmacKey, options);
      return payload as AccessTokenClaims;
    } catch (err) {
      logger.debug({ err }, 'symmetric token verification failed');
      throw unauthorized('Invalid or expired session');
    }
  }

  throw unauthorized('Invalid or expired session');
}

/** Extract a bearer token, or null. Case-insensitive scheme per RFC 6750. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}
