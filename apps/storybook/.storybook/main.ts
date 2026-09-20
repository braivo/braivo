// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { StorybookConfig } from "@storybook/react-vite";

/**
 * Storybook for `@braivo/ui`, as a consumer of it: stories live beside the
 * components they show, and reach them through the package's own exports, the
 * way the apps do. See docs/adr/0013-ui-package-and-storybook.md.
 */
const config: StorybookConfig = {
  stories: ["../../../packages/ui/{components,compositions}/*.stories.tsx"],
  framework: "@storybook/react-vite",
  core: { disableTelemetry: true },
};

export default config;
