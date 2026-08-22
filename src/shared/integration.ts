import type { IntegrationTier, Platform } from './enums.js';
import type { Jurisdiction } from './types.js';

/**
 * The integration readiness engine.
 *
 * This turns the integration strategy from a document into something the
 * pipeline can act on. For every jurisdiction it answers three questions:
 *
 *   1. What channel can we actually transact through today?
 *   2. What specific thing stands between us and a better channel?
 *   3. Given OUR permit volume there, is closing that gap worth the effort?
 *
 * The third question is the one that matters. Statewide platform share is a
 * vanity metric — Tyler EnerGov is the largest footprint in Florida and also
 * the hardest commercial ask. Build order comes from our own volume ranking,
 * which typically puts 60-80% of filings in 10-20 jurisdictions.
 */

export type Pathway = 'api' | 'rpa' | 'manual';

export type BlockerKind =
  | 'no_public_api'
  | 'agency_approval'
  | 'agency_purchase'
  | 'vendor_partner'
  | 'tos_unreviewed'
  | 'no_portal'
  | 'portal_unverified'
  | 'credentials_missing'
  | 'config_mapping';

export interface Blocker {
  kind: BlockerKind;
  label: string;
  /** Who has to say yes. Almost never the vendor. */
  owner: 'agency' | 'vendor' | 'us';
  /** Does money have to change hands, and whose? */
  cost: 'none' | 'our_time' | 'agency_budget';
  detail: string;
}

export interface ReadinessInput {
  jurisdiction: Jurisdiction;
  /** Our own permit count in this jurisdiction over the ranking window. */
  ourVolume: number;
  /** Total across all jurisdictions, for share math. */
  totalVolume: number;
  /** Do we hold working credentials for this jurisdiction already? */
  hasCredentials?: boolean;
}

export interface Readiness {
  jurisdictionId: string;
  /** What we can do today. */
  currentPathway: Pathway;
  /** The best pathway reachable if every blocker below were cleared. */
  targetPathway: Pathway;
  blockers: Blocker[];
  /** One sentence a human can act on tomorrow morning. */
  nextAction: string;
  /** Calendar weeks, not engineering weeks. Agency approvals dominate. */
  estimatedWeeks: number;
  /** 0-100. Volume share x pathway improvement / effort. */
  priorityScore: number;
  /** Which phase of the rollout this belongs to. */
  phase: 0 | 1 | 2 | 3;
  volumeShare: number;
}

/** Ordered worst-to-best so we can compare pathways numerically. */
const PATHWAY_RANK: Record<Pathway, number> = { manual: 0, rpa: 1, api: 2 };

export function pathwayForTier(tier: IntegrationTier): Pathway {
  if (tier === 'api_live') return 'api';
  if (tier === 'rpa') return 'rpa';
  return 'manual';
}

/** The realistic best channel, given what the platform actually permits. */
export function targetPathwayFor(j: Jurisdiction): Pathway {
  if (j.paperOnly || j.platform === 'none') return 'manual';
  if (j.gate.publicApi) return 'api';
  // Tyler and Citizenserve have APIs behind a commercial gate. Reachable, but
  // the ask is a budget line for the agency, so we do not treat it as the
  // default target unless our volume there justifies the campaign.
  if (j.gate.agencyPurchaseRequired || j.gate.vendorPartnerRequired) return 'api';
  if (j.portalUrl) return 'rpa';
  return 'manual';
}

const PLATFORM_ENTRY: Partial<Record<Platform, string>> = {
  accela: 'Self-register at developer.accela.com (free, no commitment), build against the shared sandbox, then ask this agency\'s administrator to approve and install the app.',
  opengov: 'Ask a client contact inside the agency to request API credentials, or to introduce you to their OpenGov customer success manager.',
  clariti: 'Ask the agency\'s Salesforce administrator to create a Connected App — no vendor licensing negotiation needed.',
  energov: 'Find an agency champion willing to fund the Tyler API license, and confirm they are on EPL v9.6.1 or later. Serve them by portal automation until then.',
  citizenserve: 'Contact Citizenserve sales for a scoped integration quote. Expect per-agency pricing; keep automating the portal in the meantime.',
};

export function assessReadiness({
  jurisdiction: j,
  ourVolume,
  totalVolume,
  hasCredentials = false,
}: ReadinessInput): Readiness {
  const currentPathway = pathwayForTier(j.integrationTier);
  const targetPathway = targetPathwayFor(j);
  const blockers: Blocker[] = [];
  let weeks = 0;

  if (targetPathway === 'api' && currentPathway !== 'api') {
    if (!j.gate.publicApi) {
      blockers.push({
        kind: 'no_public_api',
        label: 'No public developer portal',
        owner: 'vendor',
        cost: 'none',
        detail: 'Documentation is partner-gated. You cannot evaluate the surface area before committing.',
      });
      weeks += 4;
    }
    if (j.gate.vendorPartnerRequired) {
      blockers.push({
        kind: 'vendor_partner',
        label: 'Vendor partner program membership',
        owner: 'vendor',
        cost: 'our_time',
        detail: 'Requires an application to the platform vendor before any agency conversation can proceed.',
      });
      weeks += 6;
    }
    if (j.gate.agencyPurchaseRequired) {
      blockers.push({
        kind: 'agency_purchase',
        label: 'Agency must purchase an API license',
        owner: 'agency',
        cost: 'agency_budget',
        detail:
          'Your integration request carries a budget ask for the jurisdiction. You need a champion willing to fund it, not just a technical contact. Lead with staff workload reduction, never with data access.',
      });
      weeks += 20;
    }
    if (j.gate.agencyApprovalRequired) {
      blockers.push({
        kind: 'agency_approval',
        label: 'Agency administrator must approve and install the app',
        owner: 'agency',
        cost: 'none',
        detail: 'Every gate in this market is controlled by a jurisdiction administrator, not the vendor. Budget 1-3 months per agency.',
      });
      weeks += 10;
    }
    if (j.platform === 'accela') {
      blockers.push({
        kind: 'config_mapping',
        label: 'Per-agency configuration mapping',
        owner: 'us',
        cost: 'our_time',
        detail: 'Record types, fee schedules and workflows are customized per agency. Approval is not the finish line.',
      });
      weeks += 2;
    }
    if (!hasCredentials) {
      blockers.push({
        kind: 'credentials_missing',
        label: 'No credentials in the vault',
        owner: 'us',
        cost: 'our_time',
        detail: 'Firm-owned OAuth2 client or API key, stored encrypted. Never a client login.',
      });
    }
  }

  if (targetPathway === 'rpa' || (targetPathway === 'api' && currentPathway === 'manual')) {
    if (!j.portalUrl) {
      blockers.push({
        kind: j.paperOnly ? 'no_portal' : 'portal_unverified',
        label: j.paperOnly ? 'No online portal exists' : 'Portal URL unverified',
        owner: 'us',
        cost: 'our_time',
        detail: j.paperOnly
          ? 'This jurisdiction accepts paper or email only. Manual is the permanent, correct answer here — tool it well rather than treating it as a failure state.'
          : 'Call the building department and confirm the portal before quoting a client a timeline.',
      });
      weeks += j.paperOnly ? 0 : 1;
    }
    if (!j.automationApproved && !j.paperOnly) {
      blockers.push({
        kind: 'tos_unreviewed',
        label: 'Portal terms of service not reviewed',
        owner: 'us',
        cost: 'our_time',
        detail:
          'A human must read this portal\'s terms before the RPA adapter will run. Prefer disclosed, rate-limited, identifiable automation — several jurisdictions will simply say yes if asked.',
      });
      weeks += 1;
    }
  }

  const volumeShare = totalVolume > 0 ? ourVolume / totalVolume : 0;
  const lift = PATHWAY_RANK[targetPathway] - PATHWAY_RANK[currentPathway];

  // Priority: what fraction of our book improves, scaled by how much it
  // improves, damped by how long the gate takes to clear. Volume dominates by
  // design — this is the whole point of ranking by our own filings.
  const effortDamp = 1 / (1 + weeks / 12);
  const priorityScore = Math.round(Math.min(100, volumeShare * 100 * Math.max(lift, 0) * effortDamp * 3));

  let nextAction: string;
  let phase: 0 | 1 | 2 | 3;

  if (j.paperOnly) {
    nextAction = 'Permanent manual tier. Give coordinators a transcription console and log outcomes back into the same schema.';
    phase = 3;
  } else if (lift <= 0) {
    nextAction =
      currentPathway === 'api'
        ? 'Live on API. Monitor for unmapped statuses and re-verify configuration after agency upgrades.'
        : 'At its realistic ceiling for now. Revisit if volume here grows.';
    phase = currentPathway === 'api' ? 1 : 2;
  } else if (targetPathway === 'api') {
    nextAction = PLATFORM_ENTRY[j.platform] ?? 'Identify the agency administrator and open an integration conversation.';
    phase = 1;
  } else {
    nextAction = j.automationApproved
      ? 'Build the read/status poller first. Submission automation only after status polling is stable.'
      : 'Read the portal terms of service, record the decision, then enable the read-only status poller.';
    phase = 2;
  }

  return {
    jurisdictionId: j.id,
    currentPathway,
    targetPathway,
    blockers,
    nextAction,
    estimatedWeeks: weeks,
    priorityScore,
    phase,
    volumeShare,
  };
}

export interface RoadmapSummary {
  items: Readiness[];
  totalVolume: number;
  /** Share of our filings each pathway covers today. */
  coverageToday: Record<Pathway, number>;
  /** Share each pathway would cover if every blocker cleared. */
  coverageAtTarget: Record<Pathway, number>;
  /** How many jurisdictions produce 80% of our filings. The real build list. */
  jurisdictionsFor80Pct: number;
  /** Jurisdictions blocked purely on something we control. Do these first. */
  quickWins: Readiness[];
}

export function buildRoadmap(
  jurisdictions: Jurisdiction[],
  volumeByJurisdiction: Record<string, number>,
  credentialed: Set<string> = new Set(),
): RoadmapSummary {
  const totalVolume = Object.values(volumeByJurisdiction).reduce((a, b) => a + b, 0);
  const items = jurisdictions
    .map((j) =>
      assessReadiness({
        jurisdiction: j,
        ourVolume: volumeByJurisdiction[j.id] ?? 0,
        totalVolume,
        hasCredentials: credentialed.has(j.id),
      }),
    )
    .sort((a, b) => b.priorityScore - a.priorityScore || b.volumeShare - a.volumeShare);

  const zero: Record<Pathway, number> = { api: 0, rpa: 0, manual: 0 };
  const coverageToday = { ...zero };
  const coverageAtTarget = { ...zero };
  for (const it of items) {
    coverageToday[it.currentPathway] += it.volumeShare;
    coverageAtTarget[it.targetPathway] += it.volumeShare;
  }

  const ranked = [...items].sort((a, b) => b.volumeShare - a.volumeShare);
  let cumulative = 0;
  let jurisdictionsFor80Pct = 0;
  for (const it of ranked) {
    if (cumulative >= 0.8) break;
    cumulative += it.volumeShare;
    jurisdictionsFor80Pct++;
  }

  const quickWins = items
    .filter(
      (it) =>
        it.volumeShare > 0 &&
        it.blockers.length > 0 &&
        it.blockers.every((b) => b.owner === 'us'),
    )
    .slice(0, 10);

  return { items, totalVolume, coverageToday, coverageAtTarget, jurisdictionsFor80Pct, quickWins };
}
