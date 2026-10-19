// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { directoryStore } from "../storage/index.ts";
import { BraivoError, createClient, type RequestOptions } from "./client.ts";
import { connectionString, createTestApi, type Signed } from "./testing.ts";

// What each organization role reaches through the API (ADR 0048): `author`
// manages every piece of the organization's content, publishing included from
// the console, and reaches no person's data, no evidence, and no settings.
// Teaching a group grants what it always did, beside any role. The policy
// table (policy.test.ts) checks each route's admission by credential; this
// checks the roles behind one, on real content.

// A file store, and no model: an AI request let past its role check is
// refused as unavailable (501), one refused by it 403 (generation-8).
const { database, api, signUp } = createTestApi({
  files: directoryStore(mkdtempSync(join(tmpdir(), "braivo-roles-files-"))),
});
const client = createClient({
  fetch: ((path: string, init?: RequestInit) =>
    api.request(path, init)) as unknown as typeof globalThis.fetch,
});

const organizationId = "roles-test-org";
const otherOrganizationId = "roles-test-other-org";
const at = new Date("2026-06-01T00:00:00.000Z");
const sourceText = "Hola significa hello. Adiós significa goodbye.";

let admin!: Signed;
/** `author` alone. */
let author!: Signed;
/** `member,author`, as Better Auth stores two roles. */
let memberAuthor!: Signed;
/** `author`, teaching `taught`'s group here, and a `member` teaching in the other organization. */
let teacherAuthor!: Signed;
/** In the group `teacherAuthor` teaches. */
let learner!: Signed;
/** In another group taking the same course, which `teacherAuthor` does not teach. */
let untaught!: Signed;
/** `member` alone. */
let plainMember!: Signed;

let objectiveId!: string;
let sourceId!: string;
/** Published, taken by both groups. */
let courseId!: string;
/** Published, taken by no group `teacherAuthor` teaches. */
let otherCourseId!: string;
let taskId!: string;
let taughtGroupId!: string;

const as = (account: Signed): RequestOptions => ({ headers: { cookie: account.cookie } });
const asTool = (account: Signed): RequestOptions => ({
  headers: { authorization: `Bearer ${account.token}` },
});

/** The ID of the one task written. */
const firstId = (written: readonly { id: string }[]) => written[0]!.id;

/** The status a request was refused with, or `ok`. */
async function status(request: Promise<unknown>): Promise<number | "ok"> {
  try {
    await request;
    return "ok";
  } catch (error) {
    if (error instanceof BraivoError) return error.status;
    throw error;
  }
}

async function setRole(account: Signed, inOrganization: string, role: string) {
  await database
    .update(member)
    .set({ role })
    .where(and(eq(member.organizationId, inOrganization), eq(member.userId, account.id)));
}

/** Requires TEST_DATABASE_URL: roles are read from the database on every request. */
describe.skipIf(!connectionString)("what each organization role reaches", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    const accounts = await Promise.all(Array.from({ length: 7 }, () => signUp()));
    [admin, author, memberAuthor, teacherAuthor, learner, untaught, plainMember] = accounts as [
      Signed,
      Signed,
      Signed,
      Signed,
      Signed,
      Signed,
      Signed,
    ];

    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [author, memberAuthor, teacherAuthor, learner, untaught, plainMember].map(
        ({ id }) => id,
      ),
      adminIds: [admin.id],
      at,
    });
    await setRole(author, organizationId, "author");
    await setRole(memberAuthor, organizationId, "member,author");
    await setRole(teacherAuthor, organizationId, "author");
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [author.id, teacherAuthor.id, learner.id],
      adminIds: [admin.id],
      at,
    });

    const asAdmin = as(admin);
    sourceId = await client.addSource(
      { organizationId, title: "Saludos", text: sourceText },
      asAdmin,
    );
    objectiveId = (
      await client.defineObjectives(
        { organizationId, objectives: [{ title: "Greetings" }] },
        asAdmin,
      )
    )[0]!;
    taskId = firstId(
      await client.defineTasks(
        {
          organizationId,
          tasks: [
            {
              objectiveId,
              kind: "choice",
              prompt: "Hola?",
              options: ["hello", "goodbye"],
              answer: 0,
              citations: [{ sourceId, quote: "Hola significa hello." }],
            },
          ],
        },
        asAdmin,
      ),
    );
    ({ courseId } = await client.defineCourse(
      { organizationId, title: "Spanish", objectiveIds: [objectiveId] },
      asAdmin,
    ));
    ({ courseId: otherCourseId } = await client.defineCourse(
      { organizationId, title: "Spanish again", objectiveIds: [objectiveId] },
      asAdmin,
    ));
    await client.publish(
      { organizationId, courseIds: [courseId, otherCourseId], taskIds: [taskId] },
      asAdmin,
    );
    taughtGroupId = await client.defineGroup(
      {
        organizationId,
        name: "Taught",
        learnerIds: [learner.id],
        teacherIds: [teacherAuthor.id],
        courseIds: [courseId],
      },
      asAdmin,
    );
    await client.defineGroup(
      {
        organizationId,
        name: "Untaught",
        learnerIds: [untaught.id],
        teacherIds: [plainMember.id],
        courseIds: [courseId],
      },
      asAdmin,
    );
    await client.defineGroup(
      {
        organizationId: otherOrganizationId,
        name: "Elsewhere",
        learnerIds: [learner.id],
        teacherIds: [teacherAuthor.id],
        courseIds: [],
      },
      asAdmin,
    );
  });

  test.each([
    ["`author` alone", () => author],
    ["`member,author`", () => memberAuthor],
  ])("lets %s prepare, publish, hide, and delete content from the console", async (_, who) => {
    const options = as(who());
    const [objective] = await client.defineObjectives(
      { organizationId, objectives: [{ title: `Farewells by ${who().id}` }] },
      options,
    );
    await client.citeSources(
      {
        organizationId,
        citations: [{ objectiveId: objective!, sourceId, quote: "Adiós significa goodbye." }],
      },
      options,
    );
    const task = firstId(
      await client.defineTasks(
        {
          organizationId,
          tasks: [
            {
              objectiveId: objective!,
              kind: "choice",
              prompt: "Adiós?",
              options: ["hello", "goodbye"],
              answer: 1,
              citations: [{ sourceId, quote: "Adiós significa goodbye." }],
            },
          ],
        },
        // Written by their tool, so they wait for the console (ADR 0039).
        asTool(who()),
      ),
    );
    const { courseId: course } = await client.defineCourse(
      { organizationId, title: `Farewells by ${who().id}`, objectiveIds: [objective!] },
      asTool(who()),
    );
    const added = await client.addSource(
      {
        organizationId,
        title: `Notes by ${who().id}`,
        text: "Buenos días significa good morning.",
      },
      options,
    );

    expect((await client.listSources(organizationId, options)).map(({ id }) => id)).toContain(
      added,
    );
    expect((await client.getSource({ organizationId, sourceId }, options)).id).toBe(sourceId);
    expect((await client.listCourses(organizationId, options)).map(({ id }) => id)).toContain(
      course,
    );
    expect((await client.listObjectives(organizationId, options)).map(({ id }) => id)).toContain(
      objective,
    );
    const published = async () => ({
      course: (await client.readCourse({ organizationId, courseId: course }, options)).published,
      tasks: (await client.listTasks({ organizationId, objectiveId: objective! }, options)).map(
        ({ id, published }) => ({ id, published }),
      ),
    });
    expect(await published()).toEqual({ course: false, tasks: [{ id: task, published: false }] });
    // Another's course, as every author's: the school's content is shared.
    expect((await client.readCourse({ organizationId, courseId }, options)).id).toBe(courseId);

    await client.publish({ organizationId, courseIds: [course], taskIds: [task] }, options);
    expect(await published()).toEqual({ course: true, tasks: [{ id: task, published: true }] });
    await client.setCourseHidden({ organizationId, courseId: course, hidden: true }, options);
    await client.setCourseHidden({ organizationId, courseId: course, hidden: false }, options);
    await client.retireTasks({ organizationId, taskIds: [task] }, options);
    // A tool's waits unpublished (ADR 0039), over objectives of its own, or it
    // would be the published course again (ADR 0024).
    const [another] = await client.defineObjectives(
      { organizationId, objectives: [{ title: `Mornings by ${who().id}` }] },
      options,
    );
    const { courseId: unpublished } = await client.defineCourse(
      { organizationId, title: `Draft by ${who().id}`, objectiveIds: [another!] },
      asTool(who()),
    );
    await client.deleteCourse({ organizationId, courseId: unpublished }, options);
  });

  test("lets an author keep and open files, and ask Braivo's AI under the organization's gate", async () => {
    const pdf = new Blob(["%PDF-1.7\n"], { type: "application/pdf" });
    const { fileId } = await client.uploadFile({ organizationId, file: pdf }, as(author));

    const aiStatusesFor = (who: Signed) =>
      Promise.all([
        status(client.readFileText({ organizationId, fileId }, as(who))),
        status(client.draftCourse({ organizationId, sourceId, audience: "Adults" }, as(who))),
      ]);
    // Past the role, refused for want of a model; a plain member, by the role.
    expect(await aiStatusesFor(author)).toEqual([501, 501]);
    expect(await aiStatusesFor(plainMember)).toEqual([403, 403]);
    expect(await status(client.uploadFile({ organizationId, file: pdf }, as(plainMember)))).toBe(
      403,
    );
    const opened = await api.request(`/api/organizations/${organizationId}/files/${fileId}`, {
      headers: { cookie: author.cookie },
    });
    expect(opened.status).toBe(200);
    await opened.body?.cancel();
  });

  test("keeps an author's tools to what any tool may: writing, never publishing", async () => {
    const options = asTool(author);
    const task = firstId(
      await client.defineTasks(
        {
          organizationId,
          tasks: [
            {
              objectiveId,
              kind: "choice",
              prompt: "Hola, from a tool?",
              options: ["hello", "goodbye"],
              answer: 0,
              citations: [{ sourceId, quote: "Hola significa hello." }],
            },
          ],
        },
        options,
      ),
    );
    const { courseId: drafted } = await client.defineCourse(
      { organizationId, title: "From a tool", objectiveIds: [objectiveId] },
      options,
    );

    expect(await status(client.publish({ organizationId, taskIds: [task] }, options))).toBe(403);
    expect(
      await status(client.setCourseHidden({ organizationId, courseId, hidden: true }, options)),
    ).toBe(403);
    expect(await status(client.deleteCourse({ organizationId, courseId: drafted }, options))).toBe(
      403,
    );
    expect(await status(client.retireTasks({ organizationId, taskIds: [taskId] }, options))).toBe(
      403,
    );
  });

  test.each([
    ["`author` alone", () => author],
    ["`member,author`", () => memberAuthor],
  ])("gives %s no person's data, no evidence, and no settings", async (_, who) => {
    const options = as(who());
    const refusals = await Promise.all([
      status(client.listMembers(organizationId, options)),
      status(
        client.defineGroup(
          { organizationId, name: "Mine", learnerIds: [], teacherIds: [], courseIds: [] },
          options,
        ),
      ),
      status(
        client.changeGroup({ organizationId, groupId: taughtGroupId, name: "Renamed" }, options),
      ),
      status(
        client.changeGroup(
          { organizationId, groupId: taughtGroupId, add: { courseIds: [otherCourseId] } },
          options,
        ),
      ),
      status(client.listDomains(organizationId, options)),
      status(client.renameOrganization(organizationId, "Taken", options)),
      status(
        client.recordEvidence(
          {
            organizationId,
            learnerId: learner.id,
            evidence: [
              { id: `roles-${who().id}`, objectiveId, outcome: "success", at: at.toISOString() },
            ],
          },
          options,
        ),
      ),
      // Concealed, as from any member (progress-1, progress-12).
      status(client.courseProgress(courseId, options)),
      status(client.learnerProgress({ courseId, learnerId: learner.id }, options)),
    ]);

    expect(refusals).toEqual([403, 403, 403, 403, 403, 403, 403, 404, 404]);
    // Teaching none, they list none.
    expect(await client.listGroups(organizationId, options)).toEqual([]);
  });

  test("lets an author study the school's courses and answer their own tasks, as any member", async () => {
    const options = as(author);

    expect((await client.learnerCourses(options)).map(({ id }) => id)).toContain(courseId);
    const grade = await client.submitAttempt(
      { courseId, id: crypto.randomUUID(), taskId, response: { choice: 0 } },
      options,
    );
    expect(grade).toMatchObject({ outcome: "success" });
  });

  test("keeps an author who teaches a group to that group's learners", async () => {
    const options = as(teacherAuthor);

    expect((await client.listGroups(organizationId, options)).map(({ id }) => id)).toEqual([
      taughtGroupId,
    ]);
    const overview = await client.courseProgress(courseId, options);
    expect(overview.learners.map(({ userId }) => userId)).toEqual([learner.id]);
    for (const named of overview.learners) expect(named).not.toHaveProperty("roles");
    expect(
      (await client.learnerProgress({ courseId, learnerId: learner.id }, options)).objectives,
    ).toHaveLength(1);
    expect(
      await status(client.learnerProgress({ courseId, learnerId: untaught.id }, options)),
    ).toBe(404);
    expect(await status(client.courseProgress(otherCourseId, options))).toBe(404);
  });

  test("lists where someone authors, administers, or teaches, each flag on its own", async () => {
    const entry = (id: string) => ({ id, name: id, slug: id, learnDomain: null });

    expect(await client.listOrganizations(as(teacherAuthor))).toEqual([
      {
        ...entry(organizationId),
        administers: false,
        authors: true,
        teaches: true,
        // This API has no model.
        aiEnabled: false,
      },
      { ...entry(otherOrganizationId), administers: false, authors: false, teaches: true },
    ]);
    // A `member` there, and teaching nothing: not listed.
    expect(await client.listOrganizations(as(author))).toEqual([
      {
        ...entry(organizationId),
        administers: false,
        authors: true,
        teaches: false,
        aiEnabled: false,
      },
    ]);
    expect(await client.listOrganizations(as(plainMember))).toEqual([
      { ...entry(organizationId), administers: false, authors: false, teaches: true },
    ]);
  });

  test("grants authoring in one organization only", async () => {
    expect(
      await status(
        client.defineObjectives(
          { organizationId: otherOrganizationId, objectives: [{ title: "Elsewhere" }] },
          as(author),
        ),
      ),
    ).toBe(403);
    expect(await status(client.listSources(otherOrganizationId, as(teacherAuthor)))).toBe(403);
  });

  test("lets a plain member author nothing", async () => {
    const options = as(plainMember);
    const refusals = await Promise.all([
      status(client.listSources(organizationId, options)),
      status(client.addSource({ organizationId, title: "Mine", text: "Hola." }, options)),
      status(client.defineObjectives({ organizationId, objectives: [{ title: "Mine" }] }, options)),
      status(client.listCourses(organizationId, options)),
      status(client.publish({ organizationId, taskIds: [taskId] }, options)),
    ]);

    expect(refusals).toEqual([403, 403, 403, 403, 403]);
  });

  test("stops authoring at the next request once the role is taken, leaving a member", async () => {
    const taken = await signUp();
    await database.insert(member).values({
      id: `${organizationId}:${taken.id}`,
      organizationId,
      userId: taken.id,
      role: "author",
      createdAt: at,
    });
    const define = (options: RequestOptions) =>
      status(
        client.defineObjectives({ organizationId, objectives: [{ title: "Later" }] }, options),
      );
    expect(await define(as(taken))).toBe("ok");
    expect(await define(asTool(taken))).toBe("ok");

    await setRole(taken, organizationId, "member");

    expect(await define(as(taken))).toBe(403);
    expect(await define(asTool(taken))).toBe(403);
    expect((await client.learnerCourses(as(taken))).map(({ id }) => id)).toContain(courseId);
  });
});
