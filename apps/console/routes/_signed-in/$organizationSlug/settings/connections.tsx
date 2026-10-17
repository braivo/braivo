// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type Connection } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@braivo/ui/components/alert-dialog";
import { Button } from "@braivo/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@braivo/ui/components/item";
import { Spinner } from "@braivo/ui/components/spinner";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { CopyButton } from "#components/copy-button";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { pageHead } from "#lib/title";

/**
 * The AI apps the account connected at `/mcp`, in any organization, each
 * disconnected here (access-42): the account's own, as Profile is, so under
 * whichever organization settings were opened from.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/connections")({
  loader: async ({ context, abortController }) => ({
    connections: await context.braivo.listConnections({ signal: abortController.signal }),
  }),
  head: (head) => pageHead(head, t`Connected apps`),
  component: Connections,
});

function Connections() {
  const { connections: loaded } = Route.useLoaderData();
  const { organizations } = Route.useRouteContext();
  const { i18n } = useLingui();
  // Those disconnected here, left out rather than the list read again: a
  // failed read would show an error page, as if disconnecting had failed.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const connections = loaded.filter(({ id }) => !gone.has(id));
  // The connection just ended, said below the list; its button gone with it,
  // focus moves to the page's heading. An object, so ending a second one of
  // the same app moves focus again.
  const [disconnected, setDisconnected] = useState<{ app: string; organization: string }>();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (disconnected !== undefined) heading.current?.focus();
  }, [disconnected]);
  const dated = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" });

  return (
    <>
      <Heading ref={heading} tabIndex={-1}>
        <Trans>Connected apps</Trans>
      </Heading>
      {connections.length === 0 ? (
        <MutedText className="block wrap-break-word">
          <Trans>No AI app is connected to your account.</Trans>
        </MutedText>
      ) : (
        <>
          <MutedText className="mb-4 block wrap-break-word">
            <Trans>
              AI apps you let work in Braivo for you, each in one organization. Disconnecting one
              stops it at once; to use it there again, connect it again.
            </Trans>
          </MutedText>
          <ItemGroup className="gap-2">
            {connections.map((connection) => {
              // Its name is its own claim; a URL for its ID identifies it (CIMD).
              const url = URL.canParse(connection.client.id) ? connection.client.id : undefined;
              // Named, so a translator sees `{organization}` and `{date}`.
              const organization = connection.organization.name;
              const date = dated.format(new Date(connection.connectedAt));
              return (
                <Item key={connection.id} role="listitem" variant="outline" size="sm">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="wrap-anywhere">
                      {connection.client.name ?? connection.client.id}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none wrap-anywhere">
                      {url && connection.client.name && <>{url} · </>}
                      <Trans>
                        {organization} · connected {date}
                      </Trans>
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Disconnect
                      connection={connection}
                      onDisconnected={() => {
                        setGone((ids) => new Set(ids).add(connection.id));
                        setDisconnected({
                          app: connection.client.name ?? connection.client.id,
                          organization: connection.organization.name,
                        });
                      }}
                    />
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        </>
      )}
      {/* Mounted before it says anything: a status region shown already filled
          is not reliably announced. */}
      <p role="status" className="mt-3 text-sm wrap-anywhere text-muted-foreground empty:mt-0">
        {disconnected && <Disconnected {...disconnected} />}
      </p>
      {/* Only to someone administering an organization, the only kind consent offers. */}
      {organizations.some(({ administers }) => administers) && <HowToConnect />}
    </>
  );
}

/** How to connect an AI app: the address to paste into it, and the guide. */
function HowToConnect() {
  const { t } = useLingui();
  const id = useId();
  // The console is served on BRAIVO_URL's origin, and AI apps connect at its
  // `/mcp` (ADR 0004, ADR 0045).
  const address = new URL("/mcp", window.location.origin).href;
  return (
    <section aria-labelledby={id} className="mt-8">
      <Heading id={id} level={2}>
        <Trans>Connect an app</Trans>
      </Heading>
      <MutedText className="block wrap-break-word">
        <Trans>
          In Claude, ChatGPT, or another AI app, add a custom connector with this address, then sign
          in and approve it.{" "}
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
      <div className="mt-2 flex flex-wrap items-center gap-x-3">
        <code className="text-sm wrap-anywhere">{address}</code>
        <CopyButton value={address} label={t`Copy address`} />
      </div>
    </section>
  );
}

/** Names the organization too, so ending a second of one app's connections says something new. */
function Disconnected({ app, organization }: { app: string; organization: string }) {
  return (
    <Trans>
      Disconnected {app} from {organization}.
    </Trans>
  );
}

function Disconnect(props: { connection: Connection; onDisconnected: () => void }) {
  const { connection } = props;
  const { braivo } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useLingui();
  // A ref, set at once, refuses a second click before `disconnecting` renders.
  const pending = useRef(false);
  const [disconnecting, setDisconnecting] = useState(false);
  /** The last failure; its count keys the alert, so a repeat is announced too. */
  const [failure, setFailure] = useState<{ message: string; count: number }>();
  const app = connection.client.name ?? connection.client.id;
  const organization = connection.organization.name;

  async function disconnect() {
    if (pending.current) return;
    pending.current = true;
    setDisconnecting(true);
    try {
      await braivo.disconnectConnection(connection.id, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
    } catch (thrown) {
      // Gone already, disconnected in another tab: as asked.
      if (!(thrown instanceof BraivoError && thrown.status === 404)) {
        pending.current = false;
        setDisconnecting(false);
        setFailure((last) => ({ message: refusal(thrown), count: (last?.count ?? 0) + 1 }));
        // Read again only for the guard to send a signed-out person to sign in.
        if (thrown instanceof BraivoError && thrown.status === 401) await router.invalidate();
        return;
      }
    }
    props.onDisconnected();
  }

  function refusal(thrown: unknown): string {
    if (!(thrown instanceof BraivoError)) {
      return t`Could not disconnect. Check your connection and try again.`;
    }
    if (thrown.status === 401) return t`You were signed out. Sign in again.`;
    return t`Could not disconnect the app. Try again.`;
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          {/* Named for its app and organization: one of several on the page.
              Kept focusable while disconnecting, though it opens nothing. */}
          <Button
            variant="outline"
            size="sm"
            aria-label={disconnecting ? undefined : t`Disconnect ${app} from ${organization}`}
            aria-disabled={disconnecting}
            onClick={(event) => disconnecting && event.preventDefault()}
          >
            {disconnecting ? (
              <>
                {/* Hidden: "Disconnecting…" already says it. */}
                <Spinner data-icon="inline-start" aria-hidden="true" />
                <Trans>Disconnecting…</Trans>
              </>
            ) : (
              <Trans>Disconnect</Trans>
            )}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">
              <Trans>
                Disconnect {app} from {organization}?
              </Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                It can no longer work in Braivo for you there, from its next request. To use it
                again, connect it again.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep it</Trans>
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={disconnect}>
              <Trans>Disconnect</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {failure && (
        <p key={failure.count} role="alert" className="text-sm text-destructive">
          {failure.message}
        </p>
      )}
    </div>
  );
}
