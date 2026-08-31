/**
 * Persistence for the reference entities, and the loader that hands them back as the
 * in-memory `World` the simulator and Phase 1 engine already speak.
 *
 * Phase 1 stays runnable with no database at all; this module is the bridge that lets
 * Phase 2 durably store the same seeded population without either side learning about
 * the other's storage.
 */
import type { Customer, Mandate, Subscription } from '../domain/types.ts';
import { getPool, withTransaction } from '../db/pool.ts';
import { World, type Population } from '../sim/population.ts';

/** Write a seeded population into Postgres. Idempotent on re-run for the same seed. */
export async function persistPopulation(population: Population): Promise<void> {
  const seen = new Set<string>();
  for (const c of population.cases) {
    if (seen.has(c.subscription.id)) continue;
    seen.add(c.subscription.id);

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO customers
           (id, bank_code, inflow_day, reliability, tenure_months, account_state, preferred_language)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [
          c.customer.id,
          c.customer.bankCode,
          c.customer.inflowDay,
          c.customer.reliability,
          c.customer.tenureMonths,
          c.customer.accountState,
          c.customer.preferredLanguage,
        ],
      );
      await client.query(
        `INSERT INTO mandates
           (id, customer_id, rail, bank_code, max_amount_paise, status, card_expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [
          c.mandate.id,
          c.mandate.customerId,
          c.mandate.rail,
          c.mandate.bankCode,
          c.mandate.maxAmountPaise,
          c.mandate.status,
          c.mandate.cardExpiresAt === undefined ? null : new Date(c.mandate.cardExpiresAt),
          new Date(c.mandate.createdAt),
        ],
      );
      await client.query(
        `INSERT INTO subscriptions (id, mandate_id, customer_id, amount_paise, billing_day, status)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [
          c.subscription.id,
          c.subscription.mandateId,
          c.subscription.customerId,
          c.subscription.amountPaise,
          c.subscription.billingDay,
          c.subscription.status,
        ],
      );
    });
  }
}

/** Rebuild an in-memory World from what is stored, for the seeded simulator to use. */
export async function loadWorld(seed: string): Promise<World> {
  const world = new World(seed);

  const subs = await getPool().query<{
    id: string;
    mandate_id: string;
    customer_id: string;
    amount_paise: string;
    billing_day: number;
    status: 'active' | 'halted';
  }>('SELECT * FROM subscriptions');

  const mandates = await getPool().query<{
    id: string;
    customer_id: string;
    rail: Mandate['rail'];
    bank_code: string;
    max_amount_paise: string;
    status: Mandate['status'];
    card_expires_at: Date | null;
    created_at: Date;
  }>('SELECT * FROM mandates');

  const customers = await getPool().query<{
    id: string;
    bank_code: string;
    inflow_day: number;
    reliability: number;
    tenure_months: number;
    account_state: Customer['accountState'];
    preferred_language: Customer['preferredLanguage'];
  }>('SELECT * FROM customers');

  const mandateById = new Map(mandates.rows.map((m) => [m.id, m]));
  const customerById = new Map(customers.rows.map((c) => [c.id, c]));

  for (const s of subs.rows) {
    const m = mandateById.get(s.mandate_id);
    const c = customerById.get(s.customer_id);
    if (m === undefined || c === undefined) {
      throw new Error(`subscription ${s.id} references a missing mandate or customer`);
    }

    const customer: Customer = {
      id: c.id,
      bankCode: c.bank_code,
      inflowDay: c.inflow_day,
      reliability: c.reliability,
      tenureMonths: c.tenure_months,
      accountState: c.account_state,
      preferredLanguage: c.preferred_language,
    };
    const mandate: Mandate = {
      id: m.id,
      customerId: m.customer_id,
      rail: m.rail,
      bankCode: m.bank_code,
      maxAmountPaise: Number(m.max_amount_paise),
      status: m.status,
      createdAt: m.created_at.getTime(),
      ...(m.card_expires_at === null ? {} : { cardExpiresAt: m.card_expires_at.getTime() }),
    };
    const subscription: Subscription = {
      id: s.id,
      mandateId: s.mandate_id,
      customerId: s.customer_id,
      amountPaise: Number(s.amount_paise),
      billingDay: s.billing_day,
      status: s.status,
    };
    world.add(customer, mandate, subscription);
  }

  return world;
}

/** Wipe all operational data. Test helper; never call this against anything real. */
export async function truncateAll(): Promise<void> {
  await getPool().query(`
    TRUNCATE case_events, decisions, charge_attempts, notifications, promises,
             recovery_cases, subscriptions, mandates, customers,
             inbox, outbox, dead_letters, circuit_breakers, rail_idempotency_ledger
    RESTART IDENTITY CASCADE
  `);
}
