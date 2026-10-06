// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, LocalizationProvider } from "@braivo/i18n";

import "@braivo/ui/globals.css";
import type { Preview } from "@storybook/react-vite";

// Stories show the source language.
await activateLocale("en");

const preview: Preview = {
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <LocalizationProvider>
        <Story />
      </LocalizationProvider>
    ),
  ],
};

export default preview;
