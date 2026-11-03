// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale } from "@braivo/i18n";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { beginners } from "./fixtures.ts";
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

  test("changes and removes members, cancels and invites again, in Polish", async () => {
    const waitingOne = {
      id: "inv-1",
      email: "ada@school.example",
      role: "author",
      inviter: { name: "Olive Owner" },
      expiresAt: "2026-06-08T12:00:00.000Z",
    };
    renderAt("/example/settings/members", {
      braivo: {
        listInvitations: async () => ({
          membersLeft: 3,
          invitations: [waitingOne],
          expired: [
            {
              ...waitingOne,
              id: "inv-0",
              email: "bo@school.example",
              expiresAt: "2026-05-20T12:00:00.000Z",
            },
          ],
        }),
        setMemberRole: async () => ({ userId: "u2", name: "Lee Learner", roles: ["author"] }),
      },
    });

    expect(
      await screen.findByText(/Tutaj zapraszasz uczniów, autorów i administratorów\./),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Anuluj zaproszenie dla ada@school.example" }),
    ).toBeTruthy();
    const expired = within(screen.getByRole("list", { name: "Wygasłe" }));
    expect(expired.getByText("Wygasło 20 maja 2026.")).toBeTruthy();
    expect(
      expired.getByRole("button", { name: "Zaproś ponownie: bo@school.example" }),
    ).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("button", { name: "Zmień lub usuń: Lee Learner" }), {
      key: "Enter",
    });
    const menu = within(await screen.findByRole("menu"));
    fireEvent.click(menu.getByRole("menuitemradio", { name: "Autor" }));
    await vi.waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some(({ textContent }) => textContent === "Lee Learner ma teraz rolę: Autor."),
      ).toBe(true),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Zmień lub usuń: Lee Learner" }), {
      key: "Enter",
    });
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Usuń…" }),
    );
    const dialog = within(
      await screen.findByRole("alertdialog", { name: "Usunąć osobę Lee Learner?" }),
    );
    expect(dialog.getByText(/Jej historia nauki zostanie zachowana\./)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Nie usuwaj" })).toBeTruthy();
  });

  test("invites and accepts in Polish, the school's name quoted as a name", async () => {
    renderAt("/example/settings/members", {
      braivo: {
        listInvitations: async () => ({
          membersLeft: 3,
          expired: [],
          invitations: [
            {
              id: "inv-1",
              email: "ada@school.example",
              role: "author",
              inviter: { name: "Olive Owner" },
              expiresAt: "2026-06-08T12:00:00.000Z",
            },
          ],
        }),
      },
    });

    expect(await screen.findByRole("button", { name: "Wyślij zaproszenia" })).toBeTruthy();
    expect(screen.getByLabelText("Adresy e-mail")).toBeTruthy();
    // 3 "few" in Polish.
    expect(
      screen.getByText("Miejsce dla jeszcze 3 członków. Zaproszenie nie rezerwuje miejsca."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Wyślij ponownie do ada@school.example" }),
    ).toBeTruthy();
    const roles = screen.getByRole("radiogroup", { name: "Rola" });
    expect(within(roles).getByRole("radio", { name: "Autor" })).toBeTruthy();
    expect(within(roles).getByRole("radio", { name: "Uczeń" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("Zaproszenie od: Olive Owner. Wygasa 8 czerwca 2026.")).toBeTruthy();
    cleanup();

    renderAt("/invitations/inv-1", {
      braivo: {
        invitation: async () => ({
          organization: { name: "Example School", slug: "example" },
          status: "pending",
          recipient: true,
          role: "author",
          inviter: { name: "Ada Admin" },
        }),
      },
    });

    expect(
      await screen.findByRole("heading", { name: "Dołącz do organizacji „Example School”" }),
    ).toBeTruthy();
    expect(screen.getByText(/^Ada Admin zaprasza Cię\./)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Dołącz do organizacji „Example School” jako autor" }),
    ).toBeTruthy();
    cleanup();

    renderAt("/invitations/inv-2", {
      braivo: {
        invitation: async () => ({
          organization: { name: "Example School", slug: "example" },
          status: "accepted",
          recipient: true,
          role: "member",
          inviter: { name: "Ada Admin" },
          member: true,
          continueTo: "learn",
          learnDomain: "learn.example.org",
        }),
      },
    });

    expect(
      await screen.findByRole("button", { name: "Przejdź do learn.example.org" }),
    ).toBeTruthy();
    cleanup();

    renderAt("/invitations/inv-3", {
      braivo: {
        invitation: async () => ({
          organization: { name: "Example School", slug: "example" },
          status: "accepted",
          recipient: true,
          role: "member",
          inviter: { name: "Ada Admin" },
          member: false,
          learnDomain: null,
        }),
      },
    });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Nie należysz do organizacji „Example School”",
      }),
    ).toBeTruthy();
  });

  test("says a task's first answers by their plural forms", async () => {
    const task = beginners.objectives[0]!.tasks[0]!;
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => beginners,
        readFirstAnswers: async () => ({
          minLearners: 5,
          tasks: [
            {
              id: task.id,
              objectiveId: "greetings",
              first: { learners: 22, correct: 2, incorrect: 5, revealed: 1, options: [2, 5] },
              otherTasks: { responses: 13, learners: 7, correct: 9, incorrect: 3, revealed: 1 },
            },
          ],
          retired: [],
        }),
      },
    });

    expect(
      await screen.findByText(
        "Pierwsze odpowiedzi 22 uczniów: 2 poprawne, 5 błędnych, 1 prośba o pokazanie odpowiedzi.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Pozostałe pytania tego celu nauczania: 9 poprawnych, 3 błędne, 1 prośba o pokazanie odpowiedzi, spośród 13 pierwszych odpowiedzi 7 uczniów.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Jak liczone są pierwsze odpowiedzi")).toBeTruthy();
  });
});
