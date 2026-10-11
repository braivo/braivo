// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError } from "@braivo/server/client";
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

/** The server's limit on an organization's name, as setup's. */
const MAX_NAME_LENGTH = 100;

/**
 * The organization's own settings: its name, which learners see on its learn
 * domain, and its console address, which cannot change yet (ADR 0004).
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/general")({
  head: (head) => pageHead(head, t`General`),
  // A page per organization: switching carries over nothing typed or saving.
  remountDeps: ({ params }) => params.organizationSlug,
  component: General,
});

/** The last save's outcome; a failure's count keys its alert, so a repeat is announced too. */
type Outcome = { saved: true } | { saved: false; message: string; count: number };

function General() {
  const { organization, braivo } = Route.useRouteContext();
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
      input.setCustomValidity(t`Enter your organization's name.`);
      input.reportValidity();
      return;
    }

    setPending(true);
    let renamed: { name: string };
    try {
      renamed = await braivo.renameOrganization(organization.id, name, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
    } catch (thrown) {
      setPending(false);
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) return router.invalidate();
      setOutcome((last) => ({
        saved: false,
        message: refusal(thrown),
        count: last?.saved === false ? last.count + 1 : 1,
      }));
      // Perhaps no longer managing it: if so, the check, run again, says the
      // organization is not theirs; if not, the alert stays.
      if (thrown instanceof BraivoError && thrown.status === 403) await router.invalidate();
      return;
    }
    setPending(false);
    input.value = renamed.name;
    setOutcome({ saved: true });
    // Reads the organization again, so every page shows the new name.
    await router.invalidate();
  }

  /** Why it was not renamed, worded here from Braivo's code (ADR 0035). */
  function refusal(thrown: unknown): string {
    if (thrown instanceof BraivoError && thrown.code === "NAME_INVALID") {
      return t`Enter a name of at most ${MAX_NAME_LENGTH} characters.`;
    }
    return t`Could not save the name. Try again.`;
  }

  return (
    <>
      <Heading>
        <Trans>General</Trans>
      </Heading>
      <form onSubmit={save}>
        <FieldSet>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>
                <Trans>Organization name</Trans>
              </FieldLabel>
              <Input
                id={`${id}-name`}
                name="name"
                defaultValue={organization.name}
                required
                maxLength={MAX_NAME_LENGTH}
                // Held while saving, so the name saved is the one shown.
                readOnly={pending}
                // Not the browser's "organization", the user's employer, which
                // would offer one school's name for another.
                autoComplete="off"
                aria-describedby={`${id}-name-hint`}
                onChange={(event) => {
                  event.currentTarget.setCustomValidity("");
                  setOutcome(undefined);
                }}
              />
              <FieldDescription id={`${id}-name-hint`}>
                <Trans>Your learners see it on their site, and your team sees it here.</Trans>
              </FieldDescription>
            </Field>
            <Field>
              <FieldTitle>
                <Trans>Console address</Trans>
              </FieldTitle>
              <p className="font-mono wrap-anywhere">
                {window.location.host}/{organization.slug}
              </p>
              <FieldDescription>
                <Trans>It cannot be changed yet.</Trans>
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
            <AlertDescription>{outcome.message}</AlertDescription>
          </Alert>
        )}
      </form>
    </>
  );
}
