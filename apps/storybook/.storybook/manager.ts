// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

addons.setConfig({
  theme: create({ base: "light", brandTitle: "Braivo Design System" }),
});
