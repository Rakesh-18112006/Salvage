# Modelled assumptions, and the gateway fee

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## The gateway fee — what it is and is not

The cost headline rests on one number, so it is worth being precise about it.

| Question | Answer |
|---|---|
| What is it? | **A synthetic modelling parameter: ₹3.00 (300 paise) per charge ATTEMPT.** |
| Is it a real Razorpay price? | **No.** It is not quoted from any published fee schedule and must never be presented as one. |
| Per attempt or per success? | **Per attempt, regardless of outcome.** A failed presentment costs the same as a successful one. |
| Why not percentage MDR? | The behaviour being measured is attempt **volume**. A fee charged only on success would make four doomed retries look free — the exact failure mode under study. |
| Taxes? | **Excluded.** No GST or other tax is modelled. |
| Which rail? | One flat figure across UPI Autopay, eNACH and card. Real pricing differs by instrument; a single number keeps the comparison about **policy** rather than instrument mix, and both arms face the identical mix. |
| Where in the code? | `COST.gatewayFeePerAttemptPaise` in [`src/assumptions.ts`](../src/assumptions.ts). Applied in [`caseRunner.ts`](../src/engine/caseRunner.ts) and [`executor.ts`](../src/durable/executor.ts). |
| How is the metric computed? | `gatewayCostPaise = totalAttempts × 300`, then `gateway cost per ₹ recovered = gatewayCostPaise ÷ (recoveredPaise ÷ 100)`. Asserted in [`test/metricsAudit.test.ts`](../test/metricsAudit.test.ts). |

**Why this is acceptable for a prototype:** the headline is a *ratio between two arms that
share the constant*, so the comparison is invariant to its value. Verified empirically —
halving the fee to 150 paise leaves the delta identical to four decimal places. Only the
absolute paise figure depends on it, and that figure is never presented as a real cost.

To use real pricing: replace the value, cite the Razorpay pricing page with the date
accessed, and re-run. Nothing else changes.

## Modelled assumptions

Every stand-in value lives in [`src/assumptions.ts`](../src/assumptions.ts), carries a
`basis` string, and is **printed on every run**. None of these is a measured figure and
none is a regulatory fact.

| Assumption | Value | Basis |
|---|---|---|
| `cost.gateway_fee_per_attempt` | 300 paise | **Stand-in, not a Razorpay price.** A round figure in the plausible per-transaction range so attempt volume has a visible cost. See Open Item 5. |
| `cost.contact_patience` | 1,500 paise | **Stand-in.** There is no invoice for customer annoyance. Priced at 5× a gateway fee so messaging is never the cheap default. |
| `cost.customer_friction` | 4,000 paise | **Stand-in.** Priced above a contact because re-mandate and payment-link paths ask for effort and have a real abandonment rate. |
| `cost.float_per_rupee_per_day` | 0.0004 | **Stand-in**, ≈14.6% annualised. Exists so `DEFER` and `TIME_SHIFT` are not free. |
| `cost.human_handoff` | 25,000 paise | **Stand-in** for a few minutes of an operations agent. Set high so `ESCALATE_HUMAN` stays reserved for genuinely terminal cases. |
| `sim.case_horizon_days` | 14 | Case abandoned as `EXHAUSTED` 14 days after the opening failure. |
| `sim.base_technical_decline_rate` | 0.015 | **Stand-in** for transient gateway/issuer noise; per-bank surcharges added on top. |
| `sim.shortfall_daily_failure_rate` | 0.85 | **Stand-in.** See "Balance shortfall persists" above — the most consequential assumption here. |
| `sim.funded_daily_failure_rate` | 0.012 | **Stand-in.** Residual chance a normally-funded account is short (an unexpected debit landed first). |
| `sim.unmapped_code_rate` | 0.02 | The simulator deliberately emits codes the taxonomy does not know, so the `UNKNOWN` path and the coverage metric are genuinely exercised. |
| `sim.remandate_completion_base` | 0.10 | **Stand-in, and the one that most flatters the agent, so set conservatively.** Yields 23%–46% completion across the customer base. An earlier draft yielded 48–91%, which inflated the agent's win; that was a calibration error and is called out rather than quietly fixed. |
| `sim.payment_link_completion_base` | 0.16 | **Stand-in.** Paying once is a smaller ask than re-authorising a standing instruction. |
| `sim.customer_action_median_hours` | 26 | **Stand-in.** Median delay between sending a link and the customer acting. |
| `sim.notify_uplift_on_self_heal` | 1.9 | **Stand-in.** A customer who has been told is likelier to fix it themselves. The entire benefit of a bare `NOTIFY`, weighed against its patience cost. Diminishing returns per message, so spamming cannot win. |
| `sim.daily_self_heal_probability` | 0.035 | **Stand-in.** Chance a customer resolves out-of-band with no intervention. Applied identically to both arms — neither can take credit for it. This is what makes `WAIT` a real option in Phase 3. |

Population prevalences (mandate revocation, account states, undersized caps, card expiry)
are also stand-ins, calibrated so terminal causes land in the "quarter to a third of
failures" range the problem statement describes. They are visible in
[`src/sim/population.ts`](../src/sim/population.ts).

---
