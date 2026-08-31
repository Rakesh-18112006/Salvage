# Repository layout

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Layout

```
src/
  assumptions.ts        every stand-in value, with its basis; printed on each run
  main.ts               CLI entrypoint
  domain/
    money.ts            paise arithmetic, Indian digit grouping
    taxonomy.ts         failure classes, terminal set, classification
    types.ts            entities, action space, case, audit record, policy interface
  sim/                  ############ SIMULATOR — not live data ############
    rng.ts              seeded stream + order-independent hashed draws
    clock.ts            IST civil-time helpers
    banks.ts            fictional banks, maintenance windows, degradation
    paymentSimulator.ts charge outcomes, shortfall windows, self-healing
    customerResponse.ts re-mandate / payment-link completion; the agent's only lever
                        on terminal failures
    population.ts       cohort construction (successes discarded by design)
  agent/                ############ PHASE 3: the agent ############
    geminiClient.ts     model chain, retry, rate limiting, usage accounting
    tools.ts            the 12 tool contracts; propose_* does the arithmetic
    costModel.ts        EV(bundle) vs EV(WAIT) - deterministic, never the model's job
    agentPolicy.ts      triage -> cache -> model -> correction -> costed bundle
  policy/
    controlT3.ts        the fixed T+3 control arm we have to beat
    compliance.ts       SOURCED RBI parameters, with citations. Not stand-ins.
    gate.ts             the policy gate: deterministic, non-overridable, names its rules
  engine/
    caseRunner.ts       runs one case to closure; owns simulated time
    runner.ts           batch runner, arms, incremental lift
    metrics.ts          section 9 metrics and rendering
  db/
    pool.ts             Postgres pool, transactions, unique-violation helper
    migrate.ts          numbered .sql migrations, no ORM, no framework
  durable/              ############ PHASE 2: the durable spine ############
    idempotency.ts      sha256(case_id, attempt_no) - derived, never generated
    railClient.ts       SIMULATED gateway with its own durable idempotency ledger
    executor.ts         claim -> call -> settle; the crash-safety core
    caseStore.ts        state machine, optimistic locking, event append
    circuitBreaker.ts   per-bank, persisted so a restart does not forget
    inbox.ts            webhook dedupe on razorpay_event_id
    outbox.ts           events committed with their state change
    deadLetters.ts      DLQ with replay
    replay.ts           folds case_events and checks against stored state
    repo.ts             persist/load the seeded population
    pipeline.ts         seed, open, drain, summarise
  queue/
    queues.ts           BullMQ wiring, time compression, job ids
    recoveryWorker.ts   one job = one attempt; holds no state between jobs
  webhook/
    verify.ts           HMAC over the RAW body, timing-safe compare
    server.ts           node:http ingress; verify, dedupe, 200, process later
  phase2.ts             Phase 2 entrypoint
  phase3.ts             Phase 3 entrypoint: control vs agent
migrations/
  001_init.sql          the schema IS the specification of the guarantees
  002_rail_ledger.sql   the simulated gateway's own memory
test/
  determinism.test.ts   spec rule 5 — the tests that make the comparison defensible
  cohort.test.ts        regression tests for the Phase 1 defect
  units.test.ts         taxonomy, clock, money, control policy
  crashSafety.test.ts   real process kills at each dangerous point
  durableSpine.test.ts  inbox, outbox, locking, breakers, DLQ, append-only
  pipeline.test.ts      full batch: zero lost cases, replay equivalence
  engineEquivalence.test.ts  the two engines must agree on the same seed
  agent.test.ts         guard rails, triage, caching, fallback (stub model, offline)
  agentEval.test.ts     the spec's three judgment scenarios
  policyGate.test.ts    the adversarial cases; every rule asserted by name
```
