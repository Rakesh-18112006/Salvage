# Regulatory honesty — what is sourced, and what is ours

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Regulatory honesty

Spec rule 1: *"Do not invent regulatory facts. Any RBI e-mandate rule, NPCI eNACH return
code, or Razorpay error code must come from the official source."*

Accordingly, **`RAIL_CODE_MAP` in [`src/domain/taxonomy.ts`](../src/domain/taxonomy.ts) is
deliberately empty.** We have not yet sourced the real NPCI ACH return codes, UPI decline
codes, or Razorpay error codes, so we assert none of them. Shipping a guessed lookup
table would be exactly the failure mode the rule forbids. Until the codes are sourced,
any real-world code correctly classifies as `UNKNOWN` rather than being confidently
mislabelled.

A test in [`test/units.test.ts`](../test/units.test.ts) fails the moment that map becomes
non-empty, forcing whoever adds an entry to add its citation at the same time.

No RBI e-mandate parameter (pre-debit notification window, AFA threshold, mandate caps)
is encoded anywhere in this build yet. Those land in Phase 4's policy gate, **with
citations**, and the constants that need them are marked `// UNVERIFIED` at their point
of use.

---
