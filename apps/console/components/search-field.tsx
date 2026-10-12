// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { InputGroup, InputGroupAddon, InputGroupInput } from "@braivo/ui/components/input-group";
import { cn } from "@braivo/ui/lib/utils";
import { SearchIcon } from "lucide-react";

/**
 * A list's filter as typed, named by `label`, which shows as its placeholder
 * too. It narrows what is shown, never what a page reports.
 */
export function SearchField(props: {
  label: string;
  value: string;
  maxLength?: number;
  onChange: (value: string) => void;
  /** Left: before a link the focus went to opens, as a click blurs first. */
  onBlur?: () => void;
  className?: string;
}) {
  return (
    <InputGroup className={cn("max-w-xs", props.className)}>
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        aria-label={props.label}
        placeholder={props.label}
        value={props.value}
        maxLength={props.maxLength}
        autoComplete="off"
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onBlur={props.onBlur}
      />
    </InputGroup>
  );
}
