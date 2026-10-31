// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, chooseLocale } from "@braivo/i18n";
import { BraivoError, type BraivoClient, type LearnerProgressSummary } from "@braivo/server/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { activity, anotherActivity } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

describe("the learn app in Polish", () => {
  beforeEach(async () => {
    await activateLocale(chooseLocale(["pl-PL", "en"]));
    // Half an hour off UTC, so a time shown in UTC, or rounded to the hour, fails.
    vi.stubEnv("TZ", "Asia/Kolkata");
    return () => {
      vi.unstubAllEnvs();
      return activateLocale("en");
    };
  });

  const notStarted = (count: number): LearnerProgressSummary => ({
    modelVersion: "v1",
    asOf: "2026-06-01T00:00:00.000Z",
    repeatedMissesThreshold: 3,
    lastPractisedAt: null,
    objectives: Array.from({ length: count }, (_, index) => ({
      objectiveId: `o${index}`,
      title: `Objective ${index}`,
      phase: "unseen" as const,
    })),
  });

  test("says what was practised today, counted as the summary counts", async () => {
    // Fixed, so midnight cannot fall between the evidence and the page's "today".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
    const at = new Date().toISOString();
    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [
          { objectiveId: "a", title: "a", phase: "acquiring", lastEvidenceAt: at },
          { objectiveId: "b", title: "b", phase: "acquiring", lastEvidenceAt: at },
        ],
      }),
    });

    expect(
      await screen.findByRole("region", {
        name: "Jesteś na bieżąco",
        description: /Tematy ćwiczone dzisiaj: 2 w trakcie nauki\.$/,
      }),
    ).toBeTruthy();
  });

  // From 15:30 on Monday 1 June in Kolkata.
  test.each([
    ["2026-06-01T12:00:00.000Z", "dzisiaj o 17:30"],
    ["2026-06-02T03:00:00.000Z", "jutro o 08:30"],
    ["2026-06-03T03:00:00.000Z", "środa, 3 czerwca 2026 o 08:30"],
  ])("names a review due at %s as %s, in the learner's local time", async (dueAt, when) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [
          {
            objectiveId: "a",
            title: "Powitania",
            phase: "retaining",
            lastEvidenceAt: "2026-05-30T10:00:00.000Z",
            stability: 1,
            retrievability: 0.95,
            due: false,
            dueAt,
          },
        ],
      }),
    });

    expect(
      await screen.findByRole("region", {
        name: "Jesteś na bieżąco",
        description: `Na razie nic nie czeka na powtórkę. Następna powtórka: „Powitania”, ${when}.`,
      }),
    ).toBeTruthy();
  });

  test("lists the courses, and leads from a path that names nothing back to them", async () => {
    renderAt("/elsewhere", { signedIn: true });

    expect(await screen.findByRole("region", { name: "Nic tu nie ma." })).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Nauka"));
    fireEvent.click(screen.getByRole("link", { name: "Twoje kursy" }));

    expect(await screen.findByRole("heading", { name: "Twoje kursy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wyloguj się" })).toBeTruthy();
    expect(screen.getByText("Nie masz jeszcze kursów")).toBeTruthy();
  });

  test("says when the courses, a course, or signing out failed", async () => {
    const { signOut } = renderAt("/", {
      signedIn: true,
      learnerCourses: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const notice = await screen.findByRole("region", {
      name: "Nie udało się wczytać Twoich kursów.",
    });
    expect(within(notice).getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
    signOut.mockRejectedValueOnce(new Error("Braivo answered 500 signing out"));
    fireEvent.click(screen.getByRole("button", { name: "Wyloguj się" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Nie udało się wylogować. Spróbuj ponownie.",
    );
    cleanup();

    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const failed = await screen.findByRole("region", { name: "Coś poszło nie tak." });
    expect(within(failed).getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
    expect(within(failed).getByRole("link", { name: "Twoje kursy" })).toBeTruthy();
  });

  test("introduces a new topic, and grades a right answer", async () => {
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity });

    expect(await screen.findByText("Nowy temat · Past tense")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "hablé" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Dobrze");
    expect(screen.getByRole("button", { name: "hablé Poprawna" })).toBeTruthy();
  });

  test("says why a missed topic comes again, and when an answer is refused", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => anotherActivity,
      submitAttempt: async () => {
        throw new BraivoError(400, "invalid");
      },
    });

    expect(await screen.findByText("Jeszcze raz · Past tense")).toBeTruthy();
    expect(screen.getByText("Przećwiczmy to ponownie.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "comí" }));

    expect(await screen.findByRole("region", { name: "Coś poszło nie tak." })).toBeTruthy();
  });

  test("asks the task and grades the answer", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => ({
        ...activity,
        decision: {
          objectiveId: "o1",
          modelVersion: "v1",
          intent: "review",
          retrievability: 0.724,
          stability: 3,
        },
      }),
      submitAttempt: async () => ({
        kind: "choice",
        outcome: "failure",
        correctChoice: 0,
        passages: [{ quote: "Hablé con mi madre.", source: { title: "Libro" }, page: "12" }],
      }),
    });

    expect(
      await screen.findByRole("group", {
        name: "Past tense of 'hablar'?",
        description:
          "Powtórka · Past tense Czas na powtórkę: masz około 72% szans, że teraz sobie przypomnisz.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Twoje kursy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Nie tym razem")).toBeTruthy();
    expect(within(alert).getByText("Poprawna odpowiedź: hablé")).toBeTruthy();
    expect(screen.getByRole("button", { name: "hablé Poprawna" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "hablo Twoja odpowiedź" })).toBeTruthy();
    const passages = screen.getByRole("region", { name: "Z Twoich lekcji" });
    expect(within(passages).getByText("Libro · s. 12")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dalej" })).toBeTruthy();
  });

  test("says when an answer could not be confirmed, and resends it", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: vi
        .fn<BraivoClient["submitAttempt"]>()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockReturnValueOnce(new Promise(() => {})),
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByText("Nie udało się potwierdzić Twojej odpowiedzi.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "hablé Twoja odpowiedź" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wyślij ponownie" }));
    expect(screen.getByRole("button", { name: "Wysyłanie…" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Ładowanie" })).toBeTruthy();
  });

  test("rests a just-answered task until a time written the Polish way, in the browser's time zone", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-06-01T10:00:00.000Z"));
    onTestFinished(() => now.mockRestore());
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => ({ objective: activity.objective, retryAfter: 340 }),
    });

    expect(
      await screen.findByRole("region", {
        name: "Zrób krótką przerwę",
        description:
          "Temat „Past tense” był niedawno ćwiczony. Ćwiczenia wznowią się o 15:36, aby kolejna próba pokazała, co pamiętasz.",
      }),
    ).toBeTruthy();
  });

  test("tells a caught-up learner when their next review falls due, on a Polish date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [
          {
            objectiveId: "a",
            title: "Greetings",
            phase: "retaining",
            lastEvidenceAt: "2026-05-30T00:00:00.000Z",
            stability: 3,
            retrievability: 0.95,
            due: false,
            dueAt: "2026-06-05T09:31:00.000Z",
          },
        ],
      }),
    });

    // 09:31 UTC is 15:01 in the browser's zone.
    expect(
      await screen.findByRole("region", {
        name: "Jesteś na bieżąco",
        description:
          "Na razie nic nie czeka na powtórkę. Następna powtórka: „Greetings”, piątek, 5 czerwca 2026 o 15:01.",
      }),
    ).toBeTruthy();
    expect(screen.getByText("1 utrwalony")).toBeTruthy();
    cleanup();

    renderAt("/c/4732", { signedIn: true });
    expect(
      await screen.findByRole("region", {
        name: "Jesteś na bieżąco",
        description: "Na razie nic nie czeka na powtórkę.",
      }),
    ).toBeTruthy();
  });

  // Polish counts in three forms: one, a few, many.
  test.each([
    [1, "1 nierozpoczęty"],
    [2, "2 nierozpoczęte"],
    [5, "5 nierozpoczętych"],
  ])("counts %i objective(s) not started as %s", async (count, line) => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => notStarted(count),
    });

    fireEvent.click(await screen.findByText(line));
    // Beside a title, in a form that fits any title.
    expect(screen.getByText("Objective 0: nie rozpoczęto")).toBeTruthy();
  });

  test("says when a course has nothing to practise, or is not the learner's", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => ({ decision: activity.decision, objective: activity.objective }),
    });
    const notice = await screen.findByRole("region", {
      name: "Na razie nie ma nic do ćwiczenia",
      description: "Ćwiczenia z tematu „Past tense” są obecnie niedostępne.",
    });
    fireEvent.click(within(notice).getByRole("button", { name: "Sprawdź ponownie" }));
    await vi.waitFor(() =>
      expect(within(notice).getByRole("status").textContent).toBe("Nadal nie ma nic do ćwiczenia."),
    );
    cleanup();

    renderAt("/c/4732", { signedIn: true, nextActivity: async () => ({ empty: true }) });
    expect(
      await screen.findByRole("region", { name: "W tym kursie nie ma jeszcze nic do ćwiczenia." }),
    ).toBeTruthy();
    cleanup();

    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => {
        throw new BraivoError(404, "not found");
      },
    });
    expect(
      await screen.findByRole("region", {
        name: "Ten kurs nie istnieje albo nie masz do niego dostępu.",
      }),
    ).toBeTruthy();
  });
});
