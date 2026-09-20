// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { SignInForm, type SignInValues } from "@braivo/ui";
import { useState } from "react";

/**
 * The part of a Better Auth client signing in uses. Structural, so either app's
 * client fits whichever plugins it was built with.
 */
export type EmailAuth = {
  signIn: {
    email(input: { email: string; password: string }): Promise<AuthResult>;
  };
  signUp: {
    email(input: { email: string; password: string; name: string }): Promise<AuthResult>;
  };
};

type AuthResult = { error: { message?: string } | null };

/**
 * Signing in, or creating an account, with an email and password. Reports
 * success through `onSignedIn` and leaves where to go next to the caller.
 */
export function EmailSignIn(props: { auth: EmailAuth; onSignedIn: () => void }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(values: SignInValues) {
    setPending(true);
    setError(undefined);
    try {
      const { error } =
        values.mode === "sign-in"
          ? await props.auth.signIn.email({ email: values.email, password: values.password })
          : await props.auth.signUp.email({
              email: values.email,
              password: values.password,
              name: values.name,
            });

      if (error) setError(error.message ?? "That did not work. Try again.");
      else props.onSignedIn();
    } catch {
      // Refused answers arrive as `error` above; this is a request that got no
      // answer at all, which is worth another try.
      setError("Could not reach Braivo. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return <SignInForm pending={pending} error={error} onSubmit={submit} />;
}
