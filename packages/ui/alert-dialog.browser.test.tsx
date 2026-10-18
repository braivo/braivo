// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite-plus/client" />
// The theme as the apps load it, compiled by Tailwind (the root config).
import "./styles/globals.css";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./components/alert-dialog.tsx";

afterEach(cleanup);

/** Opens an alert dialog of `size`: its left and right edges once its opening animation ends. */
async function edges(size: "default" | "sm") {
  render(
    <AlertDialog open>
      <AlertDialogContent size={size}>
        <AlertDialogTitle>Hide “Everyday English” from learners?</AlertDialogTitle>
        <AlertDialogDescription>Learners can't open it until you show it.</AlertDialogDescription>
      </AlertDialogContent>
    </AlertDialog>,
  );
  const dialog = screen.getByRole("alertdialog");
  await Promise.all(dialog.getAnimations().map(({ finished }) => finished));
  const { left, right } = dialog.getBoundingClientRect();
  return [left, right] as const;
}

test.each(["default", "sm"] as const)(
  "on the narrowest phone, keeps an alert dialog of size %s 1rem from each edge, as a dialog",
  async (size) => {
    await page.viewport(320, 568);
    expect(await edges(size)).toEqual([16, 304]);
  },
);

test.each([
  ["default", 448],
  ["sm", 320],
] as const)(
  "on a wider screen, keeps an alert dialog of size %s its own width",
  async (size, width) => {
    await page.viewport(1280, 800);
    const [left, right] = await edges(size);
    expect(right - left).toBe(width);
  },
);
