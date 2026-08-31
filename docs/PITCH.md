# SALVAGE — 5-minute pitch

A script and shot list for the submission video. Every number below was recomputed from
this repository on 2026-09-01, and the command that reproduces each one is in the margin.

> **The frame for the whole pitch.** Most projects in this competition can tell you what
> their system scored. Very few can tell you *which part of it earned the score*, or
> *under what conditions the score stops holding*. We built the rig that answers both,
> and it told us three things we did not want to hear. All three are in this script,
> because a panel punishes overclaiming far more heavily than it punishes an honest
> limit — and because the rig is the contribution.

**Rule for the whole video:** the word *simulated* appears on screen in the first ten
seconds and stays in the corner throughout.

---

## 0:00 – 0:30 · The gap

> Every subscription business in India loses money to payments that were never *refused*
> — just fumbled. Insufficient funds on the 27th. A bank in its maintenance window. A
> mandate revoked three months ago. Customers who intended to pay, lost to plumbing.
>
> Razorpay's documented default for cards and UPI is a fixed **T+3 retry**. Their docs
> say it exactly: *"In a T+3 days cycle, we will retry the payment thrice."* It is a
> reasonable default. It is also completely context-free — it doesn't know *why* the
> payment failed, *when* the customer has money, or *whether the rail is even up*.

**On screen:** the T+3 cycle as four identical arrows into a wall.
**Source:** [Razorpay Docs — Payment Retries](https://razorpay.com/docs/payments/subscriptions/payment-retries/)

---

## 0:30 – 1:15 · Where the lift comes from — and the question you were about to ask

> Before the headline, the question you're already forming: *isn't this just smart retry?*
>
> Here's the ladder. Four arms, each adding exactly one capability to the one before it.

| Arm | Recovery | Gained | Attempts | Gateway c/₹ |
|---|---|---|---|---|
| 1. fixed T+3 | 49.4% | — | 603 | 0.602p |
| 2. **+ knows why it failed** | **49.4%** | **+0.0** | **603** | **0.602p** |
| 3. + knows when they're paid | 56.6% | +7.2 | 474 | 0.364p |
| 4. + the other six actions | 68.8% | +12.2 | 474 | 0.319p |

> Arm 2 **is** smart retry — it reads the failure class and refuses to charge a cause no
> retry can clear. It gains **nothing**. Not because the idea is wrong, but because our
> policy gate already enforces it *for the control arm too*. Run the control and read its
> rule counts: `TERMINAL_CLASS_NO_CHARGE` fires 99 times on 300 cases.
>
> So the answer isn't that we beat smart retry. It's that **our baseline already is smart
> retry** — we never switched the gate off to flatter ourselves — and the twenty points
> are measured against that.
>
> The lift is timing and the action space, not the diagnosis.

**On screen:** the four-row ladder, arm 2 highlighted as identical to arm 1.
**Command:** `node src/robustness.ts --scenario baseline`

---

## 1:15 – 1:50 · The result, with an interval

> Fifty independent cohorts. Fifteen thousand simulated failed charges.

| Metric | Control | SALVAGE | Paired difference (95% CI) | Seeds won |
|---|---|---|---|---|
| Recovery | 49.1% | 68.9% | **+19.8 ppt [19.1, 20.4]** | **50 / 50** |
| Gateway cost per ₹ | 0.627p | 0.333p | −0.293p [−0.316, −0.271] | 50 / 50 |
| Attempts | 599 | 474 | −125 [−129, −121] | 50 / 50 |

> Paired bootstrap over the seeds — both arms run on the *same* cohort, so a seed drawing
> many dead mandates depresses both together and the difference cancels it.
>
> And the seed we quote elsewhere ranks **29th of 50** by lift. Middle of its own
> distribution, not the tail. We checked, because you shouldn't have to take our word for
> which one we picked.

**On screen:** the per-seed lift distribution, seed 20260101 marked.
**Command:** `node src/seeds.ts --seeds 50 --cases 300` *(under a second, no API key)*

---

## 1:50 – 2:35 · What the language model is actually for

> Now the uncomfortable part.
>
> On failure classes our taxonomy already maps, we ran the agent with the model on and
> off. Model off: **70.7%, exactly reproducible.** Model on, three runs: 72.0%, 70.0%,
> 68.0%. **The model's effect is inside its own run-to-run noise.** We're not claiming it.
> Essentially all of that lift is deterministic machinery.
>
> That's an honest finding and an incomplete one — it tests the model on the lookup
> table's home ground, where a lookup table should win. The real question is what happens
> where the table has **no row**.
>
> So we changed the rail's vocabulary. New acquirer, codes we've never mapped. This isn't
> hypothetical — NPCI's NACH codes are unmapped in this build today.

| Arm, unmapped vocabulary | Recovery | To a human |
|---|---|---|
| Mapped vocabulary (the ceiling) | 73.3% | 1 |
| Control T+3 | **0.0%** | 0 |
| SALVAGE, model **off** | **0.0%** | 150 |
| SALVAGE, model **reading the codes** | **62.7%** | 25 |

> Everything collapses. Every failure is unclassified, an unclassified failure is never
> auto-retried, and the whole cohort goes to a human. The deterministic system doesn't
> fail here because it's badly written — it **structurally cannot read unfamiliar prose**.
>
> The model can. It recovers **85.5% of the ground the unknown vocabulary cost**.
>
> And we score it on both halves of the job, because a model that never says "I don't
> know" authorises charges against mandates that can never carry them. **88.3%** of
> legible text read correctly, **zero** misreads into different handling. **86.2%** of
> *illegible* text correctly declined — and the **13.8% it over-read is on screen**. All
> four are the same string: *"amount not acceptable"*, read as `AMOUNT_EXCEEDS_MANDATE`.
> Which is exactly the conflation our own taxonomy warns about for Razorpay's
> `invalid_amount`.
>
> Of 192 adopted readings, **192 landed on the right side of "can a charge ever work?"**
> Zero impossible charges unlocked.

**On screen:** the collapse-to-zero, then the recovery; then the over-confidence row.
**Command:** `node src/generalization.ts --cases 150`

---

## 2:35 – 3:15 · Where we're wrong, and where it breaks

> We wrote the simulator *and* the policy. If the agent's beliefs and the world's
> behaviour come from the same constants, the result is a tautology. That's the sharpest
> objection to a project like this, and it's literally true of one function in our code.
>
> So we split them. The simulator reads its own parameters; the agent still reads its
> assumptions file and has no access to the world. Then we broke the world eleven
> different ways without telling the agent.
>
> **The lift survives in ten of eleven.** Here's the eleventh.

| World | T+3 | SALVAGE | Lift |
|---|---|---|---|
| baseline | 49.4% | 68.8% | +19.4 |
| shortfall-transient | 56.3% | 64.1% | +7.8 |
| slow customers | 49.4% | 67.3% | +17.9 |
| **all-adverse** | **74.9%** | **67.0%** | **−7.9** |

> In `all-adverse` we lose, by eight points. And look **why** — T+3 doesn't get worse
> there, it gets *better*, from 49% to 75%.
>
> That world is one where balance shortfalls clear on their own and accounts deplete
> immediately. Which is a world where blind daily retry genuinely works, and **the problem
> we built this to solve doesn't really exist.** Our own assumptions file predicted it:
> *"if balances were independent day to day, the fixed T+3 policy would already be
> near-optimal and this whole project would have no thesis."*
>
> So the honest claim is conditional: **SALVAGE is worth having where balance shortfalls
> persist.** That's a testable property of a real portfolio, and it's the first thing
> you'd measure before deploying any of this.
>
> One more we won't hide. On the **all-in** measure, which prices customer patience, the
> agent is **worse** — 1.245p against 2.483p. The two curves cross when a customer contact
> is worth about **₹3.27**. We priced one at **₹15**, deliberately, so messaging could
> never be the cheap default. That choice is what puts us on the losing side of that line.
> The argument worth having is about the price of a contact, not the cost ratio — so we
> ship the curve.

**On screen:** the eleven-world table, then the break-even chart with the crossover marked.
**Command:** `node src/robustness.ts` · `node src/dashboard.ts && open out/dashboard.html`

---

## 3:15 – 3:50 · The guardrails, and the one thing that isn't simulated

> Every action passes a deterministic policy gate the agent cannot argue past. It blocked
> 108 actions on this run — 99 retries against terminal mandates, 9 charges on failures
> nobody could classify.
>
> That last one matters. We mapped Razorpay's **real documented** recurring-payment error
> reasons. Nine of the eighteen are too ambiguous to map — *"declined due to business or
> technical reasons"* could be anything — so they classify as UNKNOWN, and **an unknown
> failure is never automatically retried.**
>
> And that's the one claim here that doesn't rest on the simulator. There's an adapter
> that takes Razorpay's documented webhook envelope, pulls the failure reason off the
> payment entity, and hands it to the *same* classifier our simulated codes go through.
> All eighteen documented reasons are tested through it.
>
> What we have **not** done is call their API — not even test mode. That needs an account,
> and the document says exactly what a first run would settle.
>
> The RBI parameters are sourced, not invented: pre-transaction notification at least 24
> hours before the debit, Section 6 of the **E-mandate Framework, 2026**, which replaced
> the 2019 circular most people still cite.
>
> One honest caveat. That framework applies to *cards, PPI and UPI* — it doesn't name
> NACH, so we apply the rule only to the rails it names. And it says **nothing at all**
> about retries. We're not claiming to have found a compliance gap — we're saying the
> document doesn't answer the question, so we implemented both readings behind a flag.

**On screen:** the policy-gate rule table, then the 18 reasons flowing through the adapter.
**Sources:** [E-mandate Framework, 2026](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374) · [Razorpay eMandate errors](https://razorpay.com/docs/payments/recurring-payments/emandate/errors/)

---

## 3:50 – 4:25 · It survives being killed

> This runs on a real durable spine — Postgres, Redis, worker containers.
>
> *[run the chaos demo live]*
>
> We `docker kill` an executor with SIGKILL while it's holding charges in flight. No
> handler runs. The survivor finishes the batch.
>
> **Zero duplicate charges. Zero lost cases. And the event log still reconstructs case
> state exactly** — checked against the *gateway's* own ledger, in its own table, not ours.

**On screen:** the terminal, live.
**Command:** `node src/chaos.ts --cases 250`

---

## 4:25 – 5:00 · The audit trail, and the close

> Open any case and walk the chain: what the agent saw, what it proposed, what the gate
> ruled, what executed.
>
> Here's a revoked mandate. The fixed policy proposes a retry. The gate refuses it by name
> — `TERMINAL_CLASS_NO_CHARGE` — and the case stops instead of burning three more fees.
>
> So — what did we build?
>
> **A measurement rig, and a recovery agent worth measuring.** The agent is worth about
> twenty points of recovery at half the gateway cost, on a control arm that already
> declines every impossible charge, holding across fifty cohorts and ten of eleven broken
> worlds.
>
> And the rig is what lets us tell you the rest: that the language model contributes
> nothing on failures we already understand, and 85% of the recoverable ground on
> failures we don't. That we lose in the world where our central assumption is false. That
> we cost more per rupee once you price customer patience above ₹3.27.
>
> Most projects can't separate those things. That's the part we'd want you to take.

**On screen:** the audit trail — *proposed: RETRY_NOW → executed: STOP · DENY ·
TERMINAL_CLASS_NO_CHARGE*.
**Command:** `node src/dashboard.ts --cases 300 && open out/dashboard.html`

---

## Verified numbers

### Multi-cohort (50 seeds × 300 cases, deterministic, exactly reproducible)

| Metric | Control | SALVAGE | Paired difference (95% CI) | Seeds won |
|---|---|---|---|---|
| Recovery rate | 49.1% | 68.9% | **+19.8 ppt [19.1, 20.4]** | 50 / 50 |
| Gateway cost per ₹ | 0.627p | 0.333p | −0.293p [−0.316, −0.271] | 50 / 50 |
| Total attempts | 599 | 474 | −125 [−129, −121] | 50 / 50 |

Lift range across seeds: **13.7 to 25.3 ppt.** Published seed `20260101` ranks 29th of 50.

### Single cohort (seed `20260101`, 300 cases, deterministic)

| Metric | Control (T+3) | SALVAGE | Delta |
|---|---|---|---|
| Recovery rate | 50.3% | 70.7% | **+20.3 ppt** |
| Gateway cost per ₹ recovered | 0.505p | 0.264p | −47.8% |
| **All-in cost per ₹ (incl. patience)** | **1.245p** | **2.483p** | **agent worse** |
| Total attempts | 610 | 488 | −20.0% |
| Customer contacts | 0 | 148 | +148 |
| Actions blocked by the gate | 108 | 0 | — |

All-in break-even: **₹3.27 per contact.** We assumed ₹15.00.

### The ablation ladder (baseline world, 10 seeds)

| Arm | Recovery | Attempts | Gateway c/₹ |
|---|---|---|---|
| 1. fixed T+3 | 49.4% | 603 | 0.602p |
| 2. + class-aware (smart retry) | 49.4% | 603 | 0.602p |
| 3. + inflow timing | 56.6% | 474 | 0.364p |
| 4. + full action space | 68.8% | 474 | 0.319p |

### Robustness (11 worlds × 10 seeds)

Lift established in **10 of 11**. Weakest positive: `shortfall-transient`, +7.8 ppt.
Fails in `all-adverse`: **−7.9 ppt [−9.1, −6.7], 0/10 seeds.**
`notify-useless` is a **no-op** — the deterministic agent never sends a bare notification.

### What the model contributes

| Cohort | Model off | Model on |
|---|---|---|
| Mapped vocabulary (Phase 3) | 70.7% exactly | 72.0 / 70.0 / 68.0 — **inside noise** |
| Unmapped vocabulary | **0.0%** | **62.7%** — 85.5% of ground lost |

Comprehension: 88.3% correct, 0 misreads into different handling, 86.2% of illegible text
declined, 13.8% over-read. Consequence: 192/192 on the right side, **0 impossible charges
unlocked**. Live Groq `openai/gpt-oss-120b`: 33 calls, 184 cached, 0 fallbacks.

---

## Provenance — read this before recording

`src/phase3.ts` and `src/generalization.ts` compute provenance from what was **observed**,
print it, and **exit non-zero** if a run that requested the model produced zero successful
calls. You cannot accidentally present a fallback run as an AI result.

Before recording, check the RESULT PROVENANCE block says `MODEL-DRIVEN — N live calls`.
A full 300-case live run takes ~7 minutes: the free tier's binding limit is 8,000 tokens
per minute and the client paces itself against the provider's own rate-limit headers.

Provider chain: **Groq → OpenRouter → Gemini → deterministic fallback.** Only
`GROQ_API_KEY` is required.

## Pre-flight checklist

```bash
docker compose up -d && node src/db/migrate.ts && docker compose --profile chaos up -d --scale worker=2
```

- [ ] `npm test` green (230 tests: 227 pass, 3 skipped live-model evals)
- [ ] `npm run seeds` — the intervals, under a second, no key
- [ ] `npm run robustness` — the 11 worlds, including the one we lose
- [ ] `npm run phase3:offline` — the exact deterministic floor
- [ ] `npm run phase3` — check RESULT PROVENANCE says MODEL-DRIVEN (~7 min)
- [ ] `npm run generalization` — the model's actual contribution
- [ ] `npm run chaos` — all four guarantees PASS
- [ ] `npm run dashboard` — check the provenance banner and the break-even chart
- [ ] Numbers on screen match the tables above

## Things you must NOT say

- ❌ "production-ready", "production system", or any claim of production performance
- ❌ "real customers", "real payments", "real money", "actual recovery rate"
- ❌ "we called the Razorpay API" — **we have not, not even test mode**
- ❌ "AI-driven results" for a deterministic or fallback-only run
- ❌ implying the LLM produced the ~20 ppt lift — it does not; its measured value is
  confined to unmapped rail codes
- ❌ "it works in every world" — it loses in `all-adverse`, by 7.9 points
- ❌ "we beat smart retry" — our *baseline* already is smart retry; say that instead
- ❌ "we found a compliance gap in Razorpay's T+3" — the framework is silent on retries
- ❌ "RBI requires a fresh notice per retry" — the document does not say that
- ❌ "quiet hours are an RBI rule" — that is our own operational policy
- ❌ "₹3 is the Razorpay fee" — it is a synthetic modelling parameter
- ❌ "+20% improvement" — it is ~+20 percentage **points** (≈40% relative)
- ❌ quoting a single live run as reproducible — three runs gave 72.0%, 70.0%, 68.0%
- ❌ citing the 2019 circular (RBI/2019-20/47) as current — it was repealed
- ❌ claiming NPCI NACH codes are mapped — they are not

## Things you CAN safely say

- ✅ "All payment data is simulated; no real money moves and no real payment API is called"
- ✅ "+19.8 percentage points, 95% CI [19.1, 20.4], positive on 50 of 50 cohorts"
- ✅ "The deterministic result is exactly reproducible — same seed, same numbers, any machine"
- ✅ "Our control arm already refuses every impossible charge; the gate applies to both arms"
- ✅ "The lift is timing and the action space, not the diagnosis — the ladder shows it"
- ✅ "It holds in ten of eleven perturbed worlds, and we show you the eleventh"
- ✅ "The claim is conditional: this is worth having where balance shortfalls persist"
- ✅ "On all-in cost we are worse above ₹3.27 per contact, and we ship the curve"
- ✅ "The model's effect on known failures is within noise, and we measured it both ways"
- ✅ "On rail codes we have never mapped, the model recovers 85% of the ground lost"
- ✅ "It declines to guess on 86% of responses that establish no cause, and we report the rest"
- ✅ "We mapped Razorpay's real documented error reasons and left the ambiguous ones UNKNOWN"
- ✅ "An unknown failure is never automatically retried"
- ✅ "The adapter parses Razorpay's documented webhook shape; all 18 reasons are tested through it"
- ✅ "The RBI figures are quoted from the E-mandate Framework, 2026, with section numbers"
