# Open items

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Open items

1. Verify the Razorpay Buildathon submission deadline and requirements at `razorpay.com/buildathon`.
2. ~~Verify and cite Razorpay's documented subscription retry behaviour.~~ **Done** — [Razorpay Docs, Payment Retries](https://razorpay.com/docs/payments/subscriptions/payment-retries/), retrieved 2026-08-31, verbatim: *"In a T+3 days cycle, we will retry the payment thrice. That is, once every day for 3 days, excluding the date of the charge."* **Caveat now documented:** that schedule is what Razorpay documents for **cards and UPI**. For eMandate they document something different — *"we attempt to retry only when we get the confirmation or rejection of the last payment, as it may take more than 24 hours"* — so our fixed T+3 control is faithful for the card and UPI rails and is an approximation for the 28% of the cohort on eNACH.
3. **Partly done.** `RAIL_CODE_MAP` now holds Razorpay's 18 documented recurring-payment (`Subsequent Payments`) reasons from [Razorpay Docs](https://razorpay.com/docs/payments/recurring-payments/emandate/errors/), retrieved 2026-08-31, each with its verbatim description and a rationale. **Still open: NPCI NACH return codes.** They are published only as PDF circulars (274, 240, NACH-006-FY-24-25) and npci.org.in returned HTTP 403 to every automated fetch on 2026-08-31. Rather than transcribe them from a blog, they are omitted — so any NACH code classifies as UNKNOWN, which the gate treats as non-retryable.
4. ~~Source the RBI e-mandate pre-debit notification window and AFA thresholds.~~ **Done** — sourced from the E-mandate Framework, 2026 with citations in [`compliance.ts`](../src/policy/compliance.ts). **Still open:** whether a *retry* needs its own 24h notice (see "a regulatory ambiguity we found" above). Confirm the figures against the primary PDF before submission.
5. ~~Decide and document the basis for the gateway-fee assumption.~~ **Done** — documented in full at [`src/assumptions.ts`](../src/assumptions.ts) and in "The gateway fee" below. It is a **synthetic modelling parameter, not a Razorpay price.**
6. **Still open.** Verify and cite Razorpay's webhook signature scheme — header name, digest encoding, and the exact bytes covered. [`src/webhook/verify.ts`](../src/webhook/verify.ts) implements the conventional hex HMAC-SHA256 over the raw body and is marked `// UNVERIFIED`.
7. The `GEMINI_API_KEY` in `.env` is quota-limited (free tier). A paid key would cut the fallback rate; the system is correct either way, but the demo is smoother with headroom.
8. ~~Fix the Phase 1 `UNKNOWN` opening-attempt defect and re-baseline.~~ **Done** — see "The Phase 1 defect" above.

---
