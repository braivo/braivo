// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drafting with a desktop agent, offered mid-sentence, linked to the guide that
 * sets one up (generation-19). A new tab, so a form being filled in stays; an
 * anchor, as shadcn's link Button keeps to one line and overflows on a phone.
 */
export function DesktopAgentLink() {
  return (
    <a
      href="https://github.com/braivo/braivo/blob/main/docs/guides/authoring.md#let-your-desktop-agent-build-the-course"
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-4"
    >
      your desktop agent through braivo mcp
    </a>
  );
}
