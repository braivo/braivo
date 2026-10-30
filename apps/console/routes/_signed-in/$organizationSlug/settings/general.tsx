// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type ToolsReadLearnerData } from "@braivo/server/client";
import { Heading } from "@braivo/ui";
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
} from "@braivo/ui/components/alert-dialog";
import { Button } from "@braivo/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { Spinner } from "@braivo/ui/components/spinner";
import { Switch } from "@braivo/ui/components/switch";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { NoSuchSetting } from "#components/no-such-setting";
import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { administratorsOnly } from "#lib/refusals";
import { pageHead } from "#lib/title";

/** The server's limit on an organization's name, as setup's. */
const MAX_NAME_LENGTH = 100;

/**
 * The organization's own settings: its name, which learners see on its learn
 * domain, its console address, which cannot change yet (ADR 0004), and
 * whether tools read its learners' data (ADR 0050).
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/general")({
  beforeLoad: administratorsOnly,
  // Read here, not from the organizations listed to every member: it names
  // who changed it. Not awaited, so the name shows at once; a read failed or
  // unanswered is `undefined`, unknown, never taken for off.
  loader: ({ context, abortController }) => ({
    toolsSetting: context.braivo
      .readToolsReadLearnerData(context.organization.id, {
        signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS),
      })
      .then(
        (setting) => setting,
        () => undefined,
      ),
  }),
  head: (head) => pageHead(head, t`General`),
  // A page per organization: switching carries over nothing typed or saving.
  remountDeps: ({ params }) => params.organizationSlug,
  component: General,
  notFoundComponent: NoSuchSetting,
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
      <ToolsSetting />
    </>
  );
}

/**
 * Whether tools read the organization's learners' data (ADR 0050), and who
 * last changed it. Shown only once read: an unknown value is never shown as
 * off. Turning it on asks first; turning it off, which only stops further
 * reads, applies at once.
 */
function ToolsSetting() {
  const { braivo, organization } = Route.useRouteContext();
  const { toolsSetting } = Route.useLoaderData();
  const router = useRouter();
  const { i18n } = useLingui();
  const id = useId();
  const [setting, setSetting] = useState<ToolsReadLearnerData | "loading" | "failed">("loading");
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  // A ref, set at once, refuses a second request before `pending` renders.
  const sending = useRef(false);
  // Once a save is sent, its answer is this page's word until reloaded: a
  // read the page makes meanwhile or after (a rename's) may hold the value it
  // replaced, with nothing telling which began first.
  const saveSent = useRef(false);
  const toggle = useRef<HTMLButtonElement>(null);
  // Cleared as each save starts, so a repeated failure mounts a new alert.
  // Unconfirmed: no answer, or the server's failure, which may follow the change.
  const [outcome, setOutcome] = useState<"saved" | "refused" | "unconfirmed">();
  useEffect(() => {
    let current = true;
    void toolsSetting.then((read) => current && !saveSent.current && setSetting(read ?? "failed"));
    return () => {
      current = false;
    };
  }, [toolsSetting]);

  async function save(allowed: boolean) {
    if (sending.current) return;
    sending.current = true;
    saveSent.current = true;
    setPending(true);
    setOutcome(undefined);
    try {
      // Bounded: retried after a lost answer, it changes nothing again.
      const saved = await braivo.setToolsReadLearnerData(organization.id, allowed, {
        signal: withDeadline(undefined, REQUEST_DEADLINE_MS),
      });
      setSetting(saved);
      setOutcome("saved");
    } catch (thrown) {
      // Signed out meanwhile: the guard's check, run again, sends them to sign in.
      if (thrown instanceof BraivoError && thrown.status === 401) return router.invalidate();
      const refused = thrown instanceof BraivoError && thrown.status < 500;
      setOutcome(refused ? "refused" : "unconfirmed");
      // Perhaps no longer managing it: if so, the page, read again, says so.
      if (thrown instanceof BraivoError && thrown.status === 403) await router.invalidate();
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  if (setting === "loading") return null;
  if (setting === "failed") {
    return (
      <Alert variant="destructive" className="mt-8">
        <CircleAlertIcon />
        <AlertDescription>
          <Trans>
            Could not load whether tools read learners' data. Reload the page to try again.
          </Trans>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mt-8">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-tools`}>
            <Trans>Let tools read learners' data</Trans>
          </FieldLabel>
          <FieldDescription id={`${id}-tools-hint`}>
            <Trans>
              Tools your organization's members connect, such as the braivo CLI, can then read
              learners' names, progress, and learning history. An AI app that receives this data may
              send it to its provider. Turning this off stops further reads, but cannot recall what
              a tool already received.
            </Trans>
          </FieldDescription>
          {setting.changedAt !== null && (
            // A name is one long word at times: it wraps rather than pushing the switch out.
            <FieldDescription id={`${id}-tools-record`} className="wrap-anywhere">
              <ChangeRecord setting={setting} locale={i18n.locale} />
            </FieldDescription>
          )}
        </FieldContent>
        <Switch
          ref={toggle}
          id={`${id}-tools`}
          checked={setting.allowed}
          // Focusable while saving, doing nothing.
          aria-disabled={pending || undefined}
          aria-describedby={
            setting.changedAt === null ? `${id}-tools-hint` : `${id}-tools-hint ${id}-tools-record`
          }
          onCheckedChange={(allowed) => {
            if (pending) return;
            if (allowed) setAsking(true);
            else void save(false);
          }}
        />
      </Field>
      {/* Mounted before it says anything: a status region shown already
          filled is not reliably announced. */}
      <p role="status" className="mt-3 text-sm text-muted-foreground empty:mt-0">
        {pending ? <Trans>Saving…</Trans> : outcome === "saved" && <Trans>Saved.</Trans>}
      </p>
      {(outcome === "refused" || outcome === "unconfirmed") && (
        <Alert variant="destructive" className="mt-4">
          <CircleAlertIcon />
          <AlertDescription>
            {outcome === "refused" ? (
              <Trans>Could not save whether tools read learners' data. Try again.</Trans>
            ) : (
              <Trans>
                Could not confirm the change; it may have been saved. Reload the page to check.
              </Trans>
            )}
          </AlertDescription>
        </Alert>
      )}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent
          // Back on the switch, which opened it without being its trigger.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            toggle.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Let tools read learners' data?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Tools your organization's members connect, such as the braivo CLI, will be able to
                read learners' names, progress, and learning history. An AI app that receives this
                data may send it to its provider. Turning this off later stops further reads, but
                cannot recall what a tool already received.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep it off</Trans>
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void save(true)}>
              <Trans>Turn on</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Who last changed the setting, and when; the date alone once their account is gone. */
function ChangeRecord({ setting, locale }: { setting: ToolsReadLearnerData; locale: string }) {
  // Named, so a translator sees `{name}` and `{date}`.
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
    new Date(setting.changedAt!),
  );
  const name = setting.changedBy?.name;
  if (name === undefined) {
    return setting.allowed ? <Trans>Turned on {date}.</Trans> : <Trans>Turned off {date}.</Trans>;
  }
  return setting.allowed ? (
    <Trans>
      Turned on by {name} on {date}.
    </Trans>
  ) : (
    <Trans>
      Turned off by {name} on {date}.
    </Trans>
  );
}
