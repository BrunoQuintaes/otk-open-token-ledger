/**
 * k6_stress.js — OTK Stress Load Test (E5.4)
 *
 * Target: 1000 req/min for 10 minutes
 * Pass criteria: p99 < 500ms, error rate < 5%
 *
 * Usage:
 *   k6 run scripts/load/k6_stress.js
 *   OTK_BASE_URL=https://api.example.com k6 run scripts/load/k6_stress.js
 *
 * A k6 script (runs inside the k6 load tool, not Node.js). Every virtual user calls the API's unauthenticated
 * liveness route, then sleeps 1 s. Reads `OTK_BASE_URL` (default: local port 3000). k6 exits non-zero when a
 * threshold in `options` fails.
 *
 * @module scripts/load/k6_stress
 * @since Wave 4 (4B-PACK-4B03 / E5.4)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const latencyTrend = new Trend('request_duration');

const BASE_URL = __ENV.OTK_BASE_URL || 'http://localhost:3000';

/** k6 options: ramp to 17 virtual users, hold 8 minutes, ramp down; fails on p99 >= 500 ms or >= 5 % failed checks. */
export const options = {
  stages: [
    { duration: '1m', target: 17 },  // ramp up to ~1000 req/min (17 VUs × ~1 req/s)
    { duration: '8m', target: 17 },  // sustain
    { duration: '1m', target: 0 },   // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(99)<500'],
    errors: ['rate<0.05'],
  },
};

/** One k6 iteration: one liveness request, checked for a 2xx status and latency under 500 ms. */
export default function () {
  const res = http.get(`${BASE_URL}/healthz`, {
    timeout: '10s',
    tags: { endpoint: 'healthz' },
  });

  const ok = check(res, {
    'status 2xx': (r) => r.status >= 200 && r.status < 300,
    'p99 < 500ms': (r) => r.timings.duration < 500,
  });

  errorRate.add(!ok);
  latencyTrend.add(res.timings.duration);

  sleep(1);
}
