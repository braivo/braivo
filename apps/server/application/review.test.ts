// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { organizationDomain } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { joinCues, joinPages } from "../content/index.ts";
import {
  createCitations,
  createCourse,
  createObjectives,
  createSource,
  markPublished,
  recordEvidence,
  updateCourseHidden,
} from "../persistence/index.ts";
import type { RequestHost } from "./host.ts";
import { reviewObjective } from "./review.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "review-test-org";
const otherOrganizationId = "review-test-other-org";
const learner = "review-test-learner";
/** A member of another organization only. */
const outsider = "review-test-outsider";
const installation: RequestHost = { hostname: "localhost", installation: true };
const otherDomain: RequestHost = { hostname: "review-test.example.com", installation: false };
const ago = (ms: number) => new Date(Date.now() - ms);

let pastSimple!: string;
/** In the course, citing nothing. */
let uncited!: string;
/** In the organization, in no course of the learner's. */
let elsewhere!: string;
/** Cites a recording alone. */
let spoken!: string;
let courseId!: string;

function review(
  objectiveId: string,
  options: { learnerId?: string; course?: string; host?: RequestHost } = {},
) {
  return reviewObjective({
    database,
    learnerId: options.learnerId ?? learner,
    courseId: options.course ?? courseId,
    objectiveId,
    host: options.host ?? installation,
    now: new Date(),
  });
}

/** The learner's answer on `objectiveId`, as an attempt or another grader records it. */
function answered(objectiveId: string, id = `evidence:${objectiveId}`, learnerId = learner) {
  return recordEvidence(database, { learnerId, organizationId }, [
    { id, objectiveId, outcome: "failure", at: ago(1000) },
  ]);
}

/** Cites `quote`, found in `text`, from `sourceId` for `objectiveId`, published `at` or pending. */
function cite(objectiveId: string, sourceId: string, text: string, quote: string, at?: Date) {
  // Fixtures are ASCII, so UTF-16 units are code points.
  const start = text.indexOf(quote);
  return createCitations(
    database,
    organizationId,
    [{ objectiveId, sourceId, start, end: start + quote.length }],
    at,
  );
}

/** Requires TEST_DATABASE_URL: access and publication are the database's to answer. */
describe.skipIf(!connectionString)("reviewing an objective", () => {
  const grammar = "Past simple: add -ed. I walked home. She played chess. They watched TV.";
  const pages = joinPages([
    { page: "11", text: "Regular verbs take -ed." },
    { page: "12", text: "Irregular verbs: go, went." },
  ]);
  const cues = joinCues([
    { at: 0, text: "Welcome back." },
    { at: 62.5, text: "We walked, we talked." },
  ]);
  if ("problem" in pages || "problem" in cues) throw new Error("Bad fixture");

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    const at = ago(60 * 60_000);
    await testing.seedOrganization(database, { organizationId, learnerIds: [learner], at });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [outsider, learner],
      at,
    });
    await database
      .insert(organizationDomain)
      .values({ hostname: otherDomain.hostname, organizationId: otherOrganizationId })
      .onConflictDoNothing();

    [pastSimple, uncited, elsewhere, spoken] = (await createObjectives(database, organizationId, [
      "Past simple",
      "Uncited",
      "Elsewhere",
      "Spoken",
    ])) as [string, string, string, string];

    const workbook = await createSource(database, {
      organizationId,
      title: "B workbook",
      text: grammar,
      createdAt: at,
    });
    const book = await createSource(database, {
      organizationId,
      title: "A book",
      ...pages,
      url: "https://example.com/book.pdf",
      createdAt: at,
    });
    const video = await createSource(database, {
      organizationId,
      title: "C video",
      ...cues,
      url: "https://www.youtube.com/watch?v=abc123",
      createdAt: at,
    });
    // Six, published: the first five by source title, then position, whatever
    // order they were cited in.
    const cited = ago(30 * 60_000);
    await cite(pastSimple, video, cues.text, "We walked, we talked.", cited);
    await cite(pastSimple, workbook, grammar, "They watched TV.", cited);
    await cite(pastSimple, workbook, grammar, "Past simple: add -ed.", cited);
    await cite(pastSimple, workbook, grammar, "She played chess.", cited);
    await cite(pastSimple, book, pages.text, "Irregular verbs: go, went.", cited);
    await cite(pastSimple, workbook, grammar, "I walked home.", cited);
    await cite(elsewhere, workbook, grammar, "I walked home.", cited);
    await cite(spoken, video, cues.text, "We walked, we talked.", cited);

    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Review",
        objectiveIds: [pastSimple, uncited, spoken],
      })
    ).id;
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner, outsider]);
  });

  test("is no way to read passages before the learner's first answer on the objective", async () => {
    expect(await review(pastSimple)).toEqual({ kind: "unavailable" });
  });

  test("shows the objective's first five passages, in a grade's order, once answered on", async () => {
    await answered(pastSimple);

    expect(await review(pastSimple)).toEqual({
      kind: "review",
      title: "Past simple",
      passages: [
        {
          quote: "Irregular verbs: go, went.",
          page: "12",
          source: { title: "A book", url: "https://example.com/book.pdf" },
        },
        { quote: "Past simple: add -ed.", source: { title: "B workbook" } },
        { quote: "I walked home.", source: { title: "B workbook" } },
        { quote: "She played chess.", source: { title: "B workbook" } },
        { quote: "They watched TV.", source: { title: "B workbook" } },
      ],
    });
  });

  test("carries a recording's moment, and leaves out the sixth passage", async () => {
    await answered(spoken);
    expect(await review(spoken)).toEqual({
      kind: "review",
      title: "Spoken",
      passages: [
        {
          quote: "We walked, we talked.",
          at: 62.5,
          source: { title: "C video", url: "https://www.youtube.com/watch?v=abc123" },
        },
      ],
    });
  });

  test("counts evidence from another course or grader at the organization", async () => {
    await answered(pastSimple, "graded-elsewhere");
    expect(await review(pastSimple)).toMatchObject({ kind: "review" });
  });

  test("is empty for an objective citing nothing", async () => {
    await answered(uncited);
    expect(await review(uncited)).toEqual({ kind: "empty" });
  });

  test("shows a tool's citation only once a person publishes it, publishing a course or not", async () => {
    const [later] = await createObjectives(database, organizationId, ["Cited by a tool"]);
    const text = "A passage a tool cited.";
    const source = await createSource(database, {
      organizationId,
      title: "Later",
      text,
      createdAt: ago(1000),
    });
    const { id: laterCourse } = await createCourse(database, {
      published: true,
      organizationId,
      title: "Cited by a tool",
      objectiveIds: [later!],
    });
    await cite(later!, source, text, "A passage");
    await answered(later!);
    expect(await review(later!, { course: laterCourse })).toEqual({ kind: "empty" });

    // A course published since, from a page loaded before the citation, publishes nothing of it.
    const { id: stale } = await createCourse(database, {
      published: false,
      organizationId,
      title: "Published since",
      objectiveIds: [later!],
    });
    await markPublished(database, {
      organizationId,
      courseIds: [stale],
      taskIds: [],
      now: new Date(),
    });
    expect(await review(later!, { course: laterCourse })).toEqual({ kind: "empty" });

    const start = text.indexOf("A passage");
    await markPublished(database, {
      organizationId,
      courseIds: [],
      taskIds: [],
      citations: [
        { objectiveId: later!, sourceId: source, start, end: start + "A passage".length },
      ],
      now: new Date(),
    });
    expect(await review(later!, { course: laterCourse })).toEqual({
      kind: "review",
      title: "Cited by a tool",
      passages: [{ quote: "A passage", source: { title: "Later" } }],
    });
  });

  test("refuses an objective outside the course, as one never answered", async () => {
    await answered(elsewhere);
    expect(await review(elsewhere)).toEqual({ kind: "unavailable" });
    expect(await review("no-such-objective")).toEqual({ kind: "unavailable" });
  });

  test("refuses a learner outside the organization, and another organization's domain", async () => {
    await answered(pastSimple, "outsider", outsider);
    expect(await review(pastSimple, { learnerId: outsider })).toEqual({ kind: "unavailable" });

    await answered(pastSimple);
    expect(await review(pastSimple, { host: otherDomain })).toEqual({ kind: "unavailable" });
  });

  test("refuses a course hidden from learners, or never published", async () => {
    await answered(pastSimple);
    const { id: hidden } = await createCourse(database, {
      published: true,
      organizationId,
      title: "Hidden",
      objectiveIds: [pastSimple],
    });
    await updateCourseHidden(database, {
      organizationId,
      courseId: hidden,
      hidden: true,
      now: new Date(),
    });
    const { id: unpublished } = await createCourse(database, {
      published: false,
      organizationId,
      title: "Unpublished",
      objectiveIds: [pastSimple],
    });

    expect(await review(pastSimple, { course: hidden })).toEqual({ kind: "unavailable" });
    expect(await review(pastSimple, { course: unpublished })).toEqual({ kind: "unavailable" });
  });
});
