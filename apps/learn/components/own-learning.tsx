// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { learnSignInUrl } from "@braivo/auth-client";
import type { Course, Membership, Organization } from "@braivo/server/client";
import { Heading } from "@braivo/ui";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@braivo/ui/components/item";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { AccountHeader } from "./account-header.tsx";

/**
 * My learning (ADR 0059): the person's own courses, each at `/c/<course ID>`,
 * or, with none, that nothing of their own is here yet, and the sites of the
 * schools they belong to, through each one's sign-in start, which offers the
 * account signed in here without another code (ADR 0018); not their schools' courses,
 * which open on each school's domain. Beneath, the console of each school
 * they work in, a page load away, as the console is another app on this
 * origin. Either list unread or empty is left out.
 */
export function OwnLearning({
  courses,
  organizations,
  schools,
}: {
  courses: Course[];
  organizations: Organization[] | undefined;
  /** Memberships with a learn domain. */
  schools: Membership[] | undefined;
}) {
  const consolesId = useId();
  const schoolsId = useId();
  return (
    <>
      <AccountHeader />
      <section>
        <Heading>
          <Trans>My learning</Trans>
        </Heading>
        {courses.length === 0 ? (
          <>
            <Empty className="max-sm:p-6">
              <EmptyHeader>
                <EmptyTitle>
                  <Trans>Nothing of your own yet</Trans>
                </EmptyTitle>
                <EmptyDescription>
                  <Trans>
                    What you learn for yourself, apart from any school, will be here. A school's
                    courses open on its own site.
                  </Trans>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
            {schools !== undefined && schools.length > 0 && (
              <section aria-labelledby={schoolsId} className="mt-8">
                <Heading level={2} id={schoolsId}>
                  <Trans>Your schools</Trans>
                </Heading>
                <ItemGroup className="gap-2">
                  {schools.map(({ id, name, learnDomain }) => (
                    <Row key={id}>
                      <a href={learnSignInUrl(learnDomain!)}>
                        <RowTitle>{name}</RowTitle>
                      </a>
                    </Row>
                  ))}
                </ItemGroup>
              </section>
            )}
          </>
        ) : (
          <ItemGroup className="gap-2">
            {courses.map(({ id, title }) => (
              <Row key={id}>
                <Link to="/c/$courseRef" params={{ courseRef: id }}>
                  <RowTitle>{title}</RowTitle>
                </Link>
              </Row>
            ))}
          </ItemGroup>
        )}
      </section>
      {organizations !== undefined && organizations.length > 0 && (
        <section aria-labelledby={consolesId} className="mt-8">
          <Heading level={2} id={consolesId}>
            <Trans>Your organizations</Trans>
          </Heading>
          <ItemGroup className="gap-2">
            {organizations.map(({ id, name, slug }) => (
              <Row key={id}>
                <a href={`/${slug}`}>
                  <RowTitle>{name}</RowTitle>
                </a>
              </Row>
            ))}
          </ItemGroup>
        </section>
      )}
    </>
  );
}

/** A whole-row link in a list, as the course list's cards. */
function Row({ children }: { children: ReactNode }) {
  return (
    // `ItemGroup` is a list, and a link is not a list item. A chevron and a
    // press's fill mark it as a link on a phone, where nothing hovers.
    <div role="listitem">
      <Item variant="outline" className="flex-nowrap active:bg-muted" asChild>
        {children}
      </Item>
    </div>
  );
}

function RowTitle({ children }: { children: ReactNode }) {
  return (
    <>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none wrap-anywhere">{children}</ItemTitle>
      </ItemContent>
      <ItemActions className="shrink-0">
        <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      </ItemActions>
    </>
  );
}
