// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { MutedText } from "@braivo/ui";
import { useLingui } from "@lingui/react/macro";

import { CopyButton } from "#components/copy-button";

/**
 * Where an organization's learners practise: `at` and a link to its learn
 * domain, with a way to copy the address, or `none`, if given, until the
 * operator registers one.
 */
export function LearnersSite(props: { learnDomain: string | null; at: string; none?: string }) {
  const { learnDomain } = props;
  const { t } = useLingui();
  if (!learnDomain)
    return props.none && <MutedText className="mb-4 block wrap-break-word">{props.none}</MutedText>;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2">
      <MutedText className="wrap-anywhere">
        {props.at}{" "}
        <a href={`https://${learnDomain}`} target="_blank" rel="noreferrer" className="underline">
          {learnDomain}
        </a>
        .
      </MutedText>
      {/* A teacher passes it on by chat or email. */}
      <CopyButton value={`https://${learnDomain}`} label={t`Copy address`} />
    </div>
  );
}
