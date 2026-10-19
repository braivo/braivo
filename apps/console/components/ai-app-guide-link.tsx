// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drafting with the person's own AI app, offered mid-sentence, linked to the
 * guide that connects one (generation-19). A new tab, so a form being filled
 * in stays; an anchor, as shadcn's link Button keeps to one line and overflows
 * on a phone.
 */
export function AiAppGuideLink() {
  return (
    <a
      href="https://github.com/braivo/braivo/blob/main/docs/guides/assistants.md"
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-4"
    >
      your own AI app, such as Claude or ChatGPT
    </a>
  );
}
