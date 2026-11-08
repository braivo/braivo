// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { defineRequestState, runWithRequestState } from "@better-auth/core/context";
import type { Locale } from "@braivo/i18n/locales";
import { APIError } from "better-auth/api";

import type { CreateInvitationResult, InvitableRole } from "../application/index.ts";
import { NotPermitted, SignedOut } from "../application/permission.ts";
import type { Auth } from "./auth.ts";

/**
 * Whether `sendInvitationEmail` sent the mail, which Better Auth's answer
 * omits (ADR 0018), as for a sign-in code (ADR 0033); `locale`, the inviter's,
 * goes the other way. Per request; holds while the send is awaited, that is
 * while `advanced.backgroundTasks` is unset.
 */
export const invitationDelivery = defineRequestState(() => ({
  locale: "en" as Locale,
  sent: true,
}));

/** Better Auth's refusal of a learner's invitation while the organization has no learn domain. */
export const NO_LEARN_DOMAIN = "NO_LEARN_DOMAIN";

/** Better Auth's refusal of a member or an invitation to a personal organization (ADR 0060). */
export const PERSONAL_ORGANIZATION = "PERSONAL_ORGANIZATION";

/**
 * Makes an invitation through Better Auth as the session in `headers`, which
 * runs its hooks (`beforeCreateInvitation`) and mails it. Its own HTTP
 * endpoint stays closed (ADR 0018): its `resend` skips that hook.
 */
export async function createInvitation(
  auth: Auth,
  input: {
    headers: Headers;
    organizationId: string;
    email: string;
    role: InvitableRole;
    locale: Locale;
  },
): Promise<CreateInvitationResult> {
  const { headers, organizationId, email, role, locale } = input;
  // A store of this call's own, which the endpoint then reuses rather than
  // starting one the route could not read.
  return runWithRequestState(new WeakMap(), async () => {
    await invitationDelivery.set({ locale, sent: true });
    try {
      const made = await auth.api.createInvitation({
        headers,
        body: { organizationId, email, role },
      });
      const delivery = await invitationDelivery.get();
      return {
        invitation: { id: made.id, email: made.email, role: made.role, expiresAt: made.expiresAt },
        emailSent: delivery.sent,
      };
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      const code = error.body?.code;
      if (code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION") return "already a member";
      if (code === "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION") return "already invited";
      if (code === "INVITATION_LIMIT_REACHED") return "pending limit";
      if (code === NO_LEARN_DOMAIN) return "no learn domain";
      // The session ended, or the actor stopped administering or was
      // removed, since Braivo's route checked: refused as that check refuses.
      if (error.statusCode === 401) throw new SignedOut("The session ended.");
      if (error.statusCode === 403 || code === "MEMBER_NOT_FOUND") {
        throw new NotPermitted("May not invite to this organization.");
      }
      throw error;
    }
  });
}
