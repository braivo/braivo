// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { MutedText } from "@braivo/ui";
import { useLingui } from "@lingui/react/macro";

import { CopyButton } from "#components/copy-button";

/**
 * Where an organization's learners practise: `at` and a link to its learn
 * domain, or to `path` there, such as a course's, with a way to copy the
 * address, or `none`, if given, until it has one.
 */
export function LearnersSite(props: {
  learnDomain: string | null;
  path?: string;
  at: string;
  none?: string;
}) {
  const { learnDomain } = props;
  const { t } = useLingui();
  if (!learnDomain)
    return props.none && <MutedText className="mb-4 block wrap-break-word">{props.none}</MutedText>;

  const address = `${learnDomain}${props.path ?? ""}`;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2">
      <MutedText className="wrap-anywhere">
        {props.at}{" "}
        <a href={`https://${address}`} target="_blank" rel="noreferrer" className="underline">
          {address}
        </a>
        .
      </MutedText>
      {/* A teacher passes it on by chat or email. */}
      <CopyButton value={`https://${address}`} label={t`Copy address`} />
    </div>
  );
}
