# What this project claims, and what it does not

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

Every figure below is reproducible from this repository, and
[`scripts/verify-claims.sh`](../scripts/verify-claims.sh) recomputes all of them and fails
if any has moved. It is the reason a dashboard/deck mismatch was caught before the demo
video was recorded rather than after.

The second half is the more unusual document: the list of sentences that would be **wrong**
to say about this work. It was written to be read before presenting it, because the easiest
way to lose a result like this is to overstate it by one adjective.

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
`scripts/verify-claims.sh`. Built with `--use-model` the dashboard puts a fifth live
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
