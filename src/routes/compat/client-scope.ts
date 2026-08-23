/**
 * Which contractor a request is about.
 *
 * A CLIENT session is pinned to one company, so a clientId naming a different
 * one has always been ignored: `auth.role === 'CLIENT' ? auth.clientId :
 * body.clientId` appears in several handlers and is why a contractor cannot
 * write into somebody else's tenant. That part is right and stays.
 *
 * What was wrong is what the caller was told. Two endpoints -- compliance and
 * support -- answered 201 to "create this for Beta" having created it for
 * Alpha. Nothing in the response said so. A contractor who mistypes an id, or
 * a script pointed at the wrong company, gets a success and a record filed
 * somewhere they did not ask for, and finds out when somebody notices an
 * insurance certificate on the wrong account.
 *
 * So a mismatch is now a refusal rather than a quiet substitution. The
 * behaviour is unchanged for every honest caller: a CLIENT that sends no
 * clientId, or sends its own, is scoped exactly as before.
 */
import type { FastifyRequest } from 'fastify';
import { forbidden } from '../../lib/errors.js';

export function resolveClientId(
  req: FastifyRequest,
  requested: string | null | undefined,
): string | null {
  const auth = req.apiAuth!;
  if (auth.role !== 'CLIENT') return requested ?? null;
  if (!auth.clientId) {
    throw forbidden('This account is not linked to a contractor company');
  }
  if (requested && requested !== auth.clientId) {
    throw forbidden('You can only do that for your own company');
  }
  return auth.clientId;
}
