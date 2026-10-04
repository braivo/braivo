// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type Draft, type Source } from "@braivo/server/client";
import {
  AuthoredTask,
  type EditableTask,
  Heading,
  MutedText,
  SourcePassage,
  TaskEditor,
} from "@braivo/ui";
import { Alert, AlertDescription, AlertTitle } from "@braivo/ui/components/alert";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import { Checkbox } from "@braivo/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { useAbortOnUnmount } from "#lib/abort-on-unmount";
import { MAX_TITLE } from "#lib/limits";
import { explainAiProxyTimeout, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/$organizationSlug/sources/$sourceId")({
  loader: async ({ context, params, abortController }) => ({
    source: await orNotFound(
      context.braivo.getSource(
        { organizationId: context.organization.id, sourceId: params.sourceId },
        { signal: abortController.signal },
      ),
    ),
  }),
  // Marked, as a course drafted from it takes its title by default.
  head: (head) => pageHead(head, head.loaderData && `${head.loaderData.source.title} · Source`),
  // Remounted for another source, so no draft carries over to it.
  remountDeps: ({ params }) => params,
  component: SourcePage,
  notFoundComponent: () => <p>This source does not exist, or you do not manage it.</p>,
});

/** Enough to recognise the material by; a source may run to megabytes. */
const SHOWN_CHARACTERS = 20_000;

/**
 * What the server would refuse in a title, said of `subject` ("the course",
 * "objective 2"), checked before sending since what is sent is then locked in.
 */
function titleProblem(title: string, subject: string): string | undefined {
  const trimmed = title.trim();
  if (trimmed === "") return `Give ${subject} a title.`;
  if (trimmed.length > MAX_TITLE) {
    return `Keep the title of ${subject} to ${MAX_TITLE} characters.`;
  }
  if (trimmed.includes("\u0000") || !trimmed.isWellFormed()) {
    return `Remove the characters in the title of ${subject} that are not text.`;
  }
}

/** Braivo's words when it gave any, or `fallback`. */
function reasonOf(thrown: unknown, fallback: string): string {
  return (thrown instanceof BraivoError && thrown.reason) || fallback;
}

function SourcePage() {
  const { source } = Route.useLoaderData();
  const { organization } = Route.useRouteContext();

  return (
    <>
      <Heading>{source.title}</Heading>
      <p className="mb-4 flex flex-wrap gap-2">
        {source.language && <Badge variant="secondary">{source.language}</Badge>}
        {source.original && (
          // A download, never shown inline: the server answers it as an attachment.
          <a
            href={`/api/organizations/${encodeURIComponent(organization.id)}/files/${source.original}`}
            className="underline"
          >
            Download the original
          </a>
        )}
        {source.url && (
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline">
            Where it is from
          </a>
        )}
      </p>
      <pre className="mb-6 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap">
        {source.text.slice(0, SHOWN_CHARACTERS)}
      </pre>
      {source.text.length > SHOWN_CHARACTERS && (
        <MutedText>
          The first {SHOWN_CHARACTERS.toLocaleString()} of {source.text.length.toLocaleString()}{" "}
          characters.
        </MutedText>
      )}
      <DraftCourse source={source} />
    </>
  );
}

/**
 * Asks Braivo's AI for a course drafted from this source, then lets the
 * content owner keep what is right and author it (docs/adr/0029-server-drafting.md).
 * Nothing is stored until they do.
 */
function DraftCourse(props: { source: Source }) {
  const { source } = props;
  const { braivo, organization } = Route.useRouteContext();
  const organizationId = organization.id;
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  // The review replaces this form, so it takes the focus if the form held it.
  const [focusReview, setFocusReview] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const abortOnUnmount = useAbortOnUnmount();
  // Back from a discarded review, the button that drafted it takes the focus.
  const draftButton = useRef<HTMLButtonElement>(null);
  const [discarded, setDiscarded] = useState(false);
  useLayoutEffect(() => {
    if (!discarded) return;
    draftButton.current?.focus();
    setDiscarded(false);
  }, [discarded]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in the field from submitting the form.
    if (drafting) return;
    const form = event.currentTarget;
    const audience = (new FormData(form).get("audience") as string).trim();
    const signal = abortOnUnmount();

    setDrafting(true);
    setError(undefined);
    try {
      const drafted = await explainAiProxyTimeout(
        braivo.draftCourse(
          { organizationId, sourceId: source.id, audience: audience || undefined },
          { signal },
        ),
      );
      setFocusReview(form.contains(document.activeElement));
      setDraft(drafted);
    } catch (thrown) {
      if (signal?.aborted) return;
      setError(reasonOf(thrown, "The course could not be drafted. Try again."));
    } finally {
      setDrafting(false);
    }
  }

  if (draft) {
    return (
      <ReviewDraft
        source={source}
        draft={draft}
        takeFocus={focusReview}
        onDiscard={() => {
          setDraft(undefined);
          setDiscarded(true);
        }}
      />
    );
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-heading`}>
      <Heading level={2} id={`${id}-heading`}>
        Draft a course
      </Heading>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-audience`}>Learners</FieldLabel>
          <Input
            id={`${id}-audience`}
            name="audience"
            maxLength={200}
            readOnly={drafting}
            placeholder="Grade 2, English speakers learning Spanish"
            aria-describedby={`${id}-audience-hint`}
          />
          <FieldDescription id={`${id}-audience-hint`}>
            Who the course is for. Braivo's AI reads the whole source, which can take a minute; you
            review everything it proposes before learners see any of it.
          </FieldDescription>
        </Field>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field>
          {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
          <Button type="submit" ref={draftButton} aria-disabled={drafting}>
            {drafting ? "Drafting…" : "Draft a course"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}

/**
 * A draft under review: every objective and task kept by default, each one
 * dropped by unticking it, objectives' titles and tasks correctable, and what
 * Braivo already left out listed.
 */
function ReviewDraft(props: {
  source: Source;
  draft: Draft;
  /** Whether the heading takes the focus once shown. */
  takeFocus: boolean;
  onDiscard: () => void;
}) {
  const { source, draft, takeFocus, onDiscard } = props;
  const { braivo, organization } = Route.useRouteContext();
  const organizationId = organization.id;
  const router = useRouter();
  const abortOnUnmount = useAbortOnUnmount();
  // Dropped rather than kept, so the default is everything: "o:<i>", "t:<i>:<j>".
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  // Objectives' titles as the owner left them, by index; a draft's own until typed in.
  const [titles, setTitles] = useState<ReadonlyMap<number, string>>(new Map());
  const titleOf = (index: number) => titles.get(index) ?? draft.objectives[index]!.title;
  // The owner's corrections, by "<i>:<j>", and the one open, if any.
  const [edited, setEdited] = useState<ReadonlyMap<string, EditableTask>>(new Map());
  const [editing, setEditing] = useState<string>();
  // Where focus returns once an edit closes: the Edit button it was opened from.
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const [refocus, setRefocus] = useState<string>();
  useEffect(() => {
    if (refocus === undefined) return;
    editButtons.current.get(refocus)?.focus();
    setRefocus(undefined);
  }, [refocus]);

  function closeEdit(at: string) {
    setEditing(undefined);
    setRefocus(at);
  }
  const [creating, setCreating] = useState(false);
  // What was sent, once anything was: part of it may be stored, and authoring
  // only adds, so a retry sends the same rather than what was changed since.
  const [submitted, setSubmitted] = useState<{ title: string; objectives: typeof kept }>();
  const [error, setError] = useState<string>();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (takeFocus) heading.current?.focus();
  }, [takeFocus]);
  const createButton = useRef<HTMLButtonElement>(null);

  /** The task as the owner last left it: the draft's, or their correction of it. */
  function current(index: number, taskIndex: number) {
    const task = draft.objectives[index]!.tasks[taskIndex]!;
    const edit = edited.get(`${index}:${taskIndex}`);
    if (!edit) return task;
    // Whole, not merged: an explanation the owner removed stays removed.
    const { explanation: _, ...rest } = task;
    return { ...rest, ...edit, options: [...edit.options] };
  }

  const kept = draft.objectives.flatMap((objective, index) =>
    dropped.has(`o:${index}`)
      ? []
      : [
          {
            ...objective,
            title: titleOf(index).trim(),
            tasks: objective.tasks.flatMap((_, task) =>
              dropped.has(`t:${index}:${task}`) ? [] : [current(index, task)],
            ),
          },
        ],
  );

  function toggle(key: string, keep: boolean) {
    const next = new Set(dropped);
    if (keep) next.delete(key);
    else next.add(key);
    setDropped(next);
    // Dropping an objective hides its tasks, and with them an edit open on one.
    if (!keep && editing?.startsWith(`${key.slice("o:".length)}:`)) setEditing(undefined);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in the title from submitting the form.
    if (creating) return;
    const sending = submitted ?? {
      title: (new FormData(event.currentTarget).get("title") as string).trim(),
      objectives: kept,
    };
    // In page order, focusing the first to fix: the alert sits below a long review.
    const titled = [
      ...draft.objectives.flatMap((_, index) =>
        dropped.has(`o:${index}`)
          ? []
          : [
              {
                title: titleOf(index),
                subject: `objective ${index + 1}`,
                field: `${id}-o${index}`,
              },
            ],
      ),
      { title: sending.title, subject: "the course", field: `${id}-title` },
    ];
    for (const { title, subject, field } of titled) {
      const problem = titleProblem(title, subject);
      if (problem !== undefined) {
        setError(problem);
        document.getElementById(field)?.focus();
        return;
      }
    }

    // Sent by Enter in a title, which locks with the review below: the button
    // takes the focus rather than the page.
    createButton.current?.focus();
    const signal = abortOnUnmount();
    // The page, as `remountDeps` tells pages apart: a changed hash is no leaving.
    const from = router.latestLocation.pathname;
    setSubmitted(sending);
    setCreating(true);
    setError(undefined);
    try {
      const courseId = await braivo.acceptDraft({
        organizationId,
        sourceId: source.id,
        ...sending,
      });
      // Unless the owner left meanwhile. A review still shown can be sent
      // again, which finishes the course already created and opens it.
      if (signal?.aborted || router.latestLocation.pathname !== from) {
        setCreating(false);
        return;
      }
      await router.navigate({
        to: "/$organizationSlug/courses/$courseId",
        params: { organizationSlug: organization.slug, courseId },
      });
    } catch (thrown) {
      // Braivo's refusal says what to fix; anything else — the network, say —
      // is what trying again is for.
      setError(
        reasonOf(
          thrown,
          "The course could not be created. Try again to finish it as reviewed; retire what you would drop on the course page afterwards.",
        ),
      );
      setCreating(false);
    }
  }

  const passages = (citations: Draft["objectives"][number]["citations"]) =>
    citations.map((citation, index) => (
      // Fixed for this draft, and a model may quote the same words twice.
      <SourcePassage key={index} quote={citation.quote} title={source.title} />
    ));

  return (
    // `noValidate`: `create` checks every title, as the server would, and says
    // what to fix; the browser would check only `required`, in its own words.
    <form
      onSubmit={create}
      noValidate
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-6"
    >
      <Heading level={2} id={`${id}-heading`} ref={heading} tabIndex={-1}>
        Review the draft
      </Heading>
      <MutedText>
        Untick what is wrong, or correct an objective's title or a task's words and answer. Nothing
        is stored until you create the course.
      </MutedText>
      {draft.refused.length > 0 && (
        <Alert>
          <AlertTitle>Left out: what Braivo could not check against the source</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {draft.refused.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {draft.objectives.length === 0 && <MutedText>The draft proposes no objectives.</MutedText>}
      {/* Still while sending, and once sent: see `submitted`. */}
      <FieldSet disabled={creating || submitted !== undefined}>
        {draft.objectives.map((objective, index) => {
          const keptObjective = !dropped.has(`o:${index}`);
          const title = titleOf(index);
          return (
            <article
              key={objective.key}
              // Numbered, since titles may repeat, and titled for navigating by
              // article; set here, since implementations disagree on naming one
              // by a textbox.
              aria-label={[`Objective ${index + 1}`, title.trim()].filter(Boolean).join(": ")}
              className="flex flex-col gap-3"
            >
              <Field orientation="horizontal">
                <Checkbox
                  aria-label={`Keep objective ${index + 1}`}
                  checked={keptObjective}
                  onCheckedChange={(checked) => toggle(`o:${index}`, checked === true)}
                />
                <FieldLabel htmlFor={`${id}-o${index}`} className="whitespace-nowrap">
                  Objective {index + 1}
                </FieldLabel>
                <Input
                  id={`${id}-o${index}`}
                  maxLength={MAX_TITLE}
                  value={title}
                  required={keptObjective}
                  disabled={!keptObjective}
                  onChange={(event) => setTitles(new Map(titles).set(index, event.target.value))}
                />
              </Field>
              {keptObjective && (
                <>
                  {passages(objective.citations)}
                  {objective.tasks.map((drafted, taskIndex) => {
                    const at = `${index}:${taskIndex}`;
                    const task = current(index, taskIndex);
                    if (editing === at) {
                      return (
                        <TaskEditor
                          key={taskIndex}
                          task={task}
                          onSave={(edit) => {
                            setEdited(new Map(edited).set(at, edit));
                            closeEdit(at);
                          }}
                          onCancel={() => closeEdit(at)}
                        />
                      );
                    }
                    return (
                      <AuthoredTask
                        key={taskIndex}
                        prompt={task.prompt}
                        options={task.options}
                        answer={task.answer}
                        explanation={task.explanation}
                        action={
                          <span className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Edit “${task.prompt}”`}
                              ref={(button) => {
                                if (button) editButtons.current.set(at, button);
                                else editButtons.current.delete(at);
                              }}
                              disabled={editing !== undefined}
                              onClick={() => setEditing(at)}
                            >
                              Edit
                            </Button>
                            <Checkbox
                              aria-label={`Keep “${task.prompt}”`}
                              checked={!dropped.has(`t:${at}`)}
                              onCheckedChange={(checked) => toggle(`t:${at}`, checked === true)}
                            />
                          </span>
                        }
                      >
                        {passages(drafted.citations)}
                      </AuthoredTask>
                    );
                  })}
                </>
              )}
            </article>
          );
        })}
        <Field>
          <FieldLabel htmlFor={`${id}-title`}>Course title</FieldLabel>
          <Input
            id={`${id}-title`}
            name="title"
            required
            maxLength={MAX_TITLE}
            defaultValue={source.title}
          />
        </Field>
      </FieldSet>
      <FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field orientation="horizontal">
          {/* Not while a task is open: its unsaved edit would be left out.
              While sending, aria-disabled, so that it keeps the focus. */}
          <Button
            type="submit"
            ref={createButton}
            disabled={kept.length === 0 || editing !== undefined}
            aria-disabled={creating}
          >
            {submitted && !creating ? "Try again" : "Create course"}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-disabled={creating}
            onClick={() => !creating && onDiscard()}
          >
            Discard draft
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
