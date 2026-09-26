// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type FormEvent, type ReactNode, useId } from "react";

import { Alert, AlertDescription } from "#components/alert";
import { Button } from "#components/button";
import { Field, FieldGroup, FieldLabel } from "#components/field";
import { Input } from "#components/input";
import { Spinner } from "#components/spinner";

export type SignInValues =
  | { mode: "sign-in"; email: string; password: string }
  | { mode: "sign-up"; email: string; password: string; name: string };

/**
 * Email and password, for signing in or creating an account. Presentation
 * only: what a submission does is the caller's, and so are `pending` and
 * `error`, which describe the caller's request, and `mode`, which an app keeps
 * in its URL. `switchMode` is the caller's way to the other mode, usually a
 * link, since only the app knows its routes.
 */
export function SignInForm(props: {
  mode: SignInValues["mode"];
  switchMode?: ReactNode;
  pending?: boolean;
  error?: string;
  onSubmit: (values: SignInValues) => void;
}) {
  const { mode } = props;
  const id = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    // Every field here is a text input, and a text input's value is a string.
    const field = (name: string) => form.get(name) as string;
    const credentials = { email: field("email"), password: field("password") };

    props.onSubmit(
      mode === "sign-in" ? { mode, ...credentials } : { mode, ...credentials, name: field("name") },
    );
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        {mode === "sign-up" && (
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} name="name" required autoComplete="name" />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
          <Input id={`${id}-email`} name="email" type="email" required autoComplete="email" />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
          <Input
            id={`${id}-password`}
            name="password"
            type="password"
            required
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          />
        </Field>
        {/* The whole request was refused, not one field, so this is a callout. */}
        {props.error && (
          <Alert variant="destructive">
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
        )}
        <Field>
          <Button type="submit" disabled={props.pending}>
            {props.pending && <Spinner data-icon="inline-start" />}
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </Button>
          {props.switchMode}
        </Field>
      </FieldGroup>
    </form>
  );
}
