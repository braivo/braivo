// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Trans } from "@lingui/react/macro";

/**
 * A settings page someone does not have: one that does not exist, or an
 * organization's, to whoever does not administer it. Told in the settings'
 * outlet, by each such page's route, so their navigation and way back stay.
 */
export function NoSuchSetting() {
  return (
    <>
      <Heading>
        <Trans>There is no such setting</Trans>
      </Heading>
      <MutedText className="block wrap-break-word">
        <Trans>Choose one from the list.</Trans>
      </MutedText>
    </>
  );
}
