// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { TaskEditor } from "./task-editor.tsx";

afterEach(cleanup);

const task = {
  kind: "choice" as const,
  prompt: "¿Rojo? ",
  options: ["red", "blue"],
  answer: 1,
  explanation: "Rojo.",
};

function edit() {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(<TaskEditor task={task} onSave={onSave} onCancel={onCancel} />);
  return { onSave, onCancel };
}

describe("editing a task", () => {
  test("saves its words and its correct option, trimmed, the explanation dropped when blank", () => {
    const { onSave } = edit();

    fireEvent.change(screen.getByLabelText("Option B"), { target: { value: " azul " } });
    fireEvent.click(screen.getByRole("radio", { name: "A is correct" }));
    fireEvent.change(screen.getByLabelText("Why the answer is right"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({
      kind: "choice",
      prompt: "¿Rojo?",
      options: ["red", "azul"],
      answer: 0,
    });
  });

  test("counts options that differ only in spacing as repeated, as the server does", () => {
    const { onSave } = edit();

    fireEvent.change(screen.getByLabelText("Option A"), { target: { value: "dark  red" } });
    fireEvent.change(screen.getByLabelText("Option B"), { target: { value: "dark red" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Every option must differ.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  test("saves an option in the Unicode form typed, as the server stores it", () => {
    const { onSave } = edit();

    fireEvent.change(screen.getByLabelText("Option A"), { target: { value: "cafe\u0301" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ options: ["cafe\u0301", "blue"] }),
    );
  });

  test("counts options that differ only in Unicode form as repeated, as the server does", () => {
    const { onSave } = edit();

    fireEvent.change(screen.getByLabelText("Option A"), { target: { value: "żółć" } });
    fireEvent.change(screen.getByLabelText("Option B"), {
      target: { value: "żółć".normalize("NFD") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Every option must differ.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  test("keeps a form feed, which a page shows, as the server does", () => {
    const { onSave } = edit();

    fireEvent.change(screen.getByLabelText("Option A"), { target: { value: "a\f!" } });
    fireEvent.change(screen.getByLabelText("Option B"), { target: { value: "a !" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ ...task, prompt: "¿Rojo?", options: ["a\f!", "a !"] });
  });

  test.each([
    ["a blank question", "Question", "", "Write the question."],
    ["a blank option", "Option A", " ", "Fill in every option."],
    ["a repeated option", "Option B", "red", "Every option must differ."],
    [
      "an overlong explanation",
      "Why the answer is right",
      "x".repeat(2001),
      "Keep each text to 2,000 characters.",
    ],
    [
      "a NUL in the question",
      "Question",
      "¿Rojo?\u0000",
      "Remove the characters that are not text, such as a NUL.",
    ],
  ])("says what is wrong with %s, and saves nothing", (_label, field, value, problem) => {
    const { onSave } = edit();

    fireEvent.change(screen.getByLabelText(field), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText(problem)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  test("saves on Enter in an option, which would otherwise submit the form around it", () => {
    const { onSave } = edit();

    // `false`: the default — a browser's implicit submission — was prevented.
    expect(fireEvent.keyDown(screen.getByLabelText("Option A"), { key: "Enter" })).toBe(false);
    expect(onSave).toHaveBeenCalled();
  });

  test("gives the question room to wrap, saving its line breaks as spaces", () => {
    const { onSave } = edit();
    const question = screen.getByLabelText("Question");

    // A one-line input scrolls a long question out of sight on a phone.
    expect(question.tagName).toBe("TEXTAREA");
    fireEvent.change(question, { target: { value: "¿Qué dice\nel perro?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ prompt: "¿Qué dice el perro?" }));
  });

  test.each(["Question", "Why the answer is right"])("leaves Enter in %s a new line", (field) => {
    const { onSave } = edit();

    // `true`: not prevented, so the browser starts the line.
    expect(fireEvent.keyDown(screen.getByLabelText(field), { key: "Enter" })).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  test("leaves Enter to an input method composing a word", () => {
    const { onSave } = edit();

    fireEvent.keyDown(screen.getByLabelText("Option A"), { key: "Enter", isComposing: true });

    expect(onSave).not.toHaveBeenCalled();
  });

  test("takes focus as it opens, at the question", () => {
    edit();

    expect(document.activeElement).toBe(screen.getByLabelText("Question"));
  });

  test("names the choice of correct option", () => {
    edit();

    expect(
      screen.getByRole("radiogroup", { name: "Options, the correct one chosen" }),
    ).toBeTruthy();
  });

  test("gives up the edit on Cancel", () => {
    const { onSave, onCancel } = edit();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("editing a typed task", () => {
  const typed = {
    kind: "typed" as const,
    prompt: "Red, in Spanish?",
    accepted: ["rojo"],
    answerLanguage: "es",
  };
  function editTyped() {
    const onSave = vi.fn();
    render(<TaskEditor task={typed} onSave={onSave} onCancel={vi.fn()} />);
    return { onSave, answers: screen.getByLabelText("Accepted answers, one a line") };
  }

  test("opens with an answer added last, at the end of its accepted answers, to review it", () => {
    render(
      <TaskEditor
        task={{ ...typed, accepted: ["rojo."] }}
        answerToAdd="rojo"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const answers = screen.getByLabelText<HTMLTextAreaElement>("Accepted answers, one a line");

    expect(document.activeElement).toBe(answers);
    expect(answers.value).toBe("rojo.\nrojo");
    expect([answers.selectionStart, answers.selectionEnd]).toEqual([10, 10]);
  });

  test("saves its accepted answers a line each, blank lines dropped, its language kept", () => {
    const { onSave, answers } = editTyped();

    fireEvent.change(answers, { target: { value: " rojo \n\n  colorado  rojo " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({
      kind: "typed",
      prompt: "Red, in Spanish?",
      accepted: ["rojo", "colorado rojo"],
      answerLanguage: "es",
    });
  });

  test("saves twenty answers of 200 characters, more than one text's limit together", () => {
    const { onSave, answers } = editTyped();
    const many = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(200, "x"));

    fireEvent.change(answers, { target: { value: many.join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ accepted: many }));
  });

  test.each([
    ["no answer", " \n ", "Write at least one accepted answer."],
    [
      "answers equal as compared",
      "Rojo\nrojo",
      "Every answer must differ, case, spacing, and curly or straight quotes aside.",
    ],
    ["an answer over 200 characters", "x".repeat(201), "Keep each answer to 200 characters."],
  ])("refuses %s before saving, as the server would", (_case, value, problem) => {
    const { onSave, answers } = editTyped();

    fireEvent.change(answers, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText(problem)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
