# Phase 4 — the policy gate

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Phase 4 — the policy gate

Deterministic rules the agent cannot argue past. No model, no probability, no discretion —
a guard rail implemented as a prompt instruction is a *request*, and a request is not a
guard rail. The agent proposes; the gate decides; the executor only ever sees what came
out of the gate.

**The gate applies to BOTH arms.** It is enforcement, not a feature of the agent.

### Regulatory parameters — sourced, not invented

Spec rule 1 forbids inventing compliance facts, so these were read from the RBI's own
site and each carries its citation in
[`src/policy/compliance.ts`](../src/policy/compliance.ts):

| Parameter | Value | Section | Source |
|---|---|---|---|
| Pre-transaction notification | **at least 24 hours** before the charge/debit | §6 | [E-mandate Framework, 2026](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374) |
| AFA relaxation, general | **₹15,000** per transaction | §8(a) | ibid. |
| AFA relaxation, named categories | **₹1,00,000** (insurance premiums, mutual fund subscriptions, credit card bills) | §8(b) | ibid. |
| Applicability | cards / PPI / UPI — **NACH not named** | §2 | ibid. |

Verified 2026-08-31 by two independent reads of the RBI page, which agreed on every figure
and section number. Each value carries its verbatim quote in
[`src/policy/compliance.ts`](../src/policy/compliance.ts).

**The instrument in force is not the one most write-ups cite.** Nearly everything written
about Indian e-mandates points at RBI/2019-20/47 (21 August 2019). That circular has been
**repealed**. The current direction is *Digital Payments – E-mandate Framework, 2026*
(RBI/DPSS/2026-27/396; RBI/CO.DPSS.POLC.No.S56/02.14.003/2026-27), effective 21 April
2026, which consolidates and repeals eight earlier circulars including the 2019 one.
Retrieved 2026-08-30.

Quiet hours are **our own operational policy, not a regulation**, and are labelled as such
— we found no payments regulation setting contact hours, and inventing one and stamping
"RBI" on it would be exactly the failure rule 1 describes.

### A regulatory question the document does not answer

Section 6 of the framework requires notification "at least 24 hours prior to the actual
charge / debit". A retry is, on any ordinary reading, a charge — so it is tempting to
conclude that every retry needs its own 24-hour notice.

**We checked, and the document does not say that.** Verified 2026-08-31: the framework
contains **no clause about retries, re-presentment, failed transactions or declined
transactions at all**, and Section 6 does not state whether the notification is
per-mandate or per-transaction. The question is simply not addressed.

An earlier draft of this README claimed the strict reading would render the incumbent's
T+3 cycle "non-compliant on its face". **That was our inference stated as a finding, and
it has been withdrawn.** We have not found a compliance gap; we have found an ambiguity.

Both readings are implemented as an **operational policy choice**, defaulting to the
permissive one. Neither is presented as what the regulation requires:

```bash
SALVAGE_PREDEBIT_SCOPE=per_debit node src/phase3.ts --cases 300 --deterministic-only
```

| Reading | Control | Agent | Agent lift |
|---|---|---|---|
| `per_cycle` (default) | 50.3% | 70.7% | +20.3 ppt |
| `per_debit` (conservative posture) | 43.3% | 68.3% | +25.0 ppt |

**Scope limit that matters:** Section 2 applies the framework to "cards / PPI / UPI".
**It does not name NACH.** eNACH is an NPCI system under NPCI's own procedural guidelines,
so the gate applies the pre-debit rule only to the rails the direction names. Extending a
regulation past its stated scope is its own kind of invention.

### The rules

| Rule | What it does |
|---|---|
| `GLOBAL_ABORT_ON_CAPTURE` | A captured payment halts every pending action, checked before anything else |
| `TERMINAL_CLASS_NO_CHARGE` | No charge against a terminal failure class |
| `AMOUNT_EXCEEDS_MANDATE_CAP` | Hard check before execution |
| `MANDATE_NOT_ACTIVE` | No charge on a revoked or expired mandate |
| `ATTEMPT_CAP_PER_CYCLE` | 4 per cycle, regardless of agent preference |
| `PRE_DEBIT_NOTIFICATION_REQUIRED` | RBI 24h notice; a notice authorises **one** debit and is then spent |
| `CIRCUIT_BREAKER_OPEN` | Defers rather than burning an attempt into a rail known to be down |
| `LIVE_PROMISE_TO_PAY` | No charging *or* chasing inside a promise's grace window |
| `CONTACT_FREQUENCY_CAP` | 2 per 48h rolling, 4 per case lifetime |
| `QUIET_HOURS` | No contact 21:00–09:00 IST, or on a national holiday |
| `ESCALATION_LADDER_ORDER` | gentle → firm → owner CC → final notice. Tiers cannot be skipped, and legal or collections language can never be sent by automation |

Every rejection records the **name** of the rule that fired. "Blocked by policy" with no
rule name is an assertion; a rule name is evidence.

### What the gate is worth on its own

An honest decomposition, because it changes how much of Phase 3's result belongs to the
agent. Turning the gate on, with the control policy unchanged:

| Control arm | Gate off | Gate on |
|---|---|---|
| Total attempts | 910 | **627** |
| Attempts burned on terminal cases | 382 | **99** |

The gate alone removes **283 doomed attempts** from the *dumb* policy — every retry after
the opening charge on a terminal case. The 99 that remain are the opening charges
themselves, which nothing can prevent. So a large share of the attempt-efficiency win is
the gate, not the agent's judgement, and the agent's remaining edge is recovery rate
(+19.7 ppt) and gateway cost (−48%).

The agent fires `TERMINAL_CLASS_NO_CHARGE` **zero** times: its own triage already refuses
those. The gate is there for when it is wrong, not because it is.

### Two bugs this phase exposed

1. **One action per case was reaching the executor unadjudicated.** Cohort seeding hardcoded "retry at T+1" and enqueued it directly, bypassing the policy and the gate — including charges against already-revoked mandates. That is precisely the hole the acceptance criterion is written to catch. Both paths now share one `decideNext` routine.
2. **The strict-compliance flag was silently a no-op.** The rule checked only the *age* of the most recent notice, so a single cycle-opening notification authorised unlimited retries and `per_debit` produced numbers identical to `per_cycle`. A notice is now consumed by the debit it authorises. Both are pinned by [`test/policyGate.test.ts`](../test/policyGate.test.ts).

### Acceptance

```bash
node --test test/policyGate.test.ts
```

27 tests. The three adversarial cases the spec names — retry on a revoked mandate, contact
at 2am, amount above cap — are each blocked with the **correct rule named**, plus a case
for every other rule, plus two whole-run assertions: no decision reaches the executor with
`NOT_YET_IMPLEMENTED`, and the audit trail keeps **what the agent wanted** alongside what
was allowed. A trail that records only the approved action cannot show the gate doing
anything.

---
