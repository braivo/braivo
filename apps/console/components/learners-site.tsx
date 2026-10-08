// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { MutedText } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import { useEffect, useState } from "react";

/**
 * Where an organization's learners practise: `at` and a link to its learn
 * domain, with a way to copy the address, or `none` until the operator
 * registers one.
 */
export function LearnersSite(props: { learnDomain: string | null; at: string; none: string }) {
  const { learnDomain } = props;
  if (!learnDomain)
    return <MutedText className="mb-4 block wrap-break-word">{props.none}</MutedText>;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2">
      <MutedText className="wrap-anywhere">
        {props.at}{" "}
        <a href={`https://${learnDomain}`} target="_blank" rel="noreferrer" className="underline">
          {learnDomain}
        </a>
        .
      </MutedText>
      <CopyAddress address={`https://${learnDomain}`} />
    </div>
  );
}

/**
 * Copies the learners' address, which a teacher passes on by chat or email.
 * "Copied" shows for a moment and is announced, as a button's new label is
 * not; a refusal (no clipboard outside a secure context, or permission denied)
 * says so, leaving the link to copy by hand. Each try is announced afresh: the
 * status is emptied first, and each refusal mounts a new alert (docs/apps.md),
 * since React batches the emptying with a refusal thrown before any await.
 */
function CopyAddress(props: { address: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    setState("idle");
    try {
      await navigator.clipboard.writeText(props.address);
      setState("copied");
    } catch {
      setState("failed");
      setFailures((count) => count + 1);
    }
  }

  return (
    <>
      <Button variant="link" size="sm" className="h-auto px-0" onClick={copy}>
        {state === "copied" ? "Copied" : "Copy address"}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied" ? "Address copied." : ""}
      </span>
      {state === "failed" && (
        <p key={failures} role="alert" className="basis-full text-sm text-destructive">
          Could not copy. Select the address instead.
        </p>
      )}
    </>
  );
}
