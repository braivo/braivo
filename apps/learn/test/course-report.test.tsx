// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Reporting a problem with a task from its feedback (learner-loop-22, ADR 0052).

import { type Activity, BraivoError, type BraivoClient, type Grade } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { activity, anotherActivity, typedActivity } from "./fixtures.ts";
import { renderAt, stall } from "./render.tsx";

const miss: Grade = { kind: "choice", outcome: "failure", correctChoice: 0 };
const withPassages: Grade = {
  ...miss,
  passages: [{ quote: "Ayer hablé con ella.", source: { title: "Unidad 4" } }],
};
const ALL_REASONS = [
  "My answer seems correct",
  "The expected answer seems wrong",
  "The question or explanation is confusing",
  "The lesson passage doesn't support this",
  "Something else",
];

/** The course with `activity` (a choice task) answered by `answer`, graded as `grade`. */
async function graded(
  options: {
    grade?: Grade;
    next?: Activity;
    answer?: "hablo" | "reveal";
    reportAttempt?: BraivoClient["reportAttempt"];
    nextActivity?: BraivoClient["nextActivity"];
    hostOrganization?: BraivoClient["hostOrganization"];
  } = {},
) {
  const rendered = renderAt("/c/4732", {
    signedIn: true,
    nextActivity: options.nextActivity ?? (async () => options.next ?? activity),
    submitAttempt: async () => options.grade ?? miss,
    reportAttempt: options.reportAttempt,
    hostOrganization: options.hostOrganization,
  });
  if (options.answer === "reveal") {
    fireEvent.click(await screen.findByRole("button", { name: "Show answer" }));
  } else {
    fireEvent.click(await screen.findByRole("button", { name: options.answer ?? "hablo" }));
  }
  await screen.findByRole("button", { name: "Continue" });
  return rendered;
}

function openReport() {
  fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
  return screen.getByRole("dialog", { name: "What's wrong with this question?" });
}

const reasonsIn = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole("radio")
    .map((radio) => (radio as HTMLButtonElement).labels[0]?.textContent);

describe("reporting a problem with a question", () => {
  test("is offered after Continue, never before it, and keeps Continue focused", async () => {
    await graded();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    const report = screen.getByRole("button", { name: "Report a problem" });
    expect(document.activeElement).toBe(continueButton);
    expect(
      continueButton.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("offers My answer seems correct after a miss, and the passage reason only with passages", async () => {
    await graded({ grade: withPassages });

    const dialog = openReport();
    expect(reasonsIn(dialog)).toEqual(ALL_REASONS);
    // Says who reads it, and that the result stays.
    expect(
      within(dialog).getByText(
        "Your school will see this question, your answer, and your note. Your result stays as it is.",
      ),
    ).toBeTruthy();
  });

  test("names the organization that will read it", async () => {
    await graded({ hostOrganization: async () => ({ name: "Fernwood Academy" }) });

    expect(
      within(openReport()).getByText(
        "Fernwood Academy will see this question, your answer, and your note. Your result stays as it is.",
      ),
    ).toBeTruthy();
  });

  test("offers My answer seems correct after a typed miss", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => typedActivity,
      submitAttempt: async () => ({ kind: "typed", outcome: "failure", correctAnswer: "bin" }),
    });
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "ben" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByRole("button", { name: "Continue" });

    expect(reasonsIn(openReport())).toContain("My answer seems correct");
  });

  test.each([
    ["a success", { answer: "hablo", grade: { ...miss, outcome: "success" } }],
    ["Show answer", { answer: "reveal" }],
  ] as const)("never offers My answer seems correct after %s", async (_case, options) => {
    await graded(options);

    expect(reasonsIn(openReport())).toEqual([
      "The expected answer seems wrong",
      "The question or explanation is confusing",
      "Something else",
    ]);
  });

  test("asks for a reason, and for a note with Something else, sending nothing", async () => {
    const { reportAttempt } = await graded();
    const dialog = openReport();

    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(within(dialog).getByText("Choose what's wrong.")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Something else" }));
    const note = within(dialog).getByRole("textbox", { name: "What's wrong?" });
    fireEvent.change(note, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(within(dialog).getByText("Write what's wrong.")).toBeTruthy();
    expect(note.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(note);
    expect(reportAttempt).not.toHaveBeenCalled();
  });

  test("says Sending…, then that it was sent, focusing that", async () => {
    let answer!: () => void;
    const { reportAttempt, submitAttempt } = await graded({
      reportAttempt: (input) =>
        new Promise((resolve) => {
          answer = () => resolve({ reason: input.reason, at: "2026-06-01T00:00:00.000Z" });
        }),
    });
    const dialog = openReport();
    fireEvent.click(within(dialog).getByRole("radio", { name: "The expected answer seems wrong" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Anything to add?" }), {
      target: { value: "  Both fit.  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    const sending = await within(dialog).findByRole("button", { name: "Sending…" });
    expect(sending.getAttribute("aria-disabled")).toBe("true");
    expect(reportAttempt.mock.calls[0]![0]).toEqual({
      courseId: "c1",
      attemptId: submitAttempt.mock.calls[0]![0]!.id,
      reason: "key-wrong",
      note: "Both fit.",
    });

    answer();
    const status = await screen.findByText("Thanks. Your report was sent.");
    expect(status.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(status);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
  });

  test("says the question was reported already on a conflict", async () => {
    await graded({
      reportAttempt: async () => {
        throw new BraivoError(
          409,
          "Conflict",
          "This task is already reported.",
          "ALREADY_REPORTED",
        );
      },
    });
    const dialog = openReport();
    fireEvent.click(within(dialog).getByRole("radio", { name: "The expected answer seems wrong" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    expect(await screen.findByText("You already reported this question.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("keeps what was sent after a lost answer, read-only, and resends it unchanged", async () => {
    const reportAttempt = vi
      .fn<BraivoClient["reportAttempt"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        reason: "confusing",
        note: "Which one?",
        at: "2026-06-01T00:00:00Z",
      });
    await graded({ reportAttempt });
    const dialog = openReport();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: "The question or explanation is confusing" }),
    );
    const note = within(dialog).getByRole("textbox", { name: "Anything to add?" });
    fireEvent.change(note, { target: { value: "Which one?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Could not send. Try again.");
    // Read-only: the note, and the reason by pointer and by key.
    expect(note.hasAttribute("readonly")).toBe(true);
    const other = within(dialog).getByRole("radio", { name: "Something else" });
    fireEvent.click(other);
    fireEvent.keyDown(within(dialog).getByRole("radio", { name: /confusing/ }), {
      key: "ArrowDown",
    });
    expect(
      within(dialog)
        .getByRole("radio", { name: "The question or explanation is confusing" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(other.getAttribute("aria-checked")).toBe("false");

    // Failing again mounts a new alert.
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(reportAttempt).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByRole("alert")).not.toBe(alert);

    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Thanks. Your report was sent.")).toBeTruthy();
    const bodies = reportAttempt.mock.calls.map(([input]) => input);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  test("keeps the note and unlocks it when Braivo refuses the report", async () => {
    await graded({
      reportAttempt: async () => {
        throw new BraivoError(400, "Bad request");
      },
    });
    const dialog = openReport();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Something else" }));
    const note = within(dialog).getByRole("textbox", { name: "What's wrong?" });
    fireEvent.change(note, { target: { value: "Odd" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Could not send this report. Reload the page and try again.",
    );
    expect(note).toHaveProperty("value", "Odd");
    expect(note.hasAttribute("readonly")).toBe(false);
  });

  test("keeps the dialog and what was typed when the session ended, offering sign-in in a new tab", async () => {
    await graded({
      reportAttempt: async () => {
        throw new BraivoError(401, "Unauthorized");
      },
    });
    const dialog = openReport();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Something else" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "What's wrong?" }), {
      target: { value: "Odd" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    const alert = await within(dialog).findByRole("alert");
    const link = within(alert).getByRole("link", { name: "Sign in in a new tab" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(within(dialog).getByRole("textbox", { name: "What's wrong?" })).toHaveProperty(
      "value",
      "Odd",
    );
  });

  test("never holds Continue back: closed while sending, the dialog reopens on what was sent, and a late answer changes nothing", async () => {
    let answer!: () => void;
    const { reportAttempt } = await graded({
      next: activity,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValue(anotherActivity),
      reportAttempt: (input) =>
        new Promise((resolve) => {
          answer = () => resolve({ reason: input.reason, at: "2026-06-01T00:00:00.000Z" });
        }),
    });
    let dialog = openReport();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Something else" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "What's wrong?" }), {
      target: { value: "Odd" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await within(dialog).findByRole("button", { name: "Sending…" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    dialog = openReport();
    const note = within(dialog).getByRole("textbox", { name: "What's wrong?" });
    expect(note).toHaveProperty("value", "Odd");
    expect(note.hasAttribute("readonly")).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    answer();
    await Promise.resolve();
    expect(screen.queryByText("Thanks. Your report was sent.")).toBeNull();
    expect(reportAttempt).toHaveBeenCalledTimes(1);
  });

  test("leaves the focus on Continue when a report sent earlier is answered while Continue fails", async () => {
    let answer!: () => void;
    await graded({
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockImplementation((_courseId, options) => stall(options)),
      reportAttempt: (input) =>
        new Promise((resolve) => {
          answer = () => resolve({ reason: input.reason, at: "2026-06-01T00:00:00.000Z" });
        }),
    });
    const dialog = openReport();
    fireEvent.click(within(dialog).getByRole("radio", { name: "The expected answer seems wrong" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // Closed, the dialog hands the focus back once it unmounts; the learner moves on after.
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const continueButton = screen.getByRole("button", { name: "Continue" });
    continueButton.focus();
    fireEvent.click(continueButton);
    await screen.findByRole("button", { name: "Loading…" });

    answer();
    expect(await screen.findByText("Thanks. Your report was sent.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Loading…" }));
  });
});
