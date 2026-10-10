// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@braivo/ui/lib/utils";
import { SparkleIcon } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * Braivo's logo: Lucide's sparkle, then "braivo" in the logo's face
 * (`--font-logo`). The sparkle in the main action's colour: the theme's, or
 * with `tone="dark"` the story panel's accent, as that panel is dark in either
 * theme. Sized by its font size.
 */
export function BraivoLogo({
  tone = "theme",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: "dark" | "theme" }) {
  return (
    <span
      className={cn("flex items-center gap-[0.35em] font-logo leading-none font-normal", className)}
      {...props}
    >
      <SparkleIcon
        aria-hidden="true"
        className={cn(
          "size-[0.9em] shrink-0",
          tone === "dark" ? "text-brand-panel-accent" : "text-primary",
        )}
      />
      <span>braivo</span>
    </span>
  );
}
