# Repository layout

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Where to start reading

If you have ten minutes and want to judge whether the result is real, read these four
files in order. They are the argument; everything else is machinery.

| # | File | Why it matters |
|---|---|---|
| 1 | [`src/domain/taxonomy.ts`](../src/domain/taxonomy.ts) | The failure classes, and the nine Razorpay reasons we refused to guess at |
| 2 | [`src/policy/gate.ts`](../src/policy/gate.ts) | The deterministic rules the agent cannot argue past — ordinary code, not a prompt |
| 3 | [`src/seeds.ts`](../src/seeds.ts) | The 50-cohort interval. Runs in under a second, no API key |
| 4 | [`src/robustness.ts`](../src/robustness.ts) | The ablation ladder and the eleven perturbed worlds, including the one we lose |

---

## Entry points

Every one is runnable directly — Node ≥ 22.18 strips the types, there is no build step.
The four with no external dependency are the ones worth running first.

| Command | What it produces | Needs |
|---|---|---|
| `node src/main.ts` | The seeded cohort and the T+3 control baseline | nothing |
| `node src/seeds.ts` | 50-cohort paired bootstrap intervals for the lift | nothing |
| `node src/robustness.ts` | Four-arm ablation ladder × eleven perturbed worlds | nothing |
| `node src/economics.ts` | The all-in cost curve and its break-even point | nothing |
| `node src/phase3.ts` | Control vs agent on one cohort, live model | `GROQ_API_KEY` |
| `node src/generalization.ts` | What the model is worth on unmapped rail codes | `GROQ_API_KEY` |
| `node src/dashboard.ts` | Self-contained HTML dashboard and audit viewer | nothing |
| `node src/phase2.ts` | The durable spine end to end | Docker |
| `node src/chaos.ts` | `docker kill` an executor mid-flight; prove no double charge | Docker |
| `node src/worker.ts` | A queue worker process (used by the chaos demo) | Docker |

---

## `src/` — the system

```
src/
  main.ts                 cohort + T+3 control baseline
  phase2.ts               durable spine end to end
  phase3.ts               control vs agent, one cohort
  seeds.ts                50-cohort paired bootstrap intervals
  robustness.ts           ablation ladder x perturbed worlds
  generalization.ts       what the model is worth where the taxonomy has no row
  economics.ts            all-in cost curve and break-even
  dashboard.ts            self-contained HTML dashboard + audit viewer
  chaos.ts                SIGKILL an executor mid-charge and check four guarantees
  worker.ts               queue worker process

  config.ts               env loading; the only place process.env is read
  assumptions.ts          every modelled constant the AGENT believes, with its basis
  stats.ts                paired percentile bootstrap; no distributional assumption

  domain/                 ######## the vocabulary everything else speaks ########
    types.ts              cases, attempts, actions, the audit record
    taxonomy.ts           failure classes; Razorpay's 18 documented reasons, 9 left UNKNOWN
    money.ts              paise arithmetic and Indian digit grouping

  sim/                    ######## THE SIMULATED WORLD — all data originates here ########
    worldParams.ts        the constants the WORLD obeys, kept apart from what the agent believes
    population.ts         seeded cohort construction; the at-risk set, by construction
    paymentSimulator.ts   why a charge fails, and the vocabulary it fails in
    customerResponse.ts   whether a customer acts on a link, and when
    banks.ts              fictional banks (SIMBANK_*), their uptime and outage windows
    clock.ts              IST calendar arithmetic, billing days, month boundaries
    rng.ts                seeded, ORDER-INDEPENDENT draws — why both arms face one world

  engine/                 ######## running an arm ########
    caseRunner.ts         one case from opening failure to closure
    runner.ts             a whole arm, concurrently, with identical results
    metrics.ts            incremental lift against control, never gross

  policy/                 ######## what is allowed ########
    gate.ts               the deterministic rules the agent cannot argue past
    compliance.ts         RBI parameters, sourced with section numbers
    controlT3.ts          the control arm: Razorpay's documented fixed T+3
    ablation.ts           the intermediate arms that isolate where the lift comes from

  agent/                  ######## what is proposed ########
    agentPolicy.ts        nine actions, three layers of cost discipline
    costModel.ts          what the agent BELIEVES about success and cost
    tools.ts              read tools gather evidence; propose tools do the arithmetic
    provenance.ts         "was this model-driven?" derived from observed counts, never flags
    model/
      decisionModel.ts    the contract every provider implements, and nothing wider
      chain.ts            Groq -> OpenRouter -> Gemini, and the usage accounting
      openAiCompatible.ts Groq and OpenRouter
      gemini.ts           Gemini
      rateLimiter.ts      client-side pacing, shared by every provider

  eval/                   ######## evidence about the model ########
    railDialect.ts        a SYNTHETIC unmapped rail vocabulary, with per-response labels
    misspecification.ts   the perturbed worlds the agent is never told about

  durable/                ######## PHASE 2: crash safety ########
    idempotency.ts        sha256(case_id, attempt_no) — derived, never generated
    railClient.ts         simulated gateway with its own durable idempotency ledger
    executor.ts           claim -> call -> settle; the crash-safety core
    caseStore.ts          state machine, optimistic locking, event append
    circuitBreaker.ts     per-bank, persisted so a restart does not forget
    inbox.ts              webhook dedupe on razorpay_event_id
    outbox.ts             events committed with their state change
    deadLetters.ts        dead-letter queue with replay
    replay.ts             folds case_events and checks against stored state
    repo.ts               persist and reload the seeded population
    pipeline.ts           seed, open, drain, summarise

  queue/
    queues.ts             BullMQ wiring, time compression, job ids
    recoveryWorker.ts     one job = one attempt; holds no state between jobs

  webhook/
    verify.ts             HMAC over the RAW body, timing-safe compare
    razorpayAdapter.ts    Razorpay's DOCUMENTED webhook envelope -> the taxonomy
    server.ts             node:http ingress; verify, dedupe, 200, process later

  db/
    pool.ts               pg pool, transactions, unique-violation helper
    migrate.ts            numbered .sql migrations. No ORM, no framework
```

---

## `test/` — 230 tests

Run with `npm test`. The suites that need Postgres and Redis **skip** rather than fail
when Docker is not running, so the suite is still useful on a laptop with nothing started.

```
test/
  units.test.ts             taxonomy, clock, money, the control policy
  determinism.test.ts       the tests that make the comparison defensible
  cohort.test.ts            regression tests for the Phase 1 defect
  engineEquivalence.test.ts the two engines must agree on the same seed
  metricsAudit.test.ts      metrics cannot silently disagree with the case log

  policyGate.test.ts        the adversarial cases; every rule asserted BY NAME
  agent.test.ts             guard rails, triage, caching, fallback (stub model)
  agentResilience.test.ts   what happens when the provider dies mid-run
  agentEval.test.ts         the spec's three judgment scenarios (needs a key)
  provenance.test.ts        a fallback run can never be reported as an AI result
  generalization.test.ts    what a model's reading of an unmapped code may NOT do
  robustness.test.ts        perturbing the world moves the sim, not the agent's beliefs
  stats.test.ts             the intervals behind every headline in the README
  razorpayAdapter.test.ts   all 18 documented reasons, through the documented envelope

  crashSafety.test.ts       real process kills at each dangerous point   [Docker]
  durableSpine.test.ts      inbox, outbox, locking, breakers, DLQ         [Docker]
  pipeline.test.ts          full batch: zero lost cases, replay equivalence [Docker]
  helpers/                  the DB harness and the child process used to crash on demand
```

---

## Everything else

```
docs/
  ARCHITECTURE.md           how the pieces fit together
  ASSUMPTIONS.md            every modelled constant, its basis, and the synthetic fee
  DESIGN-DECISIONS.md       choices worth defending, and why
  REGULATORY.md             what is sourced with a section number, and what is ours
  RAZORPAY-INTEGRATION.md   the adapter, and the line we did not cross
  CLAIMS.md                 every published figure, and what it would be wrong to say
  OPEN-ITEMS.md             known gaps, stated plainly
  LAYOUT.md                 this file
  phases/                   how the build went, phase by phase

migrations/
  001_init.sql              the schema IS the specification of the guarantees
  002_rail_ledger.sql       the simulated gateway's own memory

scripts/
  verify-claims.sh          recomputes every published claim and fails if one moved
```
