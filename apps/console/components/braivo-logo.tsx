// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@braivo/ui/components/badge";
import { cn } from "@braivo/ui/lib/utils";
import { Trans } from "@lingui/react/macro";
import { SparkleIcon } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * Braivo's logo: Lucide's sparkle, then "braivo" in the logo's face
 * (`--font-logo`). The sparkle in the main action's colour: the theme's, or
 * with `tone="dark"` the story panel's accent, as that panel is dark in either
 * theme. Sized by its font size. "Beta" until Braivo's first release: the API,
 * schema, and apps still change without notice (README). `compactOnPhone`: on a
 * phone, the sparkle alone, the wordmark kept for screen readers.
 */
export function BraivoLogo({
  tone = "theme",
  compactOnPhone = false,
  className,
  ...props
}: ComponentProps<"span"> & { tone?: "dark" | "theme"; compactOnPhone?: boolean }) {
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
      <span className={cn(compactOnPhone && "max-sm:sr-only")}>braivo</span>
      <Badge
        variant="outline"
        className={cn(
          "ml-[0.15em] font-sans",
          compactOnPhone && "max-sm:hidden",
          tone === "dark"
            ? "border-brand-panel-muted/40 text-brand-panel-muted"
            : "text-muted-foreground",
        )}
      >
        <Trans>Beta</Trans>
      </Badge>
    </span>
  );
}
