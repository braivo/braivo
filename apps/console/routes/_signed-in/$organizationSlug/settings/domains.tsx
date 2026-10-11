// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Badge } from "@braivo/ui/components/badge";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@braivo/ui/components/item";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * The hostnames serving the organization's learn app, the primary one first
 * (white-label-9).
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/domains")({
  loader: ({ context, abortController }) =>
    orNotFound(
      context.braivo.listDomains(context.organization.id, { signal: abortController.signal }),
    ),
  head: (head) => pageHead(head, t`Domains`),
  component: Domains,
  notFoundComponent: () => (
    <p>
      <Trans>This organization does not exist, or you do not manage it.</Trans>
    </p>
  ),
});

function Domains() {
  const { domains } = Route.useLoaderData();

  return (
    <>
      <Heading>
        <Trans>Domains</Trans>
      </Heading>
      {domains.length === 0 ? (
        <MutedText className="block wrap-break-word">
          <Trans>
            Learners have no site to practise on yet. Ask whoever set Braivo up for you to add one.
          </Trans>
        </MutedText>
      ) : (
        <>
          <MutedText className="mb-4 block wrap-break-word">
            <Trans>
              Learners can practise at any of these addresses. New links Braivo sends them,
              invitations included, use the primary one.
            </Trans>
          </MutedText>
          <ItemGroup className="gap-2">
            {domains.map(({ hostname }, index) => (
              <Item key={hostname} role="listitem" variant="outline" size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle className="wrap-anywhere">
                    <a
                      href={`https://${hostname}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {hostname}
                    </a>
                  </ItemTitle>
                </ItemContent>
                {index === 0 && (
                  <ItemActions>
                    <Badge variant="secondary">
                      <Trans>Primary</Trans>
                    </Badge>
                  </ItemActions>
                )}
              </Item>
            ))}
          </ItemGroup>
        </>
      )}
    </>
  );
}
