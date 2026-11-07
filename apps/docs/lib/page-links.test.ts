// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { assetRoute, pageRoute, screenshotSize } from "./page-links.ts";

describe("pageRoute", () => {
  test("turns a sibling page into its route", () => {
    expect(pageRoute("./api.mdx", "guides/authoring.mdx", "/")).toBe("/guides/api");
  });

  test("keeps the fragment", () => {
    expect(pageRoute("./api.mdx#a-heading", "guides/authoring.mdx", "/")).toBe(
      "/guides/api#a-heading",
    );
  });

  test("reaches another section, and a section's index is the section", () => {
    expect(pageRoute("../guides/api.mdx", "docs/index.mdx", "/")).toBe("/guides/api");
    expect(pageRoute("../docs/index.mdx#x", "guides/api.mdx", "/")).toBe("/docs#x");
    expect(pageRoute("./index.mdx", "docs/cli.mdx", "/")).toBe("/docs");
  });

  test("applies the base once, with or without its last slash", () => {
    expect(pageRoute("./api.mdx#x", "guides/authoring.mdx", "/help/")).toBe("/help/guides/api#x");
    expect(pageRoute("./api.mdx", "guides/authoring.mdx", "/help")).toBe("/help/guides/api");
  });

  test.each([
    "https://example.com/a.mdx",
    "#a-heading",
    "/guides/api",
    "/guides/api.mdx",
    "api.mdx",
    "./api",
    "./api.md",
    "../../../README.md",
    "../../outside.mdx",
    "./api.mdx?x=1",
  ])("leaves %s alone", (href) => {
    expect(pageRoute(href, "guides/authoring.mdx", "/")).toBeUndefined();
  });
});

describe("assetRoute", () => {
  test("turns a file in public/ into where the site serves it, base applied once", () => {
    const image = "../../public/docs/shots/a.png";
    expect(assetRoute(image, "guides/first-course.mdx", "/")).toBe("/docs/shots/a.png");
    expect(assetRoute(image, "guides/first-course.mdx", "/help/")).toBe("/help/docs/shots/a.png");
  });

  test.each(["https://example.com/a.png", "/docs/a.png", "./a.png", "../../../outside.png"])(
    "leaves %s alone",
    (href) => {
      expect(assetRoute(href, "guides/first-course.mdx", "/")).toBeUndefined();
    },
  );
});

describe("screenshotSize", () => {
  const screenshot = (path: string) =>
    fileURLToPath(new URL(`../public/docs/screenshots/${path}`, import.meta.url));

  test("is half a screenshot's pixels, as captured at device scale 2", () => {
    // 636×120 pixels.
    expect(screenshotSize(screenshot("maintain-practice/1-explanations.png"))).toEqual({
      width: 318,
      height: 60,
    });
  });

  test("leaves any other file alone", () => {
    expect(
      screenshotSize(fileURLToPath(new URL("../public/docs/favicon.svg", import.meta.url))),
    ).toBeUndefined();
  });
});
