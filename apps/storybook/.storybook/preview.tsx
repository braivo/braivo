// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, chooseLocale, type Locale, LocalizationProvider } from "@braivo/i18n";

import "@braivo/ui/globals.css";
import type { Preview } from "@storybook/react-vite";

const LANGUAGES: Record<Locale, string> = { en: "English", pl: "Polski" };

const preview: Preview = {
  parameters: { layout: "centered" },
  // So a translation can be read, and its longer words checked, in isolation.
  globalTypes: {
    locale: {
      description: "Language",
      toolbar: {
        icon: "globe",
        items: Object.entries(LANGUAGES).map(([value, title]) => ({ value, title })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { locale: "en" },
  // A URL's `globals=locale:…` may name any language; `chooseLocale` gives an
  // unsupported one English.
  loaders: [({ globals }) => activateLocale(chooseLocale([String(globals.locale)]))],
  decorators: [
    (Story) => (
      <LocalizationProvider>
        <Story />
      </LocalizationProvider>
    ),
  ],
};

export default preview;
