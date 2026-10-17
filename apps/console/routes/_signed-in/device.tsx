// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { Spinner } from "@braivo/ui/components/spinner";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { type SubmitEvent, useId, useLayoutEffect, useRef, useState } from "react";

import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

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
    // Better Auth refuses an unknown or expired code with 400 alone. Any other
    // error says nothing about the code, so the page fails, and Try again
    // looks it up again rather than sending the owner back to the terminal.
    if (error?.status === 400) return { request: "unknown" as const };
    if (error) throw new Error(`Braivo answered ${error.status}.`);
    return { request: data };
  },
  component: Device,
});

/** What the approval asks about, by the client ID Braivo lets use the device flow. */
const CLIENT_NAMES: Record<string, string> = {
  "braivo-cli": "Braivo's command-line tool, or an AI agent using it",
};

function Device() {
  const { request } = Route.useLoaderData();
  const { user_code } = Route.useSearch();

  if (request === undefined) return <EnterCode />;
  if (request === "unknown") return <EnterCode refusedCode={user_code} />;
  if (request.status !== "pending") {
    return <Heading>This code was already {request.status}.</Heading>;
  }
  // Keyed, so neither state nor a late answer from one code can reach another.
  return (
    <Review key={request.user_code} userCode={request.user_code} clientId={request.client_id} />
  );
}

/** For a code typed from the terminal, when the link was not followed. */
function EnterCode({ refusedCode }: { refusedCode?: string }) {
  const navigate = useNavigate({ from: Route.fullPath });
  const id = useId();

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    // Trimmed here, not as typed, so a value the browser restored is caught too.
    const input = event.currentTarget.elements.namedItem("code") as HTMLInputElement;
    const code = input.value.trim();
    if (code) return void navigate({ search: { user_code: code } });
    input.setCustomValidity("Enter the code.");
    input.reportValidity();
  }

  return (
    <>
      <Heading>Sign in a tool</Heading>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-code`}>Code shown in your terminal</FieldLabel>
            <Input
              id={`${id}-code`}
              name="code"
              required
              autoComplete="off"
              // A custom validity persists until cleared: clear it once the code is edited.
              onChange={(event) => event.currentTarget.setCustomValidity("")}
            />
          </Field>
          {/* Remounted for each code refused, so assistive tech can announce it. */}
          {refusedCode && (
            <Alert key={refusedCode} variant="destructive">
              <AlertDescription>
                That code is not valid, or has expired. Start again in your terminal.
              </AlertDescription>
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

/** A signal for one request, aborted at the console's deadline. */
const deadline = () => withDeadline(undefined, REQUEST_DEADLINE_MS);

function Review({ userCode, clientId }: { userCode: string; clientId?: string | null }) {
  const { auth } = Route.useRouteContext();
  const router = useRouter();
  const [outcome, setOutcome] = useState<"approved" | "denied">();
  // The decision being sent, which its button names.
  const [deciding, setDeciding] = useState<"approve" | "deny">();
  const [error, setError] = useState<string>();
  // The outcome replaces the buttons, so focus moves to it.
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (outcome) heading.current?.focus();
  }, [outcome]);

  async function decide(approve: boolean) {
    // One decision at a time: Better Auth checks the code is pending, then
    // updates it, so an Approve and a Deny in flight together could both
    // succeed, and this page would report whichever answered last.
    if (deciding) return;
    setDeciding(approve ? "approve" : "deny");
    setError(undefined);
    try {
      const { error } = approve
        ? await auth.device.approve({ userCode, fetchOptions: { signal: deadline() } })
        : await auth.device.deny({ userCode, fetchOptions: { signal: deadline() } });
      // Signed out meanwhile (in another tab, say): the session check sends
      // them to sign in, and back to this code.
      if (error?.status === 401) return await router.invalidate();
      if (error) {
        // Answered already, as by a try given up here that reached Braivo
        // late: the code says how.
        const reread = await auth
          .device({ query: { user_code: userCode }, fetchOptions: { signal: deadline() } })
          .catch(() => ({ data: null }));
        const status = reread.data?.status;
        if (status === "approved" || status === "denied") return setOutcome(status);
        // The device flow's errors are OAuth's shape, `error_description` for words.
        return setError(error.error_description || UNRECORDED);
      }
      setOutcome(approve ? "approved" : "denied");
    } catch {
      // Unreachable or out of time, it rejects rather than answering `{ error }`.
      setError(UNRECORDED);
    } finally {
      setDeciding(undefined);
    }
  }

  if (outcome) {
    return (
      <Heading ref={heading} tabIndex={-1}>
        {outcome === "approved"
          ? "Signed in. You can go back to your terminal."
          : "Denied. Nothing was signed in."}
      </Heading>
    );
  }

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
      {/* aria-disabled, not disabled, so that they keep the focus meanwhile. */}
      <div className="flex gap-2">
        <Button aria-disabled={deciding !== undefined} onClick={() => decide(true)}>
          {deciding === "approve" ? (
            <>
              {/* Hidden: "Approving…" already says it. */}
              <Spinner data-icon="inline-start" aria-hidden="true" />
              Approving…
            </>
          ) : (
            "Approve"
          )}
        </Button>
        <Button
          variant="outline"
          aria-disabled={deciding !== undefined}
          onClick={() => decide(false)}
        >
          {deciding === "deny" ? (
            <>
              <Spinner data-icon="inline-start" aria-hidden="true" />
              Denying…
            </>
          ) : (
            "Deny"
          )}
        </Button>
      </div>
    </section>
  );
}
