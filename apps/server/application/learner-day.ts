// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Calendar days: a learner's, which the daily limit and the learn app's
// "Practised today" count in (docs/adr/0041-daily-limit.md), and a reader's,
// which the console's practice window counts in (docs/specs/progress.md,
// progress-17). Imports nothing: the client bundles it.

/**
 * The local hour a learner's day begins: practice past midnight belongs to the
 * evening it continues, not to a day the learner has not slept into yet.
 */
const DAY_STARTS_AT_HOUR = 4;

/**
 * The learner's day of an instant in `timeZone`, an IANA name, or the
 * runtime's when none: its calendar date, "2026-06-01", or the one before when
 * the local time is earlier than `DAY_STARTS_AT_HOUR`. Steps back a calendar
 * date, never hours, so a night whose clocks change still begins the day at
 * four. Made once per zone, as a formatter is costly to make.
 */
export function learnerDayIn(timeZone?: string): (at: Date) => string {
  const partsOf = localPartsIn(timeZone);
  return (at) => {
    const { year, month, day, hour } = partsOf(at);
    return isoDate(year, month, day - (hour < DAY_STARTS_AT_HOUR ? 1 : 0));
  };
}

/**
 * The calendar date of an instant in `timeZone`, or the runtime's when none,
 * a day beginning at midnight: "2026-06-01". Read from the local clock, never
 * by resolving a midnight to an instant, which a zone may skip or repeat.
 */
export function calendarDayIn(timeZone?: string): (at: Date) => string {
  const partsOf = localPartsIn(timeZone);
  return (at) => {
    const { year, month, day } = partsOf(at);
    return isoDate(year, month, day);
  };
}

/** An instant's local year, month (1–12), day, and hour (0–23). Made once per zone. */
function localPartsIn(timeZone: string | undefined) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  });
  return (at: Date) => {
    const parts = format.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((each) => each.type === type)?.value);
    return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour") };
  };
}

/** `YYYY-MM-DD`, a day out of range carried into the adjacent month: in UTC, where every date is one. */
function isoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}
