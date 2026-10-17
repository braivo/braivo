// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type BraivoClient,
  BraivoError,
  type Course,
  type Group,
  type GroupDefinition,
  type Member,
  type Organization,
} from "@braivo/server/client";
import { Heading } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Button } from "@braivo/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@braivo/ui/components/command";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@braivo/ui/components/popover";
import { Spinner } from "@braivo/ui/components/spinner";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useBlocker, useNavigate, useRouter } from "@tanstack/react-router";
import { CircleAlertIcon, PlusIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { NameTag } from "#components/name-tag";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import {
  changeOf,
  conflictingUserIds,
  definitionOf,
  edited,
  type GroupEdits,
  type GroupRole,
  NO_EDITS,
  NO_ROSTER,
  outstanding,
} from "#lib/group-edits";
import { MAX_TITLE } from "#lib/limits";
import { nameWithTag, sharedNameTags } from "#lib/name-tags";

/** A save's outcome; a failure's count keys its alert, so a repeat is announced too. */
type Outcome =
  | { saved: true }
  | { saved: false; message: ReactNode; count: number; reload?: true; toGroups?: true };

/** An empty group, which a new one's form starts from. */
const EMPTY_GROUP = { name: "", ...NO_ROSTER };

/**
 * A group's name, people, and courses, to create it (`group` absent) or change
 * it (access-38). Its people are the organization's members and its courses
 * the organization's, both read by the page. What it saves:
 *
 * - Created, the whole group, under one key for this visit to the form. After
 *   an unconfirmed answer the form holds what it sent, so trying again sends
 *   the same group, which the key never creates twice.
 * - Changed, only what the form changes over `group` as loaded (`changeOf`),
 *   so another administrator's changes meanwhile stand. Nothing changed sends
 *   nothing. Edits are kept only while they differ from the group
 *   (`outstanding`), so one undone is never carried onto a reloaded group as
 *   new. An unconfirmed change is never sent again by itself: it may have
 *   landed, and sent late could undo a change made since.
 */
export function GroupForm(props: {
  braivo: BraivoClient;
  organization: Organization;
  members: Member[];
  courses: Course[];
  group?: Group;
}) {
  const { braivo, members, courses } = props;
  const { id: organizationId, slug: organizationSlug } = props.organization;
  // The group as last read or saved here, over the page's: reading it again
  // never replaces the form, whose changes a failed read must not lose.
  const [latest, setLatest] = useState<Group>();
  const group = latest ?? props.group ?? EMPTY_GROUP;
  const creating = props.group === undefined;
  const router = useRouter();
  const navigate = useNavigate();
  const { t, i18n } = useLingui();
  const id = useId();
  // As typed, once typed: untouched, the group's own, as reloaded.
  const [typed, setTyped] = useState<string>();
  const name = typed ?? group.name;
  const [edits, setEdits] = useState<GroupEdits>(NO_EDITS);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  // What the last edit did, said to a screen reader.
  const [announcement, setAnnouncement] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  // A creation sent without an answer, held as sent: trying again sends it unchanged.
  const [sent, setSent] = useState<GroupDefinition>();
  // Unmounted, a creation finishing late leaves the page someone went to alone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const unconfirmedRefusal = {
    message: t`Could not confirm the change. Reload the group to check it before saving again.`,
    reload: true as const,
  };
  // A change sent without an answer, which may have landed: saving waits for a reload.
  const [unconfirmed, setUnconfirmed] = useState(false);
  // Whose row just moved to the other section: its action takes the focus there.
  const moved = useRef<string>(undefined);
  const refocus = (userId: string) => (button: HTMLButtonElement | null) => {
    if (button && moved.current === userId) {
      moved.current = undefined;
      button.focus();
    }
  };
  const heading = useRef<HTMLHeadingElement>(null);
  // Arrived from creating the group, whose button is gone: the focus starts here.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) heading.current?.focus();
  }, []);
  const teachersPicker = useRef<HTMLButtonElement>(null);
  const learnersPicker = useRef<HTMLButtonElement>(null);
  const coursesPicker = useRef<HTMLButtonElement>(null);

  const shown = edited(group, edits);
  const change = changeOf(group, name.trim(), edits);
  // Nothing to keep once the group is gone or was created already: only Groups helps.
  const unsaved = change !== undefined && !(outcome?.saved === false && outcome.toGroups);
  // Left only when asked, roster changes being long to redo; not while saving.
  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      unsaved &&
      !pending &&
      current.pathname !== next.pathname &&
      !window.confirm(t`Leave this page? Your changes to this group will be lost.`),
    enableBeforeUnload: () => unsaved,
  });

  // Each person's name: the organization's members, and the group's own, whom
  // a stale member list may lack.
  const names = new Map<string, string>([
    ...group.teachers.map(({ userId, name }) => [userId, name] as const),
    ...group.learners.map(({ userId, name }) => [userId, name] as const),
    ...members.map(({ userId, name }) => [userId, name] as const),
  ]);
  const tags = sharedNameTags([...names].map(([userId, name]) => ({ userId, name })));
  const person = (userId: string) => ({ name: names.get(userId) ?? userId, tag: tags.get(userId) });
  // As a control reached alone names them: with their tag, when it is needed.
  const labelOf = (userId: string) => nameWithTag(person(userId).name, person(userId).tag);
  const byName = (ids: string[]) =>
    ids.toSorted((a, b) => person(a).name.localeCompare(person(b).name, i18n.locale));
  const titles = new Map([...group.courses, ...courses].map(({ id, title }) => [id, title]));

  function edit(next: GroupEdits, message: string) {
    setEdits(outstanding(group, next));
    setAnnouncement(message);
    // An unconfirmed change's alert stays, with its Reload, until reloaded.
    if (!unconfirmed) setOutcome(undefined);
  }
  const setRole = (userId: string, role: GroupRole | null) =>
    edit(
      { ...edits, people: { ...edits.people, [userId]: role } },
      role === "teacher"
        ? t`${person(userId).name} is a teacher.`
        : role === "learner"
          ? t`${person(userId).name} is a learner.`
          : t`Removed ${person(userId).name}.`,
    );
  const setCourse = (courseId: string, taken: boolean) =>
    edit(
      { ...edits, courses: { ...edits.courses, [courseId]: taken } },
      taken ? t`Added ${titles.get(courseId)}.` : t`Removed ${titles.get(courseId)}.`,
    );

  const fail = (refusal: Omit<Extract<Outcome, { saved: false }>, "saved" | "count">) =>
    setOutcome((last) => ({
      saved: false,
      ...refusal,
      count: last?.saved === false ? last.count + 1 : 1,
    }));

  /**
   * Reads the group again into the form, keeping the changes still to make,
   * less any adding someone whom someone else put in the other role meanwhile
   * (`conflictingUserIds`), who is named: whether it could read it, and whether
   * it named anyone.
   */
  async function reconcile(): Promise<"failed" | "reloaded" | "conflicted"> {
    try {
      const groups = await braivo.listGroups(organizationId, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
      const found = groups.find(({ id }) => id === props.group?.id);
      if (!found) {
        fail({ message: t`This group no longer exists.`, toGroups: true });
        return "failed";
      }
      const conflicts = conflictingUserIds(group, found, edits);
      setLatest(found);
      setEdits((last) =>
        outstanding(found, {
          ...last,
          people: Object.fromEntries(
            Object.entries(last.people).filter(([userId]) => !conflicts.includes(userId)),
          ),
        }),
      );
      // A name typed as it was, or as it now is, is no rename to carry over.
      setTyped((last) =>
        last?.trim() === group.name || last?.trim() === found.name ? undefined : last,
      );
      if (conflicts.length > 0) {
        const whom = new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(
          conflicts.map(labelOf),
        );
        fail({
          message: t`Someone changed this group meanwhile: ${whom} is already in it in the other role, so that change was left out. Change their role below if you meant to, then save again.`,
        });
        return "conflicted";
      }
      return "reloaded";
    } catch (thrown) {
      // Signed out, or no longer administering: the page, read again, says so.
      if (thrown instanceof BraivoError && (thrown.status === 401 || thrown.status === 403)) {
        await router.invalidate();
        return "failed";
      }
      fail({ message: t`Could not reload the group. Try again.`, reload: true });
      return "failed";
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in the name from submitting.
    if (pending) return;
    const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
    const trimmed = name.trim();
    const problem =
      trimmed === ""
        ? t`Enter the group's name.`
        : trimmed.length > MAX_TITLE
          ? t`Keep the name to ${MAX_TITLE} characters.`
          : trimmed.includes("\u0000") || !trimmed.isWellFormed()
            ? t`Remove the characters in the name that are not text.`
            : undefined;
    if (problem) {
      input.setCustomValidity(problem);
      input.reportValidity();
      return;
    }
    // Never sent again unchecked: it may have landed, and someone may have changed it since.
    if (unconfirmed) return fail(unconfirmedRefusal);
    if (!change) {
      setOutcome(undefined);
      setAnnouncement(t`Nothing to save: the group is as shown.`);
      return;
    }

    setPending(true);
    setOutcome(undefined);
    const signal = withDeadline(undefined, REQUEST_DEADLINE_MS);
    const definition = sent ?? definitionOf(trimmed, edits);
    try {
      if (creating) {
        const groupId = await braivo.defineGroup(
          { organizationId, key, ...definition },
          { signal },
        );
        if (!mounted.current) return;
        await router.invalidate();
        // Left while the page was read again: stay where they went.
        if (!mounted.current) return;
        // Unblocked: saved, nothing is left to lose.
        await navigate({
          to: "/$organizationSlug/settings/groups/$groupId",
          params: { organizationSlug, groupId },
          ignoreBlocker: true,
        });
        return;
      }
      // The group as it now stands, the form's changes in it.
      setLatest(
        await braivo.changeGroup(
          { organizationId, groupId: props.group!.id, ...change },
          { signal },
        ),
      );
      setEdits(NO_EDITS);
      setTyped(undefined);
      setOutcome({ saved: true });
      // The tab's title names the group by the page's own read.
      void router.invalidate();
    } catch (thrown) {
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) return router.invalidate();
      if (thrown instanceof BraivoError && thrown.status === 409) {
        if (creating) {
          return fail({
            message: t`A group was already created from this form. Find it among the groups.`,
            toGroups: true,
          });
        }
        // Someone added a person the form adds, in the other role: reloading
        // shows them as they now are, says so, and leaves the addition out;
        // a failed reload offers to try again, which does the same.
        if ((await reconcile()) === "reloaded") {
          fail({
            message: t`Someone changed this group meanwhile. Check the group as it is now, then save again.`,
          });
        }
        return;
      }
      if (thrown instanceof BraivoError && thrown.status === 403) {
        // No longer administering: the page, read again, says so.
        return router.invalidate();
      }
      if (thrown instanceof BraivoError && thrown.status === 404) {
        return fail({ message: t`This group no longer exists.`, toGroups: true });
      }
      if (thrown instanceof BraivoError && thrown.status === 400) {
        // The name is checked here first: what is left is someone, or a
        // course, no longer the organization's since the page was read.
        // Refused, nothing was created: the form is theirs to change again,
        // under the same key, which a creation landing late still holds.
        setSent(undefined);
        return fail({
          message: t`Braivo refused this group: someone or a course in it is no longer the organization's. Remove them and save again, or reload the page to see who and what can be added, losing these changes.`,
        });
      }
      if (creating) {
        setSent(definition);
        return fail({
          message: t`Could not confirm the group was created. Try again: the same group is sent, and never created twice.`,
        });
      }
      fail(unconfirmedRefusal);
      setUnconfirmed(true);
    } finally {
      // Only now: a conflict's reload, under way until here, is part of this save.
      setPending(false);
    }
  }

  async function reload() {
    if (pending) return;
    setPending(true);
    const reloaded = await reconcile();
    setPending(false);
    if (reloaded === "failed") return;
    setUnconfirmed(false);
    // A conflict found by the reload stays said.
    setOutcome((last) => (last?.saved === false && !last.reload ? last : undefined));
    setAnnouncement(t`Reloaded. Your changes not yet in the group are still shown.`);
  }

  const people = (role: GroupRole) =>
    byName(role === "teacher" ? shown.teacherIds : shown.learnerIds);
  const teachers = people("teacher");
  const learners = people("learner");
  const removing = change?.remove !== undefined;

  return (
    <>
      {/* The way back to every group, above its heading (docs/apps.md). */}
      <Link
        to="/$organizationSlug/settings/groups"
        params={{ organizationSlug }}
        className="mb-2 inline-block text-sm text-muted-foreground underline"
      >
        <Trans>Groups</Trans>
      </Link>
      {/* The group's name as last saved, which a rename here changes. */}
      <Heading ref={heading} tabIndex={-1}>
        {creating ? <Trans>New group</Trans> : group.name}
      </Heading>
      <form onSubmit={save} aria-busy={pending}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>
              <Trans context="group">Name</Trans>
            </FieldLabel>
            <Input
              id={`${id}-name`}
              name="name"
              value={name}
              required
              maxLength={MAX_TITLE}
              readOnly={pending || sent !== undefined}
              autoComplete="off"
              aria-describedby={`${id}-name-hint`}
              onChange={(event) => {
                event.currentTarget.setCustomValidity("");
                const value = event.currentTarget.value;
                // Typed back as it was: nothing to rename, nor to carry onto a reload.
                setTyped(value);
                if (!unconfirmed) setOutcome(undefined);
              }}
            />
            <FieldDescription id={`${id}-name-hint`}>
              <Trans>For example, 7A · English.</Trans>
            </FieldDescription>
          </Field>
          {/* Held while saving, so what is saved is what is shown; the name, read-only, keeps its focus. */}
          <fieldset disabled={pending || sent !== undefined} className="contents">
            <FieldSeparator />
            <PeopleSection
              legend={<Trans>Teachers</Trans>}
              description={
                <Trans>They can read the progress of this group's learners in its courses.</Trans>
              }
              empty={<Trans>Add a teacher to make this group visible to them.</Trans>}
              ids={teachers}
              person={person}
              picker={
                <Picker
                  ref={teachersPicker}
                  label={t`Add teachers`}
                  search={t`Find a member`}
                  none={t`No member matches.`}
                  options={members.map(({ userId }) => ({
                    id: userId,
                    ...person(userId),
                    checked: teachers.includes(userId),
                    // Moved by their row's action, which says what changes.
                    taken: learners.includes(userId) ? t`Learner` : undefined,
                  }))}
                  onToggle={(userId, checked) => setRole(userId, checked ? "teacher" : null)}
                />
              }
              rowAction={(userId) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  ref={refocus(userId)}
                  aria-label={t`Change to learner: ${labelOf(userId)}`}
                  onClick={() => {
                    moved.current = userId;
                    setRole(userId, "learner");
                  }}
                >
                  <Trans>Change to learner</Trans>
                </Button>
              )}
              onRemove={(userId) => {
                setRole(userId, null);
                // Its row gone, the focus goes to adding, in the same section.
                teachersPicker.current?.focus();
              }}
            />
            <FieldSeparator />
            <PeopleSection
              legend={<Trans>Learners</Trans>}
              empty={<Trans>No learners yet.</Trans>}
              ids={learners}
              person={person}
              picker={
                <Picker
                  ref={learnersPicker}
                  label={t`Add learners`}
                  search={t`Find a member`}
                  none={t`No member matches.`}
                  options={members.map(({ userId }) => ({
                    id: userId,
                    ...person(userId),
                    checked: learners.includes(userId),
                    taken: teachers.includes(userId) ? t`Teacher` : undefined,
                  }))}
                  onToggle={(userId, checked) => setRole(userId, checked ? "learner" : null)}
                />
              }
              rowAction={(userId) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  ref={refocus(userId)}
                  aria-label={t`Change to teacher: ${labelOf(userId)}`}
                  onClick={() => {
                    moved.current = userId;
                    setRole(userId, "teacher");
                  }}
                >
                  <Trans>Change to teacher</Trans>
                </Button>
              )}
              onRemove={(userId) => {
                setRole(userId, null);
                learnersPicker.current?.focus();
              }}
              footer={
                <FieldDescription>
                  <Trans>
                    Only the organization's members can be added. Ask whoever runs Braivo for you to
                    add anyone missing first.
                  </Trans>{" "}
                  <Link
                    to="/$organizationSlug/settings/members"
                    params={{ organizationSlug }}
                    className="underline underline-offset-4"
                  >
                    <Trans>See members</Trans>
                  </Link>
                </FieldDescription>
              }
            />
            <FieldSeparator />
            <FieldSet>
              <SectionLegend count={shown.courseIds.length}>
                <Trans>Courses</Trans>
              </SectionLegend>
              <Rows
                ids={shown.courseIds.toSorted((a, b) =>
                  (titles.get(a) ?? a).localeCompare(titles.get(b) ?? b, i18n.locale),
                )}
                label={(courseId) => ({ name: titles.get(courseId) ?? courseId })}
                empty={<Trans>No courses yet.</Trans>}
                onRemove={(courseId) => {
                  setCourse(courseId, false);
                  coursesPicker.current?.focus();
                }}
              />
              {courses.length === 0 ? (
                <FieldDescription>
                  <Trans>
                    This organization has no courses yet: draft one from a source first.
                  </Trans>{" "}
                  <Link
                    to="/$organizationSlug/sources"
                    params={{ organizationSlug }}
                    className="underline underline-offset-4"
                  >
                    <Trans>See sources</Trans>
                  </Link>
                </FieldDescription>
              ) : (
                <Picker
                  ref={coursesPicker}
                  label={t`Add courses`}
                  search={t`Find a course`}
                  none={t`No course matches.`}
                  options={courses.map((course) => ({
                    id: course.id,
                    name: course.title,
                    checked: shown.courseIds.includes(course.id),
                  }))}
                  onToggle={setCourse}
                />
              )}
            </FieldSet>
          </fieldset>
          <FieldSeparator />
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">
              {teachers.length === 0 ? (
                <Trans>No teacher can read this group's progress yet.</Trans>
              ) : learners.length === 0 || shown.courseIds.length === 0 ? (
                // Incomplete: what is missing, rather than a count of nothing.
                <Trans>Its teachers will see no progress until it has learners and a course.</Trans>
              ) : (
                <Trans>
                  <Plural value={teachers.length} one="# teacher" other="# teachers" /> will be able
                  to read progress for{" "}
                  <Plural value={learners.length} one="# learner" other="# learners" /> in{" "}
                  <Plural value={shown.courseIds.length} one="# course" other="# courses" />.
                </Trans>
              )}
            </p>
            <p className="text-muted-foreground">
              <Trans>This does not change which courses learners can study.</Trans>
            </p>
            {removing && (
              <p className="text-muted-foreground">
                <Trans>
                  Removing someone keeps their learning history and their membership; another group
                  may still give the same access.
                </Trans>
              </p>
            )}
          </div>
        </FieldGroup>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {/* Unavailable, as said, until an unconfirmed change is reloaded. */}
          <Button type="submit" aria-disabled={pending || unconfirmed}>
            {pending && <Spinner data-icon="inline-start" aria-hidden="true" />}
            {creating ? <Trans>Create group</Trans> : <Trans>Save changes</Trans>}
          </Button>
          {/* Mounted empty: a status region shown already filled is not reliably announced. */}
          <p role="status" className="text-sm text-muted-foreground">
            {outcome?.saved ? (
              <Trans>Saved.</Trans>
            ) : (
              <span className="sr-only">{announcement}</span>
            )}
          </p>
        </div>
        {outcome?.saved === false && (
          <Alert key={outcome.count} variant="destructive" className="mt-4">
            <CircleAlertIcon />
            <AlertDescription className="wrap-break-word">
              <p>{outcome.message}</p>
              {outcome.reload && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  aria-disabled={pending}
                  onClick={reload}
                >
                  <Trans>Reload the group</Trans>
                </Button>
              )}
              {outcome.toGroups && (
                <Link
                  to="/$organizationSlug/settings/groups"
                  params={{ organizationSlug }}
                  className="underline underline-offset-4"
                >
                  <Trans>See groups</Trans>
                </Link>
              )}
            </AlertDescription>
          </Alert>
        )}
      </form>
    </>
  );
}

function SectionLegend({ count, children }: { count: number; children: ReactNode }) {
  return (
    <FieldLegend className="flex items-baseline gap-2">
      {children}
      <span className="text-sm font-normal text-muted-foreground tabular-nums">{count}</span>
    </FieldLegend>
  );
}

/** Teachers or learners: who is in the group in that role, and adding more. */
function PeopleSection(props: {
  legend: ReactNode;
  description?: ReactNode;
  empty: ReactNode;
  ids: string[];
  person: (userId: string) => { name: string; tag?: string };
  picker: ReactNode;
  rowAction: (userId: string) => ReactNode;
  onRemove: (userId: string) => void;
  footer?: ReactNode;
}) {
  return (
    <FieldSet>
      <SectionLegend count={props.ids.length}>{props.legend}</SectionLegend>
      {props.description && <FieldDescription>{props.description}</FieldDescription>}
      <Rows
        ids={props.ids}
        label={props.person}
        empty={props.empty}
        action={props.rowAction}
        onRemove={props.onRemove}
      />
      {props.picker}
      {props.footer}
    </FieldSet>
  );
}

/** What a section holds, one row each, with its actions: compact, never a wall of chips. */
function Rows(props: {
  ids: string[];
  label: (id: string) => { name: string; tag?: string };
  empty: ReactNode;
  action?: (id: string) => ReactNode;
  onRemove: (id: string) => void;
}) {
  const { t } = useLingui();
  if (props.ids.length === 0) {
    return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  }
  return (
    <ul className="divide-y rounded-2xl border">
      {props.ids.map((id) => {
        const { name, tag } = props.label(id);
        return (
          <li key={id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 ps-3 pe-1.5">
            <span className="min-w-0 grow basis-40 text-sm wrap-anywhere">
              {name}
              <NameTag tag={tag} />
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {props.action?.(id)}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                // Named with whom or what it removes: a button reached alone is not read with its row.
                aria-label={t`Remove ${nameWithTag(name, tag)}`}
                onClick={() => props.onRemove(id)}
              >
                <Trans>Remove</Trans>
              </Button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Adds to a section, searching what can be added: a list that stays open, each
 * chosen marked, chosen again to take it out. Someone already in the other
 * role is shown, but moved only by their row's action.
 */
function Picker({
  ref,
  ...props
}: {
  ref: Ref<HTMLButtonElement>;
  label: string;
  search: string;
  none: string;
  options: { id: string; name: string; tag?: string; checked: boolean; taken?: string }[];
  onToggle: (id: string, checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button ref={ref} type="button" variant="outline" size="sm" className="w-fit">
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          {props.label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <Command>
          <CommandInput placeholder={props.search} aria-label={props.search} />
          <CommandList>
            <CommandEmpty>{props.none}</CommandEmpty>
            <CommandGroup>
              {props.options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.id}
                  keywords={[option.name, ...(option.tag ? [option.tag] : [])]}
                  disabled={option.taken !== undefined}
                  data-checked={option.checked}
                  onSelect={() => props.onToggle(option.id, !option.checked)}
                >
                  <span className="min-w-0 wrap-anywhere">
                    {option.name}
                    <NameTag tag={option.tag} />
                  </span>
                  {option.taken && (
                    <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                      {option.taken}
                    </span>
                  )}
                  {/* Said, not only shown as a check: the list's own "selected"
                      is the highlighted item, which choosing toggles. */}
                  {option.checked && (
                    <span className="sr-only">
                      <Trans>(in this group)</Trans>
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
