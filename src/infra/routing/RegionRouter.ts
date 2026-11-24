/**
 * MR-01 — RegionRouter
 *
 * Region-aware proxy routing for distributed deployment.
 * Determines the closest OTK region from a lat/lng coordinate and
 * resolves the full URL for a given path within that region.
 *
 * Regions:
 *   us-east      — North America east coast
 *   eu-west      — Europe (AWS eu-west-1 / GCP europe-west1)
 *   ap-southeast — Asia-Pacific (AWS ap-southeast-1)
 *
 * @module infra/routing/RegionRouter
 * @since W9-C (MR-01)
 */

export type Region = 'us-east' | 'eu-west' | 'ap-southeast';

export const REGION_ENDPOINTS: Record<Region, string> = {
  'us-east': 'https://otk-us.example.com',
  'eu-west': 'https://otk-eu.example.com',
  'ap-southeast': 'https://otk-ap.example.com',
};

/**
 * Determine the nearest region from a WGS-84 latitude/longitude.
 *
 * Uses a simple centroid-distance heuristic — good enough for routing
 * decisions where sub-region precision is not required.
 *
 * Centroids:
 *   us-east:      40.0°N, 76.0°W
 *   eu-west:      51.0°N,  1.0°W
 *   ap-southeast:  1.4°N, 103.8°E
 */
export function getRegionFromLatLng(lat: number, lng: number): Region {
  const centroids: Array<{ region: Region; lat: number; lng: number }> = [
    { region: 'us-east', lat: 40.0, lng: -76.0 },
    { region: 'eu-west', lat: 51.0, lng: -1.0 },
    { region: 'ap-southeast', lat: 1.4, lng: 103.8 },
  ];

  let nearest: Region = 'us-east';
  let minDist = Infinity;
  for (const c of centroids) {
    const dLat = lat - c.lat;
    const dLng = lng - c.lng;
    const dist = dLat * dLat + dLng * dLng; // squared Euclidean — sufficient for routing
    if (dist < minDist) {
      minDist = dist;
      nearest = c.region;
    }
  }
  return nearest;
}

/**
 * Read OTK_REGION from the environment.
 * Falls back to 'us-east' when the variable is absent or unrecognised.
 */
export function getLocalRegion(): Region {
  const r = process.env['OTK_REGION'];
  if (r === 'eu-west' || r === 'ap-southeast') return r;
  return 'us-east';
}

/**
 * Build the full URL for the given path in a specific region.
 *
 * @example
 *   routeToRegion('eu-west', '/v1/receipts') → 'https://otk-eu.example.com/v1/receipts'
 */
export function routeToRegion(region: Region, path: string): string {
  const base = REGION_ENDPOINTS[region];
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalised}`;
}
