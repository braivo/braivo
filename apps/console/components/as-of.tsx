// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Trans, useLingui } from "@lingui/react/macro";

/**
 * The moment a progress answer describes (progress-16), always with its date: a
 * page kept open past midnight would otherwise show yesterday's time as today's.
 */
export function AsOf({ at }: { at: string }) {
  const { i18n } = useLingui();
  const time = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
  return <Trans>As of {time}</Trans>;
}
