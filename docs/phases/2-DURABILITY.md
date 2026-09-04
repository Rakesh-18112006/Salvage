# Phase 2 — the durable spine

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../../README.md)

---

## Phase 2 — the durable spine

Phase 1 proves the thesis on paper. Phase 2 is what makes it a system: state in Postgres,
retries as real delayed jobs, and guarantees that survive the process being killed.

### Run it

Needs Docker (Postgres 16 + Redis 7, on non-default ports so they cannot collide with
anything already running locally).

```bash
docker compose up -d && node src/db/migrate.ts && node src/phase2.ts --cases 300
```

Output on the seeded 300-case cohort:

| Metric | Value |
|---|---|
| Cases opened / closed / still open | 300 / 300 / **0** |
| Attempts executed | 910 |
| Gateway charges vs idempotency keys | **910 / 910** — no double charge |
| Cases replayed from `case_events` | 300, **0 divergences** from stored state |
| Outbox events published | all, none stranded |
| Wall-clock time | ~1.2s (simulated time is compressed — see below) |

### Where each guarantee actually lives

None of these rest on application code remembering to be careful. They rest on
constraints, which hold while the process is dead:

| Guarantee | Enforced by |
|---|---|
| Never double-charge | `charge_attempts.idempotency_key UNIQUE`, key = `sha256(case_id, attempt_no)` |
| Redelivered webhook is a no-op | `inbox.razorpay_event_id PRIMARY KEY` |
| One retry budget per billing cycle | `UNIQUE (subscription_id, cycle_id, arm)` on `recovery_cases` |
| Two workers cannot both advance a case | `version` + `WHERE version = $n` |
| Audit trail cannot be rewritten | `BEFORE UPDATE/DELETE` triggers on `decisions` and `case_events` |
| State and event log cannot diverge | both written in one transaction |

### The crash-safety design

Executing an attempt is three phases, and the ordering is the whole point:

1. **CLAIM** — insert `charge_attempts` with the derived key, `status='in_flight'`, committed **before** the rail is called.
2. **CALL** — present the charge, passing the same key.
3. **SETTLE** — record the outcome.

Crashing between 2 and 3 is the case that loses money in naive systems: the gateway may
have charged, and we have no record of it. The reclaimer does not re-decide — it
re-presents **the same idempotency key**, and the gateway returns the original outcome
from its ledger without charging again.

The tests kill a **real child process** with `process.exit(137)` (the code Docker reports
for `SIGKILL`) at each of those two points. No `finally` block runs, nothing is flushed.
And the assertion is made against the **gateway's** ledger, in its own table, not against
our `charge_attempts` — asserting our own bookkeeping says one row exists would be
circular. What is checked is that the counterparty only ever moved money once.

Also covered: ten sequential replays of one attempt, and eight concurrent workers racing
the same attempt. One charge each time.

### Time compression

The domain runs on simulated time — a T+1 retry is 24 simulated hours away. Waiting 24
real hours is not a demo, so one simulated hour maps to a few real milliseconds
(`SALVAGE_MS_PER_SIM_HOUR`, default 4).

This compresses **only the delay**. Every timestamp written to the database is the
simulated instant, so the audit trail reads in real dates and no metric is affected.

### Cross-validated against Phase 1

There are now two engines that can run the same scenario. If they disagreed on the same
seed, one would be wrong and every number after that would be suspect — so agreement is
asserted, not assumed ([`test/engineEquivalence.test.ts`](../../test/engineEquivalence.test.ts)):

- **Circuit breakers off** — the durable spine reproduces the in-memory runner *exactly*: same outcome, same attempt count, same closing timestamp, for all 120 cases.
- **Circuit breakers on** — every difference is confined to cases a breaker actually deferred. That is a real behavioural difference (Phase 1 has no breakers), and it is measured rather than waved away. On the seeded cohort a breaker costs one recovery: an attempt that would have succeeded was deferred because that bank was degraded for other customers at the time. That is the trade the breaker exists to make.

### Four bugs the Phase 2 checks caught

Worth listing, because they are the reason to write the checks rather than assert the
guarantees in a slide:

1. **`diagnosis` was never written to `recovery_cases`.** The event log carried the right failure class; the stored row was stuck on its opening value. Found by the replay reducer — invisible until someone audited a case.
2. **A successful attempt erased the diagnosis.** A recovered case was left saying `UNKNOWN` rather than recording why it had failed — deleting the most useful field in the audit trail at the moment it became interesting.
3. **An open circuit breaker stranded cases forever.** The deferral re-queued under *the same job id as the job being processed*, which BullMQ silently ignores. No job, no error, case open forever. Only appeared at 150+ cases, where breakers actually open.
4. **Entity ids were not seed-scoped.** `sub_sim_000008` was generated from the candidate index alone, so different populations shared ids — and with `ON CONFLICT DO NOTHING`, one seed's subscription silently impersonated another's in shared storage.

### Reclaim latency is `lockDuration`, not `stalledInterval`

A detail that matters for the Phase 5 chaos demo. BullMQ will not hand a dead worker's
job to a survivor until the **lock expires**; the stalled sweep can run every 250ms and
still find nothing. The default lock is 30 seconds — a sensible production value and a
terrible demo, since `docker kill` followed by thirty seconds of nothing demonstrates
nothing. Our jobs settle in milliseconds, so the demo and tests set it to 1s deliberately
(`DEMO_LOCK_DURATION_MS`).

---
