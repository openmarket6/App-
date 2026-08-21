/**
 * Distance between two points on the earth.
 *
 * Used to check that a supervisor is actually at the job site when they check
 * in. That single number is what separates "a visit was logged" from "someone
 * was there", and it is the evidence the whole qualifying service rests on.
 */

const EARTH_RADIUS_METERS = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return Math.round(2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h)));
}

/**
 * How far from the site a check-in may be and still count.
 *
 * 250 m is chosen to be generous rather than strict. Phone GPS is routinely off
 * by 30-50 m, worse beside a steel-framed structure, and a large site's
 * recorded coordinate may be its mailbox rather than where the work is. A tight
 * radius would reject honest supervisors, who would then stop using the app --
 * and an unused evidence trail is worth nothing.
 *
 * Distance is always RECORDED regardless, so an unusual check-in stays visible
 * even when it is accepted.
 */
export const CHECK_IN_RADIUS_METERS = 250;

export interface ProximityResult {
  distanceMeters: number | null;
  withinRadius: boolean;
  /** True when the site has no coordinates, so proximity cannot be judged. */
  unverifiable: boolean;
}

export function assessProximity(
  site: { latitude: number | null; longitude: number | null },
  checkIn: { latitude: number; longitude: number },
): ProximityResult {
  if (site.latitude === null || site.longitude === null) {
    return { distanceMeters: null, withinRadius: false, unverifiable: true };
  }

  const distance = distanceMeters(
    { latitude: site.latitude, longitude: site.longitude },
    checkIn,
  );

  return {
    distanceMeters: distance,
    withinRadius: distance <= CHECK_IN_RADIUS_METERS,
    unverifiable: false,
  };
}
