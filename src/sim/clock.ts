/**
 * Simulated time. All instants are UTC milliseconds; all business rules are expressed
 * in IST, because quiet hours, maintenance windows, and salary dates are IST facts.
 */
import type { Timestamp } from '../domain/types.ts';

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Civil date/time fields as seen in IST. */
export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday
}

export function istParts(ts: Timestamp): IstParts {
  const d = new Date(ts + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

/** Build a UTC instant from IST civil fields. */
export function fromIst(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Timestamp {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) - IST_OFFSET_MS;
}

export const addHours = (ts: Timestamp, h: number): Timestamp => ts + h * HOUR_MS;
export const addDays = (ts: Timestamp, d: number): Timestamp => ts + d * DAY_MS;

/** Days in an IST month. Handles the 31st-in-February class of bug. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Same IST hour/minute on the given day-of-month, clamped to the month's length. */
export function atIstDayOfMonth(
  ref: Timestamp,
  dayOfMonth: number,
  hour: number,
  minute = 0,
): Timestamp {
  const p = istParts(ref);
  const day = Math.min(dayOfMonth, daysInMonth(p.year, p.month));
  return fromIst(p.year, p.month, day, hour, minute);
}

/**
 * Next occurrence of `dayOfMonth` strictly after `ref`, at the given IST hour.
 * Rolls into the following month when needed.
 */
export function nextIstDayOfMonth(
  ref: Timestamp,
  dayOfMonth: number,
  hour: number,
  minute = 0,
): Timestamp {
  const thisMonth = atIstDayOfMonth(ref, dayOfMonth, hour, minute);
  if (thisMonth > ref) return thisMonth;
  const p = istParts(ref);
  const year = p.month === 12 ? p.year + 1 : p.year;
  const month = p.month === 12 ? 1 : p.month + 1;
  const day = Math.min(dayOfMonth, daysInMonth(year, month));
  return fromIst(year, month, day, hour, minute);
}

/** Whole days since the customer's most recent inflow date, at instant `ts`. */
export function daysSinceInflow(ts: Timestamp, inflowDay: number): number {
  const p = istParts(ts);
  if (p.day >= inflowDay) return p.day - inflowDay;
  const prevMonth = p.month === 1 ? 12 : p.month - 1;
  const prevYear = p.month === 1 ? p.year - 1 : p.year;
  const prevLen = daysInMonth(prevYear, prevMonth);
  return p.day + (prevLen - Math.min(inflowDay, prevLen));
}

export function formatIst(ts: Timestamp): string {
  const p = istParts(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} IST`;
}
