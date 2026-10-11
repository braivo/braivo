// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { Spinner } from "@braivo/ui/components/spinner";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { pageHead } from "#lib/title";

/** The signed-in account, the same in every organization: its name, and the email it signs in with. */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/account")({
  head: (head) => pageHead(head, t`Profile`),
  component: Account,
});

/** The last save's outcome; a failure's count keys its alert, so a repeat is announced too. */
type Outcome = { saved: true } | { saved: false; count: number };

function Account() {
  const { auth, user } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useLingui();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in the field from submitting the form.
    if (pending) return;
    const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
    const name = input.value.trim();
    if (!name) {
      input.setCustomValidity(t`Enter your name.`);
      input.reportValidity();
      return;
    }

    setPending(true);
    // Better Auth answers a refusal as `error`, and throws when unreachable or out of time.
    const { error } = await auth
      .updateUser({ name, fetchOptions: { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) } })
      .catch(() => ({ error: { status: 0 } }));
    setPending(false);
    if (error) {
      // Signed out meanwhile (in another tab, say): the session check sends
      // them to sign in, and back here.
      if (error.status === 401) return router.invalidate();
      setOutcome((last) => ({ saved: false, count: last?.saved === false ? last.count + 1 : 1 }));
      return;
    }
    input.value = name;
    setOutcome({ saved: true });
    // Reads the account again, so every page shows the new name.
    await router.invalidate();
  }

  return (
    <>
      <Heading>
        <Trans>Profile</Trans>
      </Heading>
      <form onSubmit={save}>
        <FieldSet>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>
                <Trans>Your name</Trans>
              </FieldLabel>
              <Input
                id={`${id}-name`}
                name="name"
                defaultValue={user.name}
                // Held while saving, so the name saved is the one shown.
                readOnly={pending}
                required
                autoComplete="name"
                aria-describedby={`${id}-name-hint`}
                onChange={(event) => {
                  event.currentTarget.setCustomValidity("");
                  setOutcome(undefined);
                }}
              />
              <FieldDescription id={`${id}-name-hint`}>
                <Trans>Shown to the people you work with, in every organization.</Trans>
              </FieldDescription>
            </Field>
            <Field>
              <FieldTitle>
                <Trans>Email address</Trans>
              </FieldTitle>
              <p className="wrap-anywhere">{user.email}</p>
              <FieldDescription>
                <Trans>You sign in with it. It cannot be changed yet.</Trans>
              </FieldDescription>
            </Field>
          </FieldGroup>
        </FieldSet>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button type="submit" aria-disabled={pending}>
            {pending ? (
              <>
                {/* Hidden: "Saving…" already says it. */}
                <Spinner data-icon="inline-start" aria-hidden="true" />
                <Trans>Saving…</Trans>
              </>
            ) : (
              <Trans>Save</Trans>
            )}
          </Button>
          {/* Mounted before it says anything: a status region shown already
              filled is not reliably announced. */}
          <p role="status" className="text-sm text-muted-foreground">
            {outcome?.saved && <Trans>Saved.</Trans>}
          </p>
        </div>
        {outcome?.saved === false && (
          <Alert key={outcome.count} variant="destructive" className="mt-4">
            <CircleAlertIcon />
            <AlertDescription>
              <Trans>Could not save your name. Try again.</Trans>
            </AlertDescription>
          </Alert>
        )}
      </form>
    </>
  );
}
