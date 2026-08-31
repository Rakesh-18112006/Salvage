# Phase 5 — evidence: chaos demo, dashboard, audit trail

> ### ⚠️ Everything in this repository runs against a SIMULATOR
>
> Customers, banks, mandates, decline codes, outages, and payment outcomes are generated
> by a seeded model in [`src/sim/`](../src/sim). **No number in this document comes from
> live traffic, from Razorpay, or from any bank.** This is a working prototype with a
> measured comparison against a control arm, not a production system.

[← back to the README](../README.md)

---

## Phase 5 — evidence

```bash
docker compose --profile chaos up -d --scale worker=2 && node src/chaos.ts --cases 250
```

```bash
node src/dashboard.ts --cases 300 && open out/dashboard.html
```

### The chaos demo

Real worker **containers** running [`src/worker.ts`](../src/worker.ts), killed with a real
`SIGKILL`. A test that simulates a crash by throwing an `Error` proves the catch block
works; nothing here catches anything — the process stops existing and the guarantees have
to survive on their own.

Result on the seeded 250-case batch, with the kill landing while **7 charges were in
flight** (verified 2026-08-31):

| Guarantee | Result | Evidence |
|---|---|---|
| **Zero duplicate charges** | PASS | 523 charges for 523 keys and 523 attempts |
| **Zero lost cases** | PASS | 0 open, 0 stranded after the kill |
| **Event log reconstructs state** | PASS | 0 divergences across every case |
| **Breaker stops feeding a dead rail** | PASS | refused inside cooldown, one probe after |

Checked against the **gateway's own ledger**, in its own table — not ours. Asserting our
`charge_attempts` has one row would be circular; what matters is that the counterparty
only ever moved money once.

### The dashboard and audit viewer

A single self-contained HTML file — no build step, no framework, no CDN — with the data
embedded as JSON, so it opens from the filesystem and survives being emailed. It carries
the headline comparison, the policy-gate rule tally, the sourced RBI parameters with their
citations, every modelled assumption with its basis, and a **case explorer**.

The case explorer is demo step 5. Filter to terminal cases, click one, and read the chain:

```
Decision 1 · 2026-03-05 08:00 IST
proposed: RETRY_NOW  →  executed: STOP
DENY   TERMINAL_CLASS_NO_CHARGE
"Fixed T+3 policy: retry 1 of 3, one day after the previous presentment.
 Chosen without reference to the failure class..."
```

One screen showing what the policy wanted, the gate refusing it *by name*, and what
actually happened.

### Four bugs the demo exposed

The chaos demo failed on its first run, three separate ways, and every one was a real
defect rather than a demo artifact. A fourth surfaced once the containers existed:

1. **Workers snapshotted reference data at boot.** Any subscription created *after* a worker started was invisible to it — 37 cases failed with `unknown subscription` and were stranded. In a real system new subscriptions appear continuously, so a worker that loads its customers once is broken by construction. It now refreshes on a miss, collapsing concurrent refreshes into one reload.
2. **The kill never landed mid-flight.** Charges settled in under a millisecond, so "killed while holding charges" could not actually be demonstrated. A configurable rail latency (`SALVAGE_RAIL_LATENCY_MS`, 180ms in the demo) makes the crash window real — as it is against a real gateway.
3. **The breaker demonstration was meaningless.** It opened the breaker at a simulated instant weeks before the traffic it was meant to block, so the 30-minute cooldown had long expired and everything sailed through. The breaker was right; the demo was wrong. Timing is now asserted explicitly: refused *inside* the cooldown, one probe allowed *after* it.
4. **Leftover demo containers silently stole the test suite's jobs.** The chaos workers keep running between demos and consume from the default queue, so a test that seeded the same queue had its jobs processed by workers configured differently. It surfaced as the engine-equivalence test failing on one mystery case, reproducibly, for reasons nothing in the test could explain — and it would have looked like a real regression to anyone who hit it. Tests now run on their own queue (`SALVAGE_QUEUE_NAME`), and the suite is green even with the demo containers running.

### Documents

- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — the four layers, why they are split that way, where each guarantee physically lives, and what is real vs simulated.
- [`docs/RUNSHEET.md`](RUNSHEET.md) — **the recording runsheet**: what is on screen in each time slot, the exact command, and full slide content for the slots with no command. Start here on the day.
- [`docs/PITCH.md`](PITCH.md) — the 5-minute video script with shot list, the exact commands per beat, a pre-flight checklist, and a "things not to say" list (don't claim production-readiness; don't quote gross recovery; don't cite the repealed 2019 circular; don't claim the agent wins on every cost measure).

---
