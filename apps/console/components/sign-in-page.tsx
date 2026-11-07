// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { ModeToggle, SignInPage } from "@braivo/ui";
import { Separator } from "@braivo/ui/components/separator";
import { Trans } from "@lingui/react/macro";
import { MailIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { BraivoLogo } from "./braivo-logo.tsx";
import { LanguageMenu } from "./language-menu.tsx";

/**
 * `/login`'s frame, `@braivo/ui`'s `SignInPage`, with the console's language and theme
 * menus beside `brand`.
 */
export function ConsoleSignInPage(props: Omit<ComponentProps<typeof SignInPage>, "controls">) {
  return (
    <SignInPage
      {...props}
      controls={
        <>
          <LanguageMenu />
          <ModeToggle />
        </>
      }
    />
  );
}

/**
 * Braivo above `/login`'s form, at every width. No app's name: the page is for
 * anyone who teaches or learns.
 */
export function SignInBrand() {
  return <BraivoLogo className="text-2xl sm:text-3xl" />;
}

/**
 * The console's name above an invitation's page: Braivo's logo on a phone,
 * the app's name from `lg`. "Braivo Console" in every language (localization-2).
 */
export function ConsoleBrand() {
  return (
    <>
      <BraivoLogo className="text-2xl sm:text-3xl lg:hidden" />
      <span className="hidden items-center gap-2 text-xs font-medium tracking-widest text-muted-foreground uppercase lg:flex">
        <span className="size-1.5 rounded-full bg-ring" />
        Braivo Console
      </span>
    </>
  );
}

/**
 * Below the form, for someone signing in to accept an invitation: here, not
 * on a course's website, is where they join.
 */
export function InvitationNote() {
  return (
    <>
      <Separator className="my-6" />
      <p className="flex gap-3 text-sm text-muted-foreground">
        <MailIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          <Trans>Sign in with the email address the invitation was sent to, then accept it.</Trans>
        </span>
      </p>
    </>
  );
}
