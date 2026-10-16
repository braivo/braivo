// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Organization } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

/**
 * Where a person lets an AI app, such as Claude, work in Braivo as them
 * through `/mcp`, in one organization they manage (ADR 0045). Better Auth
 * sends each authorization here twice, by way of `/api/oauth/*`: first to
 * choose the organization (`step=organization`), then, unless that one's
 * consent was given already, to consent. Under the signed-in layout, someone
 * signed out signs in on the way, then chooses.
 */
export const Route = createFileRoute("/_signed-in/consent")({
  // Better Auth's signed request, whole, as `/api/oauth/*` wrapped it.
  validateSearch: (search): { step?: "organization"; request?: string } => ({
    ...(search.step === "organization" && { step: "organization" as const }),
    ...(typeof search.request === "string" &&
      search.request.startsWith("r.") && { request: search.request }),
  }),
  loaderDeps: ({ search }) => ({ step: search.step, request: search.request }),
  loader: async ({ context, deps, abortController }) => {
    const query = deps.request && decodeRequest(deps.request);
    if (!query) return { query: "", client: undefined, organizations: [] };
    const clientId = new URLSearchParams(query).get("client_id") ?? "";
    // Verifies the request's signature first: a forged one names no client.
    const [named, managed, session] = await Promise.all([
      context.auth.$fetch<{ client_name?: string }>("/oauth2/public-client-prelogin", {
        method: "POST",
        body: { client_id: clientId, oauth_query: query },
      }),
      context.braivo.listOrganizations({ signal: abortController.signal }),
      context.auth.getSession(),
    ]);
    if (named.error) return { query, client: undefined, organizations: [] };
    const client = { id: clientId, name: named.data.client_name ?? clientId };
    const organizations = managed.filter(({ administers }) => administers);
    if (deps.step === "organization") return { query, client, organizations };
    // Consenting: to the organization chosen, which Better Auth keeps on the session.
    const chosen = (session.data?.session as { activeOrganizationId?: unknown } | undefined)
      ?.activeOrganizationId;
    return { query, client, organizations: organizations.filter(({ id }) => id === chosen) };
  },
  component: Consent,
});

/** The signed query `/api/oauth/*` wrapped as `r.<base64url>`, or none for a mangled one. */
function decodeRequest(request: string): string | undefined {
  try {
    return atob(request.slice(2).replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return undefined;
  }
}

function Consent() {
  const { auth, visit } = Route.useRouteContext();
  const { step } = Route.useSearch();
  const { query, client, organizations } = Route.useLoaderData();
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState(0);
  // Refused, which retrying cannot mend: another tab chose another
  // organization since (`ACTIVE_ORGANIZATION_CHANGED`), or anything else.
  const [refused, setRefused] = useState<"changed" | "other">();

  if (!client) {
    return (
      <Heading>
        <Trans>This request is not valid. Start again in the app.</Trans>
      </Heading>
    );
  }
  // Named, so a translator sees what each placeholder holds.
  const clientName = client.name;
  const [organization] = organizations;
  if (step !== "organization" && !organization) {
    return (
      <Heading>
        <Trans>This request is not valid. Start again in {clientName}.</Trans>
      </Heading>
    );
  }

  /** Asks Better Auth, then follows its answer: on to consent, or back to the app. */
  async function act(ask: () => Promise<{ data: { url: string } | null; error: unknown }>) {
    if (pending) return;
    setPending(true);
    try {
      const { data, error } = await ask();
      const { status, code } = (error ?? {}) as { status?: number; code?: string };
      if (status === 403)
        return setRefused(code === "ACTIVE_ORGANIZATION_CHANGED" ? "changed" : "other");
      if (error || !data) return setFailures((count) => count + 1);
      visit(data.url);
    } catch {
      setFailures((count) => count + 1);
    } finally {
      setPending(false);
    }
  }

  const decide = (accept: boolean) =>
    act(() =>
      auth.$fetch<{ url: string }>("/oauth2/consent", {
        method: "POST",
        // The organization shown, which Braivo refuses to grant once the
        // session's choice differs (another tab's).
        body: { accept, oauth_query: query, organizationId: organization?.id },
      }),
    );

  // Kept on the session, where Better Auth reads it, then the authorization resumed.
  const choose = (chosen: Organization) =>
    act(async () => {
      const active = await auth.$fetch("/organization/set-active", {
        method: "POST",
        body: { organizationId: chosen.id },
      });
      // Failed, not refused as changed: retrying can work.
      if (active.error) return { data: null, error: true };
      return auth.$fetch<{ url: string }>("/oauth2/continue", {
        method: "POST",
        body: { postLogin: true, oauth_query: query, organizationId: chosen.id },
      });
    });

  if (refused === "changed") {
    return (
      <Heading>
        <Trans>Another organization was chosen in another tab. Start again in {clientName}.</Trans>
      </Heading>
    );
  }
  if (refused) {
    return (
      <Heading>
        <Trans>
          Could not connect {clientName}. Check your access, then start again in {clientName}.
        </Trans>
      </Heading>
    );
  }
  const failed = failures > 0 && (
    // Keyed by the count, so a repeated failure is announced again.
    <Alert key={failures} variant="destructive">
      <AlertDescription>{t`Could not record your answer. Try again.`}</AlertDescription>
    </Alert>
  );
  // A client's name is its own claim; a URL for its ID identifies it (CIMD).
  const clientId = URL.canParse(client.id) ? client.id : undefined;
  const from = clientId && (
    <MutedText className="wrap-anywhere">
      <Trans>Client ID: {clientId}</Trans>
    </MutedText>
  );
  const deny = (
    <Button variant="outline" aria-disabled={pending} onClick={() => decide(false)}>
      {organizations.length === 0 ? <Trans>Cancel</Trans> : <Trans>Deny</Trans>}
    </Button>
  );

  if (step === "organization") {
    if (organizations.length === 0) {
      return (
        <section className="flex flex-col gap-4">
          <Heading>
            <Trans>You don't manage any organizations</Trans>
          </Heading>
          <p>
            <Trans>
              {clientName} works in an organization you manage. Ask its owner, or whoever set Braivo
              up for you, to add you, then connect again.
            </Trans>
          </p>
          {failed}
          <div className="flex gap-2">{deny}</div>
        </section>
      );
    }
    return (
      <section className="flex flex-col gap-4">
        <Heading>
          <Trans>Which organization should {clientName} work in?</Trans>
        </Heading>
        {from}
        <p>
          <Trans>It works in one. To use it in another too, connect it again.</Trans>
        </p>
        {failed}
        <ul className="flex flex-col gap-2">
          {organizations.map((each) => (
            <li key={each.id}>
              <Button
                variant="outline"
                className="h-auto min-h-9 w-full justify-start py-1.5 wrap-anywhere whitespace-normal"
                aria-disabled={pending}
                onClick={() => choose(each)}
              >
                {each.name}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">{deny}</div>
      </section>
    );
  }

  const organizationName = organization!.name;
  return (
    <section className="flex flex-col gap-4">
      <Heading>
        <Trans>
          Let {clientName} work in {organizationName}?
        </Trans>
      </Heading>
      {from}
      <p>
        <Trans>
          As you, it will be able to read the material and courses of {organizationName}, and add
          material and the learning objectives it teaches.
        </Trans>
      </p>
      {failed}
      <div className="flex gap-2">
        <Button aria-disabled={pending} onClick={() => decide(true)}>
          <Trans>Approve</Trans>
        </Button>
        {deny}
      </div>
    </section>
  );
}
