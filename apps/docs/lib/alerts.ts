// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { MdastNode, MdastPluginDefinition, MdxJsxFlowElement } from "satteri";

type Blockquote = Extract<MdastNode, { type: "blockquote" }>;

/**
 * GitHub's alert kinds, as Fumadocs' Callout types. A page writes a callout as
 * a GitHub alert (`> [!WARNING]`), so it reads as one on GitHub too; the site
 * shows it as a Callout.
 */
const CALLOUT_TYPES: Record<string, string> = {
  NOTE: "info",
  TIP: "idea",
  IMPORTANT: "info",
  WARNING: "warn",
  CAUTION: "error",
};

/** The Callout a GitHub alert stands for, its marker dropped; `undefined` for any other blockquote. */
export function alertCallout(quote: Blockquote): MdxJsxFlowElement | undefined {
  const [first, ...rest] = quote.children;
  if (first?.type !== "paragraph") return undefined;
  const [text, ...inline] = first.children;
  if (text?.type !== "text") return undefined;
  const marker = /^\[!(\w+)\][ \t]*(?:\n|$)/.exec(text.value);
  const type = marker && CALLOUT_TYPES[marker[1]!];
  if (!marker || !type) return undefined;
  const after = text.value.slice(marker[0].length);
  const lead = after ? [{ ...text, value: after }, ...inline] : inline;
  return {
    type: "mdxJsxFlowElement",
    name: "Callout",
    attributes: [{ type: "mdxJsxAttribute", name: "type", value: type }],
    children: [...(lead.length ? [{ ...first, children: lead }] : []), ...rest],
  } as MdxJsxFlowElement;
}

/** Turns each page's GitHub alerts into Callouts as it compiles. */
export function alerts(): MdastPluginDefinition {
  return {
    name: "alerts",
    blockquote(node, ctx) {
      const callout = alertCallout(node);
      if (callout) ctx.replaceNode(node, callout);
    },
  };
}
