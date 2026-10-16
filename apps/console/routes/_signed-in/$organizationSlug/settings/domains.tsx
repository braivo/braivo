// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type DomainClaim } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
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
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from "react";

import { CopyButton } from "#components/copy-button";
import { NoSuchSetting } from "#components/no-such-setting";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { administratorsOnly, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

/**
 * The hostnames serving the organization's learn app, the primary one first
 * (white-label-9). Then those it added, not active yet, each with its DNS
 * records (white-label-10); and, where the installation can prove one, a
 * button activating each (white-label-11) and a form to add another
 * (ADR 0038).
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/domains")({
  beforeLoad: administratorsOnly,
  // Another organization's domains are another page: nothing typed or pending carries over.
  remountDeps: ({ params }) => params.organizationSlug,
  loader: ({ context, abortController }) =>
    orNotFound(
      context.braivo.listDomains(context.organization.id, { signal: abortController.signal }),
    ),
  head: (head) => pageHead(head, t`Domains`),
  component: Domains,
  notFoundComponent: NoSuchSetting,
});

function Domains() {
  const { domains, claims, canAdd } = Route.useLoaderData();
  // What was just done, said below the list. Its button gone with what it
  // acted on, focus moves: to the domain activated or, removed, to the page's
  // heading.
  const [done, setDone] = useState<{ hostname: string; action: "activated" | "removed" }>();
  const activatedLink = useRef<HTMLAnchorElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (done?.action === "activated") activatedLink.current?.focus();
    if (done?.action === "removed") heading.current?.focus();
  }, [done]);
  const removed = (hostname: string) => setDone({ hostname, action: "removed" });
  // Named, so a translator sees `{domain}`, not `{0}`.
  const domain = done?.hostname;

  return (
    <>
      <Heading ref={heading} tabIndex={-1} className="outline-none">
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
              Learners can practise at any of these addresses. Links to share with them use the
              primary one.
            </Trans>
          </MutedText>
          <ItemGroup className="gap-2">
            {domains.map(({ hostname, removable }, index) => (
              <Item key={hostname} role="listitem" variant="outline" size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle className="wrap-anywhere">
                    <a
                      ref={
                        done?.action === "activated" && hostname === done.hostname
                          ? activatedLink
                          : undefined
                      }
                      href={`https://${hostname}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {hostname}
                    </a>
                  </ItemTitle>
                </ItemContent>
                {(index === 0 || removable) && (
                  <ItemActions>
                    {index === 0 && (
                      <Badge variant="secondary">
                        <Trans>Primary</Trans>
                      </Badge>
                    )}
                    {removable && <RemoveDomain hostname={hostname} serving onRemoved={removed} />}
                  </ItemActions>
                )}
              </Item>
            ))}
          </ItemGroup>
        </>
      )}
      {/* Mounted before it says anything: a status region shown already filled
          is not reliably announced. */}
      <p role="status" className="mt-3 text-sm wrap-anywhere text-muted-foreground empty:mt-0">
        {done?.action === "activated" && <Trans>{domain} now serves your learners.</Trans>}
        {done?.action === "removed" && <Trans>Removed {domain}.</Trans>}
      </p>
      {claims.length > 0 && (
        <Claims
          claims={claims}
          canCheck={canAdd}
          onActivated={(hostname) => setDone({ hostname, action: "activated" })}
          onRemoved={removed}
        />
      )}
      {canAdd && <AddDomain />}
    </>
  );
}

/** Domains added and not yet serving, each with the DNS records it waits for. */
function Claims(props: {
  claims: DomainClaim[];
  /** Whether the installation has a provisioner to ask: without one, they wait read-only. */
  canCheck: boolean;
  onActivated: (hostname: string) => void;
  onRemoved: (hostname: string) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-10">
      <Heading level={2} id={id}>
        <Trans>Not active yet</Trans>
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
          <Claim
            key={claim.hostname}
            claim={claim}
            canCheck={props.canCheck}
            onActivated={props.onActivated}
            onRemoved={props.onRemoved}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * A domain not active yet, and its button activating it once the provisioner
 * reports it ready: it then serves as the primary domain.
 */
function Claim(props: {
  claim: DomainClaim;
  canCheck: boolean;
  onActivated: (hostname: string) => void;
  onRemoved: (hostname: string) => void;
}) {
  const { hostname, status } = props.claim;
  const { organization, braivo } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useLingui();
  const [checking, setChecking] = useState(false);
  /** The last failure; its count keys the alert, so a repeat is announced too. */
  const [failure, setFailure] = useState<{ message: string; count: number }>();

  async function activate() {
    setChecking(true);
    try {
      await braivo.activateDomain(organization.id, hostname, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
    } catch (thrown) {
      setFailure((last) => ({ message: refusal(thrown), count: (last?.count ?? 0) + 1 }));
      setChecking(false);
      // Read again only for what it shows: its records as they stand, or the
      // guard sending a signed-out owner to sign in. Not otherwise, which
      // could take this claim, its alert, and the focused button away.
      if (
        thrown instanceof BraivoError &&
        (thrown.code === "NOT_VERIFIED" || thrown.status === 401)
      ) {
        await router.invalidate();
      }
      return;
    }
    // Focus moves once the domain is listed (`sync`), its button gone with its claim.
    await router.invalidate({ sync: true });
    props.onActivated(hostname);
  }

  /** Why it is not serving yet, worded here from Braivo's code (ADR 0035). */
  function refusal(thrown: unknown): string {
    if (!(thrown instanceof BraivoError)) {
      return t`Could not connect. Check your connection and try again.`;
    }
    if (thrown.status === 401) return t`You were signed out. Sign in again.`;
    if (thrown.code === "NOT_VERIFIED") {
      return t`It is not ready yet: its records can take a few minutes to be found, and its certificate to be issued. Try again then.`;
    }
    if (thrown.status === 404) return t`It changed meanwhile. Reload the page to see it as it is.`;
    return t`Could not check the domain. Try again.`;
  }

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
            <Trans>Could not check this domain just now. Try again in a moment.</Trans>
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
      {props.canCheck && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant={status?.ready ? "default" : "outline"}
            aria-disabled={checking}
            onClick={() => !checking && activate()}
          >
            {checking ? (
              <>
                {/* Hidden: "Checking…" already says it. */}
                <Spinner data-icon="inline-start" aria-hidden="true" />
                <Trans>Checking…</Trans>
              </>
            ) : status?.ready ? (
              <Trans>Activate</Trans>
            ) : (
              <Trans>Check and activate</Trans>
            )}
          </Button>
          <RemoveDomain hostname={hostname} serving={false} onRemoved={props.onRemoved} />
        </div>
      )}
      {failure && (
        <Alert key={failure.count} variant="destructive" className="mt-4">
          <CircleAlertIcon />
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
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

/**
 * Removes a domain, or a domain's claim (`serving` false), asked first since a
 * domain stops serving at once. Once removed, it and this button are gone, so
 * `onRemoved` says where focus goes instead.
 */
function RemoveDomain(props: {
  hostname: string;
  serving: boolean;
  onRemoved: (hostname: string) => void;
}) {
  const { hostname } = props;
  const { organization, braivo } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useLingui();
  // A ref, set at once, refuses a second click before `removing` renders.
  const pending = useRef(false);
  const [removing, setRemoving] = useState(false);
  /** The last failure; its count keys the alert, so a repeat is announced too. */
  const [failure, setFailure] = useState<{ message: string; count: number }>();

  async function remove() {
    if (pending.current) return;
    pending.current = true;
    setRemoving(true);
    try {
      await braivo.removeDomain(organization.id, hostname, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
    } catch (thrown) {
      pending.current = false;
      setRemoving(false);
      setFailure((last) => ({ message: refusal(thrown), count: (last?.count ?? 0) + 1 }));
      // Read again only for the guard to send a signed-out owner to sign in:
      // otherwise the list, read again, could take this button and its alert
      // away (another owner removed the other domain, say).
      if (thrown instanceof BraivoError && thrown.status === 401) await router.invalidate();
      return;
    }
    // Focus moves once the domain is gone from the page.
    await router.invalidate({ sync: true });
    props.onRemoved(hostname);
  }

  /** Why it was not removed, worded here from Braivo's code (ADR 0035). */
  function refusal(thrown: unknown): string {
    if (!(thrown instanceof BraivoError)) {
      return t`Could not connect. Check your connection and try again.`;
    }
    if (thrown.status === 401) return t`You were signed out. Sign in again.`;
    if (thrown.code === "LAST_DOMAIN") {
      return t`It is the only domain your learners have. Add another first.`;
    }
    if (thrown.status === 404) return t`It changed meanwhile. Reload the page to see it as it is.`;
    return t`Could not remove the domain. Try again.`;
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          {/* Named for its domain: one of several Remove buttons on the page.
              Kept focusable while removing, though it opens nothing. */}
          <Button
            variant="outline"
            size="sm"
            aria-label={removing ? undefined : t`Remove ${hostname}`}
            aria-disabled={removing}
            onClick={(event) => removing && event.preventDefault()}
          >
            {removing ? (
              <>
                {/* Hidden: "Removing…" already says it. */}
                <Spinner data-icon="inline-start" aria-hidden="true" />
                <Trans>Removing…</Trans>
              </>
            ) : (
              <Trans>Remove</Trans>
            )}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">
              <Trans>Remove {hostname}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {props.serving ? (
                <Trans>
                  Learners can no longer practise there: links to it stop working, and anyone signed
                  in there is signed out.
                </Trans>
              ) : (
                <Trans>This cancels its setup. You can add it again later.</Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep it</Trans>
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              <Trans>Remove</Trans>
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

/** A record's name or value, exactly as the DNS provider wants it, with a button copying it. */
function CopyableText(props: { text: string; label: string }) {
  return (
    <div className="flex flex-wrap items-start gap-1">
      <span className="min-w-0 flex-1 py-1 font-mono wrap-anywhere">{props.text}</span>
      <CopyButton value={props.text} label={props.label} iconOnly className="shrink-0" />
    </div>
  );
}
