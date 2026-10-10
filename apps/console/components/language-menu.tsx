// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { chooseLanguage, LANGUAGE_NAMES, type Locale, LOCALES } from "@braivo/i18n";
import { Button } from "@braivo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@braivo/ui/components/dropdown-menu";
import { useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, GlobeIcon } from "lucide-react";
import { useState } from "react";

/**
 * The language the page speaks, chosen from Braivo's, each by its own name.
 * Kept for every later visit (`chooseLanguage`), and the page switches at
 * once. Nothing is loaded again, so what the page holds (a sign-in under way)
 * stays; a route's tab title follows on the next page.
 */
export function LanguageMenu() {
  const { i18n, t } = useLingui();
  // Failures so far: a key, so a second one is announced too (docs/apps.md).
  const [failures, setFailures] = useState(0);
  const [failed, setFailed] = useState(false);
  const current = i18n.locale as Locale;
  const name = LANGUAGE_NAMES[current];
  return (
    <div className="relative">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Named with what it shows (WCAG 2.5.3), and what it is for. On a
              phone just the globe, so the header's row fits beside the logo. */}
          <Button variant="ghost" className="h-11 px-3" aria-label={t`Language: ${name}`}>
            <GlobeIcon data-icon="inline-start" />
            <span className="max-sm:hidden">{name}</span>
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={async (locale) => {
              setFailed(false);
              // The catalog is fetched on choosing it, and that can fail.
              await chooseLanguage(locale as Locale).catch(() => {
                setFailures((count) => count + 1);
                setFailed(true);
              });
            }}
          >
            {LOCALES.map((locale) => (
              <DropdownMenuRadioItem key={locale} value={locale} lang={locale}>
                {LANGUAGE_NAMES[locale]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Below the button, out of the header's row, which it must not push. */}
      {failed && (
        <p
          key={failures}
          role="alert"
          className="absolute top-full right-0 mt-1 w-max max-w-64 text-right text-sm text-destructive"
        >
          {t`Could not change the language. Try again.`}
        </p>
      )}
    </div>
  );
}
