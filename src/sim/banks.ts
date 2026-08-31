/**
 * ############################  SIMULATOR  ############################
 * This file models bank behaviour. It is a SIMULATOR. None of these banks,
 * maintenance windows, or success rates are real, observed, or sourced from any
 * institution. Bank codes are fictional placeholders (SIMBANK_*) precisely so that
 * no reader can mistake this for live traffic (spec rule 4).
 * #####################################################################
 */
import type { Timestamp } from '../domain/types.ts';
import { istParts } from './clock.ts';
import { uniform } from './rng.ts';

export interface SimulatedBank {
  readonly code: string;
  readonly displayName: string;
  /** Share of the simulated customer base held at this bank. */
  readonly share: number;
  /** Nightly maintenance window in IST, [startHour, endHour). Empty = none. */
  readonly maintenanceWindowIst: readonly [number, number] | null;
  /** Weekdays the maintenance window applies to (0 = Sunday). */
  readonly maintenanceWeekdays: ReadonlyArray<number>;
  /** Probability of an unplanned degradation episode beginning on any given day. */
  readonly unplannedDegradationRate: number;
  /** Baseline transient decline rate, on top of the global rate. */
  readonly extraTechnicalDeclineRate: number;
}

export const SIMULATED_BANKS: ReadonlyArray<SimulatedBank> = [
  {
    code: 'SIMBANK_A',
    displayName: 'Simulated Bank A (large private)',
    share: 0.30,
    maintenanceWindowIst: [0, 2],
    maintenanceWeekdays: [0], // Sundays
    unplannedDegradationRate: 0.03,
    extraTechnicalDeclineRate: 0.00,
  },
  {
    code: 'SIMBANK_B',
    displayName: 'Simulated Bank B (large public)',
    share: 0.26,
    maintenanceWindowIst: [23, 3], // wraps midnight
    maintenanceWeekdays: [0], // Sundays
    unplannedDegradationRate: 0.06,
    extraTechnicalDeclineRate: 0.015,
  },
  {
    code: 'SIMBANK_C',
    displayName: 'Simulated Bank C (mid-size private)',
    share: 0.20,
    maintenanceWindowIst: [1, 3],
    maintenanceWeekdays: [2], // Tuesdays
    unplannedDegradationRate: 0.04,
    extraTechnicalDeclineRate: 0.005,
  },
  {
    code: 'SIMBANK_D',
    displayName: 'Simulated Bank D (co-operative)',
    share: 0.14,
    maintenanceWindowIst: [22, 4],
    maintenanceWeekdays: [3], // Wednesdays
    unplannedDegradationRate: 0.10,
    extraTechnicalDeclineRate: 0.030,
  },
  {
    code: 'SIMBANK_E',
    displayName: 'Simulated Bank E (payments bank)',
    share: 0.10,
    maintenanceWindowIst: null,
    maintenanceWeekdays: [],
    unplannedDegradationRate: 0.02,
    extraTechnicalDeclineRate: 0.010,
  },
];

const BY_CODE = new Map(SIMULATED_BANKS.map((b) => [b.code, b]));

export function bank(code: string): SimulatedBank {
  const b = BY_CODE.get(code);
  if (b === undefined) throw new Error(`unknown simulated bank: ${code}`);
  return b;
}

/** True when `hour` falls inside [start, end), handling windows that wrap midnight. */
function hourInWindow(hour: number, [start, end]: readonly [number, number]): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Is this bank's rail down at `ts`?
 *
 * Two sources: a scheduled nightly maintenance window, and unplanned degradation
 * episodes that last a seeded number of hours. Both are pure functions of
 * (seed, bank, instant), so every arm observes exactly the same outages.
 */
export function isBankDown(seed: string, bankCode: string, ts: Timestamp): boolean {
  const b = bank(bankCode);
  const p = istParts(ts);

  if (
    b.maintenanceWindowIst !== null &&
    b.maintenanceWeekdays.includes(p.weekday) &&
    hourInWindow(p.hour, b.maintenanceWindowIst)
  ) {
    return true;
  }

  // Unplanned episode: does one start today, and are we inside it?
  const dayKey = `${p.year}-${p.month}-${p.day}`;
  if (uniform('degradation_day', seed, bankCode, dayKey) < b.unplannedDegradationRate) {
    const startHour = Math.floor(uniform('degradation_start', seed, bankCode, dayKey) * 20);
    const lengthHours = 1 + Math.floor(uniform('degradation_len', seed, bankCode, dayKey) * 4);
    if (p.hour >= startHour && p.hour < startHour + lengthHours) return true;
  }

  return false;
}

/**
 * Observable recent health, in [0, 1]: the fraction of the last `windowHours` this bank
 * was up. Phase 3 exposes this to the agent via `get_bank_health`; the agent should
 * prefer DEFER over RETRY_NOW when it is low.
 */
export function bankHealth(
  seed: string,
  bankCode: string,
  ts: Timestamp,
  windowHours = 6,
): number {
  let up = 0;
  for (let i = 0; i < windowHours; i++) {
    if (!isBankDown(seed, bankCode, ts - i * 3_600_000)) up++;
  }
  return up / windowHours;
}
