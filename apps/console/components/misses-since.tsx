// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Plural, Trans, useLingui } from "@lingui/react/macro";

/**
 * An objective's misses since the last correct answer, and when the latest was:
 * "4 misses since the last correct answer, latest Oct 28, 2026".
 */
export function MissesSince(props: { count: number; lastMissAt: string; everSucceeded: boolean }) {
  const { i18n } = useLingui();
  const { count } = props;
  const latest = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
    new Date(props.lastMissAt),
  );
  return props.everSucceeded ? (
    <Trans>
      <Plural
        value={count}
        one="# miss since the last correct answer"
        other="# misses since the last correct answer"
      />
      , latest {latest}
    </Trans>
  ) : (
    <Trans>
      <Plural
        value={count}
        one="# miss, no correct answer yet"
        other="# misses, no correct answer yet"
      />
      , latest {latest}
    </Trans>
  );
}
