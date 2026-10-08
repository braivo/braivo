// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError } from "@braivo/server/client";
import { Heading, MutedText } from "@braivo/ui";
import { Alert, AlertDescription } from "@braivo/ui/components/alert";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { Textarea } from "@braivo/ui/components/textarea";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type SubmitEvent, useId, useRef, useState } from "react";

import { useAbortOnUnmount } from "#lib/abort-on-unmount";
import { MAX_TITLE, titleProblem } from "#lib/limits";
import { explainAiProxyTimeout, orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/$organizationSlug/sources/")({
  loader: async ({ context, abortController }) => ({
    sources: await orNotFound(
      context.braivo.listSources(context.organization.id, { signal: abortController.signal }),
    ),
  }),
  head: (head) => pageHead(head, "Sources"),
  // Remounted for another organization, so no form or request carries over to it.
  remountDeps: ({ params }) => params,
  component: Sources,
  notFoundComponent: () => <p>This organization does not exist, or you do not manage it.</p>,
});

/**
 * An organization's material, and a way to add more: its text, which is what
 * Braivo grounds a course in, and optionally the file it came from
 * (docs/adr/0020-source-content.md, docs/adr/0028-original-files.md).
 */
function Sources() {
  const { sources } = Route.useLoaderData();
  const { organizationSlug } = Route.useParams();

  return (
    <>
      <Heading>Sources</Heading>
      {sources.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No material yet</EmptyTitle>
            <EmptyDescription>
              Add a lesson, a worksheet, or a video's transcript below. Courses are written from it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="mb-6 flex flex-col gap-2">
          {sources.map((source) => (
            <li key={source.id} className="flex flex-wrap items-center gap-2">
              <Link
                to="/$organizationSlug/sources/$sourceId"
                params={{ organizationSlug, sourceId: source.id }}
                className="underline"
              >
                {source.title}
              </Link>
              {source.language && <Badge variant="secondary">{source.language}</Badge>}
              {source.original && <Badge variant="outline">Original kept</Badge>}
            </li>
          ))}
        </ul>
      )}
      <AddSource />
    </>
  );
}

/** Braivo's limit on an uploaded file (docs/adr/0028-original-files.md). */
const MAX_FILE_BYTES = 50_000_000;

/**
 * Types Braivo refuses to upload, since a page elsewhere could send them
 * without asking (`isTrustedUpload`), whatever the file is.
 */
const REFUSED_TYPES = [
  "",
  "text/plain",
  "multipart/form-data",
  "application/x-www-form-urlencoded",
];

/**
 * Why Braivo's AI would refuse to read `file`, as the server's `readFileText`
 * does (generation-2), saying what to do instead. Checked before uploading, so
 * a file it refuses is not stored for nothing.
 */
function readingProblem(file: File): string | undefined {
  const instead = "or paste its text in the Text field.";
  if (file.type === "application/pdf") {
    if (file.size > 24_000_000) {
      return `Braivo's AI reads a PDF of at most 24 MB: split it, adding a chapter at a time, ${instead}`;
    }
  } else if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
    if (file.size > 7_500_000) {
      return `Braivo's AI reads an image of at most 7.5 MB: save it smaller, ${instead}`;
    }
  } else {
    return "Braivo's AI reads PDFs and PNG, JPEG, GIF, or WebP images. Paste this file's text or transcript in the Text field to keep the file as its original.";
  }
}

/**
 * Suggested for a source's language, as the tag Braivo stores (sources-3) with
 * its name: a teacher knows "Spanish", not `es`.
 */
const LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "pl", "uk", "nl", "sv", "zh", "ja", "ar"];
const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * Every two-letter tag by its English name, lowercase, as this browser names
 * it. Some list a suggestion's tag alone (iOS Safari), so a name typed in full
 * must work too, suggested or not. Deprecated tags canonicalize to the current
 * one (`mo` to `ro`); of two current tags an engine names alike (ICU 78: `ak`
 * and `tw`, "Akan"), the first, the macrolanguage, is kept.
 */
const TAG_BY_NAME = (() => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const byName = new Map<string, string>();
  for (const first of letters) {
    for (const second of letters) {
      const tag = first + second;
      const name = languageNames.of(tag)?.toLowerCase();
      if (name && !byName.has(name)) {
        byName.set(name, Intl.getCanonicalLocales(tag)[0]!);
      }
    }
  }
  return byName;
})();
/** A language named in full as its tag; anything else as typed, for Braivo to judge. */
const languageTag = (typed?: string) => typed && (TAG_BY_NAME.get(typed.toLowerCase()) ?? typed);

/**
 * A title from a file's name: without its extension, underscores read as
 * spaces ("Unidad_1.pdf" is "Unidad 1").
 */
function titleOf(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "") || fileName;
  return stem.replaceAll("_", " ").replace(/\s+/g, " ").trim();
}

function AddSource() {
  const { braivo, organization } = Route.useRouteContext();
  const organizationId = organization.id;
  const router = useRouter();
  // The step under way while adding: reading a file can take a few minutes.
  const [status, setStatus] = useState<string>();
  const adding = status !== undefined;
  const [error, setError] = useState<string>();
  const id = useId();
  const original = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLInputElement>(null);
  // Whether the title was filled in from a file's name and not edited since,
  // so the next file's may replace it; one typed is never replaced.
  const titleFromFile = useRef(false);
  // The last file read and its pages: correcting a refused title or language
  // and sending again does not pay for reading the same file twice.
  const read = useRef<{ fileId: string; pages: { page: string; text: string }[] }>(undefined);
  const abortOnUnmount = useAbortOnUnmount();

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    // aria-disabled does not stop Enter in a field from submitting the form.
    if (adding) return;
    const data = new FormData(event.currentTarget);
    // Left out when blank: Braivo refuses an empty link or language.
    const optional = (name: string) => (data.get(name) as string).trim() || undefined;
    const file = original.current?.files?.[0];
    // `required` lets a blank title through, which Braivo would refuse only
    // after the upload and the reading.
    const titled = titleProblem(data.get("title") as string, "the material");
    if (titled) return setError(titled);
    // Said before sending: Braivo would answer both with a bare status.
    if (file && REFUSED_TYPES.includes(file.type)) {
      return setError(
        "The original file must be a PDF, a document, or an image; plain text goes in the Text field.",
      );
    }
    if (file && file.size > MAX_FILE_BYTES) {
      return setError("The original file is larger than 50 MB.");
    }
    const text = data.get("text") as string;
    if (text.trim() === "" && !file) {
      return setError("Paste the material's text, or attach the file for Braivo's AI to read.");
    }
    // Only without pasted text: beside it, the file is kept unread.
    const unreadable = text.trim() === "" && file ? readingProblem(file) : undefined;
    if (unreadable) return setError(unreadable);

    const signal = abortOnUnmount();
    // The page, as `remountDeps` tells pages apart: a changed hash is no leaving.
    const from = router.latestLocation.pathname;
    setStatus(file ? "Uploading the file…" : "Adding…");
    setError(undefined);
    try {
      // The file first, so the source can name it; the same file again is stored once.
      // Aborted too on leaving: a file uploaded for nobody stays stored, since nothing deletes files.
      const fileId = file
        ? (await braivo.uploadFile({ organizationId, file }, { signal })).fileId
        : undefined;
      const source = {
        organizationId,
        title: data.get("title") as string,
        url: optional("url"),
        language: languageTag(optional("language")),
        original: fileId,
      };
      // No text pasted: the file's own, read page by page, so passages name their pages.
      let pages: { page: string; text: string }[] | undefined;
      if (fileId && text.trim() === "") {
        if (read.current?.fileId !== fileId) {
          setStatus("Braivo's AI is reading the file, which can take a few minutes…");
          read.current = {
            fileId,
            pages: await explainAiProxyTimeout(
              braivo.readFileText({ organizationId, fileId }, { signal }),
            ),
          };
        }
        pages = read.current.pages;
      }
      setStatus("Adding…");
      const sourceId = await braivo.addSource(pages ? { ...source, pages } : { ...source, text });
      // To the source's page, where a course is drafted from it, unless the
      // owner left meanwhile: added anyway, it is listed.
      if (signal?.aborted || router.latestLocation.pathname !== from) return;
      await router.navigate({
        to: "/$organizationSlug/sources/$sourceId",
        params: { organizationSlug: organization.slug, sourceId },
      });
    } catch (thrown) {
      if (signal?.aborted) return;
      // Braivo's own words when it gave any: which field, and what would fix it.
      setError(
        (thrown instanceof BraivoError && thrown.reason) ||
          "The material could not be added. Try again.",
      );
    } finally {
      setStatus(undefined);
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-heading`}>
      <Heading level={2} id={`${id}-heading`}>
        Add material
      </Heading>
      {/* Read-only while sending, as what is typed meanwhile would not be what
          was added; not disabled, which drops the focus. */}
      <FieldSet>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
            <Input
              id={`${id}-title`}
              ref={title}
              name="title"
              // `onInput`, not `onChange`, which React skips when what is typed
              // equals the value a file's name set.
              onInput={() => (titleFromFile.current = false)}
              required
              maxLength={MAX_TITLE}
              readOnly={adding}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-text`}>Text</FieldLabel>
            <Textarea
              id={`${id}-text`}
              name="text"
              rows={10}
              readOnly={adding}
              aria-describedby={`${id}-text-hint`}
            />
            <FieldDescription id={`${id}-text-hint`}>
              The material's words as they read: what questions will quote. Paste them, or leave
              this empty and attach the PDF or a photo below for Braivo's AI to read — which can
              take a few minutes.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-url`}>Link</FieldLabel>
            <Input
              id={`${id}-url`}
              name="url"
              type="url"
              readOnly={adding}
              aria-describedby={`${id}-url-hint`}
            />
            <FieldDescription id={`${id}-url-hint`}>
              Where it is online, such as a YouTube video. Optional.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-language`}>Language</FieldLabel>
            <Input
              id={`${id}-language`}
              name="language"
              list={`${id}-languages`}
              readOnly={adding}
              aria-describedby={`${id}-language-hint`}
            />
            <datalist id={`${id}-languages`}>
              {LANGUAGES.map((tag) => (
                <option key={tag} value={tag}>
                  {languageNames.of(tag)}
                </option>
              ))}
            </datalist>
            <FieldDescription id={`${id}-language-hint`}>
              Its language, such as Spanish, or a tag such as es or en-US. Optional.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-original`}>Original file</FieldLabel>
            <Input
              id={`${id}-original`}
              ref={original}
              type="file"
              // A file input cannot be read-only.
              disabled={adding}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                const field = title.current;
                if (!file || !field) return;
                if (field.value.trim() !== "" && !titleFromFile.current) return;
                field.value = titleOf(file.name);
                titleFromFile.current = true;
              }}
              accept="application/pdf,image/*,audio/*,video/*,.docx,.pptx,.odt,.odp,.epub"
              aria-describedby={`${id}-original-hint`}
            />
            <FieldDescription id={`${id}-original-hint`}>
              The PDF or slides the text is from, kept with it. Optional; at most 50 MB.
            </FieldDescription>
          </Field>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Field>
            <Button type="submit" aria-disabled={adding}>
              Add material
            </Button>
          </Field>
        </FieldGroup>
      </FieldSet>
      {/* One line: the step under way while adding, in a live region present
          from the start so the change is announced. */}
      <MutedText role="status">
        {status ?? "Adding the same material again adds nothing."}
      </MutedText>
    </form>
  );
}
