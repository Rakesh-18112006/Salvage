# Phase 3 — the agent, and what the language model is actually worth

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Phase 3 — the agent

```bash
docker compose up -d && node src/phase3.ts --cases 300
```

```bash
node src/phase3.ts --cases 300 --deterministic-only
```

The second form runs the whole comparison with **no API calls at all**, which matters:
if the result only exists when a language model is reachable, it is not reproducible.

### Result (SIMULATED, seed `20260101`, 300 cases, identical population for both arms)

**One live, model-driven run** — Groq `openai/gpt-oss-120b`, 48 live calls, 202 served
from the decision cache, 223 settled by deterministic triage, **0 fallbacks**. Live runs
are **not** bit-reproducible; this is one of three observed (68.0–72.0%). The
exactly-reproducible deterministic figure is 70.7%.

| Metric | Control (T+3) | Agent (live model) | Delta |
|---|---|---|---|
| Recovery rate | 50.3% | **72.0%** | **+21.7 ppt** (≈ +43.1% relative) |
| Recovered | ₹3,62,549.00 | **₹5,52,884.00** | +₹1,90,335.00 |
| Gateway cost per ₹ recovered | 0.505p | **0.268p** | **−46.9%** |
| **All-in cost per ₹ recovered** | **1.245p** | **2.697p** | **+116.7% — agent worse** |
| Total attempts | 610 | **494** | **−19.0%** |
| Attempts on terminal cases | 99 | 99 | 0 |
| Customer contacts | 0 | 220 | +220 |
| Cases escalated to a human | 10 | 13 | +3 |

**Headline:** *against the documented fixed T+3 policy, on identical traffic — roughly +20
percentage points of recovery with ~19% fewer attempts.* (Three live runs observed
68.0–72.0%; the exactly-reproducible deterministic figure is 70.7%.)

### What is the language model actually worth? (an honest null-ish result)

The way to ask this is to run the agent BOTH ways on the identical cohort — once with the
model, once with it switched off entirely:

| Arm | Recovery | Gateway cost per ₹ | Reproducible? |
|---|---|---|---|
| Control (fixed T+3) | 50.3% | 0.505p | exactly |
| Agent, **model off** (`--deterministic-only`) | **70.7%** | 0.264p | **exactly** |
| Agent, **model on** (Groq gpt-oss-120b), run 1 | 72.0% | 0.268p | no |
| Agent, **model on**, run 2 | 70.0% | — | no |
| Agent, **model on**, run 3 | 68.0% | — | no |

**Three live runs on the identical seeded cohort produced 72.0%, 70.0% and 68.0%** — a
4-point spread. The deterministic path produced **70.7% every single time**, and sits in
the middle of that range. On one of the three runs the model was *worse* than using no
model at all.

So the model's contribution is **well inside its own run-to-run variance**, and we cannot
claim a measurable improvement from it on this cohort.

That is the honest reading and it is stated rather than buried:

- **Essentially all of the ~+20 ppt lift comes from the deterministic machinery** — the
  taxonomy, the triage, the cost model, the scheduling arithmetic, the policy gate.
- The language model's measurable contribution here is **indistinguishable from noise**,
  and on one run it was negative. Establishing a real effect would need many seeds and a
  proper significance test, which we have not run.
- Live model runs are **not bit-reproducible** even at temperature 0. `--deterministic-only`
  is, which is why it remains the headline figure anyone can verify.

This is a less exciting claim than "the AI did it", and it is the one the evidence
supports. The architecture is still the right shape — the model is confined to genuinely
ambiguous cases, which is exactly where a modest, hard-to-measure contribution is what you
would expect.

> #### Which path produced these numbers
>
> **A live, model-driven run.** Provenance is derived from what was **observed**, never
> from flags ([`src/agent/provenance.ts`](../src/agent/provenance.ts)): a run that requested
> the model and got zero successful calls is reported as `FALLBACK ONLY` and **exits
> non-zero**. Eight tests in [`test/provenance.test.ts`](../test/provenance.test.ts) pin this.
>
> `--deterministic-only` remains available and reproduces the middle row above with **no
> API key at all** — that is the floor, and it is what anyone can verify from a clean
> checkout without credentials.

### What the model does, and what it is forbidden from doing

Spec rule 2 says the LLM does diagnosis, not arithmetic. The split is enforced in code,
not by convention:

| | |
|---|---|
| **The model supplies** | a diagnosis, one of nine named **strategies**, whether to also notify, and a rationale |
| **Code supplies** | when the next inflow date falls, how many hours that is, what each action costs, the expected value of each option, whether an action fits inside the horizon |

The model is never asked *"retry in how many hours?"* — it is asked *"should this wait
for the customer's money to arrive?"* Calendar arithmetic and expected-value arithmetic
are things code does correctly every time and a model does approximately, so they stay in
code. The prompt explicitly forbids naming hours or dates.

A test asserts the prompt never leaks simulator ground truth: reliability reaches the
model as a **band** (`strong`/`mixed`/`weak`), never the raw scalar, and the shortfall
window is never mentioned. Otherwise the agent would be reading the answer key.

### Three layers of cost discipline

Spec §4: *"the LLM never runs over the full ledger."*

1. **Triage** — a terminal class has exactly one correct response and the taxonomy already knows it. Those cases never reach the model (~38% of decisions).
2. **Cache** — two cases with identical decision-relevant context have the same correct answer. The signature is **class-conditional**: it names only the evidence that bears on that class, so a bank outage is not re-asked once per customer payday. It stores an **in-flight promise**, so a dozen concurrent cases with one signature make one call rather than twelve.
3. **Fallback** — if the model is unavailable, a deterministic policy takes over and the case still resolves.

Layer 3 was not hypothetical, and it is the reason this phase has a result at all. The
supplied key is free-tier: a first live run returned **300 rate-limit rejections against
17 successes**, and once the daily quota was spent, **every** call failed. The system
resolved all 300 cases regardless. That is the failure-recovery criterion demonstrated by
accident rather than by design.

The client now paces itself (bounded concurrency, minimum interval, long backoff on 429)
and **fails fast on quota**: a 429 is a per-*project* rejection, so walking the model
chain after one just earns the same rejection three times more slowly.

### Model choice, and the provider chain

The primary provider is **Groq**, chosen on measured evidence:

| Model | Latency | Answer to the project's central scenario (insufficient funds on the 27th, paid on the 1st) |
|---|---|---|
| `openai/gpt-oss-120b` | 1350ms | **`TIME_SHIFT_TO_INFLOW`** — correct |
| `openai/gpt-oss-20b` | 975ms | `RETRY_SHORT_BACKOFF` — wrong |

The larger model is right and the smaller one is quick; being quick about the wrong answer
is not a trade worth making, so 120b leads and 20b is the fallback.

Groq's free tier needs no card and supports **strict JSON-schema constrained decoding**,
so the response shape is *guaranteed* rather than best-effort.

**The chain spans providers, not just models**
([`src/agent/modelChain.ts`](../src/agent/modelChain.ts)):

```
Groq → OpenRouter → Gemini → [deterministic fallback, outside the model layer]
```

Every time this project failed to produce a live result, the cause was the same: one
vendor's quota. Walking models *inside* one provider does not help, because quota is per
project. Set any subset of `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY`.

**Rate limits are read, not guessed.** The binding constraint on Groq's free tier turned
out to be **8,000 tokens per minute**, not requests per minute — a client paced on RPM
walks straight into 429s, which is exactly what the first run did (22 of 110 decisions
fell back). The client now reads `x-ratelimit-remaining-tokens` and
`x-ratelimit-reset-tokens` from each response and pauses exactly as long as the provider
says it needs. After that change: **0 fallbacks**.

### The honest part: the agent does NOT win on every cost view

Spec §7's cost model prices customer patience and friction alongside gateway fees. On
that **all-in** measure the agent is worse, and by a lot:

| Cost view | Control | Agent | |
|---|---|---|---|
| Gateway fees per ₹ recovered | 0.696p | **0.266p** | agent wins |
| + human escalation | 0.696p | 0.713p | roughly level |
| + patience & friction (all-in) | 0.747p | 2.336p | **control wins** |

Three things are worth saying plainly rather than burying:

- **The agent recovers 43% more money at a higher modelled human cost.** That is a real trade-off, not a rounding error. Whether it is worth it depends on what a business thinks a customer message costs — which is exactly why the number is reported instead of averaged away.
- **The escalation line is not a fair loss.** Control never escalates a frozen or risk-declined account *to anyone*. It looks cheaper on human cost by declining an obligation the spec's own policy gate requires, which is why that cost is broken out rather than folded into the headline.
- **The all-in gap is driven by a constant we invented.** `cost.contact_patience` (₹15) and `cost.customer_friction` (₹40) are stand-ins, deliberately priced high so messaging could never be the cheap default. The run prints a **sensitivity table** across 0×–2× of those values, so the reader can see how much of the result is the assumption rather than the agent. The arms do not cross within that range: the conclusion is robust in the direction that is unflattering to us.

Tuning those constants downward would have flipped the metric. That would be precisely
the overclaiming §10 forbids, so they were left where they were set before the result was
known.

### The eval set

Built around the three judgment scenarios the spec names
([`test/agentEval.test.ts`](../test/agentEval.test.ts)), each checked twice:

- **Offline (always runs)** — the *deterministic* machinery must get these right on its own. The EV model must rank time-shifting above retry-tomorrow; the fallback must choose it; the shift must land *after* the inflow, never before. If the answer only appears with a model in the loop, the reasoning is unverifiable and there is no floor when the API is down.
- **Live (`RUN_LLM_EVAL=1`)** — the same scenarios against the real model. Kept out of `npm test` because a green suite must not depend on someone else's rate limiter. It passes: the model picks `TIME_SHIFT` for insufficient funds on the 27th when payday is the 1st, and defers on a degraded rail.

### Three bugs this phase's own runs exposed

1. **Cash and shadow costs were being summed.** Gateway fees (money out) and customer patience (a price we invented) were added into one "cost per rupee recovered" and reported as a financial metric. They are now three separate buckets, all reported.
2. **A thundering herd on the decision cache.** With cases running concurrently, a dozen with the same signature all missed the cache, all called the model, and eleven calls answered a question already asked. The cache now stores the *in-flight promise*.
3. **A rejected shared promise took down the whole batch.** Once the cache stored promises, a single quota rejection propagated to every case joined to it, and only the case that created it had a `catch`. It crashed a 120-case run outright. Both are pinned by [`test/agentResilience.test.ts`](../test/agentResilience.test.ts), which fails without the fix.

### Two more simulator assumptions this phase required

`REMANDATE` is the **only** route by which a revoked mandate can ever be recovered, so
its completion rate alone decides how much of the terminal third is winnable. An early
draft of that curve yielded 48–91% completion, which made re-authorisation nearly free
money and inflated the agent's win to +32 ppt. That was a calibration error, not a
result. It now yields **23% for a weak two-month customer to 46% for a strong four-year
one**, and the headline above is measured on the corrected model.

---
