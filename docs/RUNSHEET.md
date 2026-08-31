# SALVAGE — recording runsheet

Everything you need on the day: what is on screen in each slot, the exact command, and the
slide content for the slots where there is no command.

**The one rule that saves the take:** nothing on camera takes longer than 30 seconds. The
live model run takes ~7 minutes, so it is done *before* you record and you show the saved
output. Everything else is genuinely fast.

---

## Before you hit record

```bash
bash scripts/prep-recording.sh
```

Takes ~8 minutes. It starts Docker, runs the tests, does the live model run, rebuilds the
model-driven dashboard, and **refuses to pass if any claim you are about to make is
false**. Everything it saves lands in `out/recording/`.

If the model quota is out, use `bash scripts/prep-recording.sh --offline` and present the
deterministic numbers — the script will tell you which you are on. Never present a
fallback run as a model result.

**Set up two terminal windows:**

| Window | Purpose | Prepare it with |
|---|---|---|
| **A** — live | You type in this one | `cd ~/Razorpay-Buildathon && clear` |
| **B** — saved | Pre-run live-model output | `cd ~/Razorpay-Buildathon && clear` |

Font size 16–18pt, dark theme, window ~120 columns. Have `out/dashboard.html` already open
in a browser tab, scrolled to the top.

---

## Timeline

| Time | Screen | What to run / show |
|---|---|---|
| 0:00–0:35 | **SLIDE 1** | The gap (no terminal) |
| 0:35–1:10 | **Terminal A** | `node src/main.ts --cases 300` |
| 1:10–2:00 | **SLIDE 2** | The action space (no terminal) |
| 2:00–2:45 | **SLIDE 3** | Model vs code split (no terminal) |
| 2:45–3:20 | **Terminal B** | `cat out/recording/live.txt` — pre-run live result |
| 3:20–4:00 | **Terminal A** | `node src/phase3.ts --cases 300 --deterministic-only` |
| 4:00–4:35 | **Terminal A** | `node src/chaos.ts --cases 250` — **run this live, 27s** |
| 4:35–5:00 | **Browser** | `out/dashboard.html` — audit trail |

---

## 0:00–0:35 · SLIDE 1 — the gap

No terminal. Put this on screen:

> ### A failed recurring payment is not a retry problem
>
> **Razorpay's documented default (cards & UPI):**
> *"In a T+3 days cycle, we will retry the payment thrice. That is, once every day for 3
> days, excluding the date of the charge."*
> — Razorpay Docs, Payment Retries
>
> It is a reasonable default. It is also **context-free**:
> - it does not know **why** the payment failed
> - it does not know **when** the customer has money
> - it does not know **whether the rail is even up**
>
> `⚠ All data in this demo is SIMULATED`

Keep that simulated badge in a corner for the whole video.

---

## 0:35–1:10 · TERMINAL A — the cohort

```bash
node src/main.ts --cases 300
```

Runs in ~1 second, no database needed. Scroll to the **"WHY THE OPENING CHARGE FAILED"**
table and rest on the `-- terminal subtotal --` row: **99 cases, 33.0%**.

> "A third of these failures are terminal. No retry can ever succeed against them. The
> fixed policy doesn't know that — every attempt it spends there is a guaranteed loss that
> still costs a fee."

---

## 1:10–2:00 · SLIDE 2 — the action space

No terminal.

> ### Retry is one of nine actions, not the default
>
> ```
>                    Payment failed
>                          │
>            ┌─────────────┴─────────────┐
>            ↓                           ↓
>        Retryable                    Terminal
>            │                           │
>  ┌────┬────┼────┬─────┐        ┌───────┼────────┐
>  ↓    ↓    ↓    ↓     ↓        ↓       ↓        ↓
> RETRY DEFER TIME- WAIT      REMANDATE PAYMENT  ESCALATE
>            SHIFT                       LINK     HUMAN
>
>          (+ NOTIFY composes with any of these)
> ```
>
> **WAIT is a first-class action.** Some customers fix it themselves, and every
> intervention costs money and patience. An agent that can say *"acting is worth less than
> waiting"* is reasoning about cost, not classifying error codes.

---

## 2:00–2:45 · SLIDE 3 — what the model may and may not do

No terminal.

> ### The model does judgment. Code does arithmetic.
>
> | The model supplies | Code supplies |
> |---|---|
> | a diagnosis | when the next payday falls |
> | one of nine strategies | how many hours that is |
> | whether to also notify | what each action costs |
> | a rationale | the expected value of each option |
> | | whether it fits inside the case horizon |
>
> It is never asked *"retry in how many hours?"*
> It is asked *"should this wait for the customer's money to arrive?"*
>
> **Three layers of cost discipline**
> 1. **Triage** — ~40% of decisions settled by the taxonomy; the model is never called
> 2. **Cache** — identical contexts answered once (300 cases → 48 live calls)
> 3. **Fallback** — model unavailable? deterministic policy takes over, every case resolves

---

## 2:45–3:20 · TERMINAL B — the live result

```bash
cat out/recording/live.txt
```

This is the **pre-run live model output** — do not run it live, it takes 7 minutes. Scroll
to `RESULT PROVENANCE` first so the audience sees `MODEL-DRIVEN`, then up to the lift table.

> "Same seeded population, both arms, identical world. Recovery goes from 50.3% to about
> 71% — call it **+20 percentage points**, roughly 40% relative. 19% fewer attempts.
> Gateway cost per rupee down 47%.
>
> And we can tell you what the model is actually worth, because we ran the agent both ways.
> With the model off entirely it reaches **70.7%, every time**. With it on, three runs gave
> 72.0%, 70.0% and 68.0% — on that last one it did worse than no model at all. **The
> model's effect is inside its own run-to-run noise**, so we're not claiming it. Essentially
> all of this lift is the deterministic machinery.
>
> And the part we won't hide: on the all-in measure that prices customer patience, the
> agent is **worse**. It recovers more money at a higher modelled human cost. That's a real
> trade-off, which is why we report it instead of averaging it away."

---

## 3:20–4:00 · TERMINAL A — the guardrails

```bash
node src/phase3.ts --cases 300 --deterministic-only
```

Under a second. Scroll to the **POLICY GATE** table.

> "Every action passes a deterministic gate the agent cannot argue past. Here it blocked
> **108 actions** — 99 retries against terminal mandates, 9 charges on failures nobody
> could classify.
>
> That second one matters. We mapped Razorpay's **real documented** error reasons. Nine of
> the eighteen are too ambiguous to map — *'declined due to business or technical reasons'*
> could be anything — so they classify as UNKNOWN, and **an unknown failure is never
> automatically retried.**
>
> The RBI figures are sourced with section numbers, from the **E-mandate Framework 2026**,
> which replaced the 2019 circular most people still cite. One honest caveat: that
> framework covers cards, PPI and UPI — it doesn't name NACH, so we don't apply it there.
> And it says **nothing about retries**. We're not claiming a compliance gap; we're saying
> the document doesn't answer the question, so we implemented both readings."

---

## 4:00–4:35 · TERMINAL A — run this LIVE

```bash
node src/chaos.ts --cases 250
```

**27 seconds. Run it live — this is the moment of the video.** Talk over the seeding, then
stop talking when the results table lands.

> "Real Postgres, real Redis, real worker containers. We `docker kill` an executor with
> SIGKILL while it's holding charges in flight. No handler runs. The survivor finishes the
> batch."

Then read the four PASS rows off the screen:

> "**Zero duplicate charges. Zero lost cases. The event log still reconstructs state
> exactly. And the breaker refused to feed a dead rail.** We check that against the
> *gateway's own ledger*, in its own table — not ours. Asserting our own bookkeeping shows
> one row would be circular."

---

## 4:35–5:00 · BROWSER — the audit trail and the close

Switch to the already-open `out/dashboard.html`.

1. Point at the **provenance banner** at the top — it says who actually decided.
2. In the case explorer, set the dropdown to **"terminal only"**.
3. Click the **first row**.
4. Point at the decision chain:

```
Decision 1 · 2026-03-05 08:00 IST
proposed: RETRY_NOW  →  executed: STOP
DENY   TERMINAL_CLASS_NO_CHARGE
```

> "What the policy wanted, the gate refusing it **by name**, and what actually happened.
>
> This is a working prototype with a measured comparison against a control arm. The data is
> simulated and labelled as such everywhere. No real money moves, no real payment API is
> called. Every cost assumption is documented — and the ones that flatter us most are the
> ones we set most conservatively.
>
> The gap is real, it's documented, and it's in your core domain."

---

## If something goes wrong on camera

| Problem | Do this |
|---|---|
| `chaos.ts` says "need at least 2 worker containers" | `docker compose --profile chaos up -d --scale worker=2`, then re-run |
| Docker daemon died (it auto-updates) | `open -a Docker`, wait ~30s, `docker compose up -d`, re-run prep |
| Live run shows `FALLBACK ONLY` | Daily quota is out. Say "we're showing the deterministic floor" and use `out/recording/deterministic.txt`. **Do not call it an AI result.** |
| Numbers differ from this runsheet | The deterministic ones never should (70.7% exactly). Live ones vary — three runs gave 72.0%, 70.0%, 68.0%. **Quote what is on your screen**, not what is written here. |

## Do not say

- ❌ production-ready · real customers · real money · actual Razorpay performance
- ❌ "the AI produced this lift" — its effect is within run-to-run noise
- ❌ "+20% improvement" — it is +20 percentage **points** (≈40% relative)
- ❌ "we found a compliance gap in T+3" — the framework is silent on retries
- ❌ "quiet hours are an RBI rule" — that is our own operational policy
- ❌ "₹3 is the Razorpay fee" — it is a synthetic modelling parameter
- ❌ citing the 2019 RBI circular as current — it was repealed

## Safe to say

- ✅ all data is simulated; no real money moves, no real payment API is called
- ✅ the cohort is seeded and reproducible — same seed, same numbers, any machine
- ✅ control and agent face an identical simulated world; only decisions differ
- ✅ the deterministic run is **exactly** reproducible; live model runs are not
- ✅ essentially all the lift is deterministic; the model's effect is within noise, measured both ways
- ✅ the AI **cannot** bypass the deterministic policy gate — it applies to both arms
- ✅ ambiguous vendor error reasons are left explicitly UNKNOWN, and never auto-retried
- ✅ RBI figures are quoted with section numbers from the instrument in force
- ✅ on the all-in cost measure the agent is worse, and we report it
