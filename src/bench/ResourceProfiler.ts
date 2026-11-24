/**
 * ResourceProfiler — per-operation CPU/RAM delta measurement
 *
 * Captures process.cpuUsage() and process.memoryUsage() before/after
 * a synchronous or async operation, returning the deltas.
 *
 * Columns emitted (all numeric):
 *   cpu_user_ms   — delta user CPU time (ms)
 *   cpu_sys_ms    — delta system CPU time (ms)
 *   heap_used_kb  — delta heap used (KB, can be negative due to GC)
 *   heap_total_kb — delta heap total (KB)
 *   rss_kb        — delta resident set size (KB)
 *   external_kb   — delta external memory (KB)
 *
 * @module ResourceProfiler
 * @since U9.2
 */

export interface ResourceSnapshot {
  cpu: NodeJS.CpuUsage;
  mem: NodeJS.MemoryUsage;
  hrtime: [number, number]; // [seconds, nanoseconds]
}

export interface ResourceDelta {
  cpu_user_ms: number;
  cpu_sys_ms: number;
  heap_used_kb: number;
  heap_total_kb: number;
  rss_kb: number;
  external_kb: number;
  elapsed_ms: number;
}

const US_TO_MS = 1 / 1000;
const BYTES_TO_KB = 1 / 1024;

function r4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * Take a snapshot of current process resources.
 */
export function snapshot(): ResourceSnapshot {
  return {
    cpu: process.cpuUsage(),
    mem: process.memoryUsage(),
    hrtime: process.hrtime(),
  };
}

/**
 * Compute delta between two snapshots.
 */
export function delta(before: ResourceSnapshot, after: ResourceSnapshot): ResourceDelta {
  // CPU delta computed from the two snapshots:
  const cpuUser = (after.cpu.user - before.cpu.user) * US_TO_MS;
  const cpuSys  = (after.cpu.system - before.cpu.system) * US_TO_MS;

  const heapUsed  = (after.mem.heapUsed  - before.mem.heapUsed)  * BYTES_TO_KB;
  const heapTotal = (after.mem.heapTotal - before.mem.heapTotal) * BYTES_TO_KB;
  const rss       = (after.mem.rss       - before.mem.rss)       * BYTES_TO_KB;
  const external  = (after.mem.external  - before.mem.external)  * BYTES_TO_KB;

  const elapsedNs = (after.hrtime[0] - before.hrtime[0]) * 1e9 +
                    (after.hrtime[1] - before.hrtime[1]);

  return {
    cpu_user_ms:  r4(cpuUser),
    cpu_sys_ms:   r4(cpuSys),
    heap_used_kb: r4(heapUsed),
    heap_total_kb: r4(heapTotal),
    rss_kb:       r4(rss),
    external_kb:  r4(external),
    elapsed_ms:   r4(elapsedNs / 1e6),
  };
}

/**
 * Profile an async operation, returning both its result and resource delta.
 */
export async function profileAsync<T>(
  fn: () => Promise<T>
): Promise<{ result: T; resources: ResourceDelta }> {
  const before = snapshot();
  const result = await fn();
  const after = snapshot();
  return { result, resources: delta(before, after) };
}

/**
 * Profile a sync operation, returning both its result and resource delta.
 */
export function profileSync<T>(
  fn: () => T
): { result: T; resources: ResourceDelta } {
  const before = snapshot();
  const result = fn();
  const after = snapshot();
  return { result, resources: delta(before, after) };
}

/**
 * CSV header for ResourceDelta columns.
 */
export const RESOURCE_CSV_HEADER =
  'cpu_user_ms,cpu_sys_ms,heap_used_kb,heap_total_kb,rss_kb,external_kb,elapsed_ms';

/**
 * Serialize a ResourceDelta to CSV row (no newline).
 */
export function resourceDeltaToCsvRow(d: ResourceDelta): string {
  return [
    d.cpu_user_ms,
    d.cpu_sys_ms,
    d.heap_used_kb,
    d.heap_total_kb,
    d.rss_kb,
    d.external_kb,
    d.elapsed_ms,
  ].join(',');
}
