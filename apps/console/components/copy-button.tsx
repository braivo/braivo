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

  const copied = state === "copied";
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
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      ) : (
        // An icon: in the light theme a link is the text's colour, and a phone
        // shows no hover underline, so without one it reads as plain words.
        // Padded for its focus ring and pulled back as much, so it lines up with
        // the text when wrapped; 44px tall, a touch target's least, on a phone
        // or a touch screen.
        <Button
          variant="link"
          size="sm"
          className={cn(
            "-ml-1 h-auto px-1 has-data-[icon=inline-start]:pl-1 pointer-coarse:min-h-11 max-md:min-h-11",
            props.className,
          )}
          onClick={copy}
        >
          {copied ? (
            <CheckIcon data-icon="inline-start" aria-hidden="true" />
          ) : (
            <CopyIcon data-icon="inline-start" aria-hidden="true" />
          )}
          {/* Both labels in one cell, the other hidden, so it is as wide as the
              longer and never moves between lines when "Copied" shows. */}
          <span className="grid text-left">
            <span
              aria-hidden={copied || undefined}
              className={cn("col-start-1 row-start-1", copied && "invisible")}
            >
              {props.label}
            </span>
            <span
              aria-hidden={!copied || undefined}
              className={cn("col-start-1 row-start-1", !copied && "invisible")}
            >
              {t`Copied`}
            </span>
          </span>
        </Button>
      )}
      <span role="status" className="sr-only">
        {copied ? t`Copied.` : ""}
      </span>
      {state === "failed" && (
        <p key={failures} role="alert" className="basis-full text-sm text-destructive">
          {t`Could not copy. Select it instead.`}
        </p>
      )}
    </>
  );
}
