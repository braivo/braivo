// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

/** Secondary text: metadata and hints that sit beside what matters. */
export function MutedText({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
