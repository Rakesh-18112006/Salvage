# Design decisions worth defending

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Design decisions worth defending

### Determinism is engineered, not hoped for

Two facilities in [`src/sim/rng.ts`](../src/sim/rng.ts), and the distinction is the reason
the eventual control-vs-agent comparison means anything:

- **`Rng`** — a sequential seeded stream, used *only* to build the population, where the
  order of draws is fixed and identical for every arm.
- **`uniform(...)`** — an **order-independent** hashed draw, used for *every* environment
  outcome. Because the value is a pure function of `(seed, subscription, timestamp,
  purpose)` and not of how many draws preceded it, the control arm and the agent arm face
  a bit-identical world even though they take different actions at different times.

A single shared sequential stream would silently de-synchronise the two arms the moment
their action sequences diverged, and the comparison would be worthless. Five tests in
[`test/determinism.test.ts`](../test/determinism.test.ts) assert this property directly.

### The simulator never leaks ground truth

`RecoveryCase.trueOpeningClass` records what the environment actually applied. It exists
so metrics can measure how many attempts a policy spent on unwinnable cases. It is
**never** placed in `CaseView`, which is the only thing a policy or the agent is handed.

### Balance shortfall persists; it is not re-rolled daily

The single most consequential modelling choice in the simulator. A customer inside a
shortfall window fails **85% of days** until their next inflow, rather than getting an
independent coin flip each day. This is why T+1 and T+2 land inside the same window T+0
failed in, and why time-shifting to the inflow date is a different kind of action rather
than a slower retry.

Stated openly because it deserves to be challenged: **if balances were independent day to
day, the fixed T+3 policy would already be close to optimal and this project would have
no thesis.** The assumption is named in [`src/assumptions.ts`](../src/assumptions.ts) as
`sim.shortfall_daily_failure_rate` and printed on every run.

### The action space is already typed, but not yet all executable

`ActionKind` in [`src/domain/types.ts`](../src/domain/types.ts) carries all eight actions
plus `STOP`. Phase 1's engine executes the schedule-affecting subset (`RETRY_NOW`,
`DEFER`, `TIME_SHIFT`, `WAIT`, `ESCALATE_HUMAN`, `STOP`). `NOTIFY`, `REMANDATE`, and
`PAYMENT_LINK` need a customer-response model that lands in Phase 3, and they **throw
loudly** rather than silently succeeding.

### The audit trail shape is fixed now, not retrofitted

Every decision is already written to an append-only `DecisionRecord` with
`policyVerdict` and `policyRuleFired` fields. Phase 1 writes
`policyVerdict: 'NOT_YET_IMPLEMENTED'`. When the Phase 4 policy gate lands, it fills
those fields in — the audit shape does not change underneath the demo.

---
