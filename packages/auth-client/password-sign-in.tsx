// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { Spinner } from "@braivo/ui/components/spinner";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { type SubmitEvent, useId, useState } from "react";

import { type AuthResult, type Bounded, deadline, RATE_LIMITED, UNANSWERED } from "./sign-in.tsx";

/** The part of a Better Auth client that signs in with a password. */
export type PasswordSignInAuth = {
  signIn: {
    email(
      input: { email: string; password: string } & Bounded,
    ): Promise<AuthResult<{ user: { name: string } }>>;
  };
};

/**
 * Signing in with a password the operator set, for an app directory's
 * reviewer, who cannot receive a code (ADR 0018). Nothing links to it, and it
 * offers no reset: the operator gives the password. Reports success through
 * `onSignedIn`, as `SignIn` does, leaving where to go next to the caller.
 */
export function PasswordSignIn(props: { auth: PasswordSignInAuth; onSignedIn: () => void }) {
  const { t } = useLingui();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageDescriptor>();
  // Keys the alert, so the same refusal twice is announced twice.
  const [refusals, setRefusals] = useState(0);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in a field from submitting the form.
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    let refused: MessageDescriptor;
    try {
      const { error } = await props.auth.signIn.email({
        email: form.get("email") as string,
        password: form.get("password") as string,
        fetchOptions: deadline(),
      });
      // Pending until the caller's navigation replaces the form.
      if (!error) return props.onSignedIn();
      refused =
        error.status === 429
          ? RATE_LIMITED
          : error.status === 401
            ? msg`That email and password do not match.`
            : msg`That did not work. Try again.`;
    } catch {
      refused = UNANSWERED;
    }
    setError(refused);
    setRefusals((count) => count + 1);
    setPending(false);
  }

  return (
    <form data-slot="sign-in-form" data-touch onSubmit={submit}>
      <FieldGroup>
        <Heading className="mb-0 text-4xl tracking-tight text-foreground">
          <Trans>Sign in with a password</Trans>
        </Heading>
        <Field>
          <FieldLabel htmlFor={`${id}-email`}>
            <Trans>Email address</Trans>
          </FieldLabel>
          <Input
            id={`${id}-email`}
            name="email"
            type="email"
            required
            autoFocus
            autoComplete="username"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-password`}>
            <Trans>Password</Trans>
          </FieldLabel>
          <Input
            id={`${id}-password`}
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
        </Field>
        {error && (
          <Alert key={refusals} variant="destructive">
            <AlertDescription>{t(error)}</AlertDescription>
          </Alert>
        )}
        <Field>
          {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
          <Button type="submit" aria-disabled={pending}>
            {pending && <Spinner data-icon="inline-start" aria-label={t`Loading`} />}
            <Trans>Sign in</Trans>
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
