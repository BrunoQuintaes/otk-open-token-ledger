/**
 * k6_smoke.js — OTK Smoke Load Test (E5.4)
 *
 * Target: 100 req/min for 2 minutes
 * Pass criteria: p99 < 500ms, error rate < 1%
 *
 * Usage:
 *   k6 run scripts/load/k6_smoke.js
 *   OTK_BASE_URL=https://api.example.com k6 run scripts/load/k6_smoke.js
 *
 * A k6 script (runs inside the k6 load tool, not Node.js). Every virtual user calls the API's unauthenticated
 * liveness route, then sleeps 0.75 s. Reads `OTK_BASE_URL` (default: local port 3000). k6 exits non-zero when a
 * threshold in `options` fails.
 *
 * @module scripts/load/k6_smoke
 * @since Wave 4 (4B-PACK-4B03 / E5.4)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const latencyTrend = new Trend('request_duration');

const BASE_URL = __ENV.OTK_BASE_URL || 'http://localhost:3000';

/** k6 options: 2 virtual users for 2 minutes; fails when p99 latency is 500 ms or more or 1 % or more checks fail. */
export const options = {
  // 100 req/min = ~1.67 req/s → 2 VUs at 0.75s sleep achieves ~2.5 req/s ≈ 100 req/min
  vus: 2,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(99)<500'],
    errors: ['rate<0.01'],
  },
};

/** One k6 iteration: one liveness request, checked for status 200 and latency under 500 ms. */
export default function () {
  // Health check endpoint (no auth required)
  const res = http.get(`${BASE_URL}/healthz`, {
    timeout: '5s',
    tags: { endpoint: 'healthz' },
  });

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  errorRate.add(!ok);
  latencyTrend.add(res.timings.duration);

  sleep(0.75);
}
