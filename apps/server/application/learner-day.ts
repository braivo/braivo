// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A learner's day, which the daily limit and the learn app's "Practised
// today" both count in (docs/adr/0041-daily-limit.md). Imports nothing: the
// client bundles it.

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
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  });
  return (at) => {
    const parts = format.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((each) => each.type === type)?.value);
    const daysBack = part("hour") < DAY_STARTS_AT_HOUR ? 1 : 0;
    // Calendar arithmetic in UTC, where every date is one: no zone's clock applies.
    return new Date(Date.UTC(part("year"), part("month") - 1, part("day") - daysBack))
      .toISOString()
      .slice(0, 10);
  };
}
