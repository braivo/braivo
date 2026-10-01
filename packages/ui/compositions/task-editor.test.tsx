// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { TaskEditor } from "./task-editor.tsx";

afterEach(cleanup);

const task = { prompt: "¿Rojo? ", options: ["red", "blue"], answer: 1, explanation: "Rojo." };

function edit() {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(<TaskEditor task={task} onSave={onSave} onCancel={onCancel} />);
  return { onSave, onCancel };
}

describe("editing a proposed task", () => {
  test("saves its words and its correct option, trimmed, the explanation dropped when blank", () => {
    const { onSave } = edit();

    fireEvent.change(screen.getByLabelText("Option B"), { target: { value: " azul " } });
    fireEvent.click(screen.getByRole("radio", { name: "A is correct" }));
    fireEvent.change(screen.getByLabelText("Why the answer is right"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ prompt: "¿Rojo?", options: ["red", "azul"], answer: 0 });
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

  test("saves on Enter in a field, which would otherwise submit the form around it", () => {
    const { onSave } = edit();

    // `false`: the default — a browser's implicit submission — was prevented.
    expect(fireEvent.keyDown(screen.getByLabelText("Question"), { key: "Enter" })).toBe(false);
    expect(onSave).toHaveBeenCalled();
  });

  test("leaves Enter to an input method composing a word", () => {
    const { onSave } = edit();

    fireEvent.keyDown(screen.getByLabelText("Question"), { key: "Enter", isComposing: true });

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
