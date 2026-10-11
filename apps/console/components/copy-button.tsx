// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import { cn } from "@braivo/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Copies `value`, something a person passes on or pastes elsewhere: the
 * learners' address, a DNS record. `label` names it, shown as its text, or,
 * `iconOnly`, as its accessible name, kept so each of several stays told
 * apart. "Copied" shows for a moment, as text or a check, and is announced, as
 * a button's new name is not; a refusal (no clipboard outside a secure
 * context, or permission denied) says so, leaving the value to select by hand. Each try is announced afresh: the status is
 * emptied first, and each refusal mounts a new alert (docs/apps.md), since
 * React batches the emptying with a refusal thrown before any await.
 */
export function CopyButton(props: {
  value: string;
  label: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
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
      await navigator.clipboard.writeText(props.value);
      setState("copied");
    } catch {
      setState("failed");
      setFailures((count) => count + 1);
    }
  }

  const name = state === "copied" ? t`Copied` : props.label;
  return (
    <>
      {props.iconOnly ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className={props.className}
          aria-label={props.label}
          title={props.label}
          onClick={copy}
        >
          {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        </Button>
      ) : (
        <Button
          variant="link"
          size="sm"
          className={cn("h-auto px-0", props.className)}
          onClick={copy}
        >
          {name}
        </Button>
      )}
      <span role="status" className="sr-only">
        {state === "copied" ? t`Copied.` : ""}
      </span>
      {state === "failed" && (
        <p key={failures} role="alert" className="basis-full text-sm text-destructive">
          {t`Could not copy. Select it instead.`}
        </p>
      )}
    </>
  );
}
