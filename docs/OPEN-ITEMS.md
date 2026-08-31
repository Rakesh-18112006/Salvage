# Open items

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Still open

**1. NPCI NACH return codes are unmapped.**
They are published only as PDF circulars (274, 240, NACH-006-FY-24-25) and npci.org.in
returned HTTP 403 to every automated fetch on 2026-08-31. Rather than transcribe them from
a blog or a third-party summary, they are omitted — so any NACH code classifies as
`UNKNOWN`, which the gate treats as non-retryable. That is the safe direction to be wrong
in, but it is a gap, not a design choice. See [REGULATORY.md](REGULATORY.md).

**2. Razorpay's webhook signature scheme is unverified.**
[`src/webhook/verify.ts`](../src/webhook/verify.ts) implements the conventional hex
HMAC-SHA256 over the raw body and is marked `// UNVERIFIED`. The header name, digest
encoding (hex vs base64), and the exact bytes covered all need confirming against
Razorpay's own documentation before anyone relies on it.

**3. No live Razorpay API call has been made — not even test mode.**
[`src/webhook/razorpayAdapter.ts`](../src/webhook/razorpayAdapter.ts) parses Razorpay's
*documented* webhook envelope and routes all eighteen documented recurring-payment reasons
into the taxonomy, with tests. That is the shape of the integration, not the integration.
Doing it for real needs test-mode API keys and is scoped in
[RAZORPAY-INTEGRATION.md](RAZORPAY-INTEGRATION.md).

**4. Whether a retry needs its own 24-hour pre-debit notice is unresolved.**
The E-mandate Framework, 2026 is silent on retries. Both readings are implemented behind a
flag and the permissive one is the default. We are not claiming a compliance gap — we are
saying the document does not answer the question. Confirm the figures against the primary
PDF before submission. See [REGULATORY.md](REGULATORY.md).

**5. The generalization result has no confidence interval.**
[Result 3 in the README](../README.md) — 62.7% recovery under an unmapped dialect — comes
from **one run on one seed**. That is precisely the criticism the 50-cohort harness was
built to answer for the deterministic lift, and it has not been answered for this number.
It is not cheap to fix: under an unmapped dialect nothing is settled by triage, so every
decision reaches the model and a single 150-case run takes ~15 minutes on the free tier.
Quote it as a single observation, because that is what it is.

**6. The `readable` labels in the dialect corpus are our own judgement.**
[`src/eval/railDialect.ts`](../src/eval/railDialect.ts) scores the model against our view of
what each synthetic string supports. Three labels were corrected during development when a
live run showed the model was right and the label was too strict; that correction is
recorded in the file header rather than quietly made. A real unmapped rail could be harder
or easier than this corpus.

**7. Perturbing parameters is not the same as testing a wrong model shape.**
[`src/robustness.ts`](../src/robustness.ts) moves the simulator's dials without telling the
agent, which tests sensitivity to those dials. A world where shortfalls, paydays, and
self-healing work in some *entirely different* way is not reachable by moving them, and the
robustness run says nothing about it. See [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md).

**8. The T+3 control arm is an approximation for eNACH.**
Razorpay documents the T+1/T+2/T+3 schedule for **cards and UPI**. For eMandate they
document something different — *"we attempt to retry only when we get the confirmation or
rejection of the last payment"* — so the control arm is faithful for the card and UPI rails
and approximate for the ~28% of the cohort on eNACH. Both arms face the identical rail mix,
so it does not flatter either one in particular. See
[PHASE1-BASELINE.md](PHASE1-BASELINE.md).

**9. Verify the Buildathon submission deadline and requirements** at `razorpay.com/buildathon`.

**10. The repository has no remote.** Four commits exist locally; nothing is pushed.

---

## Closed

- ~~Verify and cite Razorpay's documented subscription retry behaviour.~~ **Done** —
  [Razorpay Docs, Payment Retries](https://razorpay.com/docs/payments/subscriptions/payment-retries/),
  retrieved 2026-08-31, quoted verbatim in [`controlT3.ts`](../src/policy/controlT3.ts).
  The eNACH caveat is item 8 above.
- ~~Map Razorpay's documented recurring-payment error reasons.~~ **Done** — all 18
  `Subsequent Payments` reasons are in `RAIL_CODE_MAP` with verbatim descriptions and a
  rationale each. Nine are deliberately `UNKNOWN` because their descriptions do not settle
  a cause. NPCI codes remain item 1.
- ~~Source the RBI e-mandate pre-debit notification window and AFA thresholds.~~ **Done** —
  cited with section numbers in [`compliance.ts`](../src/policy/compliance.ts). The retry
  ambiguity is item 4 above.
- ~~Decide and document the basis for the gateway-fee assumption.~~ **Done** — it is a
  **synthetic modelling parameter, not a Razorpay price**, documented in
  [ASSUMPTIONS.md](ASSUMPTIONS.md).
- ~~Fix the Phase 1 `UNKNOWN` opening-attempt defect and re-baseline.~~ **Done** — see
  [PHASE1-BASELINE.md](PHASE1-BASELINE.md).
- ~~The `GEMINI_API_KEY` free tier is quota-limited and forces fallbacks.~~ **Superseded** —
  the project migrated off Gemini on 2026-08-31. The chain is now
  **Groq → OpenRouter → Gemini → deterministic fallback**, only `GROQ_API_KEY` is required,
  and the client paces itself against the provider's own rate-limit headers. The last full
  live run produced **0 fallbacks**.
- ~~The headline rests on a single seed.~~ **Done** — [`src/seeds.ts`](../src/seeds.ts)
  reports +19.8 ppt [19.1, 20.4] across 50 cohorts, positive on 50/50. The generalization
  number is still single-run: item 5 above.
- ~~The agent's beliefs and the simulator read the same constants.~~ **Done** — split into
  [`src/sim/worldParams.ts`](../src/sim/worldParams.ts) (the world) and
  [`src/assumptions.ts`](../src/assumptions.ts) (what the agent believes), with tests that
  perturbing the world moves the simulator and leaves the agent's beliefs untouched.
