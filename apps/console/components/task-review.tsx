// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reviewing an objective's tasks before learners reach them (ADR 0039), on a
 * course's page and on an objective's: each task with Edit and Retire, a
 * pending one selectable, and Publish's buttons, which send what the page
 * showed, all or nothing.
 */

import {
  type AuthoredCourse,
  BraivoError,
  hasExplanation,
  type SourceSummary,
  type TaskWriteResult,
} from "@braivo/server/client";
import { AuthoredTask, type EditableTask, MutedText, SourcePassage, TaskEditor } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@braivo/ui/components/alert-dialog";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import { Checkbox } from "@braivo/ui/components/checkbox";
import { Label } from "@braivo/ui/components/label";
import { Spinner } from "@braivo/ui/components/spinner";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { NoExplanation } from "#components/explanations";
import { FindingLines } from "#components/findings";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

/** A task as authored, published or pending, with the passages it cites. */
export type ReviewTask = AuthoredCourse["objectives"][number]["tasks"][number];

type Citation = AuthoredCourse["objectives"][number]["citations"][number];

/**
 * The task whose editor is open on a page, and an answer to add to it, from
 * a finding's suggestion: one editor at a time.
 */
export type Editing = { taskId: string; answerToAdd?: string };

/** "1 task", "3 tasks". */
export const formatTaskCount = (count: number) => (count === 1 ? "1 task" : `${count} tasks`);

/** The organization's pages' context: its client and the organization itself. */
const useOrganizationContext = () => useRouteContext({ from: "/_signed-in/$organizationSlug" });

/** Passages, each under its source's title. */
export function Passages(props: {
  citations: readonly Citation[];
  sources: ReadonlyMap<string, SourceSummary>;
}) {
  return props.citations.map((citation) => {
    const source = props.sources.get(citation.sourceId);
    return (
      <SourcePassage
        key={`${citation.sourceId}:${citation.start}:${citation.end}`}
        quote={citation.quote}
        title={source?.title ?? "A source"}
        url={source?.url}
      />
    );
  });
}

/** Which pending tasks Publish selected sends, and choosing them. */
export type TaskSelection = {
  selectedIds: ReadonlySet<string>;
  select: (taskIds: readonly string[], checked: boolean) => void;
};

/**
 * Selected for Publish selected, none on opening. By ID, so a task no longer
 * pending (published, retired, or corrected, a correction being a new ID)
 * drops out of what the page counts as selected.
 */
export function useTaskSelection(): TaskSelection {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const select = (taskIds: readonly string[], checked: boolean) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of taskIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  return { selectedIds, select };
}

/** Selects an objective's pending tasks at once: the unit a teacher reviews. */
export function SelectAll(props: {
  taskIds: readonly string[];
  selection: TaskSelection;
  /** Completes the checkbox's name. */
  objectiveTitle: string;
}) {
  const { taskIds, selection, objectiveTitle } = props;
  const selectedCount = taskIds.filter((id) => selection.selectedIds.has(id)).length;
  return (
    <Label className="font-normal">
      <Checkbox
        checked={
          selectedCount === 0 ? false : selectedCount === taskIds.length ? true : "indeterminate"
        }
        onCheckedChange={(checked) => selection.select(taskIds, checked === true)}
      />
      Select all {taskIds.length}
      <span className="sr-only"> of “{objectiveTitle}”</span>
    </Label>
  );
}

/**
 * Publish's request: `publishing`, which button's is under way, and
 * `failures`, counted, so a second failure mounts a new alert, announced
 * again. Refused as stale (409), the page is read again and says why, so
 * nothing is published unseen.
 */
export function usePublish(callbacks: {
  /** Sending: what an earlier attempt said no longer holds. */
  onStart: () => void;
  /** Published, or refused as stale: the page shown again, and what to announce. */
  onDone: (message: string) => void;
}) {
  const { braivo, organization } = useOrganizationContext();
  const router = useRouter();
  const [publishing, setPublishing] = useState<"selected" | "all">();
  const [failures, setFailures] = useState(0);

  async function publish(
    action: "selected" | "all",
    ids: { courseIds?: string[]; taskIds: string[] },
    successMessage: string,
  ) {
    if (publishing) return;
    setPublishing(action);
    // What earlier attempts said goes: this one's result is what the page says.
    setFailures(0);
    callbacks.onStart();
    try {
      await braivo.publish(
        { organizationId: organization.id, ...ids },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
      // Focus moves once the page shows it published (`sync`, as a correction's).
      await router.invalidate({ sync: true });
      callbacks.onDone(successMessage);
    } catch (thrown) {
      if (thrown instanceof BraivoError && thrown.status === 409) {
        await router.invalidate({ sync: true });
        callbacks.onDone(
          "Nothing was published: this page changed since it loaded. Review it, then publish.",
        );
      } else if (thrown instanceof BraivoError && [401, 403].includes(thrown.status)) {
        // Signed out or no longer authoring there meanwhile: the guard's check, run again, says so.
        await router.invalidate();
      } else {
        setFailures((count) => count + 1);
      }
    } finally {
      setPublishing(undefined);
    }
  }

  return { publishing, failures, publish };
}

/** One of Publish's buttons. */
export type PublishAction = {
  action: "selected" | "all";
  label: string;
  disabled: boolean;
  /**
   * Asked first, when there is something to say: what learners may run into
   * once it is published, and the published courses its tasks reach.
   */
  confirm?: {
    title: string;
    /**
     * How many tasks sent have findings, and the titles of objectives it
     * leaves without practice; Review them closes it, calling `onReview`.
     */
    checks?: {
      taskCount: number;
      objectivesWithoutPractice: readonly string[];
      onReview: () => void;
    };
    /** The published courses its tasks reach, if any, after `description`. */
    reach?: { description: string; courses: readonly { id: string; title: string }[] };
  };
  onPublish: () => void;
};

/**
 * Publish's buttons, kept in view while the tasks below are read, however
 * many: a direct child of the page, so it sticks over all of it.
 */
export function PublishBar(props: {
  actions: readonly PublishAction[];
  /** Which button's request is under way: it says Publishing…, and neither sends another. */
  publishing: "selected" | "all" | undefined;
  /** Why the buttons wait, if they do. */
  note?: string;
  /** Failures so far, keying the last one's alert; 0 hides it. */
  failures: number;
}) {
  const { actions, publishing, note, failures } = props;
  return (
    <div className="sticky top-0 z-10 mb-4 flex flex-col gap-2 bg-background py-2">
      <div className="flex flex-wrap items-center gap-2">
        {actions.map(({ action, label, disabled, confirm, onPublish }) => (
          <PublishButton
            key={action}
            // Publish selected beside Publish all, told apart by weight.
            variant={actions.length > 1 && action === "selected" ? "outline" : "default"}
            label={publishing === action ? undefined : label}
            publishing={publishing !== undefined}
            disabled={disabled}
            confirm={confirm}
            onPublish={onPublish}
          />
        ))}
      </div>
      {note && <MutedText>{note}</MutedText>}
      {/* Gone while trying again, so it never speaks of the attempt under way. */}
      {failures > 0 && publishing === undefined && (
        <Alert key={failures} variant="destructive">
          <AlertDescription>Could not publish. Try again.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function PublishButton(props: {
  variant: "default" | "outline";
  /** Its name; none while its own request is under way, when it says Publishing…. */
  label: string | undefined;
  publishing: boolean;
  disabled: boolean;
  confirm: PublishAction["confirm"];
  onPublish: () => void;
}) {
  const { variant, label, publishing, disabled, confirm, onPublish } = props;
  const { t } = useLingui();
  // Set by Review them, for the dialog's close to move the focus where it leads.
  const reviewing = useRef(false);

  // aria-disabled, not disabled, while publishing, so that it keeps the focus
  // meanwhile; its click ignored then, opening no confirmation either.
  const button = (onClick?: () => void) => (
    <Button
      size="sm"
      variant={variant}
      disabled={disabled}
      // Absent rather than false while `disabled` says it.
      aria-disabled={publishing || undefined}
      onClick={(event) => (publishing ? event.preventDefault() : onClick?.())}
    >
      {label ?? (
        <>
          {/* Hidden: "Publishing…" already says it. */}
          <Spinner data-icon="inline-start" aria-hidden="true" />
          Publishing…
        </>
      )}
    </Button>
  );

  if (!confirm) return button(onPublish);
  const { checks, reach } = confirm;
  return (
    <AlertDialog>
      {/* Radix opens it unless the click was prevented, as while publishing. */}
      <AlertDialogTrigger asChild>{button()}</AlertDialogTrigger>
      <AlertDialogContent
        // Only once closed: before, the dialog's focus trap takes it back.
        onCloseAutoFocus={(event) => {
          if (!reviewing.current) return;
          reviewing.current = false;
          event.preventDefault();
          checks?.onReview();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">{confirm.title}</AlertDialogTitle>
        </AlertDialogHeader>
        {/* Bounded by the window and wrapped, so however much it says, at 320px
            or zoomed, the buttons stay in view; focusable, so a keyboard
            scrolls it too. */}
        <AlertDialogDescription
          asChild
          className="max-h-[50dvh] min-w-0 overflow-y-auto text-start wrap-break-word"
        >
          <div tabIndex={0} className="flex flex-col gap-2">
            {checks && <PublishChecks {...checks} />}
            {reach && (
              <>
                <p>{reach.description}</p>
                <ul aria-label="Courses" className="list-disc pl-6">
                  {reach.courses.map(({ id, title }) => (
                    <li key={id}>{title}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </AlertDialogDescription>
        <AlertDialogFooter>
          {checks ? (
            <>
              <AlertDialogCancel onClick={() => (reviewing.current = true)}>
                {t`Review them`}
              </AlertDialogCancel>
              <AlertDialogAction onClick={onPublish}>{t`Publish anyway`}</AlertDialogAction>
            </>
          ) : (
            <>
              <AlertDialogCancel>Not yet</AlertDialogCancel>
              <AlertDialogAction onClick={onPublish}>Publish</AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * What to check before publishing: how many tasks sent have findings, and the
 * objectives it leaves without a published task, by title.
 */
function PublishChecks(props: { taskCount: number; objectivesWithoutPractice: readonly string[] }) {
  const { taskCount, objectivesWithoutPractice } = props;
  const { t } = useLingui();
  return (
    <>
      <p>{t`Some of this may not work as intended:`}</p>
      <ul className="list-disc pl-6">
        {taskCount > 0 && (
          <li>
            {t({
              // Neutral: a check may be intended; each task's note says what it is.
              message: plural(taskCount, {
                one: "# of these tasks has checks to review",
                other: "# of these tasks have checks to review",
              }),
            })}
          </li>
        )}
        {objectivesWithoutPractice.length > 0 && (
          <li>
            {t({
              message: plural(objectivesWithoutPractice.length, {
                one: "# objective would have no practice:",
                other: "# objectives would have no practice:",
              }),
            })}
            <ul aria-label={t`Objectives without practice`} className="list-[circle] pl-6">
              {objectivesWithoutPractice.map((title, index) => (
                // Titles may repeat.
                <li key={index}>{title}</li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </>
  );
}

/**
 * An objective's pending tasks, each selectable, a correction above the task
 * it replaces as published now; or else its published tasks. Each with the
 * passages it was written from, Edit, and Retire.
 */
export function TaskList(props: {
  objectiveId: string;
  /** All the objective's tasks, published and pending: a correction's task may be in the other list. */
  tasks: readonly ReviewTask[];
  /** Its pending tasks rather than its published ones. */
  showPending?: boolean;
  /** Only these of them, by ID, when the page is narrowed: `tasks` stays whole, for lookups. */
  shownIds?: ReadonlySet<string>;
  sources: ReadonlyMap<string, SourceSummary>;
  selection?: TaskSelection;
  /** The task whose editor is open on the page, if any: every other Edit waits for it. */
  editing: Editing | undefined;
  onEdit: (editing: Editing | undefined) => void;
  /** A page action (Publish, a course's Delete) is under way: no editor opens, as what follows would close it. */
  pending: boolean;
  /** A task was corrected or retired: focus what is still there to take it. */
  onChanged: () => void;
  /**
   * A task was corrected, saved as `saved` and the page read again: in place
   * of `onChanged`, when given, to say so and move the focus itself.
   */
  onSaved?: (taskId: string, saved: TaskWriteResult) => void;
  /**
   * The page's status, shown at the top of task `at`, if listed here, where
   * the focus went after a save; hidden from assistive technology, which
   * hears the page's status already.
   */
  status?: { message: string; at?: string };
}) {
  const {
    objectiveId,
    tasks,
    showPending,
    shownIds,
    status,
    sources,
    selection,
    editing,
    onEdit,
    pending,
    onChanged,
    onSaved,
  } = props;
  const { t } = useLingui();
  // The task whose Edit button takes focus back once its editor closes unsaved.
  const refocus = useRef<string>(undefined);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // Published tasks a tool's correction waits to replace (ADR 0039), of all
  // its tasks: the list showing the task may not show its correction.
  const withPendingCorrection = new Set(tasks.flatMap((task) => task.replaces ?? []));
  const shown = tasks.filter(
    ({ id, published }) =>
      (showPending ? !published : published) && (shownIds === undefined || shownIds.has(id)),
  );

  return shown.map((task) => {
    const replaced = task.replaces === undefined ? undefined : byId.get(task.replaces);
    return (
      <Fragment key={task.id}>
        {editing?.taskId === task.id ? (
          <CorrectTask
            objectiveId={objectiveId}
            task={task}
            answerToAdd={editing.answerToAdd}
            hasPendingCorrection={withPendingCorrection.has(task.id)}
            onDone={(outcome) => {
              onEdit(undefined);
              if (outcome !== "reloaded" && onSaved) onSaved(task.id, outcome.saved);
              else onChanged();
            }}
            onCancel={() => {
              refocus.current = task.id;
              onEdit(undefined);
            }}
          />
        ) : (
          // Focusable, to take the focus when the task before it leaves the page.
          <div id={`task-${task.id}`} tabIndex={-1} className="rounded-xl">
            {status?.at === task.id && (
              <MutedText aria-hidden="true" className="mb-2 block">
                {status.message}
              </MutedText>
            )}
            <RetirableTask
              task={task}
              renderEdit={(retiring) => (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${taskName(task)}`}
                  ref={(button) => {
                    if (button && refocus.current === task.id) {
                      refocus.current = undefined;
                      button.focus();
                    }
                  }}
                  // Not while retiring it, which could land under the edit, nor while Publish or Delete could close it.
                  disabled={retiring || pending || editing !== undefined}
                  onClick={() => onEdit({ taskId: task.id })}
                >
                  Edit
                </Button>
              )}
              findings={(retiring) => (
                <>
                  <NoExplanation task={task} />
                  <FindingLines
                    taskId={task.id}
                    findings={task.findings}
                    onAdd={{
                      label: (answer) =>
                        task.published
                          ? t`Edit “${task.prompt}” and add “${answer}”`
                          : t`Edit unpublished task “${task.prompt}” and add “${answer}”`,
                      // As its Edit button.
                      disabled: retiring || pending || editing !== undefined,
                      add: (answer) => onEdit({ taskId: task.id, answerToAdd: answer }),
                    }}
                  />
                </>
              )}
              select={
                selection && (
                  <Checkbox
                    aria-label={`Select ${taskName(task)}`}
                    checked={selection.selectedIds.has(task.id)}
                    onCheckedChange={(checked) => selection.select([task.id], checked === true)}
                  />
                )
              }
              hasPendingCorrection={withPendingCorrection.has(task.id)}
              corrects={replaced?.prompt}
              onRetired={onChanged}
            >
              <Passages citations={task.citations} sources={sources} />
            </RetirableTask>
          </div>
        )}
        {/* Beside its correction, to compare; its buttons are with the published tasks. */}
        {replaced && (
          <div className="ms-6 flex flex-col gap-2">
            <MutedText>As published now:</MutedText>
            <AuthoredTask task={replaced}>
              <NoExplanation task={replaced} />
              <Passages citations={replaced.citations} sources={sources} />
            </AuthoredTask>
          </div>
        )}
      </Fragment>
    );
  });
}

/**
 * A task as its buttons are named: a pending one apart from a published one,
 * since a correction usually keeps the prompt of the task it corrects.
 */
const taskName = (task: ReviewTask) =>
  task.published ? `“${task.prompt}”` : `unpublished task “${task.prompt}”`;

/**
 * Edits a task the only way an immutable one can be: its correction, with the
 * task's passages and option order, replaces it in one step. Not asked first,
 * unlike retiring, since learners always have one or the other.
 */
function CorrectTask(props: {
  objectiveId: string;
  task: ReviewTask;
  /** An accepted answer to add, from a finding: the editor opens with it, focused there. */
  answerToAdd?: string;
  /** A correction waits to replace it, which saving retires. */
  hasPendingCorrection: boolean;
  /**
   * The page as stored is shown: corrected, with what Braivo answered (another
   * author may have published it meanwhile), or reloaded to find it changed.
   */
  onDone: (outcome: { saved: TaskWriteResult } | "reloaded") => void;
  onCancel: () => void;
}) {
  const { objectiveId, task, answerToAdd, hasPendingCorrection, onDone, onCancel } = props;
  const { braivo, organization } = useOrganizationContext();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // `stale` when someone changed the task first, so saving again cannot help.
  const [error, setError] = useState<{ text: string; stale?: true }>();
  const alert = useRef<HTMLDivElement>(null);

  // Saving disabled the button that had focus; the reason it failed takes it.
  useLayoutEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  async function save(edit: EditableTask) {
    setSaving(true);
    setError(undefined);
    try {
      const [saved] = await braivo.defineTasks(
        {
          organizationId: organization.id,
          tasks: [
            {
              objectiveId,
              ...(edit.kind === "choice"
                ? {
                    ...edit,
                    options: [...edit.options],
                    ...(task.kind === "choice" && task.keepOrder && { keepOrder: true }),
                  }
                : { ...edit, accepted: [...edit.accepted] }),
              citations: task.citations.map(({ sourceId, quote }) => ({ sourceId, quote })),
              replaces: task.id,
            },
          ],
        },
        // Bounded: an identical correction retried after a lost answer returns the stored task.
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
      // `sync`: resolved once the page is read again, not with the old one
      // while it reloads in the background, which would offer the old task to edit.
      await router.invalidate({ sync: true });
      onDone({ saved: saved! });
    } catch (thrown) {
      setSaving(false);
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) return router.invalidate();
      setError(
        !(thrown instanceof BraivoError) || thrown.status !== 409
          ? { text: "The task could not be corrected. Try again." }
          : thrown.code === "DUPLICATE_CORRECTION"
            ? {
                text: "Another task of this objective is already the same. Review its tasks before editing or publishing.",
              }
            : { text: "Someone changed or retired this task since the page loaded.", stale: true },
      );
    }
  }

  async function reload() {
    if (saving) return;
    setSaving(true);
    await router.invalidate({ sync: true });
    onDone("reloaded");
  }

  return (
    <div className="flex flex-col gap-3">
      <MutedText>
        {task.published
          ? "Saving replaces the task: wherever learners are asked it, they are asked the corrected one from now on, and what they already answered stays."
          : "Saving replaces the task: the corrected one waits for review, as this one does."}
        {hasPendingCorrection && " The correction that needs review is retired with it."}
      </MutedText>
      {error && (
        <Alert variant="destructive" ref={alert} tabIndex={-1}>
          <AlertDescription>{error.text}</AlertDescription>
          {error.stale && (
            // aria-disabled, not disabled, so that it keeps the focus meanwhile.
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-fit"
              aria-disabled={saving}
              onClick={reload}
            >
              Reload the page
            </Button>
          )}
        </Alert>
      )}
      {/* Disabled while saving, so the edit sent is the one shown, and Cancel cannot undo it. */}
      <fieldset disabled={saving} aria-busy={saving} className="min-w-0">
        {/* Without an explanation, opened there: the likeliest reason to edit it. */}
        <TaskEditor
          task={task}
          answerToAdd={answerToAdd}
          focusExplanation={!hasExplanation(task)}
          onSave={save}
          onCancel={onCancel}
        />
      </fieldset>
    </div>
  );
}

/**
 * A task with its Edit button, from `renderEdit`, and Retire. Retiring takes
 * a task out of practice for good: asked first, because learners stop seeing
 * it at once. The dialog hands focus back to Retire, which says Retiring…
 * meanwhile; once the task is gone, `onRetired` moves focus, unless it is
 * already elsewhere, as in another task's editor opened meanwhile.
 */
function RetirableTask(props: {
  task: ReviewTask;
  /** The task's Edit button, given whether it is retiring. */
  renderEdit: (retiring: boolean) => ReactNode;
  /** What a learner may run into with it, under its answers, given whether it is retiring. */
  findings: (retiring: boolean) => ReactNode;
  /** While it waits, its checkbox for Publish selected. */
  select?: ReactNode;
  /** A correction waits to replace it, which retiring retires too. */
  hasPendingCorrection: boolean;
  /** While it waits to correct a published task, that task's prompt. */
  corrects?: string;
  onRetired: () => void;
  /** The passages it was written from. */
  children: ReactNode;
}) {
  const {
    task,
    renderEdit,
    findings,
    select,
    hasPendingCorrection,
    corrects,
    onRetired,
    children,
  } = props;
  const { prompt } = task;
  const { braivo, organization } = useOrganizationContext();
  const router = useRouter();
  // A ref, set at once, refuses a second confirmation before `retiring` renders.
  const pending = useRef(false);
  const [retiring, setRetiring] = useState(false);
  /** The last failure's count keys the alert, so a repeat is announced too. */
  const [failures, setFailures] = useState(0);

  async function retire() {
    if (pending.current) return;
    pending.current = true;
    setRetiring(true);
    try {
      // Bounded: retried after a lost answer, it keeps the first retirement.
      await braivo.retireTasks(
        { organizationId: organization.id, taskIds: [task.id] },
        { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) },
      );
    } catch (thrown) {
      pending.current = false;
      setRetiring(false);
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) {
        // Not an earlier failure said again on the way to sign in.
        setFailures(0);
        return router.invalidate();
      }
      setFailures((count) => count + 1);
      return;
    }
    // Focus moves once the task is gone (`sync`, as a correction's), if it went with it.
    await router.invalidate({ sync: true });
    if (document.activeElement === document.body) onRetired();
  }

  return (
    <AuthoredTask
      task={task}
      status={
        !task.published && (
          <>
            {/* Beside its state, not its buttons, which would squeeze its prompt on a phone. */}
            <span className="flex items-center gap-2">
              {select}
              <Badge variant="outline">Unpublished</Badge>
            </span>
            {corrects !== undefined && (
              <MutedText className="mt-1 block">
                Corrects “{corrects}”, which stays published until you publish this.
              </MutedText>
            )}
            {task.matchesRetiredTask && (
              <MutedText className="mt-1 block">An identical task was retired before.</MutedText>
            )}
          </>
        )
      }
      action={
        <span className="flex items-center gap-2">
          {renderEdit(retiring)}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              {/* Named for its task, as Edit is, retiring too. Focusable meanwhile, opening nothing. */}
              <Button
                variant="outline"
                size="sm"
                aria-label={`${retiring ? "Retiring" : "Retire"} ${taskName(task)}`}
                aria-disabled={retiring}
                onClick={(event) => retiring && event.preventDefault()}
              >
                {retiring ? (
                  <>
                    {/* Hidden: the name says it. */}
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                    Retiring…
                  </>
                ) : (
                  "Retire"
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Retire “{prompt}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  {task.published
                    ? "Learners will not be asked it again; what they already answered stays."
                    : "It was never published, so learners have not been asked it."}
                  {hasPendingCorrection && " The correction that needs review is retired with it."}{" "}
                  To change it instead, edit it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={retire}>
                  Retire
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </span>
      }
      notice={
        failures > 0 &&
        !retiring && (
          <Alert variant="destructive" key={failures}>
            <AlertDescription>The task could not be retired. Try again.</AlertDescription>
          </Alert>
        )
      }
    >
      {findings(retiring)}
      {children}
    </AuthoredTask>
  );
}
