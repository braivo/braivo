// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";

import { expect, onTestFinished, test } from "vite-plus/test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The custom properties a rule sets, by its exact selector: the first rule so written. */
function tokens(css: string, selector: string): string[] {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("}", start));
  return [...body.matchAll(/--([\w-]+):/g)].map((match) => match[1]!);
}

// The theme's generated rules come first in `globals.css`, before its `Braivo:` section.
const ui = read("../../packages/ui/styles/globals.css");
const braivoCss = read("./styles.css");

test.each([
  [":root", ":root:not([data-learn-domain])"],
  [".dark", ".dark:not([data-learn-domain])"],
])(
  "sets every colour shadcn's theme sets in %s, so none stays neutral after an update",
  (theme, braivo) => {
    // The radius is shared, set in `@braivo/ui`'s `Braivo:` section.
    const colours = tokens(ui, theme).filter((name) => name !== "radius");
    expect(colours.length).toBeGreaterThan(20);
    expect(colours.filter((name) => !tokens(braivoCss, braivo).includes(name))).toEqual([]);
  },
);

test("keeps Braivo's theme off a learn domain's sign-in from the first paint, not once React renders", () => {
  onTestFinished(() => {
    document.documentElement.removeAttribute("data-learn-domain");
    document.documentElement.classList.remove("dark");
    document.head.querySelectorAll("link").forEach((link) => link.remove());
    history.replaceState(null, "", "/");
  });
  // `index.html`'s first script, as the browser runs it before any module.
  const script = new DOMParser()
    .parseFromString(read("./index.html"), "text/html")
    .querySelector("script")?.textContent;
  const boot = (url: string) => {
    history.replaceState(null, "", url);
    // As `packages/i18n/boot.test.ts` runs its own: happy-dom runs no inline script.
    // oxlint-disable-next-line no-implied-eval
    new Function(script ?? "")();
  };
  const root = document.documentElement;
  root.classList.add("dark");
  // Each of Braivo's rules a learn domain must not wear, by the part of its
  // selector `<html>` must match.
  const roots = [...braivoCss.matchAll(/^(\S+:not\(\[data-learn-domain\]\))/gm)].map(
    (match) => match[1]!,
  );
  expect(roots).toHaveLength(3);
  const braivoApplies = () => roots.map((selector) => root.matches(selector));

  boot("/login?handoff=h1");
  expect(braivoApplies()).toEqual([false, false, false]);
  expect(document.head.querySelector("link[rel=icon]")).toBeNull();

  root.removeAttribute("data-learn-domain");
  boot("/login");
  expect(root.hasAttribute("data-learn-domain")).toBe(false);
  expect(braivoApplies()).toEqual([true, true, true]);
  expect(document.head.querySelector("link[rel=icon]")).toBeTruthy();
});
