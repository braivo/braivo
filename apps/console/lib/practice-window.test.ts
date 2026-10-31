// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { practiceWindow } from "./practice-window.ts";

describe("practiceWindow", () => {
  test("starts six calendar dates before the moment's own, in its zone", () => {
    // Noon UTC on June 10: 14:00 in Warsaw, already June 11 in Auckland.
    const asOf = "2026-06-10T12:00:00Z";
    // 13:59:59 on June 4 in Warsaw; 23:59:59 that day in Auckland, before its window.
    const at = "2026-06-04T11:59:59Z";
    expect(practiceWindow(asOf, "UTC").recencyOf(at)).toBe("recent");
    expect(practiceWindow(asOf, "Europe/Warsaw").recencyOf(at)).toBe("recent");
    expect(practiceWindow(asOf, "Pacific/Auckland").recencyOf(at)).toBe("earlier");
    // Across a month and a year.
    expect(
      practiceWindow("2026-03-03T12:00:00Z", "UTC").calendarDaysAgo("2026-02-25T00:00:00Z"),
    ).toBe(6);
    expect(
      practiceWindow("2027-01-02T12:00:00Z", "UTC").calendarDaysAgo("2026-12-27T00:00:00Z"),
    ).toBe(6);
  });

  test("holds an attempt from the first date's midnight, not a second before", () => {
    const asOf = "2026-06-10T12:00:00Z";
    const { recencyOf, calendarDaysAgo } = practiceWindow(asOf, "Europe/Warsaw");
    // June 4 begins at 22:00 UTC on June 3 in Warsaw.
    expect(recencyOf("2026-06-03T21:59:59Z")).toBe("earlier");
    expect(recencyOf("2026-06-03T22:00:00Z")).toBe("recent");
    expect(recencyOf(asOf)).toBe("recent");
    expect(calendarDaysAgo(asOf)).toBe(0);
    expect(recencyOf(null)).toBe("none");
  });

  test("counts calendar dates, not hours, across both of a year's clock changes", () => {
    // Clocks went forward on March 29: from April 1, the window starts March 26, before it.
    const spring = practiceWindow("2026-04-01T12:00:00Z", "Europe/Warsaw");
    expect(spring.recencyOf("2026-03-25T22:59:59Z")).toBe("earlier"); // 23:59:59 on the 25th, UTC+1
    expect(spring.recencyOf("2026-03-25T23:00:00Z")).toBe("recent"); // midnight on the 26th
    // Clocks went back on October 25: from October 28, the window starts October 22.
    const autumn = practiceWindow("2026-10-28T12:00:00Z", "Europe/Warsaw");
    expect(autumn.recencyOf("2026-10-21T21:59:59Z")).toBe("earlier"); // 23:59:59 on the 21st, UTC+2
    expect(autumn.recencyOf("2026-10-21T22:00:00Z")).toBe("recent"); // midnight on the 22nd
  });

  test("starts on a date whose midnight the zone skipped, or repeated", () => {
    // Santiago: the window from September 12 starts September 6, which began at 01:00.
    const santiago = practiceWindow("2026-09-12T16:00:00Z", "America/Santiago");
    expect(santiago.recencyOf("2026-09-06T03:59:59Z")).toBe("earlier");
    expect(santiago.recencyOf("2026-09-06T04:00:00Z")).toBe("recent");
    // Havana: the window from November 7 starts November 1, whose midnight came twice.
    const havana = practiceWindow("2026-11-07T17:00:00Z", "America/Havana");
    expect(havana.recencyOf("2026-11-01T03:59:59Z")).toBe("earlier");
    expect(havana.recencyOf("2026-11-01T04:00:00Z")).toBe("recent");
  });
});
