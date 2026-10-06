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
 * The part of a Better Auth client, with its email code plugin, that signing in
 * uses. Structural, so either app's client fits whichever plugins it was built
 * with.
 */
export type SignInAuth = {
  emailOtp: {
    sendVerificationOtp(input: { email: string; type: "sign-in" }): Promise<AuthResult>;
  };
  signIn: {
    emailOtp(input: {
      email: string;
      otp: string;
    }): Promise<AuthResult<{ user: { name: string } }>>;
    /** Answered with Google's address, where Better Auth's client then navigates. */
    social(input: {
      provider: "google";
      callbackURL: string;
      errorCallbackURL: string;
    }): Promise<AuthResult>;
  };
  updateUser(input: { name: string }): Promise<AuthResult>;
};

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

/**
 * Why a step was refused: a code's refusal, Braivo's own (`apps/server/auth`),
 * a rate limit, which Better Auth's limiter answers with no code, or else a
 * generic line.
 */
function refusal(error: AuthError): MessageDescriptor {
  const known = CODE_REFUSALS[error.code ?? ""];
  if (known) return known;
  if (error.code === "SIGN_IN_CODE_JUST_SENT") {
    return msg`A code was just sent to this address. Wait a minute before asking again.`;
  }
  if (error.status === 429) return msg`Too many tries. Wait a minute, then try again.`;
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
 * its `callbackURL` signed in.
 */
export function SignIn(props: {
  auth: SignInAuth;
  needsName?: boolean;
  onSignedIn: () => void;
  google?: GoogleSignIn;
}) {
  const { auth, google } = props;
  const { t } = useLingui();
  const [step, setStep] = useState<SignInStep>(
    props.needsName ? { step: "name" } : { step: "email" },
  );
  const [error, setError] = useState(googleRefusal(google?.error));
  const [pending, setPending] = useState(false);

  /** Takes one step, answering why it was refused if it was. */
  async function next(values: SignInValues): Promise<MessageDescriptor | undefined> {
    if (values.step === "email") {
      const { error } = await auth.emailOtp.sendVerificationOtp({
        email: values.email,
        type: "sign-in",
      });
      if (error) return refusal(error);
      // Asked again from the code step, a refusal above keeps it there, so the
      // first code can still be entered.
      setStep({
        step: "code",
        email: values.email,
        sent: step.step === "code" ? (step.sent ?? 1) + 1 : 1,
      });
    } else if (values.step === "code" && step.step === "code") {
      const { data, error } = await auth.signIn.emailOtp({ email: step.email, otp: values.code });
      // Only a refused code clears what was typed: after a rate limit, say, it
      // may still be good.
      if (CODE_REFUSALS[error?.code ?? ""]) setStep({ ...step, refused: (step.refused ?? 0) + 1 });
      if (error) return refusal(error);
      if (data?.user.name.trim()) props.onSignedIn();
      else setStep({ step: "name" });
    } else if (values.step === "name") {
      const { error } = await auth.updateUser({ name: values.name });
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
      // answer at all.
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
      pending={pending}
      error={error && t(error)}
      onSubmit={submit}
      onResend={
        step.step === "code" ? () => submit({ step: "email", email: step.email }) : undefined
      }
      onContinueWithGoogle={google && (() => continueWithGoogle(google))}
      onChangeEmail={() => {
        setError(undefined);
        setStep({ step: "email", email: step.step === "code" ? step.email : undefined });
      }}
    />
  );
}
