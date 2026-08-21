/**
 * Adapter for jurisdictions with a portal but no API.
 *
 * This is the majority of Florida. Most smaller municipalities run eTRAKiT,
 * CityView, MyGovernmentOnline or a bespoke page: a human can look a permit up,
 * but nothing machine-readable is published.
 *
 * Rather than pretending otherwise, this returns 'skipped' with a deep link
 * straight to the jurisdiction's lookup page. A permit tech gets one click
 * instead of a search, which is a genuine saving, and nobody is told a status
 * that was never actually retrieved.
 */
import type { MunicipalAdapter, PermitCheckInput, PermitCheckResult } from '../adapter.js';
import { renderTemplate } from './configurable.js';

export function createPortalOnlyAdapter(params: {
  key: string;
  displayName: string;
  /** e.g. "https://permits.example.gov/lookup?permit={permitNumber}" */
  lookupUrlTemplate?: string | null;
}): MunicipalAdapter {
  return {
    key: params.key,
    displayName: params.displayName,
    automated: false,

    async checkPermitStatus(input: PermitCheckInput): Promise<PermitCheckResult> {
      const reference = input.externalReference ?? input.permitNumber;

      const lookupUrl = params.lookupUrlTemplate
        ? renderTemplate(params.lookupUrlTemplate, {
            permitNumber: input.permitNumber,
            externalReference: input.externalReference,
            reference,
          })
        : (input.municipality.portalUrl ?? null);

      return {
        outcome: 'skipped',
        detectedStatus: 'unknown',
        message:
          `${input.municipality.name} does not publish a permit status API. ` +
          'A team member must check the portal and update this permit.',
        ...(lookupUrl ? { extra: { lookupUrl, requiresHuman: true } } : { extra: { requiresHuman: true } }),
      };
    },
  };
}
