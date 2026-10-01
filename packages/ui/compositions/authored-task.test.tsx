// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { AuthoredTask } from "./authored-task.tsx";

afterEach(cleanup);

describe("a task under review", () => {
  test("shows every option as written, and says in words which is correct", () => {
    render(<AuthoredTask prompt="¿Dos?" options={["one", "two", "three"]} answer={1} />);

    const options = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(options.map((option) => option.textContent)).toEqual([
      "one ",
      "two Correct answer",
      "three ",
    ]);
  });

  test("carries the explanation, the passages, and what the reviewer may do", () => {
    render(
      <AuthoredTask
        prompt="¿Dos?"
        options={["one", "two"]}
        answer={1}
        explanation="Dos is two."
        action={<button type="button">Retire</button>}
      >
        <blockquote>Dos significa two.</blockquote>
      </AuthoredTask>,
    );

    expect(screen.getByText("Dos is two.")).toBeTruthy();
    expect(screen.getByText("Dos significa two.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retire" })).toBeTruthy();
  });
});
