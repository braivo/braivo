// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { learnerDayIn } from "./learner-day.ts";

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
