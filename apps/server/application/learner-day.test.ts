// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { calendarDayIn, learnerDayIn } from "./learner-day.ts";

describe("learnerDayIn", () => {
  test("begins a day at four, local", () => {
    const dayOf = learnerDayIn("Europe/Warsaw");
    // 23:30 on June 1 in Warsaw, then 03:59 and 04:00 on June 2.
    expect(dayOf(new Date("2026-06-01T21:30:00Z"))).toBe("2026-06-01");
    expect(dayOf(new Date("2026-06-02T01:59:59Z"))).toBe("2026-06-01");
    expect(dayOf(new Date("2026-06-02T02:00:00Z"))).toBe("2026-06-02");
  });

  test("steps back across a month and a year", () => {
    const dayOf = learnerDayIn("UTC");
    expect(dayOf(new Date("2026-03-01T03:00:00Z"))).toBe("2026-02-28");
    expect(dayOf(new Date("2027-01-01T01:00:00Z"))).toBe("2026-12-31");
  });

  test("begins a day at four on a night whose clocks change", () => {
    const dayOf = learnerDayIn("Europe/Warsaw");
    // March 29: 02:00 became 03:00, so 03:59 is 01:59 UTC, and 04:00 is 02:00.
    expect(dayOf(new Date("2026-03-29T01:59:59Z"))).toBe("2026-03-28");
    expect(dayOf(new Date("2026-03-29T02:00:00Z"))).toBe("2026-03-29");
    // October 25: 03:00 became 02:00, so 03:59 is 02:59 UTC, and 04:00 is 03:00.
    expect(dayOf(new Date("2026-10-25T02:59:59Z"))).toBe("2026-10-24");
    expect(dayOf(new Date("2026-10-25T03:00:00Z"))).toBe("2026-10-25");
  });

  test("counts in the runtime's zone when none is named", () => {
    vi.stubEnv("TZ", "Pacific/Auckland");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    // 06:00 on June 11 in Auckland; June 10 in UTC.
    expect(learnerDayIn()(new Date("2026-06-10T18:00:00Z"))).toBe("2026-06-11");
  });
});

describe("calendarDayIn", () => {
  test("begins a day at midnight, local", () => {
    const dayOf = calendarDayIn("Europe/Warsaw");
    // 23:59:59 on June 1 in Warsaw, then 00:00 on June 2.
    expect(dayOf(new Date("2026-06-01T21:59:59Z"))).toBe("2026-06-01");
    expect(dayOf(new Date("2026-06-01T22:00:00Z"))).toBe("2026-06-02");
  });

  test("dates a midnight a zone skips, and one it repeats, by the local calendar", () => {
    // Santiago, September 6: 23:59:59 on the 5th, then 01:00 on the 6th.
    const santiago = calendarDayIn("America/Santiago");
    expect(santiago(new Date("2026-09-06T03:59:59Z"))).toBe("2026-09-05");
    expect(santiago(new Date("2026-09-06T04:00:00Z"))).toBe("2026-09-06");
    // Havana, November 1: 00:59:59 went back to 00:00, so the date began twice.
    const havana = calendarDayIn("America/Havana");
    expect(havana(new Date("2026-11-01T03:59:59Z"))).toBe("2026-10-31");
    expect(havana(new Date("2026-11-01T04:00:00Z"))).toBe("2026-11-01");
    expect(havana(new Date("2026-11-01T05:00:00Z"))).toBe("2026-11-01");
  });
});
