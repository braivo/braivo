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
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";

import { useAbortOnUnmount } from "#lib/abort-on-unmount";
import { MAX_TITLE } from "#lib/limits";
import { orNotFound } from "#lib/refusals";
import { pageHead } from "#lib/title";

export const Route = createFileRoute("/_signed-in/$organizationSlug/sources/")({
  loader: async ({ context, abortController }) => ({
    sources: await orNotFound(
      context.braivo.listSources(context.organization.id, { signal: abortController.signal }),
    ),
  }),
  head: (head) => pageHead(head, "Sources"),
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

function AddSource() {
  const { braivo, organization } = Route.useRouteContext();
  const organizationId = organization.id;
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const original = useRef<HTMLInputElement>(null);
  // The last file read and its pages: correcting a refused title or language
  // and sending again does not pay for reading the same file twice.
  const read = useRef<{ fileId: string; pages: { page: string; text: string }[] }>(undefined);
  const abortOnUnmount = useAbortOnUnmount();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    // Left out when blank: Braivo refuses an empty link or language.
    const optional = (name: string) => (data.get(name) as string).trim() || undefined;
    const file = original.current?.files?.[0];
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

    const signal = abortOnUnmount();
    setAdding(true);
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
        language: optional("language"),
        original: fileId,
      };
      // No text pasted: the file's own, read page by page, so passages name their pages.
      let sourceId: string;
      if (fileId && text.trim() === "") {
        if (read.current?.fileId !== fileId) {
          const pages = await braivo.readFileText({ organizationId, fileId }, { signal });
          read.current = { fileId, pages };
        }
        sourceId = await braivo.addSource({ ...source, pages: read.current.pages });
      } else {
        sourceId = await braivo.addSource({ ...source, text });
      }
      // To the source's page, where a course is drafted from it.
      await navigate({
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
      setAdding(false);
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-heading`}>
      <Heading level={2} id={`${id}-heading`}>
        Add material
      </Heading>
      {/* Disabled while sending: what is typed meanwhile would not be what was added. */}
      <FieldSet disabled={adding}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
            <Input id={`${id}-title`} name="title" required maxLength={MAX_TITLE} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-text`}>Text</FieldLabel>
            <Textarea
              id={`${id}-text`}
              name="text"
              rows={10}
              aria-describedby={`${id}-text-hint`}
            />
            <FieldDescription id={`${id}-text-hint`}>
              The material's words as they read: what questions will quote. Paste them, or leave
              this empty and attach the PDF or a photo below for Braivo's AI to read — which can
              take a minute.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-url`}>Link</FieldLabel>
            <Input id={`${id}-url`} name="url" type="url" aria-describedby={`${id}-url-hint`} />
            <FieldDescription id={`${id}-url-hint`}>
              Where it is online, such as a YouTube video. Optional.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-language`}>Language</FieldLabel>
            <Input id={`${id}-language`} name="language" aria-describedby={`${id}-language-hint`} />
            <FieldDescription id={`${id}-language-hint`}>
              A language tag, such as es or en-US. Optional.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-original`}>Original file</FieldLabel>
            <Input
              id={`${id}-original`}
              ref={original}
              type="file"
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
            <Button type="submit" disabled={adding}>
              Add material
            </Button>
          </Field>
        </FieldGroup>
      </FieldSet>
      <MutedText>Adding the same material again adds nothing.</MutedText>
    </form>
  );
}
