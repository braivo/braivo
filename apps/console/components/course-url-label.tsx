// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type BraivoClient, courseRef, urlLabel } from "@braivo/server/client";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { Spinner } from "@braivo/ui/components/spinner";
import { useRouter } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

/** The last save's outcome; a failure's count keys its alert, so a repeat is announced too. */
type Outcome = { saved: true } | { saved: false; message: string; count: number };

/**
 * Edits the label after a course's number in its learners' links (ADR 0044),
 * for its owners. Saved over `base`, the label it last saved or was told of,
 * never one a reload brought unseen: someone else's change meanwhile is said,
 * and replaced only by saving again, the input kept.
 */
export function CourseUrlLabel(props: {
  braivo: BraivoClient;
  organizationId: string;
  course: { id: string; number: number; urlLabel: string };
}) {
  const { braivo, organizationId, course } = props;
  const router = useRouter();
  const id = useId();
  const [typed, setTyped] = useState(course.urlLabel);
  const [base, setBase] = useState(course.urlLabel);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const label = urlLabel(typed);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in the field from submitting the form.
    if (pending) return;
    const input = event.currentTarget.elements.namedItem("label") as HTMLInputElement;
    if (!label) {
      input.setCustomValidity("Enter a letter or a digit.");
      input.reportValidity();
      return;
    }

    const failed = (message: string) =>
      setOutcome((last) => ({
        saved: false,
        message,
        count: last?.saved === false ? last.count + 1 : 1,
      }));
    setPending(true);
    let result: Awaited<ReturnType<BraivoClient["setCourseUrlLabel"]>>;
    try {
      result = await braivo.setCourseUrlLabel(
        { organizationId, courseId: course.id, urlLabel: label, previous: base },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
    } catch (thrown) {
      setPending(false);
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) return router.invalidate();
      // Refused as sent, so retrying unchanged would not help: the course gone
      // or no longer theirs, which the page, read again, says; the write alone
      // refused (its same-origin check); or Braivo normalizing the label
      // differently from this page.
      if (thrown instanceof BraivoError && [400, 403, 404].includes(thrown.status)) {
        failed("The label was not saved. Reload the page, then try again.");
        return router.invalidate();
      }
      return failed("Could not save the label. Try again.");
    }
    setPending(false);
    if (!result.saved) {
      setBase(result.urlLabel);
      failed(
        `Someone else changed it to “${result.urlLabel}” meanwhile. Save again to replace theirs.`,
      );
      return router.invalidate();
    }
    setTyped(label);
    setBase(label);
    setOutcome({ saved: true });
    // Reads the course again, so its link above shows the new label.
    await router.invalidate();
  }

  return (
    <form onSubmit={save} className="mb-8">
      <Field>
        <FieldLabel htmlFor={`${id}-label`}>Label in its link</FieldLabel>
        <Input
          id={`${id}-label`}
          name="label"
          value={typed}
          maxLength={200}
          // Held while saving, so the label saved is the one shown.
          readOnly={pending}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-label-hint`}
          onChange={(event) => {
            event.currentTarget.setCustomValidity("");
            setTyped(event.currentTarget.value);
            setOutcome(undefined);
          }}
        />
        {/* The path alone: the link above names the domain, if there is one yet. */}
        <FieldDescription id={`${id}-label-hint`} className="wrap-anywhere">
          Its link ends {`/c/${courseRef({ number: course.number, urlLabel: label })}`}.{" "}
          {`/c/${course.number}`} alone reaches it too, short to say aloud, and links sent before
          keep working.
        </FieldDescription>
      </Field>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" aria-disabled={pending}>
          {pending ? (
            <>
              {/* Hidden: "Saving…" already says it. */}
              <Spinner data-icon="inline-start" aria-hidden="true" />
              Saving…
            </>
          ) : (
            "Save label"
          )}
        </Button>
        {/* Mounted before it says anything: a status region shown already
            filled is not reliably announced. */}
        <p role="status" className="text-sm text-muted-foreground">
          {outcome?.saved && "Saved."}
        </p>
      </div>
      {outcome?.saved === false && (
        <Alert key={outcome.count} variant="destructive" className="mt-4">
          <CircleAlertIcon />
          <AlertDescription>{outcome.message}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
