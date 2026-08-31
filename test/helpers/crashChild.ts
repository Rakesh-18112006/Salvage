/**
 * A worker that really dies mid-charge.
 *
 * Run as a child process by crashSafety.test.ts. It opens a case, starts executing an
 * attempt, and is killed by the executor's crash injection at the requested phase - by
 * `process.exit(137)`, the code Docker reports for SIGKILL. No finally block runs, no
 * connection is closed politely, no state is flushed on the way out.
 *
 * This matters: a test that simulates a crash by throwing an Error proves only that the
 * catch block works. The acceptance criterion is about a process that stops existing.
 *
 * argv: <seed> <caseId> <attemptNo> <simulatedAt> <subscriptionId>
 */
import { loadEnv } from '../../src/config.ts';
import { closePool } from '../../src/db/pool.ts';
import { executeAttempt } from '../../src/durable/executor.ts';
import { SimulatedRailClient } from '../../src/durable/railClient.ts';
import { loadWorld } from '../../src/durable/repo.ts';

loadEnv();

const [seed, caseId, attemptNoRaw, simulatedAtRaw, subscriptionId] = process.argv.slice(2);

if (
  seed === undefined ||
  caseId === undefined ||
  attemptNoRaw === undefined ||
  simulatedAtRaw === undefined ||
  subscriptionId === undefined
) {
  console.error('usage: crashChild.ts <seed> <caseId> <attemptNo> <simulatedAt> <subscriptionId>');
  process.exit(2);
}

const world = await loadWorld(seed);
const subscription = world.subscription(subscriptionId);
const mandate = world.mandate(subscription.mandateId);
const customer = world.customer(subscription.customerId);

const result = await executeAttempt({
  caseId,
  attemptNo: Number(attemptNoRaw),
  subscription,
  mandate,
  customer,
  cycleId: '2026-03',
  scheduledAt: Number(simulatedAtRaw),
  rail: new SimulatedRailClient(world),
});

// Only reached when no crash was injected.
console.log(JSON.stringify(result));
await closePool();
