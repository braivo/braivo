// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type TaskReportReason } from "@braivo/server/client";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@braivo/ui/components/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@braivo/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@braivo/ui/components/radio-group";
import { Textarea } from "@braivo/ui/components/textarea";
import { cn } from "@braivo/ui/lib/utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { FlagIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { ANSWER_DEADLINE_MS, withDeadline } from "#lib/deadline";

/** The server's limit on a note (`MAX_REPORT_NOTE_LENGTH`). */
const MAX_NOTE = 500;
/** A counter shows only near the limit: earlier, it is noise. */
const COUNTER_FROM = 400;

const REASON_LABELS: Record<TaskReportReason, MessageDescriptor> = {
  "answer-correct": msg`My answer seems correct`,
  "key-wrong": msg`The expected answer seems wrong`,
  confusing: msg`The question or explanation is confusing`,
  unsupported: msg`The lesson passage doesn't support this`,
  other: msg`Something else`,
};

type Report = { reason: TaskReportReason; note?: string };

/**
 * Report a problem, a flag by a task's feedback, after Continue (ADR 0052): a
 * dialog of the reasons that fit this grade and a note. What is sent is a
 * snapshot, read-only from Send until Braivo answers it or refuses it, and
 * resent unchanged, so a body Braivo may hold already is never replaced by
 * edits it would refuse (`ALREADY_REPORTED`). Closing the dialog never cancels
 * the request: Continue never waits for it. Its answer is ignored once this
 * unmounts, as the practice it belongs to is replaced.
 */
export function ReportProblem(props: {
  /** Sends the report; resolves once Braivo stored it, or holds it already. */
  send: (report: Report, signal: AbortSignal) => Promise<unknown>;
  /** A miss the learner answered, not Show answer: My answer seems correct fits. */
  missed: boolean;
  /** The grade showed passages: The lesson passage doesn't support this fits. */
  passages: boolean;
  /** Who will read it; "Your school" when the brand could not be read. */
  organizationName: string | undefined;
  /** Where the flag, and the status replacing it once sent, sit, as the caller lays them out. */
  triggerClassName?: string;
  statusClassName?: string;
}) {
  const { send, missed, passages, organizationName, triggerClassName, statusClassName } = props;
  const { t } = useLingui();
  const id = useId();
  const [open, setOpenState] = useState(false);
  // Read by an answer arriving later, which its closure's `open` would not see change.
  const isOpen = useRef(false);
  const setOpen = (value: boolean) => {
    isOpen.current = value;
    setOpenState(value);
  };
  const [reason, setReason] = useState<TaskReportReason>();
  const [note, setNote] = useState("");
  // Sent and not yet answered or refused: shown in place of the draft, read-only.
  const [sent, setSent] = useState<Report>();
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<"sent" | "already">();
  // Counted, so each failure mounts a new alert (docs/apps.md).
  const [failure, setFailure] = useState<{
    kind: "lost" | "refused" | "signed-out";
    count: number;
  }>();
  const [missingNote, setMissingNote] = useState(false);
  const [missingReason, setMissingReason] = useState(false);
  // A send of the snapshot went unanswered: Braivo may hold it, so it stays as sent.
  const uncertain = useRef(false);
  const firstReason = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  // Whether the status should take the focus once it says something: only if
  // the learner was still on the dialog or its button, never from where they went.
  const focusStatus = useRef(false);

  // Aborted when this goes away, so a late answer acts on nothing.
  const lifetime = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useLayoutEffect(() => {
    if (done && focusStatus.current) status.current?.focus();
  }, [done]);

  const offered: TaskReportReason[] = [
    ...(missed ? (["answer-correct"] as const) : []),
    "key-wrong",
    "confusing",
    ...(passages ? (["unsupported"] as const) : []),
    "other",
  ];
  const shown = sent ?? { reason, note };
  const locked = sent !== undefined;
  const shownNote = sent ? (sent.note ?? "") : note;
  const noteLength = shownNote.length;

  async function submit() {
    if (sending) return;
    const left = lifetime.current?.signal;
    if (!left) return;
    // A resend is the snapshot alone.
    let report = sent;
    if (!report) {
      if (!reason) {
        setMissingReason(true);
        // The invalid control takes the focus (docs/apps.md): the first reason.
        firstReason.current?.focus();
        return;
      }
      const trimmed = note.trim();
      if (reason === "other" && !trimmed) {
        setMissingNote(true);
        noteField.current?.focus();
        return;
      }
      report = { reason, ...(trimmed && { note: trimmed }) };
      setSent(report);
    }
    setSending(true);
    try {
      await send(report, withDeadline(left, ANSWER_DEADLINE_MS));
      if (left.aborted) return;
      finish("sent");
    } catch (error) {
      if (left.aborted) return;
      if (error instanceof BraivoError) {
        if (error.status === 409 && error.code === "ALREADY_REPORTED") return finish("already");
        // Refused as sent, so this request stored nothing: the draft is the
        // learner's again, unless an earlier send of it was lost, and may be stored.
        if ([400, 401, 403, 404, 413].includes(error.status)) {
          if (!uncertain.current) setSent(undefined);
          return fail(error.status === 401 ? "signed-out" : "refused");
        }
      }
      // Lost, timed out, or a 5xx: it may be stored, so only the same body is resent.
      uncertain.current = true;
      fail("lost");
    } finally {
      if (!left.aborted) setSending(false);
    }
  }

  function fail(kind: "lost" | "refused" | "signed-out") {
    setFailure((previous) => ({ kind, count: (previous?.count ?? 0) + 1 }));
  }

  function finish(answer: "sent" | "already") {
    // Only from the dialog or its button: a learner who closed it and moved on keeps their place.
    focusStatus.current = isOpen.current || document.activeElement === trigger.current;
    setOpen(false);
    setDone(answer);
  }

  return (
    <>
      {/* Mounted empty from the start, so its words are announced (docs/apps.md). */}
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        // Hidden only visually while empty, so it is in the accessibility tree before it speaks.
        className={cn(done ? "text-sm text-muted-foreground" : "sr-only", statusClassName)}
      >
        {done === "sent" && <Trans>Thanks. Your report was sent.</Trans>}
        {done === "already" && <Trans>You already reported this question.</Trans>}
      </p>
      {!done && (
        <Dialog open={open} onOpenChange={setOpen}>
          {/* The dialog's trigger, so closing it unsent hands the focus back here. */}
          <DialogTrigger asChild>
            {/* A flag, named in words, as on most practice apps: small beside
                the verdict, never competing with Continue. */}
            <Button
              ref={trigger}
              variant="ghost"
              size="icon"
              aria-label={t`Report a problem`}
              className={cn("size-11", triggerClassName)}
            >
              <FlagIcon aria-hidden="true" />
            </Button>
          </DialogTrigger>
          <DialogContent
            showCloseButton={false}
            // Room for a phone's keyboard: the form scrolls rather than leaving the screen.
            className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
            onCloseAutoFocus={(event) => {
              // Sent, its button is gone: the status takes the focus instead.
              if (done) event.preventDefault();
            }}
          >
            <form
              noValidate
              className="flex flex-col gap-6"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <DialogHeader>
                <DialogTitle className="wrap-break-word">
                  <Trans>What's wrong with this question?</Trans>
                </DialogTitle>
                <DialogDescription className="wrap-break-word">
                  {organizationName ? (
                    <Trans>
                      {organizationName} will see this question, your answer, and your note. Your
                      result stays as it is.
                    </Trans>
                  ) : (
                    <Trans>
                      Your school will see this question, your answer, and your note. Your result
                      stays as it is.
                    </Trans>
                  )}
                </DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <FieldSet data-invalid={missingReason || undefined}>
                  <FieldLegend variant="label" className="sr-only">
                    <Trans>Reason</Trans>
                  </FieldLegend>
                  <RadioGroup
                    value={shown.reason ?? ""}
                    aria-disabled={locked || undefined}
                    aria-invalid={missingReason || undefined}
                    aria-describedby={missingReason ? `${id}-reason-error` : undefined}
                    // Read-only while sent: Radix would change it on a click or an arrow key.
                    onValueChange={(value) => {
                      if (locked) return;
                      setReason(value as TaskReportReason);
                      setMissingReason(false);
                      setMissingNote(false);
                    }}
                  >
                    {offered.map((value) => (
                      <Field key={value} orientation="horizontal">
                        <RadioGroupItem
                          value={value}
                          id={`${id}-${value}`}
                          ref={value === offered[0] ? firstReason : undefined}
                        />
                        <FieldLabel
                          htmlFor={`${id}-${value}`}
                          className="font-normal wrap-anywhere"
                        >
                          {t(REASON_LABELS[value])}
                        </FieldLabel>
                      </Field>
                    ))}
                  </RadioGroup>
                  {missingReason && (
                    <FieldError id={`${id}-reason-error`}>
                      <Trans>Choose what's wrong.</Trans>
                    </FieldError>
                  )}
                </FieldSet>
                <Field data-invalid={missingNote || undefined}>
                  <FieldLabel htmlFor={`${id}-note`}>
                    {shown.reason === "other" ? t`What's wrong?` : t`Anything to add?`}
                  </FieldLabel>
                  <Textarea
                    ref={noteField}
                    id={`${id}-note`}
                    value={shownNote}
                    readOnly={locked}
                    maxLength={MAX_NOTE}
                    aria-invalid={missingNote || undefined}
                    aria-describedby={missingNote ? `${id}-note-error` : undefined}
                    onChange={(event) => {
                      setNote(event.target.value);
                      setMissingNote(false);
                    }}
                  />
                  {missingNote && (
                    <FieldError id={`${id}-note-error`}>
                      <Trans>Write what's wrong.</Trans>
                    </FieldError>
                  )}
                  {noteLength > COUNTER_FROM && (
                    <p className="text-sm text-muted-foreground" aria-live="polite">
                      <Trans>
                        {noteLength} of {MAX_NOTE} characters
                      </Trans>
                    </p>
                  )}
                </Field>
              </FieldGroup>
              {failure && !sending && (
                <Alert key={failure.count} variant="destructive">
                  <AlertDescription>
                    {failure.kind === "lost" ? (
                      <Trans>Could not send. Try again.</Trans>
                    ) : failure.kind === "refused" ? (
                      <Trans>Could not send this report. Reload the page and try again.</Trans>
                    ) : (
                      <Trans>
                        You were signed out.{" "}
                        <a href="/login" target="_blank" rel="noopener" className="underline">
                          Sign in in a new tab
                        </a>
                        , then send again.
                      </Trans>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  <Trans>Cancel</Trans>
                </Button>
                {/* aria-disabled while sending, so it keeps the focus (docs/apps.md). */}
                <Button type="submit" aria-disabled={sending || undefined}>
                  {sending ? t`Sending…` : t`Send`}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
