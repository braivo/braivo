// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Tests render in English, as `main.tsx` does for a browser asking for no
// supported language; one in another language activates it and restores this.

import { activateLocale, LOCALES } from "./index.tsx";

// Each catalog compiled here, once per project, not in the first test choosing
// its language, whose 5-second limit the compile spent under a full run's load.
for (const locale of LOCALES) await activateLocale(locale);
await activateLocale("en");
