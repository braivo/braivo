// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { Alert, AlertDescription } from "#components/alert";
import { Button } from "#components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "#components/field";
import { Input } from "#components/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "#components/input-otp";
import { Spinner } from "#components/spinner";

/** Where signing in is: asking for a code, entering it, or naming a new account. */
export type SignInStep =
  | { step: "email"; email?: string }
  /** `sent`: codes sent to `email` so far, 1 if omitted. */
  | { step: "code"; email: string; sent?: number }
  | { step: "name" };

export type SignInValues =
  | { step: "email"; email: string }
  | { step: "code"; code: string }
  | { step: "name"; name: string };

const CODE_DIGITS = 6;

/**
 * Signing in with a code sent by email, then, for a new account, a name.
 * Presentation only: the caller sends and checks codes, and moves between
 * steps; `pending` and `error` describe its request, and while `pending` the
 * form calls none of its callbacks. From the code, `onResend` asks for
 * another and `onChangeEmail` goes back to the email.
 */
export function SignInForm(props: {
  step: SignInStep;
  pending?: boolean;
  error?: string;
  onSubmit: (values: SignInValues) => void;
  onResend?: () => void;
  onChangeEmail?: () => void;
}) {
  const { step } = props;
  const id = useId();
  // A refused or superseded code is cleared and focused by remounting its
  // input, so the next is typed into empty slots, not past a full set.
  const [refusal, setRefusal] = useState(props.error);
  const [codeAttempt, setCodeAttempt] = useState(0);
  if (props.error !== refusal) {
    setRefusal(props.error);
    if (props.error) setCodeAttempt(codeAttempt + 1);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in a field from submitting the form.
    if (props.pending) return;
    // Every field here is a text input, and a text input's value is a string.
    const value = (name: string) => new FormData(event.currentTarget).get(name) as string;
    if (step.step === "email") props.onSubmit({ step: "email", email: value("email") });
    else if (step.step === "code") props.onSubmit({ step: "code", code: value("code") });
    else {
      // Spaces alone satisfy `required` but trim to no name, which would only
      // send the account back here. Checked here, not as typed, so a value
      // the browser filled in without an event is caught too.
      const name = value("name").trim();
      if (name) return props.onSubmit({ step: "name", name });
      const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
      input.setCustomValidity("Enter your name.");
      input.reportValidity();
    }
  }

  let field: ReactNode;
  let action: string;
  if (step.step === "email") {
    action = "Send code";
    field = (
      <Field>
        <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          defaultValue={step.email}
        />
      </Field>
    );
  } else if (step.step === "code") {
    action = "Sign in";
    field = (
      <Field>
        <FieldLabel htmlFor={`${id}-code`}>Code</FieldLabel>
        <InputOTP
          key={`${step.sent ?? 1}-${codeAttempt}`}
          id={`${id}-code`}
          name="code"
          // `pattern` filters each keystroke, so a short code is caught by
          // `minLength`, before it spends one of the code's guesses.
          maxLength={CODE_DIGITS}
          minLength={CODE_DIGITS}
          pattern={REGEXP_ONLY_DIGITS}
          required
          autoFocus
          autoComplete="one-time-code"
          aria-describedby={`${id}-sent`}
        >
          <InputOTPGroup>
            {Array.from({ length: CODE_DIGITS }, (_, index) => (
              <InputOTPSlot key={index} index={index} />
            ))}
          </InputOTPGroup>
        </InputOTP>
        {/* A status, so a new code's arrival is announced. */}
        <FieldDescription id={`${id}-sent`} role="status" className="wrap-break-word">
          {(step.sent ?? 1) > 1 ? "A new code was sent" : "Sent"} to {step.email}. Check your spam
          folder too.
        </FieldDescription>
      </Field>
    );
  } else {
    action = "Continue";
    field = (
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Your name</FieldLabel>
        <Input
          id={`${id}-name`}
          name="name"
          required
          autoFocus
          autoComplete="name"
          // A blank name `submit` refused stays refused until edited.
          onChange={(event) => event.currentTarget.setCustomValidity("")}
        />
        <FieldDescription>How others in your organizations see you.</FieldDescription>
      </Field>
    );
  }

  return (
    // Keyed by step, so each starts empty rather than keeping the last one's input.
    <form key={step.step} onSubmit={submit}>
      <FieldGroup>
        {field}
        {/* The whole request was refused, not one field, so this is a callout. */}
        {props.error && (
          <Alert variant="destructive">
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
        )}
        {/* aria-disabled, not disabled, so that they keep the focus meanwhile. */}
        <Field>
          <Button type="submit" aria-disabled={props.pending}>
            {props.pending && <Spinner data-icon="inline-start" />}
            {action}
          </Button>
          {/* Not while a code is checked: its answer would sign in the address left behind. */}
          {step.step === "code" && (
            <div className="flex flex-wrap justify-center gap-x-4">
              {props.onResend && (
                <Button
                  type="button"
                  variant="link"
                  aria-disabled={props.pending}
                  onClick={() => !props.pending && props.onResend?.()}
                >
                  Send a new code
                </Button>
              )}
              {props.onChangeEmail && (
                <Button
                  type="button"
                  variant="link"
                  aria-disabled={props.pending}
                  onClick={() => !props.pending && props.onChangeEmail?.()}
                >
                  Use another email
                </Button>
              )}
            </div>
          )}
        </Field>
      </FieldGroup>
    </form>
  );
}
