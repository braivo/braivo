// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

const levels = {
  1: "mb-4 text-2xl font-semibold",
  2: "mb-2 text-base font-semibold",
};

/** A page title (`level` 1) or a section title within it (`level` 2), in the heading font. */
export function Heading({
  level = 1,
  className,
  ...props
}: ComponentProps<"h1"> & { level?: keyof typeof levels }) {
  const Tag = level === 1 ? "h1" : "h2";
  return <Tag className={cn("font-heading", levels[level], className)} {...props} />;
}
