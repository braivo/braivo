// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { MutedText } from "@braivo/ui";
import { Trans } from "@lingui/react/macro";

/**
 * Where a personal organization's courses are learned, in place of a learn
 * domain it never takes (ADR 0059): My learning, the learn app's, loaded
 * rather than routed. Never the operator's to add a site for.
 */
export function PersonalCoursesNote() {
  return (
    <MutedText className="mb-4 block wrap-break-word">
      <Trans>
        Your own courses open in{" "}
        <a href="/learn" className="underline">
          My learning
        </a>
        , and need no domain.
      </Trans>
    </MutedText>
  );
}

/**
 * A personal course's one address, `/c/<course ID>` on the installation's
 * origin, where the console is too (ADR 0059): no learn domain, no number or
 * label. No copy button: no one else may open it.
 */
export function PersonalCourseLink(props: { courseId: string }) {
  const url = `${window.location.origin}/c/${props.courseId}`;
  return (
    <MutedText className="mb-4 block wrap-anywhere">
      <Trans>
        Practise it at{" "}
        <a href={url} className="underline">
          {url.replace(/^https?:\/\//, "")}
        </a>
        .
      </Trans>
    </MutedText>
  );
}
