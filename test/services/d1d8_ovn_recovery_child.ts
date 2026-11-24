/**
 * Recovery-only OTK instance in its own process (OVERNIGHT 20261005 / Phase 1 tests): it serves nothing and only
 * runs the recovery loop of the real runtime against the database given in argv[2]. A separate process is
 * required because a synchronous stall in the test process would also freeze an in-process second runtime.
 *   node --import tsx test/services/d1d8_ovn_recovery_child.ts <dbUrl> <instanceId> <leaseMs> <intervalMs>
 */
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { legacyMeasurementPorts } from '../../src/operations/measurementPorts.js';

const [dbUrl, instanceId, leaseMs, intervalMs] = process.argv.slice(2);
const rt = await OperationsRuntime.create({
  dbUrl: dbUrl!, instanceId: instanceId!, recoveryIntervalMs: Number(intervalMs), quotaFor: () => null,
  measurement: legacyMeasurementPorts(), policy: { leaseMs: Number(leaseMs) },
});
rt.start();
process.stdout.write('ready\n');
process.on('SIGTERM', () => { void rt.stop().then(() => process.exit(0)); });
