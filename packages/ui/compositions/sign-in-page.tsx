// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

import { cn } from "#lib/utils";

/**
 * A sign-in page's frame and `<main>`, after shadcn's login-02 block: `aside`
 * from `lg`, then a column with `brand` and `controls` (a language or theme
 * menu, say) above the form, and `footer` below it. Without `aside`, the
 * column is the page. The form is centred, its width a phone's at most.
 */
export function SignInPage(props: {
  brand?: ReactNode;
  controls?: ReactNode;
  footer?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className={cn("grid min-h-svh", props.aside && "lg:grid-cols-[13fr_12fr]")}>
      {props.aside}
      {/* `min-w-0`, so a long email or hostname wraps rather than widens the page. */}
      <div className="flex min-w-0 flex-col gap-6 p-6 md:p-10">
        {/* The controls' height even without them, so every page's form sits alike. */}
        <header className="flex min-h-9 items-center justify-between gap-4">
          <div className="min-w-0">{props.brand}</div>
          {props.controls && (
            <div className="flex shrink-0 items-center gap-1">{props.controls}</div>
          )}
        </header>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">{props.children}</div>
        </div>
        {props.footer && (
          <footer className="text-center text-sm wrap-anywhere text-muted-foreground md:text-left">
            {props.footer}
          </footer>
        )}
      </div>
    </main>
  );
}
