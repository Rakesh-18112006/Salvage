# SALVAGE — 5-minute pitch

A script and shot list for the submission video. Every number below was verified against
the source code and recomputed independently on 2026-08-31; the commands that reproduce
each one are in the margin.

> **The numbers in this script come from a LIVE, MODEL-DRIVEN run** on Groq
> (`openai/gpt-oss-120b`): 48 live calls, 202 served from the decision cache, 0 fallbacks.
> Verified by the RESULT PROVENANCE block, which reports `MODEL-DRIVEN`. The deterministic
> figures are also given, because the difference between them is what the model is worth.

**Rule for the whole video:** the word *simulated* appears on screen in the first ten
seconds and stays in the corner throughout. A panel punishes overclaiming far more
heavily than it punishes synthetic data honestly labelled.

---

## 0:00 – 0:35 · The gap

> Every subscription business in India loses money to payments that were never *refused* —
> just fumbled. Insufficient funds on the 27th. A bank in its maintenance window. A
> mandate the customer revoked three months ago. Customers who intended to pay, lost to
> plumbing.
>
> Razorpay's documented default for cards and UPI is a fixed **T+3 retry**. Their docs
> say it exactly: *"In a T+3 days cycle, we will retry the payment thrice. That is, once
> every day for 3 days, excluding the date of the charge."* It's a reasonable default. It
> is also completely context-free — it doesn't know *why* the payment failed, *when* the
> customer has money, or *whether the rail is even up*.

**On screen:** the T+3 cycle as four identical arrows into a wall.
**Source:** [Razorpay Docs — Payment Retries](https://razorpay.com/docs/payments/subscriptions/payment-retries/)

---

## 0:35 – 1:10 · The number that makes the case

> Here's what that costs. On a seeded cohort of 300 genuinely-failed charges, a third of
> the failures are **terminal** — a revoked mandate, a dead card, a charge above the
> mandate cap. No retry can ever succeed against them.
>
> The fixed policy doesn't know that. Every attempt it spends there is a guaranteed loss
> that still costs a fee.

**On screen:** the failure-class table, terminal rows highlighted.
**Command:** `node src/main.ts --cases 300 --seed 20260101`

---

## 1:10 – 2:00 · The thesis, and the action space

> So we stopped treating this as a retry problem. A failed recurring payment is a
> **bounded decision problem** under cost, compliance, and customer-patience constraints.
>
> Retry is one of nine actions, not the default. Defer past an outage. Time-shift to the
> customer's payday. Re-mandate. Payment link. Notify. Escalate. Stop.
>
> And **wait**. Doing nothing is a first-class action — because some customers fix it
> themselves, and every intervention costs money and patience.

**On screen:** the action-space diagram; `WAIT` pulses.

---

## 2:00 – 2:45 · What the model does — and what it is forbidden to do

> The model does diagnosis and strategy. It does **not** do arithmetic.
>
> It's never asked "retry in how many hours?" It's asked "should this wait for the
> customer's money to arrive?" When the next payday falls, what each action costs, the
> expected value of each option — all deterministic code.
>
> And the model never runs over the full ledger. Roughly 40% of decisions are settled by
> the taxonomy before a model is involved, identical contexts are answered once and
> cached, and when the API is unavailable a deterministic policy takes over so **every
> case still resolves**.

**On screen:** the two-column "model supplies / code supplies" table.

---

## 2:45 – 3:20 · The result

> Same seeded population, both arms, identical world.
>
> Recovery goes from **50.3% to about 71%** — call it **+20 percentage points**, roughly a
> 40% relative improvement. **19% fewer attempts.** Gateway cost per rupee recovered down
> **47%**.
>
> And we can tell you what the language model is actually worth, because we ran the agent
> both ways on the same cohort. With the model off entirely it reaches **70.7%, every
> time**. With the model on, three runs gave **72.0%, 70.0% and 68.0%** — and on that last
> one the model did *worse* than no model at all.
>
> So the model's contribution is **well inside its own run-to-run variance**, and we're not
> going to claim it as a win. Essentially all of this lift comes from the deterministic
> machinery — the taxonomy, the cost model, the policy gate. That's a less exciting
> sentence than "the AI did it", and it's the one the evidence supports.
>
> And here's the part we won't hide: on the *all-in* measure, which prices customer
> patience and friction, the agent is **worse — 1.245p to 2.697p per rupee**. It recovers
> more money at a higher modelled human cost. That's a real trade-off, and whether it's
> worth it depends on what you think a customer message costs — which is exactly why we
> report it instead of averaging it away. We ship the sensitivity table too.

**On screen:** the headline comparison, then the all-in row deliberately lingered on.
**Command:** `node src/phase3.ts --cases 300` (~7 min — run it before you record and show the output)

---

## 3:20 – 4:00 · The guardrails, and what we actually verified

> Every action passes a deterministic policy gate the agent cannot argue past. On this
> run it blocked **108 actions** — 99 retries against terminal mandates, and 9 charges on
> failures nobody could classify.
>
> That last one matters. We mapped Razorpay's **real documented** recurring-payment error
> reasons. Nine of the eighteen are too ambiguous to map — "declined due to business or
> technical reasons" could be anything — so they classify as UNKNOWN, and **an unknown
> failure is never automatically retried.**
>
> The RBI parameters are sourced, not invented: pre-transaction notification at least 24
> hours before the debit, Section 6 of the **E-mandate Framework, 2026**, which replaced
> the 2019 circular most people still cite.
>
> One honest caveat. That framework applies to *cards, PPI and UPI* — it doesn't name
> NACH. So we apply the rule only to the rails it names. And it says **nothing at all**
> about retries. Whether a retry needs its own notice is genuinely unresolved in the text,
> so we implemented both readings behind a flag and default to the permissive one. We're
> not claiming to have found a compliance gap — we're saying the document doesn't answer
> the question.

**On screen:** the policy-gate rule table.
**Sources:** [E-mandate Framework, 2026](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374) · [Razorpay eMandate error codes](https://razorpay.com/docs/payments/recurring-payments/emandate/errors/)

---

## 4:00 – 4:35 · It survives being killed

> This runs on a real durable spine — Postgres, Redis, worker containers.
>
> *[run the chaos demo live]*
>
> We `docker kill` an executor with SIGKILL while it's holding charges in flight. No
> handler runs. The survivor finishes the batch.
>
> **Zero duplicate charges. Zero lost cases. And the event log still reconstructs case
> state exactly.**
>
> We check that against the *gateway's* own ledger, in its own table — not ours.

**On screen:** the terminal, live.
**Command:** `node src/chaos.ts --cases 250`

---

## 4:35 – 5:00 · The audit trail, and the honest close

> Open any case and walk the chain: what the agent saw, what it proposed, what the gate
> ruled, what actually executed.
>
> Here's a revoked mandate. The fixed policy proposes a retry. The gate refuses it by name
> — `TERMINAL_CLASS_NO_CHARGE` — and the case stops instead of burning three more fees.
>
> This is a working prototype with a measured comparison against a control arm. The data
> is simulated and labelled as such everywhere. No real money moves and no real payment
> API is called — the only outbound calls are to the model provider, for diagnosis.
> Every cost assumption is documented, and the ones that flatter us most
> are the ones we set most conservatively.
>
> The gap is real, the gap is documented, and it's in your core domain.

**On screen:** the audit trail — *proposed: RETRY_NOW → executed: STOP · DENY ·
TERMINAL_CLASS_NO_CHARGE*.
**Command:** `node src/dashboard.ts --cases 300 && open out/dashboard.html`

---

## Verified numbers (seed `20260101`, 300 cases)

**One live, model-driven run** — Groq `openai/gpt-oss-120b`, 48 live calls, 202 cached, 0
fallbacks. One of three observed live runs (68.0–72.0%); the deterministic figure is 70.7%
and is exactly reproducible.

| Metric | Control (T+3) | Agent (live model) | Delta |
|---|---|---|---|
| Recovery rate | 50.3% | 72.0% | **+21.7 ppt** (≈ +43.1% relative) |
| Recovered | ₹3,62,549.00 | ₹5,52,884.00 | +₹1,90,335.00 |
| Gateway cost per ₹ recovered | 0.505p | 0.268p | −46.9% |
| **All-in cost per ₹ recovered** | **1.245p** | **2.697p** | **+116.7% (agent worse)** |
| Total attempts | 610 | 494 | −19.0% |
| Attempts on terminal cases | 99 | 99 | 0 |
| Customer contacts | 0 | 220 | +220 |
| Cases escalated to a human | 10 | 13 | +3 |

**What the model itself contributes** — run both ways on the same cohort:

| Arm | Recovery | Reproducible? |
|---|---|---|
| Control (fixed T+3) | 50.3% | exactly |
| Agent, model OFF | **70.7%** | **exactly** |
| Agent, model ON — run 1 | 72.0% | no |
| Agent, model ON — run 2 | 70.0% | no |
| Agent, model ON — run 3 | 68.0% | no |

**The model's effect is within its own run-to-run noise.** Say so. Claim the ~+20 ppt for
the deterministic machinery, not for the LLM.

Under the conservative `per_debit` reading (deterministic): control 43.3%, agent 68.3%.

---

## Provenance — read this before recording

The headline table is a **genuine model-driven run**. `src/phase3.ts` computes provenance
from what was **observed**, prints it, and **exits non-zero** if a run that requested the
model produced zero successful calls. You cannot accidentally present a fallback run as an
AI result.

Before recording, run `node src/phase3.ts --cases 300` and check the RESULT PROVENANCE
block says `MODEL-DRIVEN — N live calls`. It takes about 7 minutes: the free tier's binding
limit is 8,000 tokens/minute and the client paces itself against the provider's own
rate-limit headers. If it says `FALLBACK ONLY`, the daily quota is out — use the
deterministic numbers and say so.

Provider chain: **Groq → OpenRouter → Gemini → deterministic fallback.** Only
`GROQ_API_KEY` is required.

## Pre-flight checklist

```bash
docker compose up -d && node src/db/migrate.ts && docker compose --profile chaos up -d --scale worker=2
```

- [ ] `npm test` green (137 tests: 134 pass, 3 skipped live-model evals)
- [ ] `node src/main.ts --cases 300` — Phase 1 runs with no database
- [ ] `node src/phase3.ts --cases 300` — check RESULT PROVENANCE says MODEL-DRIVEN (~7 min)
- [ ] `node src/phase3.ts --cases 300 --deterministic-only` — the floor, no API key needed
- [ ] `node src/chaos.ts --cases 250` — all four guarantees PASS
- [ ] `node src/dashboard.ts --cases 300` — check the provenance banner says what you intend
- [ ] Numbers on screen match the table above; if you re-ran with different flags, update the script

## Things you must NOT say

- ❌ "production-ready", "production system", or any claim of production performance
- ❌ "real customers", "real payments", "real money", "actual recovery rate"
- ❌ "AI-driven results" / "Gemini decided this" **for a deterministic or fallback-only run**
- ❌ "we found a compliance gap in Razorpay's T+3" — the framework is silent on retries; we did not find a gap
- ❌ "RBI requires a fresh notice per retry" — the document does not say that
- ❌ "quiet hours are an RBI rule" — that is our own operational policy
- ❌ "₹3 is the Razorpay fee" — it is a synthetic modelling parameter
- ❌ "+20% improvement" — it is ~+20 percentage **points** (≈40% relative)
- ❌ implying the LLM produced the lift — its effect is within run-to-run noise
- ❌ quoting a single live run as reproducible — three runs gave 72.0%, 70.0%, 68.0%
- ❌ citing the 2019 circular (RBI/2019-20/47) as current — it was repealed
- ❌ claiming NPCI NACH codes are mapped — they are not; npci.org.in blocked automated access

## Things you CAN safely say

- ✅ "All payment data is simulated; no real money moves and no real payment API is called"
- ✅ "The cohort is seeded and reproducible — same seed, same numbers, on any machine"
- ✅ "Control and agent face an identical simulated world; only their decisions differ"
- ✅ "These are prototype simulation results measured against a control arm"
- ✅ "Every cost assumption is documented with its basis, and the fee is a stated synthetic parameter"
- ✅ "The AI cannot bypass the deterministic policy gate — the gate applies to both arms"
- ✅ "We mapped Razorpay's real documented error reasons, and left the ambiguous ones explicitly UNKNOWN"
- ✅ "An unknown failure is never automatically retried"
- ✅ "The RBI figures are quoted from the E-mandate Framework, 2026, with section numbers"
- ✅ "The framework is silent on retries, so we implemented both readings and defaulted to the permissive one"
- ✅ "On the all-in cost measure the agent is worse, and we report that"
- ✅ "Essentially all the lift is deterministic; the model's effect is within noise, and we measured both"
- ✅ "The deterministic run is exactly reproducible; live model runs are not"
- ✅ "The model runs on Groq's free tier with strict schema-constrained decoding"
