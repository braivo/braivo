// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "#lib/utils";

/**
 * Words quoted from a source, and where they are from: what a learner reads to
 * see why an answer is the answer, and what a content owner reviews to check a
 * citation. The source's title links to it when it has a link, in a new tab,
 * so the learner does not lose their place.
 *
 * With `at`, the words are said at that second of a recording: the caption
 * says when, and the link opens the recording there. With `page`, they are on
 * that page of a book: the caption says which, and the link is left as it is,
 * since a PDF's `#page=` counts sheets, not the numbers printed on them.
 */
export function SourcePassage(props: {
  quote: string;
  title: string;
  /** Only `http` or `https`; Braivo refuses any other link on a source. */
  url?: string;
  /** Seconds from the start of the recording the words are said at. */
  at?: number;
  /** The page the words are on, labelled as printed: `12`, `iv`. */
  page?: string;
  className?: string;
}) {
  const { quote, title, url, at, page, className } = props;
  const label =
    at !== undefined
      ? `${title} · ${clock(at)}`
      : page !== undefined
        ? `${title} · p. ${page}`
        : title;

  return (
    <figure className={cn("flex flex-col gap-1", className)}>
      <blockquote className="border-l-2 pl-3 whitespace-pre-line italic">{quote}</blockquote>
      <figcaption className="pl-3 text-sm text-muted-foreground">
        {url === undefined ? (
          label
        ) : (
          <a
            href={at === undefined ? url : atMoment(url, at)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            {label}
          </a>
        )}
      </figcaption>
    </figure>
  );
}

/** `1:05`, or `1:02:05` past an hour: how players show a moment. */
function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const [hours, minutes, rest] = [
    Math.floor(whole / 3600),
    Math.floor(whole / 60) % 60,
    whole % 60,
  ];
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * The recording's link, opening at `seconds`: YouTube's own parameters for a
 * YouTube video — `start` for its embedded player, which ignores `t`, and `t`
 * for everything else of YouTube's — and otherwise a media fragment, `#t=`,
 * which browsers honour for a video file and other players ignore harmlessly.
 * Whatever moment the link already named is replaced.
 */
function atMoment(url: string, seconds: number): string {
  const link = new URL(url);
  const whole = Math.floor(seconds);
  const host = link.hostname.replace(/^(www|m)\./, "");
  if (
    (host === "youtube.com" || host === "youtube-nocookie.com") &&
    link.pathname.startsWith("/embed/")
  ) {
    link.searchParams.delete("t");
    link.searchParams.set("start", String(whole));
  } else if (host === "youtube.com" || host === "youtu.be") {
    link.searchParams.delete("start");
    link.searchParams.set("t", `${whole}s`);
  } else {
    link.hash = `t=${whole}`;
  }
  return link.toString();
}
