// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/** A person's tag (`sharedNameTags`), after their name, set apart from it; nothing without one. */
export function NameTag({ tag }: { tag: string | undefined }) {
  return tag ? <span className="ms-2 font-mono text-xs text-muted-foreground">{tag}</span> : null;
}
