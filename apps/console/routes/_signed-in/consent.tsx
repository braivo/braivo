// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

/**
 * Spike (#113): where a person lets an AI app, such as Claude, act as them
 * through `/mcp`. Better Auth sends both signing in and consenting here, by
 * way of `/api/oauth/consent`; under the signed-in layout, someone signed out
 * signs in and comes back to it.
 */
export const Route = createFileRoute("/_signed-in/consent")({
  // Better Auth's signed request, whole, as `/api/oauth/consent` wrapped it.
  validateSearch: (search): { request?: string } =>
    typeof search.request === "string" && search.request.startsWith("r.")
      ? { request: search.request }
      : {},
  loaderDeps: ({ search }) => ({ request: search.request }),
  loader: async ({ context, deps }) => {
    const query = deps.request && decodeRequest(deps.request);
    if (!query) return { query: "", client: undefined };
    const clientId = new URLSearchParams(query).get("client_id") ?? "";
    // Verifies the request's signature first: a forged one names no client.
    const { data, error } = await context.auth.$fetch<{ client_name?: string }>(
      "/oauth2/public-client-prelogin",
      { method: "POST", body: { client_id: clientId, oauth_query: query } },
    );
    if (error) return { query, client: undefined };
    return { query, client: { id: clientId, name: data.client_name ?? clientId } };
  },
  component: Consent,
});

/** The signed query `/api/oauth/consent` wrapped as `r.<base64url>`, or none for a mangled one. */
function decodeRequest(request: string): string | undefined {
  try {
    return atob(request.slice(2).replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return undefined;
  }
}

/** Where an app's metadata comes from: its `client_id`'s host, when that is a URL (CIMD). */
function metadataHost(clientId: string): string | undefined {
  return URL.canParse(clientId) ? new URL(clientId).host : undefined;
}

const UNRECORDED = "Could not record your answer. Try again.";

function Consent() {
  const { auth } = Route.useRouteContext();
  const { query, client } = Route.useLoaderData();
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string>();

  if (!client) return <Heading>This request is not valid. Start again in the app.</Heading>;

  async function decide(accept: boolean) {
    if (deciding) return;
    setDeciding(true);
    setError(undefined);
    try {
      const { data, error } = await auth.$fetch<{ url: string }>("/oauth2/consent", {
        method: "POST",
        body: { accept, oauth_query: query },
      });
      if (error) return setError(UNRECORDED);
      // Back to the app, with a code or with its refusal.
      window.location.assign(data.url);
    } catch {
      setError(UNRECORDED);
    } finally {
      setDeciding(false);
    }
  }

  const host = metadataHost(client.id);
  return (
    <section className="flex flex-col gap-4">
      <Heading>Let {client.name} act as you?</Heading>
      {host && <MutedText>Its details come from {host}.</MutedText>}
      <p>It will be able to list the organizations you manage in Braivo.</p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button aria-disabled={deciding} onClick={() => decide(true)}>
          Approve
        </Button>
        <Button variant="outline" aria-disabled={deciding} onClick={() => decide(false)}>
          Deny
        </Button>
      </div>
    </section>
  );
}
