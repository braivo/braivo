// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { Badge } from "@braivo/ui/components/badge";
import { Button } from "@braivo/ui/components/button";
import { Checkbox } from "@braivo/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@braivo/ui/components/field";
import { Input } from "@braivo/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@braivo/ui/components/radio-group";
import { Textarea } from "@braivo/ui/components/textarea";
import { memo, type ReactNode, useCallback, useEffect, useState } from "react";

import type { Outcome } from "#lib/pdf/read";
import {
  type ChangeReview,
  numberFrom,
  type ReviewedPage,
  type ReviewField,
} from "#lib/pdf/review";

const BADGES: Record<Outcome, string> = {
  text: "Read",
  doubtful: "To check",
  "no-text": "No text found",
  failed: "Could not be read",
};

const NOTES: Record<Exclude<Outcome, "text">, string> = {
  doubtful:
    "Its text may not be what the page shows, as on a scan with a line of typed text: check it against the PDF and correct it, or leave the page out.",
  "no-text":
    "The PDF has no text on this page, as on a scan or a picture: paste its text to keep it, or leave it out.",
  failed: "This page could not be read: paste its text to keep it, or leave it out.",
};

/** "3 pages: 1 read, 1 to check, 1 without text", leaving out what is none. */
export function readSummary(pages: readonly ReviewedPage[]): string {
  const count = (...outcomes: Outcome[]) =>
    pages.filter((page) => outcomes.includes(page.outcome)).length;
  const parts = [
    [count("text"), "read"],
    [count("doubtful", "failed"), "to check"],
    [count("no-text"), "without text"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return `${pages.length} ${pages.length === 1 ? "page" : "pages"}: ${said.join(", ")}.`;
}

type FormError = { message: ReactNode; field?: string; count: number };

/**
 * The pages a PDF's text layer gave, for the owner to correct and decide on
 * before they are saved as a source (sources-23): the label of the first page,
 * numbering the rest from it; a list of the pages, all or those flagged; and
 * one page's printed label, text, and Keep or Leave out at a time, with
 * Previous and Next. Edits stay with their page when moving. `current` is the
 * page shown, the form's to set too, as a refusal shows the page it is about;
 * `error` is the form's, said under the control it is about.
 */
export function PdfReview(props: {
  id: string;
  file: File;
  pages: ReviewedPage[];
  onChange: ChangeReview;
  current: number;
  onSelect: (position: number) => void;
  /** While saving: what is shown is what is sent. */
  locked: boolean;
  error?: FormError;
  /** Where Braivo's AI is on: reading the whole file with it instead. */
  readWithAi?: () => void;
}) {
  const { id, pages, locked, error, onChange, current, onSelect } = props;
  const [first, setFirst] = useState("");
  const flagged = pages.filter((page) => page.outcome !== "text");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const listed = onlyFlagged && flagged.length > 0 ? flagged : pages;
  // The file in the browser's own viewer, at a page: what the reader doubted is
  // checked against the page itself, which only a person can do.
  const [href, setHref] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(props.file);
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [props.file]);
  const edit = useCallback(
    (position: number, edit: Partial<ReviewedPage>) =>
      !locked &&
      onChange((pages) =>
        pages.map((page) => (page.position === position ? { ...page, ...edit } : page)),
      ),
    [locked, onChange],
  );
  const page = pages.find((page) => page.position === current) ?? pages[0]!;
  // Previous and Next go through the pages listed; from a page outside them, the nearest.
  const before = listed.findLast((listed) => listed.position < page.position);
  const after = listed.find((listed) => listed.position > page.position);

  return (
    <section aria-labelledby={`${id}-review`} className="flex flex-col gap-6">
      <div>
        {/* Focused when the review opens: what comes next. */}
        <Heading level={3} id={`${id}-review`} tabIndex={-1}>
          Review the pages
        </Heading>
        <MutedText>
          {readSummary(pages)} Correct what was read wrong; nothing is saved until you save the
          source.
        </MutedText>
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-first`}>The first page is printed page</FieldLabel>
        <Input
          id={`${id}-first`}
          type="number"
          min={1}
          max={999_999}
          step={1}
          className="w-32"
          value={first}
          readOnly={locked}
          onChange={(event) => {
            const typed = event.currentTarget.value;
            setFirst(typed);
            onChange((pages) => numberFrom(pages, typed));
          }}
          aria-describedby={`${id}-first-hint`}
        />
        <FieldDescription id={`${id}-first-hint`}>
          Numbers the pages from it. Left blank, pages keep the numbers the PDF gives them, or their
          place from 1. Each can still be changed on its page.
        </FieldDescription>
      </Field>
      {props.readWithAi && (
        <Field>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-9 self-start py-1.5 whitespace-normal"
            aria-disabled={locked}
            onClick={() => !locked && props.readWithAi?.()}
            aria-describedby={`${id}-ai-hint`}
          >
            Read the whole file with AI instead
          </Button>
          <FieldDescription id={`${id}-ai-hint`}>
            For a scan: Braivo's AI reads every page, which can take a few minutes. This review is
            kept until its reading succeeds.
          </FieldDescription>
        </Field>
      )}
      {/* The list above the page on a phone, beside it from md. */}
      <div className="flex flex-col gap-6 md:grid md:grid-cols-[14rem_1fr] md:items-start">
        <nav aria-label="Pages" className="flex flex-col gap-2">
          {flagged.length > 0 && (
            <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
              <Checkbox
                checked={onlyFlagged}
                onCheckedChange={(checked) => setOnlyFlagged(checked === true)}
              />
              Needs a decision ({flagged.length})
            </label>
          )}
          <ol className="flex max-h-72 flex-col overflow-y-auto rounded-md border md:max-h-[32rem]">
            {listed.map((listed) => (
              <li key={listed.position}>
                <button
                  type="button"
                  aria-current={listed.position === page.position ? "page" : undefined}
                  onClick={() => onSelect(listed.position)}
                  className="flex min-h-11 w-full flex-wrap items-center gap-x-2 px-3 py-1.5 text-start text-sm aria-[current=page]:bg-muted aria-[current=page]:font-semibold md:min-h-0"
                >
                  <span>Page {listed.position}</span>
                  <span className="text-muted-foreground">
                    <span className="sr-only">, printed</span> p. {listed.label}
                  </span>
                  {listed.outcome !== "text" && (
                    <span className="text-muted-foreground">
                      <span className="sr-only">,</span> {BADGES[listed.outcome]}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    <span className="sr-only">,</span>{" "}
                    {listed.keep === undefined ? "undecided" : listed.keep ? "kept" : "left out"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex flex-col gap-4">
          <ReviewPage
            id={id}
            page={page}
            href={href}
            locked={locked}
            onEdit={edit}
            error={error?.field?.startsWith(`page-${page.position}-`) ? error : undefined}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              aria-disabled={!before}
              onClick={() => before && onSelect(before.position)}
            >
              Previous page
            </Button>
            <Button
              type="button"
              variant="outline"
              aria-disabled={!after}
              onClick={() => after && onSelect(after.position)}
            >
              Next page
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

const ReviewPage = memo(function ReviewPage(props: {
  id: string;
  page: ReviewedPage;
  href?: string;
  locked: boolean;
  onEdit: (position: number, edit: Partial<ReviewedPage>) => void;
  error?: FormError;
}) {
  const { id, page, locked, error, onEdit } = props;
  const key = `${id}-page-${page.position}`;
  /** ARIA and the message for the control `field`, while the failure is about it. */
  const invalid = (field: ReviewField, hintId?: string) =>
    error?.field === field
      ? {
          aria: { "aria-invalid": true, "aria-describedby": `${hintId ?? ""} ${id}-error`.trim() },
          message: (
            <FieldError key={error.count} id={`${id}-error`}>
              {error.message}
            </FieldError>
          ),
        }
      : { aria: hintId ? { "aria-describedby": hintId } : {}, message: undefined };
  const label = invalid(`page-${page.position}-label`);
  const text = invalid(
    `page-${page.position}-text`,
    page.outcome === "text" ? undefined : `${key}-note`,
  );
  const keep = invalid(`page-${page.position}-keep`);
  return (
    <FieldSet>
      <FieldLegend className="flex flex-wrap items-center gap-x-2">
        Page {page.position}
        <Badge variant={page.outcome === "text" ? "secondary" : "outline"}>
          {BADGES[page.outcome]}
        </Badge>
      </FieldLegend>
      {page.outcome !== "text" && (
        <FieldDescription id={`${key}-note`}>
          {NOTES[page.outcome]}{" "}
          <a
            href={props.href && `${props.href}#page=${page.position}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Open page {page.position} of the PDF
          </a>
        </FieldDescription>
      )}
      <Field data-invalid={Boolean(label.message) || undefined}>
        <FieldLabel htmlFor={`${key}-label`}>
          Printed page<span className="sr-only"> of page {page.position}</span>
        </FieldLabel>
        <Input
          id={`${key}-label`}
          className="w-32"
          value={page.label}
          readOnly={locked}
          onChange={(event) => onEdit(page.position, { label: event.currentTarget.value })}
          {...label.aria}
        />
        {label.message}
      </Field>
      <Field data-invalid={Boolean(text.message) || undefined}>
        <FieldLabel htmlFor={`${key}-text`}>
          Text<span className="sr-only"> of page {page.position}</span>
        </FieldLabel>
        <Textarea
          id={`${key}-text`}
          rows={6}
          value={page.text}
          readOnly={locked}
          onChange={(event) => onEdit(page.position, { text: event.currentTarget.value })}
          {...text.aria}
        />
        {text.message}
      </Field>
      <Field data-invalid={Boolean(keep.message) || undefined}>
        <RadioGroup
          aria-label={`Page ${page.position}`}
          value={page.keep === undefined ? "" : page.keep ? "keep" : "leave"}
          onValueChange={(value) => onEdit(page.position, { keep: value === "keep" })}
          className="flex flex-wrap gap-x-6 gap-y-0 md:gap-y-3"
          {...keep.aria}
        >
          {(["keep", "leave"] as const).map((value) => (
            <div key={value} className="flex items-center gap-2">
              {/* Keep is where a missing decision sends the focus. */}
              <RadioGroupItem value={value} id={`${key}-${value}`} />
              <FieldLabel htmlFor={`${key}-${value}`} className="min-h-11 font-normal md:min-h-0">
                {value === "keep" ? "Keep" : "Leave out"}
              </FieldLabel>
            </div>
          ))}
        </RadioGroup>
        {keep.message}
      </Field>
    </FieldSet>
  );
});
