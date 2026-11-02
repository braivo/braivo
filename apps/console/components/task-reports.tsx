// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Learners' reports of tasks (ADR 0052), for whoever administers the
 * organization: read beside a page's own data, never holding it back, and
 * shown on the organization's page, listed, and under each reported task on a
 * course's and an objective's page, where they are dismissed. An author reads
 * none (`readReports` answers nothing to them). English, as the pages are.
 */

import {
  BraivoError,
  type BraivoClient,
  type Organization,
  type ReportedTask,
} from "@braivo/server/client";
import { Heading, MAX_ACCEPTED, MAX_ACCEPTED_TEXT, MutedText, normalizeAnswer } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import { Link, useRouteContext, useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Disclosure } from "#components/disclosure";
import { LinkList, linkRow } from "#components/link-list";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

/** A read's answer, or that it failed: a failure never fails the page. */
type ReportsRead = { tasks: ReportedTask[]; more: boolean } | "failed";

/**
 * The organization's open reports in `scope`, for a page's loader to return
 * unawaited, so the page shows without them; `undefined` to someone who does
 * not administer it, who reads none.
 */
export function readReports(
  braivo: BraivoClient,
  organization: Organization,
  scope: { objectiveId?: string; courseId?: string },
  signal: AbortSignal,
): Promise<ReportsRead> | undefined {
  if (!organization.administers) return undefined;
  return braivo
    .listReportedTasks(
      { organizationId: organization.id, ...scope },
      { signal: withDeadline(signal, REQUEST_DEADLINE_MS) },
    )
    .catch((): ReportsRead => "failed");
}

/** What `promise` resolved to, the last one's kept while a reload reads again. */
function useSettled<T>(promise: Promise<T> | undefined): T | undefined {
  const [settled, setSettled] = useState<T>();
  useEffect(() => {
    let current = true;
    void promise?.then((value) => current && setSettled(() => value));
    return () => {
      current = false;
    };
  }, [promise]);
  return promise === undefined ? undefined : settled;
}

const REASONS: Record<ReportedTask["reports"][number]["reason"], string> = {
  "answer-correct": "My answer seems correct",
  "key-wrong": "The expected answer seems wrong",
  confusing: "The question or explanation is confusing",
  unsupported: "The lesson passage doesn't support this",
  other: "Something else",
};

/** One task's reports one read lists, as the server's `MAX_REPORTS_AT_ONCE`. */
const MAX_REPORTS_READ = 1000;

const learners = (count: number) => `${count} ${count === 1 ? "learner" : "learners"}`;

/**
 * Where a task's reports are on its objective's page, which the organization's
 * links to: apart from `task-<id>`, the task's own, which focus moves to.
 */
export const taskAnchor = (taskId: string) => `task-reports-${taskId}`;

/** A failed read of the reports, said once; Try again reads the page again. */
function FailedRead() {
  const router = useRouter();
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertDescription>
        Reports could not be loaded.{" "}
        <Button variant="link" className="h-auto p-0" onClick={() => router.invalidate()}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** The organization's page: its reported tasks, each leading to its reports. */
export function ReportedTasks(props: {
  reports: Promise<ReportsRead> | undefined;
  organizationSlug: string;
}) {
  const read = useSettled(props.reports);
  const id = useId();
  if (read === undefined) return null;
  if (read === "failed") return <FailedRead />;
  if (read.tasks.length === 0) return null;

  return (
    <section aria-labelledby={`${id}-heading`} className="mb-8">
      <Heading level={2} id={`${id}-heading`}>
        Reported by learners
      </Heading>
      {read.more && (
        <MutedText className="mb-3 block">
          Showing the {read.tasks.length} most recently reported tasks, not every one.
        </MutedText>
      )}
      <LinkList>
        {read.tasks.map((task) => {
          const latest = task.reports[0]?.reason;
          // Of every open report, not only the newest listed.
          const others = task.reasonCount - 1;
          const note = [
            learners(task.reportCount),
            ...(latest ? [REASONS[latest]] : []),
            ...(others > 0 ? [`+${others} more ${others === 1 ? "reason" : "reasons"}`] : []),
          ].join(" · ");
          const noteId = `${id}-${task.id}`;
          return (
            <li key={task.id}>
              <Link
                to="/$organizationSlug/objectives/$objectiveId"
                params={{ organizationSlug: props.organizationSlug, objectiveId: task.objectiveId }}
                hash={taskAnchor(task.id)}
                className={linkRow}
                aria-describedby={noteId}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="line-clamp-2 wrap-break-word">{task.prompt}</span>
                  {/* The link's description, so its name stays the question. */}
                  <MutedText id={noteId} aria-hidden="true" className="font-normal">
                    {note}
                  </MutedText>
                </span>
                <ChevronRightIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </Link>
            </li>
          );
        })}
      </LinkList>
    </section>
  );
}

type TaskReportsState = {
  reports: ReadonlyMap<string, ReportedTask>;
  /**
   * Says `message` in the page's status, focused: what was acted on goes once
   * the page reads its reports again, taking the focus with it.
   */
  announce: (message: string) => void;
};

const TaskReportsContext = createContext<TaskReportsState | undefined>(undefined);

/**
 * A course's or an objective's reports, for each `TaskReports` beneath: the
 * page renders whole meanwhile, and a failed read says so once, above.
 */
export function TaskReportsProvider(props: {
  reports: Promise<ReportsRead> | undefined;
  children: ReactNode;
}) {
  const read = useSettled(props.reports);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState("");
  const [focusMessage, setFocusMessage] = useState(0);
  useLayoutEffect(() => {
    if (focusMessage > 0) status.current?.focus();
  }, [focusMessage]);

  const reports = new Map(
    read === undefined || read === "failed" ? [] : read.tasks.map((task) => [task.id, task]),
  );
  return (
    <TaskReportsContext.Provider
      value={{
        reports,
        announce: (text) => {
          setMessage(text);
          setFocusMessage((count) => count + 1);
        },
      }}
    >
      {read === "failed" && <FailedRead />}
      {/* Mounted empty from the start, so what Dismiss did is announced (docs/apps.md). */}
      <p ref={status} role="status" tabIndex={-1} className={message ? "mb-4 text-sm" : "sr-only"}>
        {message}
      </p>
      {props.children}
    </TaskReportsContext.Provider>
  );
}

/**
 * How a report's typed answer could join the task's accepted ones: spaced
 * as stored answers are, so a line break in it never makes two; offered only
 * where saving would take it.
 */
function acceptableAnswer(task: ReportedTask, text: string): string | undefined {
  if (task.kind !== "typed") return undefined;
  const answer = text.replace(/\s+/gu, " ").trim();
  if (answer === "" || answer.length > MAX_ACCEPTED_TEXT) return undefined;
  if (task.accepted.length >= MAX_ACCEPTED) return undefined;
  const compared = normalizeAnswer(answer);
  if (task.accepted.some((accepted) => normalizeAnswer(accepted) === compared)) return undefined;
  return answer;
}

/**
 * A published task's open reports, under it, closed until opened, or open on
 * arrival from the organization's page: each report's reason, the learner's
 * answer, note, and date; Add to accepted answers, which opens the task's
 * editor with it; and Dismiss, which closes the reports shown alone.
 */
export function TaskReports(props: {
  taskId: string;
  /**
   * Opens the task's editor with this answer added to its accepted ones;
   * without it, where the page offers no editor for the task, none is offered.
   */
  onAddAnswer?: (answer: string) => void;
  /** An editor open, Publish under way, or the task retiring: no editor opens meanwhile. */
  editingLocked: boolean;
}) {
  const { taskId, onAddAnswer, editingLocked } = props;
  const { braivo, organization } = useRouteContext({ from: "/_signed-in/$organizationSlug" });
  const organizationId = organization.id;
  const context = useContext(TaskReportsContext);
  const listed = context?.reports.get(taskId);
  const router = useRouter();
  const hash = useRouterState({ select: (state) => state.location.hash });
  // The task's whole list, with the page's read it was asked from: a newer read replaces it.
  const [whole, setWhole] = useState<{ from: ReportedTask; task: ReportedTask }>();
  const [busy, setBusy] = useState<"showing" | "dismissing">();
  const [failure, setFailure] = useState<{ text: string; count: number }>();
  const anchor = useRef<HTMLDetailsElement>(null);
  const showAllButton = useRef<HTMLButtonElement>(null);
  const dismissButton = useRef<HTMLButtonElement>(null);
  // Show all goes once it has shown them: Dismiss, what comes next, takes its focus.
  const [focusDismiss, setFocusDismiss] = useState(false);
  useLayoutEffect(() => {
    if (!focusDismiss) return;
    dismissButton.current?.focus();
    setFocusDismiss(false);
  }, [focusDismiss]);
  const arrived = hash === taskAnchor(taskId);

  // Arrived at from the organization's page: shown once the reports are read.
  const shown = listed !== undefined;
  useEffect(() => {
    if (arrived && shown) anchor.current?.scrollIntoView({ block: "start" });
  }, [arrived, shown]);

  if (!listed || !context) return null;
  // The whole list read on request, until the page reads its reports again.
  const read: ReportedTask = listed;
  const expanded = whole?.from === read;
  const task = expanded ? whole.task : listed;
  const shownIds = task.reports.map(({ id }) => id);
  const partial = task.reportCount > task.reports.length;

  function fail(text: string) {
    setFailure((previous) => ({ text, count: (previous?.count ?? 0) + 1 }));
  }

  async function showAll() {
    if (busy) return;
    setBusy("showing");
    const from = read;
    try {
      const { tasks } = await braivo.listReportedTasks(
        { organizationId, taskId },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
      const [found] = tasks;
      setFailure(undefined);
      if (!found) {
        // Dismissed or retired meanwhile: the page reads its reports again, without these.
        await router.invalidate({ sync: true });
        return context?.announce("These reports were closed meanwhile.");
      }
      setWhole({ from, task: found });
      setFocusDismiss(document.activeElement === showAllButton.current);
    } catch (thrown) {
      if (thrown instanceof BraivoError && thrown.status === 401) return void router.invalidate();
      fail("Could not load every report. Try again.");
    } finally {
      setBusy(undefined);
    }
  }

  async function dismiss() {
    if (busy) return;
    setBusy("dismissing");
    try {
      // Exactly those shown: a report sent since stays open.
      await braivo.dismissReports(
        { organizationId, reportIds: shownIds },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
    } catch (thrown) {
      setBusy(undefined);
      if (thrown instanceof BraivoError && thrown.status === 401) return void router.invalidate();
      return fail("Could not dismiss the reports. Try again.");
    }
    await router.invalidate({ sync: true });
    setBusy(undefined);
    context?.announce(
      `${shownIds.length === 1 ? "Report" : "Reports"} dismissed. The task is unchanged.`,
    );
  }

  const count = task.reportCount;
  return (
    <Disclosure
      ref={anchor}
      id={taskAnchor(taskId)}
      defaultOpen={arrived}
      className="scroll-mt-40"
      summary={<span className="font-medium">Reported by {learners(count)}</span>}
    >
      <div className="mt-2 flex flex-col gap-3 ps-5">
        {task.pendingCorrectionId !== undefined && (
          <MutedText>A correction waits to be published; these reports close when it is.</MutedText>
        )}
        <ul className="flex flex-col gap-3">
          {task.reports.map((report) => {
            const response = report.response;
            const answer =
              "reveal" in response
                ? "Showed the answer"
                : "text" in response
                  ? `Typed: ${response.text}`
                  : `Chose: ${task.kind === "choice" ? (task.options[response.choice] ?? "an option no longer there") : "an option"}`;
            const addable =
              onAddAnswer && report.reason === "answer-correct" && "text" in response
                ? acceptableAnswer(task, response.text)
                : undefined;
            return (
              <li key={report.id} className="flex flex-col gap-1 wrap-break-word">
                <span className="text-sm font-medium">{REASONS[report.reason]}</span>
                <MutedText>
                  {/* Kept as typed: what the learner answered, spaces and all. */}
                  <span className="whitespace-pre-wrap">{answer}</span>
                  {" · "}
                  <time dateTime={report.at}>
                    {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
                      new Date(report.at),
                    )}
                  </time>
                </MutedText>
                {report.note !== undefined && (
                  <p className="text-sm whitespace-pre-wrap">“{report.note}”</p>
                )}
                {addable !== undefined && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-8 w-fit py-1.5 whitespace-normal wrap-anywhere"
                    disabled={editingLocked}
                    onClick={() => onAddAnswer?.(addable)}
                  >
                    Add “{addable}” to accepted answers
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {failure && (
          <Alert key={failure.count} variant="destructive">
            <AlertDescription>{failure.text}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          {/* Past the most one read lists, said rather than offered again. */}
          {partial && expanded && (
            <MutedText className="basis-full">
              Showing the newest {task.reports.length.toLocaleString("en")}; dismiss them to see the
              rest.
            </MutedText>
          )}
          {partial && !expanded && (
            <Button
              ref={showAllButton}
              variant="ghost"
              size="sm"
              aria-disabled={busy !== undefined}
              onClick={() => void showAll()}
            >
              {busy === "showing"
                ? "Loading…"
                : count > MAX_REPORTS_READ
                  ? `Show the newest ${MAX_REPORTS_READ.toLocaleString("en")} reports`
                  : `Show all ${count} reports`}
            </Button>
          )}
          {/* aria-disabled, so it keeps the focus while it dismisses (docs/apps.md). */}
          <Button
            ref={dismissButton}
            variant="outline"
            size="sm"
            aria-disabled={busy !== undefined}
            onClick={() => void dismiss()}
          >
            {busy === "dismissing"
              ? "Dismissing…"
              : partial
                ? `Dismiss these ${shownIds.length}`
                : shownIds.length === 1
                  ? "Dismiss report"
                  : "Dismiss reports"}
          </Button>
        </div>
      </div>
    </Disclosure>
  );
}
