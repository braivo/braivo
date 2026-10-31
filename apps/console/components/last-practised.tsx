// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { calendarDayIn } from "@braivo/server/client";
import { Plural, Trans, useLingui } from "@lingui/react/macro";

import { practiceWindow } from "#lib/practice-window";

/**
 * When a learner last answered a question here on the course's objectives
 * (progress-17), in the reader's time zone as of the response's `asOf`, never
 * the device's clock, so a page kept open overnight still says what it said:
 * "today", "yesterday", "3 days ago" within the practice window, the date
 * before it.
 * `detailed`, as a report says it, adds the date and time to a relative day,
 * and the time to a date.
 */
export function LastPractised(props: { at: string | null; asOf: string; detailed?: boolean }) {
  const { i18n } = useLingui();
  const { at, asOf, detailed } = props;
  const { timeZone, calendarDaysAgo, recencyOf } = practiceWindow(asOf);
  if (at === null) {
    return detailed ? (
      <Trans>No practice recorded yet on this course's objectives</Trans>
    ) : (
      <Trans>No practice recorded yet</Trans>
    );
  }
  const dayOf = calendarDayIn(timeZone);
  const days = calendarDaysAgo(at);
  const exact = new Intl.DateTimeFormat(i18n.locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
  // Within the window, as the counts classify it; beyond it, a date.
  const relative = recencyOf(at) === "recent";
  const date = new Intl.DateTimeFormat(i18n.locale, {
    timeZone,
    day: "numeric",
    month: "short",
    // The year only when it is not `asOf`'s.
    ...(dayOf(new Date(at)).slice(0, 4) !== dayOf(new Date(asOf)).slice(0, 4) && {
      year: "numeric",
    }),
  }).format(new Date(at));
  const when = (
    <time dateTime={at} title={exact}>
      {relative ? (
        <Plural
          value={days}
          _0="Last practised today"
          _1="Last practised yesterday"
          other="Last practised # days ago"
        />
      ) : detailed ? (
        <Trans>Last practised {exact}</Trans>
      ) : (
        <Trans>Last practised {date}</Trans>
      )}
    </time>
  );
  return detailed && relative ? (
    <Trans>
      {when} ({exact})
    </Trans>
  ) : (
    when
  );
}
