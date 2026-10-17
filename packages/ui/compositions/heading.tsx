// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

const levels = {
  1: "mb-4 text-2xl font-semibold",
  2: "mb-2 text-base font-semibold",
  3: "text-sm font-semibold",
};

const tags = { 1: "h1", 2: "h2", 3: "h3" } as const;

/**
 * A page title (`level` 1), a section title within it (`level` 2), or a
 * part of a section (`level` 3), in the heading font.
 */
export function Heading({
  level = 1,
  className,
  ...props
}: ComponentProps<"h1"> & { level?: keyof typeof levels }) {
  const Tag = tags[level];
  return (
    <Tag
      // Given focus after an action, the outline clears the text. Solid, as `outline-2`
      // sets: Chrome's `auto` outline steps around the text's line box where it overhangs.
      className={cn(
        "rounded-sm font-heading wrap-break-word outline-offset-4 focus-visible:outline-2",
        levels[level],
        className,
      )}
      {...props}
    />
  );
}
