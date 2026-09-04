# Phase 1 — ground truth: the simulator, the taxonomy, and the T+3 baseline

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../../README.md)

---

## The Phase 1 defect, and how it was fixed

The previous build had a defect worth stating plainly, because it inflated the headline
number:

> The batch runner recorded the opening attempt as a failure **unconditionally**. When
> the simulated opening charge actually succeeded, it was logged with an empty error code
> and classified as `UNKNOWN` — 62 of 300 cases. Those subscriptions were never at risk,
> so the reported 48.7% baseline recovery rate was measured against a polluted cohort.

**The fix is structural, not a patch.** In
[`src/sim/population.ts`](../../src/sim/population.ts), candidate subscriptions are generated
and charged; successes are **discarded**; generation continues until the target cohort
size is reached. The cohort is therefore "subscriptions whose opening charge genuinely
failed" *by construction*, and every case opens on a real decline code.

Three tests in [`test/cohort.test.ts`](../../test/cohort.test.ts) hold the fix in place: no
case may open with an empty code, an `UNKNOWN` opening must correspond to a genuinely
unmapped `SIM_RAILCODE_*`, and the discard count must be reported rather than hidden.

Because the cohort changed and the previous code no longer exists, **the old 48.7%
figure is not comparable to the numbers below and has been retired rather than
restated.**

---

## Baseline result (SIMULATED, seed `20260101`, 300 cases)

### Cohort construction

| Step | Count |
|---|---|
| Candidate subscriptions charged | 2,182 |
| Opening charge succeeded — discarded | 1,882 |
| Opening charge genuinely failed — kept | **300** |
| Opening failure rate | 13.7% |

### Why the opening charge failed

| Opening failure class | Cases | Share | Terminal? |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | 108 | 36.0% | retryable |
| `TECHNICAL_DECLINE` | 57 | 19.0% | retryable |
| `MANDATE_REVOKED` | 44 | 14.7% | **TERMINAL** |
| `BANK_DOWNTIME` | 33 | 11.0% | retryable |
| `MANDATE_EXPIRED` | 25 | 8.3% | **TERMINAL** |
| `AMOUNT_EXCEEDS_MANDATE` | 12 | 4.0% | **TERMINAL** |
| `CARD_EXPIRED` | 8 | 2.7% | **TERMINAL** |
| `RISK_DECLINE` | 6 | 2.0% | **TERMINAL** |
| `UNKNOWN` | 3 | 1.0% | retryable |
| `ACCOUNT_CLOSED` | 2 | 0.7% | **TERMINAL** |
| `ACCOUNT_FROZEN` | 2 | 0.7% | **TERMINAL** |
| **Terminal subtotal** | **99** | **33.0%** | |

### Control arm — fixed T+3

| Metric | Control (T+3) |
|---|---|
| Recovery rate | 54.0% |
| — of which self-healed with no intervention | 12 cases |
| Revenue at risk | ₹7,36,800.00 |
| Recovered | ₹3,92,238.00 (53.2%) |
| Total attempts | 910 |
| Total customer contacts | 0 |
| **Attempts burned on terminal cases** | **382 (42.0%)** |
| Modelled cost | ₹2,929.52 |
| Cost per rupee recovered | 0.747 paise |
| Median hours to recovery | 24.0 |
| Taxonomy coverage | 97.8% |

**Read the recovery rate carefully.** 54.0% is *not* a weak baseline — the fixed policy
does fine on transient technical declines and bank downtime, where "try again tomorrow"
is genuinely the right move. The opportunity is not that T+3 recovers too little. It is
that **T+3 spends 42.0% of its attempts on cases it can never win**, and that its wins
on liquidity failures come one expensive day at a time rather than by waiting for the
customer's inflow date.

That is the gap Phases 3 and 4 are built to close, and the comparison will be reported
as **incremental lift against this arm** — never as a gross number.

---
