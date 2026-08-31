# SALVAGE — autonomous payment recovery

**Razorpay AI Buildathon 2026 · Track 3: AI Revenue Recovery**

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](src/sim). **No number produced by this project comes
> from live traffic, from Razorpay, or from any bank.** Simulated bank codes are
> fictional (`SIMBANK_*`) and simulated decline codes are our own inventions (`SIM_*`,
> `ACQ-*`) precisely so they cannot be mistaken for real NPCI, UPI, or Razorpay codes.
>
> A working prototype with a measured comparison against a control arm. Not a production
> system, and it does not claim to be one.

---

## The thesis

A failed recurring payment is not a retry problem. It is a **bounded decision problem
under cost, compliance, and customer-patience constraints.**

Razorpay's documented default for subscription auto-charge failures is a fixed **T+3
retry cycle** — retry the next day, once a day, three times. It is a reasonable default,
and it is **context-free**: it does not know *why* the payment failed, *when* the customer
has money, or *whether the rail is healthy*. It spends a large share of its attempt
budget on failures no retry can ever fix.

SALVAGE treats retry as **one of nine actions** — defer past an outage, time-shift to the
customer's payday, re-mandate, payment link, notify, escalate, stop, and **wait** — chosen
by expected value, and then passed through a deterministic policy gate the agent cannot
argue past.

---

## Results

Every figure below is reproducible from this repository with the command beside it.

### 1. The lift is real, and it is not one lucky cohort

**50 independent cohorts × 300 cases = 15,000 simulated failed charges.** Both arms are
deterministic, so these numbers are exact on any machine.

| Metric | Control (T+3) | SALVAGE | Paired difference (95% CI) | Seeds won |
|---|---|---|---|---|
| Recovery rate | 49.1% | **68.9%** | **+19.8 ppt [19.1, 20.4]** | 50 / 50 |
| Gateway cost per ₹ recovered | 0.627p | **0.333p** | −0.293p [−0.316, −0.271] | 50 / 50 |
| Total attempts | 599 | 474 | −125 [−129, −121] | 50 / 50 |

Intervals are percentile bootstrap over the seeds, 10,000 resamples, no distributional
assumption. The paired difference is the statistic that matters: both arms run on the
*same* cohort, so a seed drawing many dead mandates depresses both together.

The seed this project quotes elsewhere (`20260101`, 50.3% → 70.7%) ranks **29th of 50**
by lift. It sits in the middle of its own distribution, not the tail.

```bash
node src/seeds.ts --seeds 50 --cases 300
```

### 2. The language model does *not* produce that lift, and we say so

Run the same cohort with the model on and off:

| Arm | Recovery | Reproducible? |
|---|---|---|
| Control (fixed T+3) | 50.3% | exactly |
| SALVAGE, model **OFF** | **70.7%** | **exactly** |
| SALVAGE, model ON — run 1 / 2 / 3 | 72.0% / 70.0% / 68.0% | no |

**The model's effect is inside its own run-to-run variance.** Essentially all of the lift
belongs to the deterministic machinery — the taxonomy, the cost model, the policy gate.
That is a less exciting sentence than "the AI did it", and it is the one the evidence
supports.

```bash
node src/phase3.ts --cases 300                      # live, model-driven (~7 min)
node src/phase3.ts --cases 300 --deterministic-only # the exact floor, no API key
```

### 3. Where the model *does* earn its place

A lookup table has one known failure mode: a rail changes its decline vocabulary, or a
new acquirer is onboarded, and every response becomes a code the taxonomy has never seen.
Everything then classifies as `UNKNOWN`, an unclassified failure is never auto-retried,
and the whole cohort escalates to a human.

Under a synthetic unmapped dialect ([`src/eval/railDialect.ts`](src/eval/railDialect.ts)),
on the same cohort:

| Arm | Recovery | Taxonomy coverage |
|---|---|---|
| Mapped vocabulary, SALVAGE (the ceiling) | 73.3% | 100% |
| **Unmapped**, control T+3 | 0.0% | 0% |
| **Unmapped**, SALVAGE with the model OFF | 0.0% | 0% |
| **Unmapped**, SALVAGE reading the codes | see below | 0% |

The deterministic system does not fail here because it is badly written. It **structurally
cannot** read unfamiliar prose. A language model can. That is the one job in this system
where it is the right tool, and the eval scores it on both halves of that job —
comprehension on legible text, *and* refusal on illegible text, because a model that never
answers "I don't know" authorises charges against mandates that can never carry them.

```bash
node src/generalization.ts --cases 150                      # live
node src/generalization.ts --cases 150 --deterministic-only # the floor, no API key
```

---

## Run it

Phase 1 has **zero runtime dependencies** and no build step. Node ≥ 22.18 runs the
TypeScript directly via native type stripping.

```bash
node src/main.ts --cases 300 --seed 20260101
```

| Command | What it does | Needs |
|---|---|---|
| `npm run baseline` | Phase 1 simulator + T+3 control arm | nothing |
| `npm run seeds` | 50-cohort confidence intervals | nothing |
| `npm run generalization:offline` | The unmapped-dialect floor | nothing |
| `npm run phase3:offline` | Full agent, model off, exactly reproducible | nothing |
| `npm run phase3` | Full agent, live model (~7 min) | `GROQ_API_KEY` |
| `npm run generalization` | What the model is worth on unmapped codes | `GROQ_API_KEY` |
| `npm run dashboard` | Self-contained HTML dashboard + audit viewer | nothing |
| `npm run chaos` | `docker kill` an executor mid-flight; prove no double charge | Docker |
| `npm test` | Full suite | Docker (Postgres + Redis) |

Anything past Phase 1 needs the durable spine:

```bash
docker compose up -d && node src/db/migrate.ts
```

The model provider chain is **Groq → OpenRouter → Gemini → deterministic fallback**; only
`GROQ_API_KEY` is required, and it is free with no card. Every run prints a **RESULT
PROVENANCE** block computed from what was actually observed, and exits non-zero if a run
that asked for the model produced zero successful calls — so a fallback run can never be
presented as an AI result.

---

## Documentation

The detail that used to live in this file now lives beside the code it describes.

| Document | What is in it |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit together |
| [PITCH.md](docs/PITCH.md) | 5-minute video script, verified numbers, and the claims we must not make |
| [RUNSHEET.md](docs/RUNSHEET.md) | Demo run order |
| [PHASE1-BASELINE.md](docs/PHASE1-BASELINE.md) | Simulator, failure taxonomy, T+3 control arm, and the Phase 1 defect we found and fixed |
| [PHASE2-DURABILITY.md](docs/PHASE2-DURABILITY.md) | Postgres, inbox/outbox, idempotent executor, crash safety |
| [PHASE3-AGENT.md](docs/PHASE3-AGENT.md) | The agent, the cost model, and the honest null result on the LLM |
| [PHASE4-POLICY-GATE.md](docs/PHASE4-POLICY-GATE.md) | The deterministic rules the agent cannot argue past |
| [PHASE5-EVIDENCE.md](docs/PHASE5-EVIDENCE.md) | Chaos demo, dashboard, audit trail |
| [DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md) | Choices worth defending, and why |
| [ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Every modelled constant, its basis, and the synthetic gateway fee |
| [REGULATORY.md](docs/REGULATORY.md) | What is sourced with a section number, and what is our own operational policy |
| [OPEN-ITEMS.md](docs/OPEN-ITEMS.md) | Known gaps |
| [LAYOUT.md](docs/LAYOUT.md) | Repository layout, file by file |

---

## What this project claims, and what it does not

**It claims:**

- On a seeded simulated population, choosing among nine actions beats a fixed T+3 retry
  by ~20 percentage points of recovery, at roughly half the gateway cost per rupee, with
  a confidence interval and 50/50 cohorts agreeing.
- The lift is **deterministic and exactly reproducible**. Same seed, same numbers, any
  machine.
- Razorpay's real documented recurring-payment error reasons are mapped, and the nine
  whose descriptions are genuinely ambiguous are left explicitly `UNKNOWN` — never
  auto-retried.
- The RBI parameters are quoted from the **E-mandate Framework, 2026** with section
  numbers, not invented.
- The system survives `SIGKILL` mid-flight with zero duplicate charges and zero lost
  cases, checked against the gateway's own ledger rather than ours.

**It does not claim:**

- That the language model produced the recovery lift. It did not; its effect is inside
  run-to-run noise, and Phase 3 reports that instead of averaging it away.
- That these are production numbers, or that any real money moved. All data is simulated
  and labelled as such everywhere it appears.
- That we found a compliance gap in Razorpay's T+3. The 2026 framework is **silent on
  retries**; we implemented both readings behind a flag and default to the permissive one.
- That the agent wins on every measure. On the **all-in** cost view, which prices customer
  patience and friction, it is **worse**, and Phase 3 prints the break-even point rather
  than hiding the row.
- That NPCI NACH return codes are mapped. They are not — npci.org.in refused automated
  access — so any NACH code classifies as `UNKNOWN`, which is the safe direction to be
  wrong in.
