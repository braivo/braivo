// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale } from "@braivo/i18n";
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { renderAt } from "./render.tsx";

describe("the console in Polish", () => {
  beforeEach(async () => {
    await activateLocale("pl");
    vi.stubEnv("TZ", "UTC");
    return () => {
      vi.unstubAllEnvs();
      return activateLocale("en");
    };
  });

  test("says how many days ago a learner practised, by its plural forms", async () => {
    const learner = (userId: string, name: string, lastPractisedAt: string) => ({
      userId,
      name,
      roles: ["member"],
      standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
      repeatedMisses: 0,
      lastPractisedAt,
    });
    renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
        courseProgress: async () => ({
          open: true,
          modelVersion: "v1",
          asOf: "2026-06-01T12:05:00.000Z",
          repeatedMissesThreshold: 3,
          learners: [
            learner("u1", "Ana", "2026-06-01T08:00:00.000Z"),
            learner("u2", "Ben", "2026-05-29T09:00:00.000Z"),
            learner("u3", "Fay", "2026-05-31T23:30:00.000Z"),
            learner("u4", "Gil", "2026-05-27T09:00:00.000Z"),
          ],
          objectives: [
            {
              objectiveId: "greetings",
              title: "Greetings",
              standings: { unseen: 4, acquiring: 0, retained: 0, due: 0 },
              repeatedMisses: [],
            },
          ],
        }),
      },
    });

    const table = await screen.findByRole("table", { name: "Uczniowie" });
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((header) => header.querySelector("time")?.textContent),
    ).toEqual([
      // 0 and 1 by name, 3 "few", 5 "many".
      "Ostatnie ćwiczenia: dzisiaj",
      "Ostatnie ćwiczenia: 3 dni temu",
      "Ostatnie ćwiczenia: wczoraj",
      "Ostatnie ćwiczenia: 5 dni temu",
    ]);
  });
});
