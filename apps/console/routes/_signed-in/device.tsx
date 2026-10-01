// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";

/**
 * Where a content owner lets their own tools act as them: the page the CLI's
 * sign-in links to, with the code it showed (docs/adr/0022-machine-access.md).
 * Under the signed-in layout, so someone signed out signs in and comes back
 * with the code still in the address.
 */
export const Route = createFileRoute("/_signed-in/device")({
  validateSearch: (search): { user_code?: string } => {
    const code = typeof search.user_code === "string" ? search.user_code.trim() : "";
    return code === "" ? {} : { user_code: code };
  },
  loaderDeps: ({ search }) => ({ userCode: search.user_code }),
  loader: async ({ context, deps }) => {
    if (deps.userCode === undefined) return { request: undefined };
    // Also what binds the code to this user, which approving requires.
    const { data, error } = await context.auth.device({ query: { user_code: deps.userCode } });
    return { request: error ? ("unknown" as const) : data };
  },
  component: Device,
});

/** What the approval asks about, by the client ID Braivo lets use the device flow. */
const CLIENT_NAMES: Record<string, string> = {
  "braivo-cli": "Braivo's command-line tool, or an AI agent using it",
};

function Device() {
  const { request } = Route.useLoaderData();

  if (request === undefined) return <EnterCode />;
  if (request === "unknown") {
    return (
      <EnterCode problem="That code is not valid, or has expired. Start again in your terminal." />
    );
  }
  if (request.status !== "pending") {
    return <Heading>This code was already {request.status}.</Heading>;
  }
  return <Review userCode={request.user_code} clientId={request.client_id} />;
}

/** For a code typed from the terminal, when the link was not followed. */
function EnterCode({ problem }: { problem?: string }) {
  const navigate = useNavigate({ from: Route.fullPath });
  const id = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code") as string;
    void navigate({ search: { user_code: code } });
  }

  return (
    <>
      <Heading>Sign in a tool</Heading>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-code`}>Code shown in your terminal</FieldLabel>
            <Input id={`${id}-code`} name="code" required autoComplete="off" />
          </Field>
          {problem && (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          <Field>
            <Button type="submit">Continue</Button>
          </Field>
        </FieldGroup>
      </form>
    </>
  );
}

const UNRECORDED = "Braivo could not record your answer. Try again.";

function Review({ userCode, clientId }: { userCode: string; clientId?: string | null }) {
  const { auth } = Route.useRouteContext();
  const [outcome, setOutcome] = useState<"approved" | "denied">();
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(approve: boolean) {
    // One decision at a time: Better Auth checks the code is pending, then
    // updates it, so an Approve and a Deny in flight together could both
    // succeed, and this page would report whichever answered last.
    setDeciding(true);
    setError(undefined);
    try {
      const { error } = approve
        ? await auth.device.approve({ userCode })
        : await auth.device.deny({ userCode });
      // The device flow's errors are OAuth's shape, `error_description` for words.
      if (error) return setError(error.error_description || UNRECORDED);
      setOutcome(approve ? "approved" : "denied");
    } catch {
      // A failed connection rejects rather than answering `{ error }`.
      setError(UNRECORDED);
    } finally {
      setDeciding(false);
    }
  }

  if (outcome === "approved") {
    return <Heading>Signed in. You can go back to your terminal.</Heading>;
  }
  if (outcome === "denied") return <Heading>Denied. Nothing was signed in.</Heading>;

  return (
    <section className="flex flex-col gap-4">
      <Heading>Let a tool act as you?</Heading>
      <p>
        {CLIENT_NAMES[clientId ?? ""] ?? "An unknown program"} is asking to act as you in Braivo:
        anything you can do here, it will be able to do.
      </p>
      <p>
        Code: <strong className="font-mono tracking-widest">{userCode}</strong>
      </p>
      {/* Device-code phishing works by getting someone to approve a code another
          person started; this is the one moment to catch it. */}
      <MutedText>
        Approve only if this is the code your own terminal is showing now. If someone sent you this
        link or code, deny it.
      </MutedText>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button disabled={deciding} onClick={() => decide(true)}>
          Approve
        </Button>
        <Button variant="outline" disabled={deciding} onClick={() => decide(false)}>
          Deny
        </Button>
      </div>
    </section>
  );
}
