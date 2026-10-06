// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Tests render in English, as `main.tsx` does for a browser asking for no
// supported language; one in another language activates it and restores this.

import { activateLocale } from "./index.tsx";

await activateLocale("en");
