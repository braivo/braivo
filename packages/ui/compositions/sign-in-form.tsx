// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { type ComponentProps, type FormEvent, type ReactNode, useId, useState } from "react";

import { Alert, AlertDescription } from "#components/alert";
import { Button } from "#components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "#components/field";
import { Input } from "#components/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "#components/input-otp";
import { Spinner } from "#components/spinner";

/** Where signing in is: asking for a code, entering it, or naming a new account. */
export type SignInStep =
  | { step: "email"; email?: string }
  /**
   * `sent`: codes sent to `email` so far, 1 if omitted; `refused`: refusals
   * of the code typed since the last was sent, 0 if omitted. A change in
   * either clears the code typed.
   */
  | { step: "code"; email: string; sent?: number; refused?: number }
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
 * another and `onChangeEmail` goes back to the email. With
 * `onContinueWithGoogle`, the email step offers Google first.
 */
export function SignInForm(props: {
  step: SignInStep;
  pending?: boolean;
  error?: string;
  onSubmit: (values: SignInValues) => void;
  onResend?: () => void;
  onChangeEmail?: () => void;
  onContinueWithGoogle?: () => void;
}) {
  const { step } = props;
  const id = useId();
  // Which button the pending request is from, to show its spinner there.
  const [viaGoogle, setViaGoogle] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in a field from submitting the form.
    if (props.pending) return;
    setViaGoogle(false);
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
          // A refused or superseded code is cleared and focused by remounting
          // its input, so the next is typed into empty slots, not past a full
          // set. Only then: after any other error the code may still be good.
          key={`${step.sent ?? 1}-${step.refused ?? 0}`}
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
          aria-describedby={`${id}-name-hint`}
          // A blank name `submit` refused stays refused until edited.
          onChange={(event) => event.currentTarget.setCustomValidity("")}
        />
        <FieldDescription id={`${id}-name-hint`}>
          How others in your organizations see you.
        </FieldDescription>
      </Field>
    );
  }

  return (
    // Keyed by step, so each starts empty rather than keeping the last one's input.
    <form key={step.step} onSubmit={submit}>
      <FieldGroup>
        {step.step === "email" && props.onContinueWithGoogle && (
          <>
            <Field>
              <Button
                type="button"
                variant="outline"
                aria-disabled={props.pending}
                onClick={() => {
                  if (props.pending) return;
                  setViaGoogle(true);
                  props.onContinueWithGoogle?.();
                }}
              >
                {props.pending && viaGoogle ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <GoogleMark data-icon="inline-start" />
                )}
                Continue with Google
              </Button>
            </Field>
            <FieldSeparator>or</FieldSeparator>
          </>
        )}
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
            {props.pending && !viaGoogle && <Spinner data-icon="inline-start" />}
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

/** Google's "G", in its own colours, as Google's sign-in branding asks. */
function GoogleMark(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.02c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.94 11.94 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}
