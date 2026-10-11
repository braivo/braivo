// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type DomainClaim } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@braivo/ui/components/item";
import { Spinner } from "@braivo/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@braivo/ui/components/table";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { CopyButton } from "#components/copy-button";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * The hostnames serving the organization's learn app, the primary one first
 * (white-label-9). Then those it added, waiting for their DNS records, which
 * each shows (white-label-10), and, where the installation can prove one, a
 * form to add another (ADR 0038).
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/domains")({
  // Another organization's domains are another page: nothing typed or pending carries over.
  remountDeps: ({ params }) => params.organizationSlug,
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
  const { domains, claims, canAdd } = Route.useLoaderData();

  return (
    <>
      <Heading>
        <Trans>Domains</Trans>
      </Heading>
      {domains.length === 0 ? (
        <MutedText className="block wrap-break-word">
          {canAdd ? (
            <Trans>Learners have no site to practise on yet. Add a domain below.</Trans>
          ) : (
            <Trans>
              Learners have no site to practise on yet. Ask whoever set Braivo up for you to add
              one.
            </Trans>
          )}
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
      {claims.length > 0 && <Claims claims={claims} canCheck={canAdd} />}
      {canAdd && <AddDomain />}
    </>
  );
}

/** Domains added and not yet serving, each with the DNS records it waits for. */
function Claims(props: {
  claims: DomainClaim[];
  /** Whether the installation has a provisioner to ask about them. */
  canCheck: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-10">
      <Heading level={2} id={id}>
        <Trans>Waiting for DNS</Trans>
      </Heading>
      <MutedText className="mb-4 block wrap-break-word">
        <Trans>
          Create these records where the domain's DNS is managed. Learners cannot use a domain until
          its records are found and its certificate is issued, which can take a few minutes after
          they are created. A domain not activated within seven days is dropped; add it again then.
        </Trans>
      </MutedText>
      <ul className="flex flex-col gap-6">
        {props.claims.map((claim) => (
          <Claim key={claim.hostname} claim={claim} canCheck={props.canCheck} />
        ))}
      </ul>
    </section>
  );
}

/** A domain waiting for its records, with where it stands. */
function Claim(props: { claim: DomainClaim; canCheck: boolean }) {
  const { hostname, status } = props.claim;
  const { t } = useLingui();

  return (
    <li className="rounded-lg border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Heading level={3} className="wrap-anywhere">
          {hostname}
        </Heading>
        {/* A domain's, which Polish words by its gender. */}
        <Badge variant="secondary" className="shrink-0">
          {status === null ? (
            <Trans>Status unknown</Trans>
          ) : status.ready ? (
            <Trans context="domain">Verified</Trans>
          ) : (
            <Trans context="domain">Pending</Trans>
          )}
        </Badge>
      </div>
      {status === null ? (
        <MutedText className="block wrap-break-word">
          {props.canCheck ? (
            <Trans>Could not check this domain just now. Reload the page in a moment.</Trans>
          ) : (
            <Trans>
              This installation cannot check domains. Ask whoever set Braivo up for you to finish
              adding it.
            </Trans>
          )}
        </MutedText>
      ) : status.records.length === 0 ? (
        !status.ready && (
          <MutedText className="block wrap-break-word">
            <Trans>Its records are not available yet.</Trans>
          </MutedText>
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Type</Trans>
              </TableHead>
              <TableHead>
                <Trans>Name</Trans>
              </TableHead>
              <TableHead>
                <Trans>Value</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {status.records.map(({ type, name, value }) => (
              <TableRow key={`${type} ${name} ${value}`}>
                <TableCell className="align-top font-mono">{type}</TableCell>
                <TableCell className="align-top whitespace-normal">
                  <CopyableText text={name} label={t`Copy ${type} name`} />
                </TableCell>
                <TableCell className="align-top whitespace-normal">
                  <CopyableText text={value} label={t`Copy ${type} value`} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {status?.ready && (
        <MutedText className="mt-3 block wrap-break-word">
          <Trans>Its records are verified, but learners cannot use it yet.</Trans>
        </MutedText>
      )}
    </li>
  );
}

/**
 * Adds a domain, which then waits for its DNS records above. Adding one
 * already added asks again, so an unanswered request is safe to repeat.
 */
function AddDomain() {
  const { organization, braivo } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useLingui();
  const id = useId();
  const [adding, setAdding] = useState(false);
  /** The last failure; its count keys the alert, so a repeat is announced too. */
  const [failure, setFailure] = useState<{ message: string; count: number }>();
  const [added, setAdded] = useState<string>();

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in the field from submitting the form.
    if (adding) return;
    const input = event.currentTarget.elements.namedItem("hostname") as HTMLInputElement;
    const hostname = input.value.trim();
    if (!hostname) {
      input.setCustomValidity(t`Enter a domain, such as learn.example.com.`);
      input.reportValidity();
      return;
    }

    setAdding(true);
    setAdded(undefined);
    try {
      await braivo.claimDomain(organization.id, hostname, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
    } catch (thrown) {
      setFailure((last) => ({ message: refusal(thrown), count: (last?.count ?? 0) + 1 }));
      setAdding(false);
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) await router.invalidate();
      // Kept though the provisioner failed: listed again.
      if (thrown instanceof BraivoError && thrown.code === "PROVISIONING_FAILED") {
        await router.invalidate();
      }
      return;
    }
    input.value = "";
    setFailure(undefined);
    setAdded(hostname);
    setAdding(false);
    await router.invalidate();
  }

  /** Why it was not added, worded here from Braivo's code, never in its English (ADR 0035). */
  function refusal(thrown: unknown): string {
    if (!(thrown instanceof BraivoError)) {
      return t`Could not connect. Check your connection and try again.`;
    }
    if (thrown.status === 401) return t`You were signed out. Sign in again.`;
    switch (thrown.code) {
      case "DOMAIN_INVALID":
        return t`Enter a domain such as learn.example.com, without https:// or a path.`;
      case "DOMAIN_RESERVED":
        return t`That address is Braivo's own. Enter a domain your organization owns.`;
      case "DOMAIN_TAKEN":
        return t`Another organization already uses that domain.`;
      case "ALREADY_ADDED":
        return t`That domain already serves your organization.`;
      case "PROVISIONING_FAILED":
        return t`The domain was saved, but setting it up failed. Add it again to retry.`;
      default:
        return t`Could not add the domain. Try again.`;
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="mt-10">
      <Heading level={2} id={`${id}-heading`}>
        <Trans>Add a domain</Trans>
      </Heading>
      <form onSubmit={add}>
        <Field>
          <FieldLabel htmlFor={`${id}-hostname`}>
            <Trans>Domain</Trans>
          </FieldLabel>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`${id}-hostname`}
              name="hostname"
              required
              // Held while adding, so the domain added is the one shown.
              readOnly={adding}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="learn.example.com"
              aria-describedby={`${id}-hostname-hint`}
              onChange={(event) => {
                event.currentTarget.setCustomValidity("");
                setAdded(undefined);
              }}
            />
            <Button type="submit" aria-disabled={adding} className="shrink-0">
              {adding ? (
                <>
                  {/* Hidden: "Adding…" already says it. */}
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                  <Trans>Adding…</Trans>
                </>
              ) : (
                <Trans>Add domain</Trans>
              )}
            </Button>
          </div>
          <FieldDescription id={`${id}-hostname-hint`}>
            <Trans>
              Use a subdomain, such as learn.example.com. A domain without one, such as example.com,
              works only if its DNS provider supports ALIAS records or CNAME flattening.
            </Trans>
          </FieldDescription>
        </Field>
      </form>
      {/* Mounted before it says anything: a status region shown already filled
          is not reliably announced. */}
      <p role="status" className="mt-3 text-sm wrap-anywhere text-muted-foreground empty:mt-0">
        {added && <Trans>Added {added}. Create its DNS records above.</Trans>}
      </p>
      {failure && (
        <Alert key={failure.count} variant="destructive" className="mt-4">
          <CircleAlertIcon />
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

/** A record's name or value, exactly as the DNS provider wants it, with a button copying it. */
function CopyableText(props: { text: string; label: string }) {
  return (
    <div className="flex flex-wrap items-start gap-1">
      <span className="min-w-0 flex-1 py-1 font-mono wrap-anywhere">{props.text}</span>
      <CopyButton value={props.text} label={props.label} iconOnly className="shrink-0" />
    </div>
  );
}
