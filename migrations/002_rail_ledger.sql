-- The SIMULATED gateway's own memory.
--
-- This table models state that belongs to the PAYMENT GATEWAY, not to us. It is kept
-- separate from charge_attempts on purpose: if the crash-safety test asserted against
-- our own bookkeeping it would be circular. Here the claim "a crashed worker never
-- double-charges" is checked against the counterparty's ledger.
--
-- Real gateways, Razorpay included, honour an idempotency key: re-issuing a request
-- with a key they have already seen returns the ORIGINAL result instead of charging
-- again. That is the behaviour modelled here, and it is what makes replay-after-crash
-- safe rather than merely unlikely.

CREATE TABLE rail_idempotency_ledger (
  idempotency_key TEXT PRIMARY KEY,
  subscription_id TEXT        NOT NULL,
  amount_paise    BIGINT      NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('success','failed')),
  raw_error_code  TEXT        NOT NULL DEFAULT '',
  raw_error_desc  TEXT        NOT NULL DEFAULT '',
  true_class      TEXT,
  -- How many times the rail was ASKED to charge this key. The guarantee under test is
  -- that this stays 1 no matter how many workers crash and replay.
  request_count   INTEGER     NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  -- How many times the rail actually MOVED MONEY for this key. Must never exceed 1.
  charge_count    INTEGER     NOT NULL DEFAULT 1 CHECK (charge_count BETWEEN 0 AND 1),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
