// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mdxToJs, type MdastNode } from "satteri";
import { describe, expect, test } from "vite-plus/test";

import { alertCallout } from "./alerts.ts";
import { mdastPlugins } from "./plugins.ts";

type Blockquote = Extract<MdastNode, { type: "blockquote" }>;

const quote = (...paragraphs: string[]): Blockquote => ({
  type: "blockquote",
  children: paragraphs.map((value) => ({ type: "paragraph", children: [{ type: "text", value }] })),
});

describe("alertCallout", () => {
  test("turns a GitHub warning into a Callout, the marker dropped", () => {
    expect(alertCallout(quote("[!WARNING]\nCheck that your school allows that."))).toEqual({
      type: "mdxJsxFlowElement",
      name: "Callout",
      attributes: [{ type: "mdxJsxAttribute", name: "type", value: "warn" }],
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "Check that your school allows that." }],
        },
      ],
    });
  });

  test("drops a marker standing alone, and keeps every paragraph after it", () => {
    const callout = alertCallout(quote("[!NOTE]", "One.", "Two."));
    expect(callout?.attributes).toEqual([{ type: "mdxJsxAttribute", name: "type", value: "info" }]);
    expect(callout?.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "One." }] },
      { type: "paragraph", children: [{ type: "text", value: "Two." }] },
    ]);
  });

  test("maps each of GitHub's kinds to a Callout type", () => {
    const type = (kind: string) => alertCallout(quote(`[!${kind}]\nText.`))?.attributes[0];
    expect(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"].map(type)).toEqual(
      ["info", "idea", "info", "warn", "error"].map((value) => ({
        type: "mdxJsxAttribute",
        name: "type",
        value,
      })),
    );
  });

  test("leaves a quotation, or an unknown kind, as it is", () => {
    expect(alertCallout(quote("A quotation."))).toBeUndefined();
    expect(alertCallout(quote("[!DANGER]\nText."))).toBeUndefined();
    expect(alertCallout(quote("Text, then [!WARNING]."))).toBeUndefined();
  });
});

describe("the site's pipeline", () => {
  test("compiles a GitHub alert into a Callout, keeping what it holds", async () => {
    const { code } = await mdxToJs(
      "> [!WARNING]\n> Check **first** with [your school](./faq.mdx).\n",
      { mdastPlugins: mdastPlugins("content", "/") },
    );
    expect(code).toContain("Callout");
    expect(code).toContain('type: "warn"');
    expect(code).not.toContain("[!WARNING]");
    expect(code).toContain("first");
    expect(code).toContain("your school");
  });
});
