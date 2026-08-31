-- SALVAGE Phase 2: the durable spine.
--
-- Every guarantee this phase claims is enforced here, by the database, not by
-- application code that remembers to be careful:
--
--   * never double-charge          -> charge_attempts.idempotency_key UNIQUE
--   * webhook delivered twice      -> inbox.razorpay_event_id UNIQUE
--   * two workers race a case      -> recovery_cases.version + WHERE version = $n
--   * audit trail cannot be edited -> decisions is append-only (trigger below)
--
-- Money is BIGINT paise. Never floating point, never rupees.

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id                 TEXT PRIMARY KEY,
  bank_code          TEXT        NOT NULL,
  inflow_day         SMALLINT    NOT NULL CHECK (inflow_day BETWEEN 1 AND 31),
  reliability        REAL        NOT NULL CHECK (reliability BETWEEN 0 AND 1),
  tenure_months      INTEGER     NOT NULL CHECK (tenure_months >= 0),
  account_state      TEXT        NOT NULL CHECK (account_state IN ('normal','closed','frozen','risk_flagged')),
  preferred_language TEXT        NOT NULL CHECK (preferred_language IN ('english','hinglish','hindi')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mandates (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT        NOT NULL REFERENCES customers(id),
  rail             TEXT        NOT NULL CHECK (rail IN ('upi_autopay','enach','card')),
  bank_code        TEXT        NOT NULL,
  max_amount_paise BIGINT      NOT NULL CHECK (max_amount_paise > 0),
  status           TEXT        NOT NULL CHECK (status IN ('active','revoked','expired')),
  card_expires_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX mandates_customer_idx ON mandates (customer_id);

CREATE TABLE subscriptions (
  id           TEXT PRIMARY KEY,
  mandate_id   TEXT     NOT NULL REFERENCES mandates(id),
  customer_id  TEXT     NOT NULL REFERENCES customers(id),
  amount_paise BIGINT   NOT NULL CHECK (amount_paise > 0),
  billing_day  SMALLINT NOT NULL CHECK (billing_day BETWEEN 1 AND 31),
  status       TEXT     NOT NULL CHECK (status IN ('active','halted'))
);
CREATE INDEX subscriptions_customer_idx ON subscriptions (customer_id);

-- ---------------------------------------------------------------------------
-- Recovery cases. Optimistic concurrency lives on `version`.
-- ---------------------------------------------------------------------------

CREATE TABLE recovery_cases (
  id               TEXT PRIMARY KEY,
  subscription_id  TEXT        NOT NULL REFERENCES subscriptions(id),
  cycle_id         TEXT        NOT NULL,
  arm              TEXT        NOT NULL CHECK (arm IN ('control','agent')),
  state            TEXT        NOT NULL CHECK (state IN
                     ('OPEN','AWAITING_RETRY','AWAITING_CUSTOMER','RECOVERED','EXHAUSTED','HUMAN_QUEUE')),
  version          INTEGER     NOT NULL DEFAULT 1,
  diagnosis        TEXT        NOT NULL,
  attempts_used    INTEGER     NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
  contacts_used    INTEGER     NOT NULL DEFAULT 0 CHECK (contacts_used >= 0),
  opened_at        TIMESTAMPTZ NOT NULL,
  closed_at        TIMESTAMPTZ,
  outcome          TEXT CHECK (outcome IN ('recovered','recovered_self_heal','exhausted','handed_to_human')),
  recovered_paise  BIGINT      NOT NULL DEFAULT 0 CHECK (recovered_paise >= 0),
  cost_paise       BIGINT      NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  -- SIMULATOR ground truth. Never exposed to a policy or to the agent; present only so
  -- metrics can measure attempts spent on causes no retry could ever clear.
  true_opening_class TEXT      NOT NULL,

  -- A closed case must have both a closing timestamp and an outcome, or neither.
  CONSTRAINT recovery_cases_closure_consistent CHECK (
    (state IN ('RECOVERED','EXHAUSTED','HUMAN_QUEUE')) = (closed_at IS NOT NULL)
    AND (closed_at IS NULL) = (outcome IS NULL)
  )
);

-- One open case per subscription per billing cycle per arm. This is what stops a
-- redelivered webhook or a racing scheduler from opening a second case for the same
-- failure and charging the customer twice through the back door.
CREATE UNIQUE INDEX recovery_cases_one_per_cycle
  ON recovery_cases (subscription_id, cycle_id, arm);

CREATE INDEX recovery_cases_open_idx ON recovery_cases (state) WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Charge attempts. The never-double-charge guarantee is this UNIQUE constraint.
-- ---------------------------------------------------------------------------

CREATE TABLE charge_attempts (
  id              TEXT PRIMARY KEY,
  case_id         TEXT        NOT NULL REFERENCES recovery_cases(id),
  subscription_id TEXT        NOT NULL REFERENCES subscriptions(id),
  cycle_id        TEXT        NOT NULL,
  attempt_no      INTEGER     NOT NULL CHECK (attempt_no > 0),
  -- sha256(case_id, attempt_no). A crashed worker that replays its job computes the
  -- same key and loses the insert race, so the charge happens exactly once.
  idempotency_key TEXT        NOT NULL UNIQUE,
  rail            TEXT        NOT NULL CHECK (rail IN ('upi_autopay','enach','card')),
  scheduled_at    TIMESTAMPTZ NOT NULL,
  -- NULL until the rail actually answers. A row with executed_at IS NULL is a claim
  -- staked before the call, which is what makes the crash window safe.
  executed_at     TIMESTAMPTZ,
  status          TEXT        NOT NULL CHECK (status IN ('in_flight','success','failed')),
  raw_error_code  TEXT        NOT NULL DEFAULT '',
  raw_error_desc  TEXT        NOT NULL DEFAULT '',
  failure_class   TEXT        NOT NULL DEFAULT 'UNKNOWN',
  classification_matched BOOLEAN NOT NULL DEFAULT FALSE,
  fee_paise       BIGINT      NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (case_id, attempt_no),
  CONSTRAINT charge_attempts_settled_has_time CHECK (
    (status = 'in_flight') = (executed_at IS NULL)
  )
);
CREATE INDEX charge_attempts_case_idx ON charge_attempts (case_id, attempt_no);

-- ---------------------------------------------------------------------------
-- Decisions: the audit trail, and the centrepiece of the demo. APPEND ONLY.
-- ---------------------------------------------------------------------------

CREATE TABLE decisions (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id              TEXT        NOT NULL REFERENCES recovery_cases(id),
  seq                  INTEGER     NOT NULL,
  agent_input_snapshot JSONB       NOT NULL,
  agent_reasoning      TEXT        NOT NULL,
  proposed_bundle      JSONB       NOT NULL,
  policy_verdict       TEXT        NOT NULL CHECK (policy_verdict IN
                         ('APPROVE','MODIFY','DENY','ESCALATE','NOT_YET_IMPLEMENTED')),
  policy_rule_fired    TEXT,
  final_bundle         JSONB       NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, seq)
);

-- "Append only" enforced by the database, not by convention. An audit trail that the
-- application could quietly rewrite is not an audit trail.
CREATE OR REPLACE FUNCTION decisions_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'decisions is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_append_only();
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_append_only();

-- ---------------------------------------------------------------------------
-- Customer-facing side effects (Phase 3 populates these; the shape is fixed now)
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  case_id         TEXT        NOT NULL REFERENCES recovery_cases(id),
  channel         TEXT        NOT NULL,
  language        TEXT        NOT NULL,
  template_id     TEXT        NOT NULL,
  body            TEXT        NOT NULL,
  sent_at         TIMESTAMPTZ,
  idempotency_key TEXT        NOT NULL UNIQUE
);

CREATE TABLE promises (
  id               TEXT PRIMARY KEY,
  case_id          TEXT        NOT NULL REFERENCES recovery_cases(id),
  promised_amount  BIGINT      NOT NULL CHECK (promised_amount > 0),
  promised_date    TIMESTAMPTZ NOT NULL,
  grace_hours      INTEGER     NOT NULL DEFAULT 24 CHECK (grace_hours >= 0),
  status           TEXT        NOT NULL CHECK (status IN ('open','kept','broken')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX promises_case_idx ON promises (case_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Transactional inbox / outbox
-- ---------------------------------------------------------------------------

CREATE TABLE inbox (
  razorpay_event_id TEXT PRIMARY KEY,   -- dedupe key: redelivery is a no-op
  event_type        TEXT        NOT NULL,
  payload           JSONB       NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);
CREATE INDEX inbox_unprocessed_idx ON inbox (received_at) WHERE processed_at IS NULL;

CREATE TABLE outbox (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_id TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Per-bank circuit breakers. Persisted, so a restart does not forget that a rail
-- is down and immediately burn a fresh round of attempts into it.
-- ---------------------------------------------------------------------------

CREATE TABLE circuit_breakers (
  bank_code            TEXT PRIMARY KEY,
  state                TEXT        NOT NULL CHECK (state IN ('closed','open','half_open')),
  consecutive_failures INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  opened_at            TIMESTAMPTZ,
  half_open_at         TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Dead letter queue, with enough context to replay rather than just to mourn.
-- ---------------------------------------------------------------------------

CREATE TABLE dead_letters (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source       TEXT        NOT NULL,
  job_name     TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  error        TEXT        NOT NULL,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at  TIMESTAMPTZ
);
CREATE INDEX dead_letters_pending_idx ON dead_letters (id) WHERE replayed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Event log. Phase 2 acceptance: replaying this reconstructs identical case state.
-- ---------------------------------------------------------------------------

CREATE TABLE case_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    TEXT        NOT NULL REFERENCES recovery_cases(id),
  seq        INTEGER     NOT NULL,
  event_type TEXT        NOT NULL,
  payload    JSONB       NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, seq)
);
CREATE INDEX case_events_case_idx ON case_events (case_id, seq);

CREATE TRIGGER case_events_no_update BEFORE UPDATE ON case_events
  FOR EACH ROW EXECUTE FUNCTION decisions_append_only();
CREATE TRIGGER case_events_no_delete BEFORE DELETE ON case_events
  FOR EACH ROW EXECUTE FUNCTION decisions_append_only();
