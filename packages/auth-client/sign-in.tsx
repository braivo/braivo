// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { SignInForm, type SignInStep, type SignInValues } from "@braivo/ui";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

/**
 * A refusal as Better Auth's client answers it. `message` is the server's
 * English and never shown: a refusal is worded here, from `code` or `status`
 * (ADR 0035).
 */
type AuthError = { code?: string; status?: number; message?: string };

type AuthResult<Data = unknown> = { data?: Data | null; error: AuthError | null };

/**
 * Better Auth's per-request options: the deadline's signal, all a step sets
 * but sending a code, which adds the page's language.
 */
type Bounded = { fetchOptions?: { signal?: AbortSignal } };

/**
 * The part of a Better Auth client, with its email code plugin, that signing in
 * uses. Structural, so either app's client fits whichever plugins it was built
 * with, and so does a learn domain's, over Braivo's own routes (ADR 0018).
 */
export type SignInAuth = {
  emailOtp: {
    sendVerificationOtp(input: {
      email: string;
      type: "sign-in";
      fetchOptions: { headers: { "Accept-Language": string }; signal?: AbortSignal };
    }): Promise<AuthResult>;
  };
  signIn: {
    emailOtp(
      input: { email: string; otp: string } & Bounded,
    ): Promise<AuthResult<{ user: { name: string } }>>;
    /** Answered with Google's address, where Better Auth's client then navigates. */
    social(
      input: { provider: "google"; callbackURL: string; errorCallbackURL: string } & Bounded,
    ): Promise<AuthResult>;
  };
  updateUser(input: { name: string } & Bounded): Promise<AuthResult>;
};

/**
 * How long a step waits before saying it could not connect: school wifi can
 * stall a request with no error at all. The body counts: Better Auth's client
 * reads it under the same signal.
 */
const SIGN_IN_DEADLINE_MS = 10_000;

/** A request's options, aborting it after `SIGN_IN_DEADLINE_MS`. */
function deadline(): Bounded["fetchOptions"] {
  const controller = new AbortController();
  // A timer rather than `AbortSignal.timeout`, which test fake timers cannot advance.
  setTimeout(
    () => controller.abort(new DOMException("Braivo did not answer.", "TimeoutError")),
    SIGN_IN_DEADLINE_MS,
  );
  return { signal: controller.signal };
}

/**
 * Better Auth's refusals of a code, said so the next step is plain. Only these
 * clear the code typed. Better Auth's codes, not Braivo's: recheck them on
 * upgrading it.
 */
const CODE_REFUSALS: Partial<Record<string, MessageDescriptor>> = {
  INVALID_OTP: msg`That code is not right. Check it, or send a new one.`,
  OTP_EXPIRED: msg`That code has expired. Send a new one.`,
  TOO_MANY_ATTEMPTS: msg`That code was tried too many times. Send a new one.`,
};

/** Refusals after which the code can sign in no more, so only a new one helps. */
const SPENT = new Set(["OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]);

/**
 * The server's wait between codes to one address (`SIGN_IN_CODE` in
 * `apps/server/auth`), which the form counts down before offering another.
 * Advisory: another tab may have asked meanwhile, and the server decides.
 */
const RESEND_WAIT_MS = 60_000;

/**
 * Refusals of a send after which the form counts a whole minute down again,
 * not knowing how much of the server's is left: a send that failed spends its
 * minute too.
 */
const WAIT_AGAIN = new Set(["SIGN_IN_CODE_COOLDOWN", "SIGN_IN_CODE_SEND_FAILED"]);

/** Refusals asking only to wait, a limit rather than a fault: shown calm. */
const COOLDOWN = msg`Wait a minute before asking for a code again.`;
const RATE_LIMITED = msg`Too many tries. Wait a minute, then try again.`;
// "Requested", not "sent": the minute proves an ask, and another tab's send may have failed.
const SENT_RECENTLY = msg`A code was requested less than a minute ago. Check your email.`;
const WAITS = new Set([COOLDOWN, RATE_LIMITED, SENT_RECENTLY]);

/**
 * Why a step was refused: a code's refusal, Braivo's own (`apps/server/auth`),
 * a rate limit, which Better Auth's limiter answers with no code, or else a
 * generic line.
 */
function refusal(error: AuthError): MessageDescriptor {
  const known = CODE_REFUSALS[error.code ?? ""];
  if (known) return known;
  if (error.code === "SIGN_IN_CODE_COOLDOWN") return COOLDOWN;
  if (error.code === "SIGN_IN_CODE_SEND_FAILED") {
    return msg`The code could not be sent. Try again in a minute.`;
  }
  // A learn domain's sign-in (ADR 0018): the code is right and stays good
  // until it expires, so once added in time, the same one signs in.
  if (error.code === "NOT_A_MEMBER") {
    return msg`This email has not been added here yet. Ask to have it added, then sign in again: this code works until it expires.`;
  }
  if (error.status === 429) return RATE_LIMITED;
  return msg`That did not work. Try again.`;
}

/**
 * A request that got no answer at all, which is worth another try. No product
 * name: the learn app runs under the organization's brand, not Braivo's
 * (ADR 0004).
 */
const UNANSWERED = msg`Could not connect. Check your connection and try again.`;

/**
 * Why Google's round trip came back to `errorCallbackURL`, from its `error`.
 * `access_denied` is not only a cancel: it is also a school's administrator
 * blocking the app, which must not pass in silence.
 */
function googleRefusal(error: string | undefined): MessageDescriptor | undefined {
  if (error === undefined) return undefined;
  // Better Auth's own code for the same, on reaching an account an emailed
  // code made.
  if (error === "email_not_verified" || error === "account_not_linked") {
    return msg`Your Google account's email is not verified. Sign in with a code instead.`;
  }
  if (error === "email_changed") {
    return msg`Your Google account's email no longer matches this account. Sign in with a code to the account's email.`;
  }
  return GOOGLE_FAILED;
}

const GOOGLE_FAILED = msg`Could not sign in with Google. Try again, or sign in with a code.`;

/** Where Google sends the person back: signed in, or refused with an `error` parameter. */
type GoogleSignIn = {
  callbackURL: string;
  /** Without an `error` parameter, which Better Auth appends rather than replaces. */
  errorCallbackURL: string;
  /** The `error` parameter Google's round trip came back with, if it failed. */
  error?: string;
};

/**
 * Signing in with a code sent by email, which makes the account if there is
 * none, then naming an account that has no name yet (ADR 0018). Starts at the
 * name when `needsName` says a session is open for such an account. Reports
 * success through `onSignedIn` and leaves where to go next to the caller.
 * With `google`, offers Google too, which leaves the page and comes back to
 * its `callbackURL` signed in. `title` heads the email step, "Sign in" if
 * omitted. With `legal`, says signing in agrees to those pages.
 */
export function SignIn(props: {
  auth: SignInAuth;
  title?: string;
  needsName?: boolean;
  onSignedIn: () => void;
  google?: GoogleSignIn;
  legal?: { privacy: string; terms: string };
}) {
  const { auth, google } = props;
  const { i18n, t } = useLingui();
  const [step, setStep] = useState<SignInStep>(
    props.needsName ? { step: "name" } : { step: "email" },
  );
  const [error, setError] = useState(googleRefusal(google?.error));
  const [pending, setPending] = useState(false);
  // The address whose last send here failed: its minute then holds no code.
  const [failedFor, setFailedFor] = useState<string>();

  /** Takes one step, answering why it was refused if it was. */
  async function next(values: SignInValues): Promise<MessageDescriptor | undefined> {
    if (values.step === "email") {
      const { error } = await auth.emailOtp.sendVerificationOtp({
        email: values.email,
        type: "sign-in",
        // The mail in the page's language, which a menu may have chosen over
        // the browser's: the server reads it from this header (localization-6).
        fetchOptions: { ...deadline(), headers: { "Accept-Language": i18n.locale } },
      });
      const address = values.email.toLowerCase();
      if (error?.code === "SIGN_IN_CODE_SEND_FAILED") setFailedFor(address);
      if (error) {
        // Asked again from the code step, a refusal keeps it there, so the
        // first code can still be entered, and the countdown restarts.
        if (step.step === "code" && WAIT_AGAIN.has(error.code ?? "")) {
          setStep({ ...step, resendAt: Date.now() + RESEND_WAIT_MS });
        }
        // From the email (after Back, a reload, another tab), the minute means
        // a code was asked for, which likely still signs in, so on to it rather
        // than stuck here, unless this page saw that send fail. Says nothing
        // new: the refusal already said a code was asked for.
        if (
          step.step === "email" &&
          error.code === "SIGN_IN_CODE_COOLDOWN" &&
          failedFor !== address
        ) {
          setStep({ step: "code", email: values.email, resendAt: Date.now() + RESEND_WAIT_MS });
          return SENT_RECENTLY;
        }
        return refusal(error);
      }
      setFailedFor(undefined);
      setStep({
        step: "code",
        email: values.email,
        sent: step.step === "code" ? (step.sent ?? 1) + 1 : 1,
        resendAt: Date.now() + RESEND_WAIT_MS,
      });
    } else if (values.step === "code" && step.step === "code") {
      const { data, error } = await auth.signIn.emailOtp({
        email: step.email,
        otp: values.code,
        fetchOptions: deadline(),
      });
      // Only a refused code clears what was typed: after a rate limit, say, it
      // may still be good.
      if (CODE_REFUSALS[error?.code ?? ""]) {
        setStep({ ...step, refused: (step.refused ?? 0) + 1, spent: SPENT.has(error?.code ?? "") });
      }
      if (error) return refusal(error);
      if (data?.user.name.trim()) props.onSignedIn();
      else setStep({ step: "name" });
    } else if (values.step === "name") {
      const { error } = await auth.updateUser({ name: values.name, fetchOptions: deadline() });
      // The session ended (signed out in another tab, say): naming would be
      // refused every time, so sign in again.
      if (error?.code === "UNAUTHORIZED") {
        setStep({ step: "email" });
        return msg`You were signed out. Sign in again.`;
      }
      if (error) return refusal(error);
      props.onSignedIn();
    }
  }

  async function submit(values: SignInValues) {
    setPending(true);
    setError(undefined);
    try {
      setError(await next(values));
    } catch {
      // Refused answers arrive as `error` above; this is a request that got no
      // answer at all, or none in time. A check out of time may still have
      // signed in, spending the code: retried, it is refused; a new one works.
      setError(UNANSWERED);
    } finally {
      setPending(false);
    }
  }

  async function continueWithGoogle(google: GoogleSignIn) {
    setPending(true);
    setError(undefined);
    try {
      const { error } = await auth.signIn.social({
        provider: "google",
        callbackURL: google.callbackURL,
        errorCallbackURL: google.errorCallbackURL,
        fetchOptions: deadline(),
      });
      // Otherwise the page is leaving for Google, and stays pending until gone.
      // A refusal here is the installation's, in Better Auth's words, which
      // help no one signing in.
      if (!error) return;
      setError(GOOGLE_FAILED);
    } catch {
      setError(UNANSWERED);
    }
    setPending(false);
  }

  return (
    <SignInForm
      step={step}
      title={props.title}
      pending={pending}
      error={error && t(error)}
      wait={error && WAITS.has(error)}
      onSubmit={submit}
      onResend={
        step.step === "code" ? () => submit({ step: "email", email: step.email }) : undefined
      }
      onContinueWithGoogle={google && (() => continueWithGoogle(google))}
      legal={props.legal}
      onChangeEmail={() => {
        setError(undefined);
        setStep({ step: "email", email: step.step === "code" ? step.email : undefined });
      }}
    />
  );
}
