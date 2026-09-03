# SALVAGE — recording runsheet

Everything you need on the day: what is on screen in each slot, the exact command, and the
slide content for the slots where there is no command.

**This runsheet tracks [PITCH.md](PITCH.md) slot for slot.** If you change one, change the
other — a runsheet that describes a different video than the script is worse than no
runsheet, because you only find out while recording.

**The one rule that saves the take:** nothing on camera takes longer than 30 seconds. Two
things are slow — the live model run (~7 min) and the live generalization run (~15 min) —
so both are done *before* you record and you show the saved output. Everything else is
genuinely fast, and the two most important new numbers run in **under two seconds**, live.

---

## Before you hit record

```bash
bash scripts/prep-recording.sh
```

Takes ~25 minutes. It starts Docker, runs the tests, does both live model runs, rebuilds
the model-driven dashboard, recomputes every claim you are about to make on screen, and
**refuses to pass if any of them is false**. Everything it saves lands in `out/recording/`.

If the model quota is out, use `bash scripts/prep-recording.sh --offline` and present the
deterministic numbers — the script will tell you which you are on. **Never present a
fallback run as a model result.** The provenance block exists so you cannot do this by
accident; do not do it on purpose either.

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
| 0:00–0:32 | **SLIDE 1** | The gap (no terminal) |
| 0:32–1:07 | **Terminal A** | `node src/robustness.ts --scenario baseline` — the four-arm ladder, **0.1s** |
| 1:07–1:31 | **Terminal A** | `node src/seeds.ts --seeds 50 --cases 300` — 50 cohorts, **0.8s, live** |
| 1:31–2:31 | **Terminal B** | `cat out/recording/generalization.txt` — pre-run live result |
| 2:31–2:59 | **Terminal A** → **Browser** | `node src/robustness.ts` (**2s**), then the break-even chart |
| 2:59–3:54 | **Browser** → **Terminal A** | dashboard policy-gate table, then `node --test test/razorpayAdapter.test.ts` |
| 3:54–4:18 | **Terminal A** | `node src/chaos.ts --cases 250` — **run this live, 27s** |
| 4:18–5:00 | **Browser** | `out/dashboard.html` — audit trail |

Only **one** slot uses pre-recorded output. Everything else is live, because it can be.

---

## 0:00–0:32 · SLIDE 1 — the gap

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

## 0:32–1:07 · TERMINAL A — the ladder

```bash
node src/robustness.ts --scenario baseline
```

Runs in a tenth of a second. Scroll to **WHAT SURVIVES WHEN OUR BELIEFS ARE WRONG** and
rest on the single `baseline` row — it has all four arms side by side:

```
| World    | T+3   | Arm 2 | Arm 3 | SALVAGE | Lift over T+3      |
| baseline | 49.4% | 49.4% | 56.6% | 68.8%   | +19.4 [18.0, 20.7] |
```

> "Arm two **is** smart retry — it reads the failure class and refuses to charge a cause no
> retry can clear. It gains nothing. Not because the idea is wrong, but because our policy
> gate already enforces it for the control arm too."

**If a judge interrupts here** — this is the most likely interruption in the whole video —
the answer is above the table in the same output: `TERMINAL_CLASS_NO_CHARGE` fires 99 times
on 300 control cases. The baseline already declines every impossible charge.

---

## 1:07–1:31 · TERMINAL A — the interval

```bash
node src/seeds.ts --seeds 50 --cases 300
```

**Under a second, no API key, no database.** Fifty cohorts, fifteen thousand simulated
failed charges. Rest on the `PAIRED DIFFERENCE` row:

```
|   PAIRED DIFFERENCE  <- the statistic | 19.8% [19.1, 20.4] | 50/50 seeds | excludes zero |
```

Then scroll to **WHERE THE PUBLISHED SEED SITS IN ITS OWN DISTRIBUTION**.

> "And the seed we quote elsewhere ranks 29th of 50 by lift. Middle of its own
> distribution, not the tail. We checked, so you don't have to take our word for which one
> we picked."

That rank line is worth more than the interval to a sceptical panel. Do not skip it.

---

## 1:31–2:31 · TERMINAL B — what the model is actually for

```bash
cat out/recording/generalization.txt
```

Pre-run, because the live version takes ~15 minutes: under an unmapped dialect nothing is
settled by triage, so every decision reaches the model and the free tier paces on tokens
per minute.

**Say out loud that it is pre-run and why.** Then point at the provenance block at the
bottom of the file — `MODEL-DRIVEN — 33 live calls, 179 cached` — which is
the evidence that it was not a deterministic run wearing a model's name.

Three things to rest on, in order:

1. The collapse — control **0.0%**, deterministic agent **0.0%**, 150 cases to a human.
2. The recovery — reading the codes gets **61.3%**, which is 83.6% of the ground lost.
   **Read the number off the file in front of you, not off this page** — this arm is live
   and moves between runs (an earlier one gave 62.7%).
3. **The over-confidence row.** `OVER-CONFIDENT, adopted anyway: 4 (13.8%)`, and the sample
   below it showing all four are the same string.

> "We score refusal, not just comprehension. The 14% it over-read is on screen — all four
> the same string, *'amount not acceptable'*. Which is exactly the conflation our own
> taxonomy warns about for Razorpay's `invalid_amount`."

Showing your model's mistake, unprompted, on camera, is the single most credible thing in
this video. Do not soften it and do not rush past it.

---

## 2:31–2:59 · TERMINAL A, then BROWSER — where we're wrong

```bash
node src/robustness.ts
```

Two seconds, eleven worlds. Rest on the two rows that matter — `baseline` and
`all-adverse` — and let the `−7.9` sit there.

> "The lift survives ten. In the eleventh, T+3 *improves* to 75% and we lose — a world
> where daily retry works and our problem doesn't exist."

Then switch to the browser, to **The all-in cost row, and the assumption it turns on**, and
point at the crossover.

> "So: worth having where balance shortfalls persist. And above ₹3.27 a contact we're the
> expensive option. We ship both curves."

**Keep this slot short.** It is 28 seconds and it is the shortest section in the script by
design. State each limit once and move on — a panel reads one honest sentence as
confidence and three as an apology.

---

## 2:59–3:54 · BROWSER, then TERMINAL A — the guardrails

Start in the browser on **Policy gate**. 108 actions blocked — 99 retries against terminal
mandates, 9 charges on failures nobody could classify.

Then the one thing here that is **not** simulated:

```bash
node --test test/razorpayAdapter.test.ts
```

All of Razorpay's eighteen documented recurring-payment reasons, parsed from their
documented webhook envelope and handed to the same classifier the rest of the system uses.

> "That's the one claim here that isn't simulated. What we have **not** done is call their
> API — not even test mode."

Say that sentence. The adapter is only credible because you drew the line yourself.

Finish on the browser's **Sourced regulatory parameters** section for the RBI citations.

---

## 3:54–4:18 · TERMINAL A — it survives being killed

```bash
node src/chaos.ts --cases 250
```

**Run this live.** 27 seconds, and it is the only thing in the video that is visibly
dangerous. Let the terminal breathe — you have ~6 seconds of slack in this slot for exactly
that.

Four guarantees print at the end. Rest on:

- **Zero duplicate charges**
- **Zero lost cases**

> "And the event log still reconstructs case state exactly — checked against the
> *gateway's* own ledger, not ours."

If Docker has died, skip to `cat out/recording/chaos.txt` and say it is saved output. Do not
try to fix Docker on camera.

---

## 4:18–5:00 · BROWSER — the audit trail and the close

Dashboard, **Audit trail**. Open the revoked-mandate case and walk one chain:

```
proposed: RETRY_NOW  →  executed: STOP  ·  DENY  ·  TERMINAL_CLASS_NO_CHARGE
```

> "The fixed policy proposes a retry, the gate refuses it **by name**, and the case stops
> instead of burning three more fees."

Then close to camera, not to the screen:

> "So what did we build? **A measurement rig, and an agent worth measuring** — twenty
> points at half the gateway cost, against a control that already declines every
> impossible charge, across fifty cohorts and ten of eleven broken worlds.
>
> And the rig is what lets us say the sharper thing: the model contributes **nothing** on
> failures we already understand, and **85%** of the recoverable ground on failures we
> don't. Two verdicts on one model, because we could tell them apart. Most projects can't."

---

## If something breaks on camera

| What broke | Do this |
|---|---|
| Docker is down | `cat out/recording/chaos.txt`, say it is saved output |
| Model quota out | You are showing saved generalization output anyway — nothing changes |
| A live command errors | `cat out/recording/<name>.txt` — prep saved all of them |
| You are running long | Cut the adapter test (2:59 slot) first, then the robustness slot to the two-row table only. **Never cut the over-confidence row or the all-adverse row** — those are what make the rest believable |

---

## Final check, the morning of

- [ ] `bash scripts/prep-recording.sh` exits green
- [ ] `out/recording/generalization.txt` says `MODEL-DRIVEN`, not `FALLBACK ONLY`
- [ ] `out/dashboard.html` banner says what you intend to claim
- [ ] Every number you will say out loud appears in [PITCH.md](PITCH.md)'s verified table
- [ ] The word *simulated* is on screen in the first ten seconds
- [ ] You have read the **"Things you must NOT say"** list in [PITCH.md](PITCH.md) today
