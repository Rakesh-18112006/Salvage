# SALVAGE — 5-minute pitch

A script and shot list for the submission video. Every number below was recomputed from
this repository on 2026-09-01, and the command that reproduces each one is in the margin.

> **The frame for the whole pitch.** Most projects can tell you what their system scored.
> Very few can tell you *which part of it earned the score*, or *when the score stops
> holding*. This script answers both — at length where the answer is the strongest thing
> we have, and briefly where it is unflattering. Each limit is stated once and not dwelt
> on: a panel reads one honest sentence as confidence and three as an apology.
>
> **Timing.** 742 spoken words, about 287 seconds at a normal pitch pace, inside a
> 300-second video. Every section is within a few seconds of its slot, with ~13 seconds
> of breathing room spread across the whole thing. Re-measure if you rewrite a section.

**Rule for the whole video:** the word *simulated* appears on screen in the first ten
seconds and stays in the corner throughout.

---

## 0:00 – 0:32 · The gap

> Every subscription business in India loses money to payments that were never *refused*
> — just fumbled. Insufficient funds on the 27th. A bank in maintenance. A mandate revoked
> three months ago. Customers who meant to pay, lost to plumbing.
>
> Razorpay's documented default is a fixed **T+3 retry** — three tries, one a day. A
> reasonable default, and completely context-free. It doesn't know *why* the payment
> failed, *when* the customer has money, or *whether the rail is even up*.

**On screen:** the T+3 cycle as four identical arrows into a wall.
**Source:** [Razorpay Docs — Payment Retries](https://razorpay.com/docs/payments/subscriptions/payment-retries/)

---

## 0:32 – 1:07 · Where the lift comes from

> Before the headline — the question you're already forming: *isn't this just smart retry?*
>
> Here's the ladder. Four arms, each adding one capability.

| Arm | Recovery | Gained | Attempts |
|---|---|---|---|
| 1. fixed T+3 | 49.4% | — | 603 |
| 2. **+ knows why it failed** | **49.4%** | **+0.0** | **603** |
| 3. + knows when they're paid | 56.6% | +7.2 | 474 |
| 4. + the other six actions | 68.8% | +12.2 | 474 |

> Arm two **is** smart retry. It gains **nothing** — because our policy gate already
> enforces it for the control arm too. `TERMINAL_CLASS_NO_CHARGE` fires 99 times on 300
> cases.
>
> So we don't beat smart retry. **Our baseline already is smart retry**, and the twenty
> points are measured against that. The lift is timing and the action space — not the
> diagnosis.

**On screen:** the four-row ladder, arm 2 highlighted as identical to arm 1.
**Command:** `node src/robustness.ts --scenario baseline`

---

## 1:07 – 1:31 · The result, with an interval

> Fifty independent cohorts. Fifteen thousand simulated failed charges.

| Metric | Control | SALVAGE | Paired difference (95% CI) | Seeds won |
|---|---|---|---|---|
| Recovery | 49.1% | 68.9% | **+19.8 ppt [19.1, 20.4]** | **50 / 50** |
| Gateway cost per ₹ | 0.627p | 0.333p | −0.293p [−0.316, −0.271] | 50 / 50 |

> Paired bootstrap — both arms run the same cohort, so a bad seed hits both and the
> difference cancels it.
>
> And the seed we quote elsewhere ranks **29th of 50**. Middle of its own distribution.
> We checked, so you don't have to take our word for which one we picked.

**On screen:** the per-seed lift distribution, seed 20260101 marked.
**Command:** `node src/seeds.ts --seeds 50 --cases 300` *(under a second, no API key)*

---

## 1:31 – 2:31 · What the language model is actually for

> Now the uncomfortable part.
>
> On failures our taxonomy already maps, we ran the agent with the model on and off. Off:
> **70.7%, exactly reproducible.** On, five runs: 72 down to 67 — **mean 69.7, below the
> model-off figure.** **That is inside its own
> noise.** We're not claiming it.
>
> But that tests it on the lookup table's home ground. The real question is where the
> table has **no row**. So we changed the rail's vocabulary — codes we've never mapped.
> Not hypothetical: NPCI's NACH codes are unmapped in this build today.

| Arm, unmapped vocabulary | Recovery | To a human |
|---|---|---|
| Mapped vocabulary (the ceiling) | 73.3% | 1 |
| Control T+3 · SALVAGE model **off** | **0.0%** | 0 · 150 |
| SALVAGE **reading the codes** | **61.3%** | 28 |

> Everything collapses to zero. The deterministic system **structurally cannot read
> unfamiliar prose**. The model can — it recovers **85% of the ground lost**.
>
> And we score refusal, not just comprehension: **87%** of legible text read correctly,
> **86%** of *illegible* text correctly declined. The **14% it over-read is on screen** —
> all four the same string, *"amount not acceptable"*. Zero impossible charges unlocked.

**On screen:** the collapse-to-zero, then the recovery; then the over-confidence row.
**Command:** `node src/generalization.ts --cases 150`

---

## 2:31 – 2:59 · Where we're wrong

> We wrote the simulator *and* the policy — so we split them, and broke the world eleven
> ways without telling the agent.
>
> **The lift survives ten.** In the eleventh, T+3 *improves* to 75% and we lose — a world
> where daily retry works and our problem doesn't exist.
>
> So: **worth having where balance shortfalls persist.** And above **₹3.27 a contact**
> we're the expensive option. We ship both curves.

**On screen:** the two-row table, then the break-even chart with the crossover marked.
**Command:** `node src/robustness.ts` · `node src/dashboard.ts && open out/dashboard.html`

---

## 2:59 – 3:54 · The guardrails, and the one thing that isn't simulated

> Every action passes a deterministic policy gate the agent cannot argue past. It blocked
> 108 actions here — 99 retries against dead mandates, 9 charges on failures nobody could
> classify.
>
> We mapped Razorpay's **real documented** error reasons. Nine of the eighteen are too
> ambiguous to map — *"declined due to business or technical reasons"* could be anything —
> so they're UNKNOWN, and **an unknown failure is never automatically retried.**
>
> That's the one claim here that isn't simulated: an adapter takes Razorpay's documented
> webhook shape and hands the reason to the same classifier. All eighteen tested through
> it. What we have **not** done is call their API — not even test mode.
>
> RBI parameters are sourced with section numbers, from the **2026 E-mandate Framework**.
> It's silent on retries, so we implemented both readings — we're not claiming a
> compliance gap.

**On screen:** the policy-gate rule table, then the 18 reasons flowing through the adapter.
**Sources:** [E-mandate Framework, 2026](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374) · [Razorpay eMandate errors](https://razorpay.com/docs/payments/recurring-payments/emandate/errors/)

---

## 3:54 – 4:18 · It survives being killed

> This runs on a real durable spine — Postgres, Redis, worker containers.
>
> *[run the chaos demo live — let it breathe, the terminal is the point]*
>
> We `docker kill` an executor with SIGKILL while it's holding charges in flight. No
> handler runs. The survivor finishes the batch.
>
> **Zero duplicate charges. Zero lost cases.** And the event log still reconstructs case
> state exactly — checked against the *gateway's* own ledger, not ours.

**On screen:** the terminal, live.
**Command:** `node src/chaos.ts --cases 250`

---

## 4:18 – 5:00 · The audit trail, and the close

> Open any case and walk the chain. A revoked mandate: the fixed policy proposes a retry,
> the gate refuses it **by name**, and the case stops instead of burning three more fees.
>
> So what did we build? **A measurement rig, and an agent worth measuring** — twenty points
> at half the gateway cost, against a control that already declines every impossible
> charge, across fifty cohorts and ten of eleven broken worlds.
>
> And the rig is what lets us say the sharper thing: the model contributes **nothing** on
> failures we already understand, and **85%** of the recoverable ground on failures we
> don't. Two verdicts on one model, because we could tell them apart. Most projects can't.

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

This is what the dashboard shows, and it is **deterministic on purpose** — see the note in
`scripts/prep-recording.sh`. Built with `--use-model` the dashboard puts a fifth live
observation on screen (67.0%, +16.7 ppt) beside a deck claiming +19.8 ppt across fifty
cohorts. Both are correct; together they look like a contradiction, and a five-minute video
has no room to explain the difference.

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
| Mapped vocabulary (Phase 3) | 70.7% exactly | 72.0 / 71.7 / 70.0 / 68.0 / 67.0 — mean **69.7**, *below* the floor |
| Unmapped vocabulary | **0.0%** | **61.3%** — 83.6% of ground lost |

Comprehension: 86.6% correct, 0 misreads into different handling, 86.2% of illegible text
declined, 13.8% over-read. Consequence: 187/187 on the right side, **0 impossible charges
unlocked**. Live Groq `openai/gpt-oss-120b`: 33 calls, 179 cached, 3 fallbacks.

**This number moves between runs.** An earlier run of the identical command gave 62.7% and
85.5%. It is a single live observation with no interval — quote it as "about 61%", and see
open item 5.

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
