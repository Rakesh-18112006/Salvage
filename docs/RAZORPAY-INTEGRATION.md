# Razorpay integration — what is real, and what one test-mode run would settle

[← back to the README](../README.md)

> ### ⚠️ No Razorpay API has ever been called by this project
>
> Not in test mode, not in live mode. Every payment outcome in every result comes from
> the seeded simulator in [`src/sim/`](../src/sim). This document exists so that the
> boundary between "we read the docs carefully" and "we ran it" is impossible to blur.

---

## Why there is an adapter at all

One claim in this project does not rest on the simulator:

> We mapped Razorpay's **real documented** recurring-payment error reasons, and the nine
> whose descriptions are genuinely ambiguous are left explicitly `UNKNOWN`.

Until something parsed an actual payload shape, that was a claim about a **comment**.
[`src/webhook/razorpayAdapter.ts`](../src/webhook/razorpayAdapter.ts) makes it a claim
about **code**: it takes the documented webhook envelope, pulls the failure reason out of
the documented payment entity, and hands it to the same `classify()` the simulator's own
codes go through. No special case, no separate table.

[`test/razorpayAdapter.test.ts`](../test/razorpayAdapter.test.ts) runs **all eighteen**
documented reasons through it and asserts each lands on the class
[`RAIL_CODE_DETAIL`](../src/domain/taxonomy.ts) says it should.

---

## Provenance of every field the adapter reads

The payload shape is a vendor fact, and spec rule 1 forbids inventing vendor facts. So
the fields are split by how well we actually know them.

### Sourced

| Field | Source |
|---|---|
| `entity`, `account_id`, `event`, `contains`, `payload`, `created_at` | [Razorpay Docs — Subscription webhook payloads](https://razorpay.com/docs/webhooks/payloads/subscriptions/), retrieved 2026-09-01 |
| `payload.subscription.entity`, `payload.payment.entity` | same |
| payment entity: `id`, `amount`, `currency`, `status`, `order_id`, `invoice_id`, `method`, `error_code`, `error_description` | same |
| error object `{ code, description, reason, source, step }`, with `reason` documented as *"The exact error reason. It can be handled programmatically."* | [Razorpay Docs — e-mandate Handle Errors](https://razorpay.com/docs/payments/recurring-payments/emandate/errors/), retrieved 2026-09-01 |

That last row is why the taxonomy is keyed on `reason` values and not on `code` values.

### Inferred — and deliberately not depended upon

That the error object's `reason` appears on the payment entity under the flattened name
**`error_reason`**.

Razorpay flattens `code` → `error_code` and `description` → `error_description` on the
payment entity, which the webhook page does show. `reason` → `error_reason` following the
same convention is a reasonable inference. **The samples we could read do not display
it.**

So the adapter does not bet on it. It reads `error_reason` when present, falls back to
`error_code`, and reports which one answered in `reasonFieldUsed`. A wrong inference
surfaces as a warning on the first real payload instead of quietly degrading every
failure to `UNKNOWN` while appearing to work.

---

## What a first test-mode run would settle

Razorpay test mode moves no money and needs no live keys — only an account, which is the
merchant's to create. One run would convert four inferences into facts:

1. **Is the field called `error_reason` on the payment entity?** Check `reasonFieldUsed`
   on the first parsed failure. If it says `error_code`, the inference was wrong and the
   adapter says so out loud.
2. **Do the reason values arrive lower-cased**, as the docs table renders them? The
   taxonomy upper-cases before lookup, so either way works — but it should be *known*.
3. **Which events actually carry `payload.payment.entity`?** The adapter allow-lists
   `subscription.charged`, `payment.failed`, `payment.captured` and refuses everything
   else rather than parsing optimistically.
4. **Does the HMAC over the raw body verify** against a real signature? The verifier in
   [`src/webhook/verify.ts`](../src/webhook/verify.ts) already reads raw bytes and
   compares in constant time, per Razorpay's own instruction not to parse or cast the
   body before validating.

### The run itself

```bash
docker compose up -d && node src/db/migrate.ts
RAZORPAY_WEBHOOK_SECRET=<your test-mode webhook secret> node src/webhook/server.ts
```

Point a Razorpay **test-mode** webhook at the ingress, create a test subscription, and
let a charge fail. The event lands in the inbox, deduped on `razorpay_event_id`, and the
parsed reason is visible in the audit trail.

**Do not point live-mode webhooks at this.** It is a prototype with a simulated executor,
and nothing downstream of the ingress is built to touch real money.

---

## What is still missing

- **NPCI NACH return codes are unmapped.** `npci.org.in` returned HTTP 403 to every
  automated fetch on 2026-08-31, and the codes are published only as PDF circulars.
  Rather than transcribe them from a blog, they are left out. Any NACH code therefore
  classifies as `UNKNOWN`, which is never auto-retried — the safe direction to be wrong
  in. See [OPEN-ITEMS.md](OPEN-ITEMS.md).
- **Registration-time errors are not mapped.** Razorpay documents two tables; only
  *Subsequent Payments* is mapped, because that is the lifecycle this project models.
  `incorrect_otp` and friends cannot occur on the path we simulate, and including them
  would suggest a coverage we do not have.
- **No live call has been made.** Everything above is the shape of the work, not the
  work.
