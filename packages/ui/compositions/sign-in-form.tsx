// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Trans, useLingui } from "@lingui/react/macro";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowLeftIcon, ArrowRightIcon, CircleAlertIcon, ClockIcon, LockIcon } from "lucide-react";
import {
  type ComponentProps,
  type SubmitEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Alert, AlertDescription } from "#components/alert";
import { Button } from "#components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "#components/field";
import { Input } from "#components/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "#components/input-otp";
import { Spinner } from "#components/spinner";
import { cn } from "#lib/utils";

import { Heading } from "./heading.tsx";

/** Where signing in is: asking for a code, entering it, or naming a new account. */
export type SignInStep =
  | { step: "email"; email?: string }
  /**
   * `sent`: codes sent to `email` so far, 1 if omitted; `refused`: refusals
   * of the code typed since the last was sent, 0 if omitted. A change in
   * either clears the code typed. `resendAt`: when another code may be asked
   * for, in epoch milliseconds; until then "Send a new code" counts down.
   * `spent`: the code can sign in no more (expired, or out of guesses), so a
   * new one is the way on.
   */
  | {
      step: "code";
      email: string;
      sent?: number;
      refused?: number;
      resendAt?: number;
      spent?: boolean;
    }
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
 * form calls none of its callbacks. `wait` marks `error` as asking only to
 * wait (a limit, not a fault), shown calm rather than as an error. Each step
 * opens with its own heading, the email step's `title` if given. From the
 * code, `onResend` asks for another and `onChangeEmail` goes back to the
 * email. With `onContinueWithGoogle`, the email step offers Google first. With `legal`,
 * the email step says signing in agrees to those pages. A code is submitted
 * as soon as its last digit is typed or pasted.
 */
export function SignInForm(props: {
  step: SignInStep;
  title?: string;
  pending?: boolean;
  error?: string;
  wait?: boolean;
  onSubmit: (values: SignInValues) => void;
  onResend?: () => void;
  onChangeEmail?: () => void;
  onContinueWithGoogle?: () => void;
  /** The privacy policy's and terms' URLs. */
  legal?: { privacy: string; terms: string };
}) {
  const { step } = props;
  const { t } = useLingui();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  // Which button the pending request is from, to show its spinner there.
  const [viaGoogle, setViaGoogle] = useState(false);
  const resendAt = step.step === "code" ? step.resendAt : undefined;
  const wait = useSecondsUntil(resendAt);
  const spent = step.step === "code" && step.spent;
  // Resending waits for the request in flight, and for the server's minute.
  const busy = props.pending || wait > 0;

  /** Asks for another code, unless a request is pending or the server's minute is not up. */
  function resend() {
    // The clock, not `wait`, which lags it by up to a tick.
    if (props.pending || (resendAt ?? 0) > Date.now()) return;
    setViaGoogle(false);
    props.onResend?.();
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in a field from submitting the form.
    if (props.pending) return;
    // Its main button resends then, which Enter presses too.
    if (spent) return resend();
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
      input.setCustomValidity(t`Enter your name.`);
      input.reportValidity();
    }
  }

  let heading: string;
  let intro: ReactNode;
  let field: ReactNode;
  let action: string;
  if (step.step === "email") {
    heading = props.title ?? t`Sign in`;
    action = t`Send me a code`;
    // No sign-up to look for: signing in makes the account. Only that, as the
    // buttons and the note under them say how.
    intro = (
      <p id={`${id}-email-hint`}>
        <Trans>First time here? Signing in creates your account.</Trans>
      </p>
    );
    field = (
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
          autoComplete="email"
          defaultValue={step.email}
          aria-describedby={`${id}-email-hint`}
          // In the page's language, not the browser's, which a menu may differ
          // from; until edited, as the name's below.
          onInvalid={(event) => {
            const input = event.currentTarget;
            if (!input.validity.customError) {
              input.setCustomValidity(t`Enter your email address, such as name@example.com.`);
            }
          }}
          onChange={(event) => event.currentTarget.setCustomValidity("")}
        />
      </Field>
    );
  } else if (step.step === "code") {
    const { email } = step;
    const address = <strong className="font-medium text-foreground">{email}</strong>;
    heading = t`Check your email`;
    action = t`Sign in`;
    // A status, so a new code's arrival is announced.
    intro = (
      <p id={`${id}-sent`} role="status" className="wrap-break-word">
        {/* Ten minutes and once: access-1. */}
        {(step.sent ?? 1) > 1 ? (
          <Trans>
            A new code was sent to {address}. Use the newest one; it expires in 10 minutes.
          </Trans>
        ) : (
          <Trans>
            Enter the six-digit code sent to {address}. It expires in 10 minutes and works once.
          </Trans>
        )}
      </p>
    );
    field = (
      <Field data-disabled={spent || undefined}>
        <FieldLabel htmlFor={`${id}-code`}>
          <Trans context="The sign-in code sent by email">Code</Trans>
        </FieldLabel>
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
          // A code copied as "071 036" or "071-036", or with a line's end, is
          // still the code; `pattern` would refuse the whole paste in silence.
          pasteTransformer={(pasted) => pasted.replace(/[\s-]/g, "")}
          required
          autoFocus
          // Unusable, so neither typed into nor checked: the button resends.
          disabled={spent}
          autoComplete="one-time-code"
          // As if Sign in were pressed, so its checks apply: nothing while
          // pending. Only on becoming whole, so a code left whole after an
          // error is not resent until the person edits or presses Sign in.
          onComplete={() => form.current?.requestSubmit()}
          aria-describedby={`${id}-sent ${id}-auto`}
          containerClassName="w-full"
        >
          {/* Six boxes apart, sharing the column, so they fit a 320px screen. */}
          <InputOTPGroup className="w-full gap-2 *:data-[slot=input-otp-slot]:h-14 *:data-[slot=input-otp-slot]:max-w-14 *:data-[slot=input-otp-slot]:flex-1 *:data-[slot=input-otp-slot]:rounded-md *:data-[slot=input-otp-slot]:border *:data-[slot=input-otp-slot]:text-2xl *:data-[slot=input-otp-slot]:tabular-nums">
            {Array.from({ length: CODE_DIGITS }, (_, index) => (
              <InputOTPSlot key={index} index={index} />
            ))}
          </InputOTPGroup>
        </InputOTP>
        {/* Said before typing, as the last digit changes the page (WCAG 3.2.2). */}
        <FieldDescription id={`${id}-auto`}>
          <Trans>You'll be signed in once all six digits are entered.</Trans>
        </FieldDescription>
      </Field>
    );
  } else {
    heading = t`What should we call you?`;
    action = t`Continue`;
    field = (
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>
          <Trans>Your name</Trans>
        </FieldLabel>
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
          <Trans>How others in your organizations see you.</Trans>
        </FieldDescription>
      </Field>
    );
  }

  return (
    // Keyed by step, so each starts empty rather than keeping the last one's input.
    // `data-touch` sizes its controls for touch (`globals.css`).
    <form ref={form} key={step.step} data-slot="sign-in-form" data-touch onSubmit={submit}>
      <FieldGroup>
        <div className="flex flex-col gap-3 text-sm text-muted-foreground">
          {/* Where the person is: asking for a code, then past it. */}
          <div aria-hidden="true" className="mb-3 flex gap-2">
            <span className="h-1 w-6 rounded-full bg-ring" />
            <span
              className={cn(
                "h-1 w-6 rounded-full",
                step.step === "email" ? "bg-border" : "bg-ring",
              )}
            />
          </div>
          <Heading className="mb-0 text-4xl tracking-tight text-foreground">{heading}</Heading>
          {intro}
        </div>
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
                  <Spinner data-icon="inline-start" aria-label={t`Loading`} />
                ) : (
                  <GoogleMark data-icon="inline-start" />
                )}
                <Trans>Continue with Google</Trans>
              </Button>
            </Field>
            <FieldSeparator>
              {/* Just "or": the button above and the field below say what the two ways are. */}
              <Trans context="Between two ways to sign in">or</Trans>
            </FieldSeparator>
          </>
        )}
        {field}
        {/* The whole request was refused, not one field, so this is a callout.
            An alert even when it asks only to wait: it answers the press, and
            a status region mounted with its text may go unannounced. */}
        {props.error && (
          <Alert variant={props.wait ? "default" : "destructive"}>
            {props.wait ? <ClockIcon /> : <CircleAlertIcon />}
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
        )}
        {/* aria-disabled, not disabled, so that they keep the focus meanwhile. */}
        <Field>
          {spent ? (
            // Keyed, so it mounts afresh and takes the focus from the slots
            // just disabled; a new code's slots take it back.
            <Button
              key="resend"
              type="button"
              autoFocus
              aria-disabled={busy}
              aria-describedby={wait > 0 ? `${id}-wait` : undefined}
              onClick={resend}
            >
              {props.pending && <Spinner data-icon="inline-start" aria-label={t`Loading`} />}
              <Trans>Send a new code</Trans>
              <Countdown seconds={wait} />
            </Button>
          ) : (
            <Button type="submit" aria-disabled={props.pending}>
              {props.pending && !viaGoogle && (
                <Spinner data-icon="inline-start" aria-label={t`Loading`} />
              )}
              {action}
              {/* Onward, to the code: the one step that leaves to the inbox. */}
              {step.step === "email" && !props.pending && <ArrowRightIcon data-icon="inline-end" />}
            </Button>
          )}
          {step.step === "email" && (
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <LockIcon className="size-3" aria-hidden="true" />
              <Trans>No password to remember.</Trans>
            </p>
          )}
          {/* Where either way in is taken, since either may make the account. In
              a new tab, so the email typed is kept. */}
          {step.step === "email" && props.legal && (
            <p className="mt-3 text-center text-xs text-balance text-muted-foreground">
              <Trans>
                By continuing, you agree to the{" "}
                <LegalLink href={props.legal.terms}>Terms</LegalLink> and{" "}
                <LegalLink href={props.legal.privacy}>Privacy Policy</LegalLink>.
              </Trans>
            </p>
          )}
          {/* Not while a code is checked: its answer would sign in the address left behind. */}
          {step.step === "code" && (
            <div className="flex flex-col items-center gap-1 text-center text-sm text-muted-foreground">
              <p className="mt-2">
                <Trans>No code? Check your spam folder.</Trans>
              </p>
              {/* Why resending is locked, unchanging, where the ticking countdown is
                hidden. Here, not in `Field`, which widens an `sr-only` child. */}
              {wait > 0 && (
                <span id={`${id}-wait`} className="sr-only">
                  <Trans>Another code can be sent a minute after the last.</Trans>
                </span>
              )}
              {props.onResend && !spent && (
                <Button
                  type="button"
                  variant="link"
                  aria-disabled={busy}
                  aria-describedby={wait > 0 ? `${id}-wait` : undefined}
                  onClick={resend}
                >
                  <Trans>Send a new code</Trans>
                  <Countdown seconds={wait} />
                </Button>
              )}
              {props.onChangeEmail && (
                <Button
                  type="button"
                  variant="link"
                  aria-disabled={props.pending}
                  onClick={() => !props.pending && props.onChangeEmail?.()}
                  className="text-muted-foreground"
                >
                  <ArrowLeftIcon data-icon="inline-start" />
                  {props.onContinueWithGoogle ? (
                    <Trans>Back to sign-in options</Trans>
                  ) : (
                    <Trans>Use another email</Trans>
                  )}
                </Button>
              )}
            </div>
          )}
        </Field>
      </FieldGroup>
    </form>
  );
}

/**
 * Whole seconds until `at`, ticking each second meanwhile; 0 without `at`.
 * Read from the clock, not counted down, so a tab in the background, whose
 * timers slow, shows the true wait on its return.
 */
function useSecondsUntil(at: number | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= at) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [at]);
  return at === undefined ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The wait before another code, as " in 0:42", seen but not read out: the
 * button's name stays put, its `aria-disabled` says it cannot be pressed yet,
 * and its description says why. Never in a live region, which would announce
 * every tick; nor is the wait's end announced, which would interrupt whoever
 * is typing the code that arrived meanwhile.
 */
function Countdown({ seconds }: { seconds: number }) {
  if (seconds <= 0) return null;
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <span aria-hidden="true" className="tabular-nums">
      <Trans context="The wait before another sign-in code, as in: Send a new code in 0:42">
        in {time}
      </Trans>
    </span>
  );
}

function LegalLink(props: { href: string; children?: ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-foreground"
    >
      {props.children}
    </a>
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
