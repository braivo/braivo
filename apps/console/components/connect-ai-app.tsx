// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { MutedText } from "@braivo/ui";
import { Trans, useLingui } from "@lingui/react/macro";

import { CopyButton } from "#components/copy-button";

/**
 * How to connect an AI app at `/mcp`: the address, each supported app's steps
 * (docs/guides/assistants.md, Connect), and, given the `organization` to build
 * for, a first prompt. No prompt without one: settings are the account's, so
 * the organization they were opened from may not be one the person authors in.
 */
export function ConnectAiApp({ organization }: { organization?: string }) {
  const { t } = useLingui();
  // The console is served on BRAIVO_URL's origin, and AI apps connect at its
  // `/mcp` (ADR 0004, ADR 0045).
  const address = new URL("/mcp", window.location.origin).href;
  const command = `claude mcp add --transport http braivo ${address}`;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <MutedText className="block wrap-break-word">
          <Trans>Add Braivo to your AI app with this address:</Trans>
        </MutedText>
        <CopyableText text={address} label={t`Copy connector address`} />
      </div>
      {/* Not a list: each app's name leads what to do in it. */}
      <dl className="flex flex-col gap-2">
        <div>
          <dt className="font-medium">Claude</dt>
          <dd className="wrap-break-word text-muted-foreground">
            <Trans>Customize, Connectors, Add custom connector.</Trans>
          </dd>
        </div>
        <div>
          <dt className="font-medium">ChatGPT</dt>
          <dd className="wrap-break-word text-muted-foreground">
            <Trans>On the web: chatgpt.com/plugins, Add custom MCP server, with OAuth.</Trans>
          </dd>
        </div>
        <div>
          <dt className="font-medium">Claude Code</dt>
          <dd className="wrap-break-word text-muted-foreground">
            <Trans>
              Run this command, then its <code>/mcp</code> command to sign in:
            </Trans>
            <CopyableText text={command} label={t`Copy command`} />
          </dd>
        </div>
      </dl>
      <MutedText className="block wrap-break-word">
        <Trans>
          When the app opens Braivo's page, sign in, choose the organization, and approve it. Then,
          in Claude or ChatGPT, turn it on in a chat.{" "}
          <a
            href="https://github.com/braivo/braivo/blob/main/docs/guides/assistants.md#connect"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            Step by step
          </a>
        </Trans>
      </MutedText>
      {organization !== undefined && <FirstPrompt organization={organization} />}
    </div>
  );
}

/**
 * What to ask first. A connection cannot publish (ADR 0039), so it says the
 * course waits, and the teacher expects to come back.
 */
function FirstPrompt({ organization }: { organization: string }) {
  const { t } = useLingui();
  return (
    <div>
      <MutedText className="block wrap-break-word">
        <Trans>Then ask it, attaching your material:</Trans>
      </MutedText>
      <CopyableText
        text={t`Using Braivo, turn the material I attach into a course for ${organization}: objectives first, then practice tasks citing it. The course then waits for my review in Braivo.`}
        label={t`Copy first prompt`}
      />
    </div>
  );
}

function CopyableText({ text, label }: { text: string; label: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      {/* No ligatures: the code font joins a command's `--` into one dash. */}
      <code className="wrap-anywhere text-foreground [font-variant-ligatures:none]">{text}</code>
      <CopyButton value={text} label={label} />
    </div>
  );
}
