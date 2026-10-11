// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { chooseLanguage, LANGUAGE_NAMES, type Locale, LOCALES } from "@braivo/i18n";
import { Heading, type Theme, useTheme } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@braivo/ui/components/field";
import { NativeSelect, NativeSelectOption } from "@braivo/ui/components/native-select";
import { RadioGroup, RadioGroupItem } from "@braivo/ui/components/radio-group";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { CircleAlertIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useId, useState } from "react";

import { pageHead } from "#lib/title";

/**
 * How the console looks and speaks in this browser: its theme and language,
 * each kept for every later visit here, as the header's menus keep them.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/preferences")({
  head: (head) => pageHead(head, t`Preferences`),
  component: Preferences,
});

function Preferences() {
  const { theme, setTheme } = useTheme();
  const { t, i18n } = useLingui();
  const id = useId();
  // Failures so far: a key, so a second one is announced too (docs/apps.md).
  const [failures, setFailures] = useState(0);
  const [failed, setFailed] = useState(false);

  const themes = [
    { value: "light", label: t`Light`, Icon: SunIcon },
    { value: "dark", label: t`Dark`, Icon: MoonIcon },
    { value: "system", label: t`System`, Icon: MonitorIcon },
  ] as const;

  return (
    <>
      <Heading>
        <Trans>Preferences</Trans>
      </Heading>
      <FieldGroup>
        <FieldSet>
          <FieldLegend variant="label" id={`${id}-theme`}>
            <Trans>Theme</Trans>
          </FieldLegend>
          {/* Named by the legend too: it names the fieldset, not Radix's radiogroup within. */}
          <RadioGroup
            aria-labelledby={`${id}-theme`}
            value={theme}
            onValueChange={(value) => setTheme(value as Theme)}
            className="flex flex-wrap gap-x-6 gap-y-3"
          >
            {themes.map(({ value, label, Icon }) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem value={value} id={`${id}-${value}`} />
                <FieldLabel htmlFor={`${id}-${value}`} className="font-normal">
                  <Icon aria-hidden="true" className="size-4" />
                  {label}
                </FieldLabel>
              </div>
            ))}
          </RadioGroup>
          <FieldDescription>
            <Trans>System follows your device's light or dark mode.</Trans>
          </FieldDescription>
        </FieldSet>
        <Field>
          <FieldLabel htmlFor={`${id}-language`}>
            <Trans>Language</Trans>
          </FieldLabel>
          <NativeSelect
            id={`${id}-language`}
            value={i18n.locale}
            onChange={async (event) => {
              setFailed(false);
              // The catalog is fetched on choosing it, and that can fail: the
              // language shown stays, and so does the selection showing it.
              await chooseLanguage(event.currentTarget.value as Locale).catch(() => {
                setFailures((count) => count + 1);
                setFailed(true);
              });
            }}
          >
            {LOCALES.map((locale) => (
              <NativeSelectOption key={locale} value={locale} lang={locale}>
                {LANGUAGE_NAMES[locale]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {failed && (
            <Alert key={failures} variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>{t`Could not change the language. Try again.`}</AlertDescription>
            </Alert>
          )}
        </Field>
        <FieldDescription>
          <Trans>Both are kept in this browser.</Trans>
        </FieldDescription>
      </FieldGroup>
    </>
  );
}
