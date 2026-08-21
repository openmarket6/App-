/**
 * Choosing an adapter for a jurisdiction.
 *
 * The decision is deliberately conservative, in this order:
 *
 *   1. Not verified?              -> portal-only. Automated checking is gated on
 *                                    a human having confirmed the endpoint
 *                                    really works (0011 enforces this with a
 *                                    CHECK constraint too).
 *   2. Verified and configured?   -> the configurable HTTP adapter.
 *   3. Anything else              -> portal-only.
 *
 * The effect is that a misconfigured jurisdiction degrades to "a person must
 * look", never to a confidently wrong status.
 */
import type { MunicipalAdapter } from '../adapter.js';
import { createConfigurableAdapter, type StatusCheckConfig } from './configurable.js';
import { createPortalOnlyAdapter } from './portalOnly.js';
import { logger } from '../../../lib/logger.js';

export interface MunicipalityIntegration {
  id: string;
  name: string;
  platform: string;
  portal_url: string | null;
  api_base_url: string | null;
  api_config: Record<string, unknown>;
  adapter_verified_at: string | null;
  supports_status_check: boolean;
}

/** Vendors whose platform we recognise but which publish no usable API. */
const PORTAL_ONLY_PLATFORMS = new Set([
  'centralsquare', 'cityview', 'mygovernmentonline', 'iworq',
  'govbuilt', 'cloudpermit', 'citizenserve', 'none',
]);

export function resolveForMunicipality(
  municipality: MunicipalityIntegration,
  credentials: { username: string | null; secret: string | null } | null,
): MunicipalAdapter {
  const portalFallback = () =>
    createPortalOnlyAdapter({
      key: `${municipality.platform}:portal`,
      displayName: `${municipality.name} (portal lookup)`,
      lookupUrlTemplate:
        (municipality.api_config?.['lookupUrlTemplate'] as string | undefined) ??
        municipality.portal_url,
    });

  if (!municipality.adapter_verified_at) {
    return portalFallback();
  }

  if (PORTAL_ONLY_PLATFORMS.has(municipality.platform)) {
    return portalFallback();
  }

  const statusCheck = municipality.api_config?.['statusCheck'] as StatusCheckConfig | undefined;

  if (!statusCheck?.urlTemplate || !statusCheck.statusPath) {
    logger.warn(
      { municipalityId: municipality.id, platform: municipality.platform },
      'jurisdiction is marked verified but has no usable statusCheck config; falling back to portal',
    );
    return portalFallback();
  }

  return createConfigurableAdapter({
    key: `${municipality.platform}:${municipality.id}`,
    displayName: `${municipality.name} (${municipality.platform})`,
    config: statusCheck,
    secret: credentials?.secret ?? null,
    username: credentials?.username ?? null,
  });
}

export { createConfigurableAdapter, createPortalOnlyAdapter };
export type { StatusCheckConfig };
