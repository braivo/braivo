// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "@braivo/db";
import { organizationDomain } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { codeSentTo } from "../auth/testing.ts";
import { activeModel } from "../learning/index.ts";
import { createCourse, createObjectives, createTasks } from "../persistence/index.ts";
import { directoryStore } from "../storage/index.ts";
import { BraivoError, createClient } from "./client.ts";
import { connectionString, createTestApi, learnerSessionOn } from "./testing.ts";

/**
 * The client's types are derived from the server's, which say what the routes
 * *should* send; only the routes say what they do send. This drives the real
 * client against the real app, so a route that serializes something other than
 * what the client parses fails here, and so does a client that builds a request
 * the routes refuse.
 */
const selfServeDomain = "contract-self-serve.example";
/** What the provisioner answers for any hostname: pending, its records to create. */
const pendingDomain = (hostname: string) => ({
  ready: false,
  records: [{ type: "CNAME", name: hostname, value: "domains.contract-self-serve.example" }],
});
const { database, api, outbox, signUp } = createTestApi({
  files: directoryStore(mkdtempSync(join(tmpdir(), "braivo-contract-files-"))),
  selfServeDomain,
  domains: {
    add: async (hostname) => pendingDomain(hostname),
    status: async (hostname) => pendingDomain(hostname),
    remove: async () => {},
  },
  dataRegion: "EU",
  otherRegions: [
    { region: "US", setupUrl: null },
    { region: "CA", setupUrl: "https://ca.example/join" },
  ],
});

/** The client reaches Braivo over HTTP; here that HTTP is the app itself. */
const client = createClient({
  // The client only ever passes a path, which is what `request` addresses.
  fetch: ((path: string, init?: RequestInit) =>
    api.request(path, init)) as unknown as typeof globalThis.fetch,
});

/** The same app reached at `organizationId`'s own domain, which serves its learn app. */
const organizationHost = "contract-test.example.com";
const onOrganizationDomain = createClient({
  fetch: ((path: string, init?: RequestInit) =>
    api.request(`https://${organizationHost}${path}`, init)) as unknown as typeof globalThis.fetch,
});

const organizationId = "contract-test-org";
const at = new Date("2026-06-01T00:00:00.000Z");

let learnerCookie!: string;
let learnerId!: string;
let learnerEmail!: string;
let teacherCookie!: string;
let teacherId!: string;
let courseId!: string;
/** The learner's organization's, and teaching nothing yet: never anything to practise. */
let emptyCourseId!: string;
let pastTense!: string;
/** The past tense's one task, a choice correct at index 0. */
let pastTenseTask!: string;
let fractions!: string;
let decimals!: string;
/** Three objectives, so a progress report can show every phase at once. */
let progressCourseId!: string;

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the client against the real API", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");

    const learner = await signUp();
    const teacher = await signUp();
    learnerCookie = learner.cookie;
    learnerId = learner.id;
    learnerEmail = learner.email;
    teacherCookie = teacher.cookie;
    teacherId = teacher.id;

    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner.id],
      adminIds: [teacher.id],
      at,
    });

    await database
      .insert(organizationDomain)
      .values({ hostname: organizationHost, organizationId })
      .onConflictDoNothing();

    pastTense = (await createObjectives(database, organizationId, ["Past tense"]))[0]!;
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Spanish",
        objectiveIds: [pastTense],
      })
    ).id;
    pastTenseTask = await testing.createTask(database, {
      organizationId,
      objectiveId: pastTense,
      // Kept in order, so the shape below can be pinned exactly.
      body: {
        kind: "choice",
        prompt: "Past tense?",
        options: ["hablé", "hablo"],
        answer: 0,
        keepOrder: true,
      },
      createdAt: at,
    });
    emptyCourseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Not started",
        objectiveIds: [],
      })
    ).id;
    [fractions, decimals] = (await createObjectives(database, organizationId, [
      "Fractions",
      "Decimals",
    ])) as [string, string];
    progressCourseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Every phase",
        objectiveIds: [pastTense, fractions, decimals],
      })
    ).id;
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learnerId]);
  });

  test("names the organization a domain serves, and none for another", async () => {
    // `seedOrganization` names an organization after its ID.
    expect(await onOrganizationDomain.hostOrganization()).toEqual({ name: organizationId });
    expect(await client.hostOrganization()).toBeUndefined();
  });

  test("hands a member over to a learn domain, whose session it reads and ends", async () => {
    // Started by a navigation, not the client.
    const started = await api.request(`https://${organizationHost}/api/session/sign-in`);
    const handoffId = new URL(started.headers.get("location")!).searchParams.get("handoff")!;
    const nonce = started.headers.getSetCookie()[0]!.split(";", 1)[0]!;

    expect(await client.handoff(handoffId)).toEqual({
      organization: { name: organizationId },
      hostname: organizationHost,
    });
    expect(await client.handoff("expired")).toBeUndefined();
    const url = await client.completeHandoff(handoffId, { headers: { cookie: learnerCookie } });
    const redeemed = await api.request(url, { headers: { cookie: nonce } });
    const cookie = redeemed.headers
      .getSetCookie()
      .find((set) => set.startsWith("__Host-braivo-learner="))!
      .split(";", 1)[0]!;

    const signedIn = { headers: { cookie } };
    expect(await onOrganizationDomain.session(signedIn)).toEqual({
      id: learnerId,
      name: expect.any(String),
    });
    await onOrganizationDomain.signOut(signedIn);
    expect(await onOrganizationDomain.session(signedIn)).toBeUndefined();
  });

  test("signs a member in on a learn domain by the code it sends, and says why it refuses", async () => {
    await onOrganizationDomain.sendSignInCode(learnerEmail);
    const refused = (thrown: unknown) => thrown instanceof BraivoError && thrown;
    expect(
      refused(await onOrganizationDomain.sendSignInCode(learnerEmail).catch((thrown) => thrown)),
    ).toMatchObject({ status: 429, code: "SIGN_IN_CODE_COOLDOWN" });
    const code = codeSentTo(outbox, learnerEmail);
    const wrong = code === "000000" ? "000001" : "000000";
    expect(
      refused(
        await onOrganizationDomain.signInWithCode(learnerEmail, wrong).catch((thrown) => thrown),
      ),
    ).toMatchObject({ status: 400, code: "INVALID_OTP" });

    expect(await onOrganizationDomain.signInWithCode(learnerEmail, code)).toEqual({
      id: learnerId,
      name: expect.any(String),
    });
    // Signed out here, as the client carries no cookie itself.
    expect(
      refused(await onOrganizationDomain.nameAccount("Ada").catch((thrown) => thrown)),
    ).toMatchObject({ status: 401 });
  });

  test("parses an activity into the shape it declares", async () => {
    const activity = await client.nextActivity(courseId, { headers: { cookie: learnerCookie } });

    // Every field the client's type promises, from the server that really sent
    // it: a rename on either side stops matching here.
    expect(activity).toEqual({
      decision: { objectiveId: pastTense, modelVersion: "v1", intent: "introduce" },
      objective: { id: pastTense, title: "Past tense" },
      task: {
        id: pastTenseTask,
        kind: "choice",
        prompt: "Past tense?",
        options: [
          { choice: 0, text: "hablé" },
          { choice: 1, text: "hablo" },
        ],
      },
    });
  });

  test("submits an attempt the server grades, and sees its only task rest", async () => {
    const grade = await client.submitAttempt(
      { courseId, id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 1 } },
      { headers: { cookie: learnerCookie } },
    );
    expect(grade).toEqual({ kind: "choice", outcome: "failure", correctChoice: 0 });

    const next = await client.nextActivity(courseId, { headers: { cookie: learnerCookie } });
    expect(next).toEqual({
      objective: { id: pastTense, title: "Past tense" },
      retryAfter: expect.any(Number),
    });

    const early = client.submitAttempt(
      { courseId, id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 0 } },
      { headers: { cookie: learnerCookie } },
    );
    await expect(early).rejects.toBeInstanceOf(BraivoError);
    await expect(early).rejects.toMatchObject({ status: 409 });
  });

  test("lists a learner's courses in the shape it declares", async () => {
    const courses = await client.learnerCourses({ headers: { cookie: learnerCookie } });

    expect(courses).toEqual([
      {
        id: progressCourseId,
        number: expect.any(Number),
        title: "Every phase",
        urlLabel: "every-phase",
      },
      {
        id: emptyCourseId,
        number: expect.any(Number),
        title: "Not started",
        urlLabel: "not-started",
      },
      { id: courseId, number: expect.any(Number), title: "Spanish", urlLabel: "spanish" },
    ]);
  });

  test("finds a learner's course by number in the shape it declares, on its domain alone", async () => {
    const signedIn = { headers: { cookie: learnerCookie } };
    const spanish = (await client.learnerCourses(signedIn)).find(({ id }) => id === courseId)!;
    const onDomain = {
      headers: {
        cookie: await learnerSessionOn(api, `https://${organizationHost}`, learnerCookie),
      },
    };

    expect(await onOrganizationDomain.learnerCourseByNumber(spanish.number, onDomain)).toEqual(
      spanish,
    );
    expect(await client.learnerCourseByNumber(spanish.number, signedIn)).toBeUndefined();
  });

  test("lists the organizations a content owner manages, and none a learner is only in", async () => {
    expect(await client.listOrganizations({ headers: { cookie: teacherCookie } })).toEqual([
      {
        id: organizationId,
        name: organizationId,
        slug: organizationId,
        learnDomain: organizationHost,
        administers: true,
        authors: true,
        teaches: false,
        aiEnabled: false,
      },
    ]);
    expect(await client.listOrganizations({ headers: { cookie: learnerCookie } })).toEqual([]);
  });

  test("sets up an organization in the shape it declares, and says why it refuses one", async () => {
    const { cookie } = await signUp();
    const slug = `contract-${crypto.randomUUID().slice(0, 8)}`;

    expect(await client.organizationSetup({ headers: { cookie } })).toEqual({
      domain: selfServeDomain,
      maySetUp: true,
      dataRegion: "EU",
      otherRegions: [
        { region: "US", setupUrl: null },
        { region: "CA", setupUrl: "https://ca.example/join" },
      ],
    });
    const organization = await client.setUpOrganization(
      { name: "Fernwood Academy", slug },
      { headers: { cookie } },
    );
    expect(organization).toEqual({
      id: expect.any(String),
      name: "Fernwood Academy",
      slug,
      learnDomain: `${slug}.${selfServeDomain}`,
      administers: true,
      authors: true,
      teaches: false,
    });
    // Listed, it also says whether its owners may use the installation's AI.
    expect(await client.listOrganizations({ headers: { cookie } })).toEqual([
      { ...organization, aiEnabled: false },
    ]);

    const refused = client.setUpOrganization(
      { name: "Second", slug: `${slug}-2` },
      { headers: { cookie } },
    );
    await expect(refused).rejects.toBeInstanceOf(BraivoError);
    await expect(refused).rejects.toMatchObject({
      status: 409,
      reason: "You already own an organization. Reload this page to open it.",
      code: "ALREADY_OWNER",
    });
  });

  test("renames an organization, with a code for a name it cannot have", async () => {
    const options = { headers: { cookie: teacherCookie } };
    const before = (await client.listOrganizations(options)).find(
      ({ id }) => id === organizationId,
    );
    if (!before) throw new Error(`${organizationId} is not listed: nothing to rename back.`);

    try {
      expect(await client.renameOrganization(organizationId, " Contract School ", options)).toEqual(
        { name: "Contract School" },
      );
      // Its own domain names it so from then on.
      expect(await onOrganizationDomain.hostOrganization()).toEqual({ name: "Contract School" });
      await expect(client.renameOrganization(organizationId, " ", options)).rejects.toMatchObject({
        status: 400,
        code: "NAME_INVALID",
      });
      await expect(
        client.renameOrganization(organizationId, "Learner's", {
          headers: { cookie: learnerCookie },
        }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      // Put back, for whatever else reads it, even after a failure.
      await client.renameOrganization(organizationId, before.name, options);
    }
  });

  test("reads and sets whether tools read learners' data, in the shape it declares", async () => {
    const options = { headers: { cookie: teacherCookie } };

    try {
      const turnedOn = await client.setToolsReadLearnerData(organizationId, true, options);
      expect(turnedOn).toEqual({
        allowed: true,
        changedBy: { userId: teacherId, name: expect.any(String) },
        changedAt: expect.any(String),
      });
      expect(new Date(turnedOn.changedAt!).toISOString()).toBe(turnedOn.changedAt);
      expect(await client.readToolsReadLearnerData(organizationId, options)).toEqual(turnedOn);
      // Each started as awaited: one left waiting would reject unhandled.
      for (const refused of [
        () =>
          client.readToolsReadLearnerData(organizationId, { headers: { cookie: learnerCookie } }),
        () =>
          client.setToolsReadLearnerData(organizationId, false, {
            headers: { cookie: learnerCookie },
          }),
      ]) {
        await expect(refused()).rejects.toMatchObject({ status: 403 });
      }
    } finally {
      // Off and never changed, as seeded, for whatever else reads it.
      await testing.setToolsReadLearnerData(database, organizationId, false);
    }
  });

  test("lists members in the shape it declares, and refuses a learner", async () => {
    const members = await client.listMembers(organizationId, {
      headers: { cookie: teacherCookie },
    });

    expect(members.map(({ userId, roles }) => ({ userId, roles }))).toEqual(
      expect.arrayContaining([
        { userId: learnerId, roles: ["member"] },
        { userId: teacherId, roles: ["admin"] },
      ]),
    );
    expect(members).toHaveLength(2);
    expect(members.every(({ name }) => typeof name === "string")).toBe(true);

    const rejected = await client
      .listMembers(organizationId, { headers: { cookie: learnerCookie } })
      .catch((thrown: unknown) => thrown);
    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 403 });
  });

  test("defines, changes, and lists groups in the shapes it declares", async () => {
    const asAdmin = { headers: { cookie: teacherCookie } };
    const asLearner = { headers: { cookie: learnerCookie } };
    // A member who teaches: any member may, once a group says so.
    const definition = {
      name: "Tutoring",
      learnerIds: [],
      teacherIds: [learnerId],
      courseIds: [courseId],
    };
    const groupId = await client.defineGroup(
      { organizationId, key: "tutoring", ...definition },
      asAdmin,
    );
    expect(
      await client.defineGroup({ organizationId, key: "tutoring", ...definition }, asAdmin),
    ).toBe(groupId);

    const taught = await client.listGroups(organizationId, asLearner);
    expect(taught).toEqual([
      {
        id: groupId,
        organizationId,
        name: "Tutoring",
        learners: [],
        teachers: [{ userId: learnerId, name: expect.any(String) }],
        courses: [
          { id: courseId, number: expect.any(Number), title: "Spanish", urlLabel: "spanish" },
        ],
      },
    ]);
    expect(await client.listGroups(organizationId, asAdmin)).toEqual(taught);
    // Teaching a group with no learners yet is enough to find the organization.
    expect(await client.listOrganizations(asLearner)).toEqual([
      expect.objectContaining({ id: organizationId, administers: false }),
    ]);
    // A teacher learns nothing of whether its owners may use the installation's AI.
    expect((await client.listOrganizations(asLearner))[0]).not.toHaveProperty("aiEnabled");

    expect(
      await client.changeGroup(
        { organizationId, groupId, remove: { userIds: [learnerId] } },
        asAdmin,
      ),
    ).toEqual({ ...taught[0], teachers: [] });
    expect(await client.listGroups(organizationId, asLearner)).toEqual([]);
    expect(await client.listOrganizations(asLearner)).toEqual([]);

    const missing = await client
      .changeGroup({ organizationId, groupId: "no-such-group", name: "Any" }, asAdmin)
      .catch((thrown: unknown) => thrown);
    expect(missing).toBeInstanceOf(BraivoError);
    expect(missing as BraivoError).toMatchObject({ status: 404 });
  });

  test("lists domains in the shape it declares, and refuses a learner", async () => {
    const domains = await client.listDomains(organizationId, {
      headers: { cookie: teacherCookie },
    });
    expect(domains).toEqual({
      // The only one serving: not removable.
      domains: [{ hostname: organizationHost, removable: false }],
      claims: expect.any(Array),
      canAdd: true,
    });

    const rejected = await client
      .listDomains(organizationId, { headers: { cookie: learnerCookie } })
      .catch((thrown: unknown) => thrown);
    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 403 });
  });

  test("claims a domain in the shape it declares, with a code for each refusal", async () => {
    const hostname = "claimed.contract-test.example.com";
    const options = { headers: { cookie: teacherCookie } };

    expect(await client.claimDomain(organizationId, hostname, options)).toEqual({
      hostname,
      status: pendingDomain(hostname),
    });
    expect((await client.listDomains(organizationId, options)).claims).toContainEqual({
      hostname,
      status: pendingDomain(hostname),
    });

    for (const [name, status, code] of [
      [organizationHost, 409, "ALREADY_ADDED"],
      [`school.${selfServeDomain}`, 400, "DOMAIN_RESERVED"],
      ["not a hostname", 400, "DOMAIN_INVALID"],
    ] as const) {
      const refused = client.claimDomain(organizationId, name, options);
      await expect(refused).rejects.toBeInstanceOf(BraivoError);
      await expect(refused).rejects.toMatchObject({ status, code });
    }
    const rejected = client.claimDomain(organizationId, hostname, {
      headers: { cookie: learnerCookie },
    });
    await expect(rejected).rejects.toMatchObject({ status: 403 });
  });

  test("activates a domain, saying with a code why not yet", async () => {
    const options = { headers: { cookie: teacherCookie } };
    const hostname = "activated.contract-test.example.com";
    await client.claimDomain(organizationId, hostname, options);

    // Pending, as this provisioner answers every hostname.
    await expect(client.activateDomain(organizationId, hostname, options)).rejects.toMatchObject({
      status: 409,
      code: "NOT_VERIFIED",
    });
    await expect(
      client.activateDomain(organizationId, "unclaimed.contract-test.example.com", options),
    ).rejects.toMatchObject({ status: 404 });
    // Serving already, as the organization's own domain does: activated.
    await expect(
      client.activateDomain(organizationId, organizationHost, options),
    ).resolves.toBeUndefined();
  });

  test("removes a domain, saying with a code why not", async () => {
    const options = { headers: { cookie: teacherCookie } };
    const hostname = "removed.contract-test.example.com";
    await client.claimDomain(organizationId, hostname, options);

    await expect(client.removeDomain(organizationId, hostname, options)).resolves.toBeUndefined();
    expect((await client.listDomains(organizationId, options)).claims).not.toContainEqual(
      expect.objectContaining({ hostname }),
    );
    for (const [name, code] of [
      [organizationHost, "LAST_DOMAIN"],
      [`school.${selfServeDomain}`, "DOMAIN_RESERVED"],
    ] as const) {
      await expect(client.removeDomain(organizationId, name, options)).rejects.toMatchObject({
        status: 409,
        code,
      });
    }
  });

  test("lists courses in the shape it declares, and refuses a learner", async () => {
    const courses = await client.listCourses(organizationId, {
      headers: { cookie: teacherCookie },
    });

    expect(courses).toEqual([
      {
        id: progressCourseId,
        number: expect.any(Number),
        title: "Every phase",
        urlLabel: "every-phase",
        published: true,
        hidden: false,
        pendingTaskCount: 0,
      },
      {
        id: emptyCourseId,
        number: expect.any(Number),
        title: "Not started",
        urlLabel: "not-started",
        published: true,
        hidden: false,
        pendingTaskCount: 0,
      },
      {
        id: courseId,
        number: expect.any(Number),
        title: "Spanish",
        urlLabel: "spanish",
        published: true,
        hidden: false,
        pendingTaskCount: 0,
      },
    ]);

    const rejected = await client
      .listCourses(organizationId, { headers: { cookie: learnerCookie } })
      .catch((thrown: unknown) => thrown);
    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 403 });
  });

  test("changes a course's URL label, and answers the label now when it changed meanwhile", async () => {
    const asTeacher = { headers: { cookie: teacherCookie } };
    const { id } = await createCourse(database, {
      published: true,
      organizationId,
      title: "Labelled",
      objectiveIds: [],
    });
    const change = (urlLabel: string, previous: string) =>
      client.setCourseUrlLabel({ organizationId, courseId: id, urlLabel, previous }, asTeacher);

    expect(await change("labelled-a1", "labelled")).toEqual({ saved: true });
    expect(await change("labelled-b1", "labelled")).toEqual({
      saved: false,
      urlLabel: "labelled-a1",
    });
    expect(
      (await client.listCourses(organizationId, asTeacher)).find((course) => course.id === id),
    ).toMatchObject({ urlLabel: "labelled-a1" });
  });

  test("deletes an unpublished course, again too, and refuses a published one", async () => {
    const asTeacher = { headers: { cookie: teacherCookie } };
    const course = (published: boolean) =>
      createCourse(database, { published, organizationId, title: "Deleted", objectiveIds: [] });
    const { id: proposed } = await course(false);
    const { id: published } = await course(true);
    const remove = (courseId: string) =>
      client.deleteCourse({ organizationId, courseId }, asTeacher);

    await remove(proposed);
    await remove(proposed);
    await expect(remove(published)).rejects.toMatchObject({ status: 409 });
    await expect(remove("no-such-course")).rejects.toMatchObject({ status: 404 });
    const listed = (await client.listCourses(organizationId, asTeacher)).map(({ id }) => id);
    expect(listed).toContain(published);
    expect(listed).not.toContain(proposed);
  });

  test("hides a published course and shows it again, again too, and refuses an unpublished one", async () => {
    const asTeacher = { headers: { cookie: teacherCookie } };
    const course = (published: boolean) =>
      createCourse(database, { published, organizationId, title: "Hidden", objectiveIds: [] });
    const { id: proposed } = await course(false);
    const { id: published } = await course(true);
    const setHidden = (courseId: string, hidden: boolean) =>
      client.setCourseHidden({ organizationId, courseId, hidden }, asTeacher);
    const hidden = async () =>
      (await client.listCourses(organizationId, asTeacher)).find(({ id }) => id === published)
        ?.hidden;

    await setHidden(published, true);
    await setHidden(published, true);
    expect(await hidden()).toBe(true);
    await setHidden(published, false);
    await setHidden(published, false);
    expect(await hidden()).toBe(false);
    await expect(setHidden(proposed, true)).rejects.toMatchObject({ status: 409 });
    await expect(setHidden("no-such-course", true)).rejects.toMatchObject({ status: 404 });
  });

  test("publishes a course and its tasks, which learners then reach, and refuses a stale list", async () => {
    const asTeacher = { headers: { cookie: teacherCookie } };
    const [objectiveId] = (await createObjectives(database, organizationId, ["Proposed"])) as [
      string,
    ];
    const { id } = await createCourse(database, {
      published: false,
      organizationId,
      title: "Proposed",
      objectiveIds: [objectiveId],
    });
    const [taskId] = (
      await createTasks(
        database,
        organizationId,
        [
          {
            objectiveId,
            body: { kind: "choice", prompt: "Ready?", options: ["yes", "no"], answer: 0 },
          },
        ],
        new Date(),
        { published: false },
      )
    ).map(({ id }) => id) as [string];
    const published = async () =>
      (await client.listTasks({ organizationId, objectiveId }, asTeacher)).map(
        (task) => task.published,
      );
    const { number } = (await client.listCourses(organizationId, asTeacher)).find(
      (course) => course.id === id,
    )!;
    const onDomain = {
      headers: {
        cookie: await learnerSessionOn(api, `https://${organizationHost}`, learnerCookie),
      },
    };

    expect(await onOrganizationDomain.learnerCourseByNumber(number, onDomain)).toBeUndefined();
    await expect(
      client.publish(
        { organizationId, courseIds: [id, "no-such-course"], taskIds: [taskId] },
        asTeacher,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await published()).toEqual([false]);
    await client.publish({ organizationId, courseIds: [id], taskIds: [taskId] }, asTeacher);
    expect(await onOrganizationDomain.learnerCourseByNumber(number, onDomain)).toMatchObject({
      id,
    });
    expect(await published()).toEqual([true]);
  });

  test("reads a learner caught up as undefined rather than as an error", async () => {
    const activity = await client.nextActivity(emptyCourseId, {
      headers: { cookie: learnerCookie },
    });

    expect(activity).toBeUndefined();
  });

  test("reads an objective with nothing to practise as the decision without a task", async () => {
    const [untaught] = await createObjectives(database, organizationId, ["Untaught"]);
    const { id: untaughtCourseId } = await createCourse(database, {
      published: true,
      organizationId,
      title: "Untaught",
      objectiveIds: [untaught!],
    });

    const activity = await client.nextActivity(untaughtCourseId, {
      headers: { cookie: learnerCookie },
    });

    expect(activity).toEqual({
      decision: { objectiveId: untaught, modelVersion: activeModel.version, intent: "introduce" },
      objective: { id: untaught, title: "Untaught" },
    });
  });

  test("reads a course the learner cannot see as a 404, not as caught up", async () => {
    // The two used to be one answer, and a client holding a stale course ID
    // would have told its learner, indefinitely, that there was nothing to do.
    const rejected = await client
      .nextActivity("no-such-course", { headers: { cookie: learnerCookie } })
      .catch((thrown: unknown) => thrown);

    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 404 });
  });

  test("records evidence the server accepts, and sees the decision change", async () => {
    // The full loop through the published client: the body it builds is one the
    // server parses, and the decision that comes back reflects it.
    await client.recordEvidence(
      {
        organizationId,
        learnerId,
        evidence: [
          { id: "contract-1", objectiveId: pastTense, outcome: "failure", at: at.toISOString() },
        ],
      },
      { headers: { cookie: teacherCookie } },
    );

    const activity = await client.nextActivity(courseId, { headers: { cookie: learnerCookie } });

    expect(activity && "task" in activity && activity.decision).toEqual({
      objectiveId: pastTense,
      modelVersion: "v1",
      intent: "reteach",
      lastEvidenceAt: at.toISOString(),
    });
  });

  test("parses a progress report into the shape it declares", async () => {
    // Every phase at once, from the server that really sends them, so each
    // phase's fields are pinned as they arrive rather than as they are typed.
    await client.recordEvidence(
      {
        organizationId,
        learnerId,
        evidence: [
          {
            id: "contract-progress-kept",
            objectiveId: pastTense,
            outcome: "success",
            at: at.toISOString(),
          },
          {
            id: "contract-progress-failed",
            objectiveId: fractions,
            outcome: "failure",
            at: at.toISOString(),
          },
        ],
      },
      { headers: { cookie: teacherCookie } },
    );

    const report = await client.learnerProgress(
      { courseId: progressCourseId, learnerId },
      { headers: { cookie: teacherCookie } },
    );

    // Retrievability is read off the real clock, so only its type is pinned;
    // months past a one-day stability is certainly due.
    expect(report).toEqual({
      modelVersion: "v1",
      asOf: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      repeatedMissesThreshold: 3,
      objectives: [
        {
          objectiveId: pastTense,
          title: "Past tense",
          phase: "retaining",
          lastEvidenceAt: at.toISOString(),
          stability: 1,
          retrievability: expect.any(Number),
          due: true,
          dueAt: new Date(at.getTime() + 86_400_001).toISOString(),
          evidence: [{ outcome: "success", at: at.toISOString() }],
        },
        {
          objectiveId: fractions,
          title: "Fractions",
          phase: "acquiring",
          lastEvidenceAt: at.toISOString(),
          misses: { count: 1, lastMissAt: at.toISOString(), everSucceeded: false },
          evidence: [{ outcome: "failure", at: at.toISOString() }],
        },
        { objectiveId: decimals, title: "Decimals", phase: "unseen", evidence: [] },
      ],
    });
  });

  test("parses a course's progress into the shape it declares", async () => {
    await client.recordEvidence(
      {
        organizationId,
        learnerId,
        evidence: [
          {
            id: "contract-overview-failed",
            objectiveId: fractions,
            outcome: "failure",
            at: at.toISOString(),
          },
        ],
      },
      { headers: { cookie: teacherCookie } },
    );

    const overview = await client.courseProgress(progressCourseId, {
      headers: { cookie: teacherCookie },
    });

    expect(overview).toMatchObject({
      modelVersion: "v1",
      asOf: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      repeatedMissesThreshold: 3,
    });
    expect(overview.learners.find(({ userId }) => userId === learnerId)).toEqual({
      userId: learnerId,
      name: expect.any(String),
      roles: ["member"],
      standings: { unseen: 2, acquiring: 1, retained: 0, due: 0 },
      repeatedMisses: expect.any(Number),
    });
    expect(overview.objectives.find(({ objectiveId }) => objectiveId === fractions)).toEqual({
      objectiveId: fractions,
      title: expect.any(String),
      standings: expect.objectContaining({ acquiring: 1 }),
      repeatedMisses: expect.any(Array),
    });
  });

  test("reads progress the session may not see as a 404", async () => {
    // A learner asking about someone else: only their own is theirs to read.
    const rejected = await client
      .learnerProgress(
        { courseId: progressCourseId, learnerId: "someone-else" },
        { headers: { cookie: learnerCookie } },
      )
      .catch((thrown: unknown) => thrown);

    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 404 });
  });

  test("surfaces a result that disagrees with its ID's as a 409", async () => {
    // What the client's documentation promises a grader that reuses an ID across
    // attempts, from the server that actually refuses it.
    const send = (outcome: "success" | "failure") =>
      client.recordEvidence(
        {
          organizationId,
          learnerId,
          evidence: [
            { id: "contract-reused", objectiveId: pastTense, outcome, at: at.toISOString() },
          ],
        },
        { headers: { cookie: teacherCookie } },
      );

    await send("failure");
    const rejected = await send("success").catch((thrown: unknown) => thrown);

    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 409 });
  });

  test("surfaces a refusal as a BraivoError carrying the status", async () => {
    const rejected = client
      .recordEvidence(
        {
          organizationId,
          learnerId,
          evidence: [
            { id: "contract-2", objectiveId: pastTense, outcome: "success", at: at.toISOString() },
          ],
        },
        // The learner's own session: a member may not grade.
        { headers: { cookie: learnerCookie } },
      )
      .catch((thrown: unknown) => thrown);

    expect(await rejected).toBeInstanceOf(BraivoError);
    expect((await rejected) as BraivoError).toMatchObject({ status: 403 });
  });

  test("authors a grounded course from a source, as a drafting agent does", async () => {
    const as = { headers: { cookie: teacherCookie } };

    const sourceId = await client.addSource(
      {
        organizationId,
        title: "Unidad 1",
        text: "Hola significa hello. Adiós significa goodbye.",
        url: "https://example.com/u1",
        language: "es",
      },
      as,
    );
    expect(await client.listSources(organizationId, as)).toContainEqual({
      id: sourceId,
      title: "Unidad 1",
      url: "https://example.com/u1",
      language: "es",
      createdAt: expect.any(String),
    });
    expect(await client.getSource({ organizationId, sourceId }, as)).toMatchObject({
      text: "Hola significa hello. Adiós significa goodbye.",
    });
    expect(await client.getSourceSlice({ organizationId, sourceId }, as)).toEqual({
      id: sourceId,
      title: "Unidad 1",
      url: "https://example.com/u1",
      language: "es",
      createdAt: expect.any(String),
      text: "Hola significa hello. Adiós significa goodbye.",
      start: 0,
      end: 46,
      length: 46,
    });
    expect(
      await client.getSourceSlice({ organizationId, sourceId, characters: "22-27" }, as),
    ).toMatchObject({ text: "Adiós", start: 22, end: 27 });
    await expect(
      client.getSourceSlice({ organizationId, sourceId, pages: "1-" }, as),
    ).rejects.toMatchObject({
      status: 400,
      reason: "This source has no pages: read it by characters.",
    });

    const [greetings] = await client.defineObjectives(
      { organizationId, objectives: [{ title: "Greetings" }] },
      as,
    );
    expect(await client.listObjectives(organizationId, as)).toContainEqual({
      id: greetings,
      title: "Greetings",
      courseIds: [],
      pendingTaskCount: 0,
    });
    expect(
      await client.citeSources(
        {
          organizationId,
          citations: [{ objectiveId: greetings!, sourceId, quote: "Hola significa hello." }],
        },
        as,
      ),
    ).toEqual([{ objectiveId: greetings, sourceId, start: 0, end: 21 }]);

    const taskIds = (
      await client.defineTasks(
        {
          organizationId,
          tasks: [
            {
              objectiveId: greetings!,
              kind: "choice",
              prompt: "Hola?",
              options: ["hello", "goodbye"],
              answer: 0,
              citations: [{ sourceId, quote: "Hola significa hello." }],
            },
          ],
        },
        as,
      )
    ).map(({ id }) => id);
    expect(taskIds).toEqual([expect.any(String)]);

    const { courseId: course } = await client.defineCourse(
      { organizationId, title: "Saludos", objectiveIds: [greetings!] },
      as,
    );
    expect(await client.listCourses(organizationId, as)).toContainEqual({
      id: course,
      number: expect.any(Number),
      title: "Saludos",
      urlLabel: "saludos",
      // Created with a person's session, as the console does: published at once.
      published: true,
      hidden: false,
      pendingTaskCount: 0,
    });
  });

  test("corrects a task in one step, and explains why a stale correction is refused", async () => {
    const as = { headers: { cookie: teacherCookie } };
    const sourceId = await client.addSource(
      { organizationId, title: "Unidad 3", text: "Gracias significa thank you." },
      as,
    );
    const [thanks] = await client.defineObjectives(
      { organizationId, objectives: [{ title: "Thanks" }] },
      as,
    );
    const wrong = {
      objectiveId: thanks!,
      kind: "choice" as const,
      prompt: "Gracias?",
      options: ["thank you", "please"],
      answer: 1,
      citations: [{ sourceId, quote: "Gracias significa thank you." }],
    };
    const [taskId] = (await client.defineTasks({ organizationId, tasks: [wrong] }, as)).map(
      ({ id }) => id,
    );

    const correction = { ...wrong, answer: 0, replaces: taskId! };
    const [correctedId] = (
      await client.defineTasks({ organizationId, tasks: [correction] }, as)
    ).map(({ id }) => id);
    expect(await client.listTasks({ organizationId, objectiveId: thanks! }, as)).toEqual([
      {
        id: correctedId,
        kind: "choice",
        prompt: "Gracias?",
        options: ["thank you", "please"],
        answer: 0,
        citations: [{ sourceId, start: 0, end: 28, quote: "Gracias significa thank you." }],
        published: true,
      },
    ]);

    // Written from the task as it was before: someone already corrected it.
    const stale = client.defineTasks(
      { organizationId, tasks: [{ ...correction, prompt: "¿Gracias?" }] },
      as,
    );
    await expect(stale).rejects.toMatchObject({
      status: 409,
      reason: expect.stringContaining("Task 0 replaces a task already retired"),
    });
  });

  test("carries Braivo's explanation of a quote it cannot cite", async () => {
    const as = { headers: { cookie: teacherCookie } };
    const sourceId = await client.addSource(
      { organizationId, title: "Unidad 2", text: "uno, dos" },
      as,
    );

    const refused = await client
      .citeSources(
        { organizationId, citations: [{ objectiveId: pastTense, sourceId, quote: "tres" }] },
        as,
      )
      .catch((thrown: unknown) => thrown);

    expect(refused).toBeInstanceOf(BraivoError);
    expect(refused).toMatchObject({
      status: 400,
      reason: "Citation 0: the quote does not occur in the source.",
    });
    expect((refused as BraivoError).message).toContain("does not occur in the source");
  });

  test("keeps a source's original file, uploaded once however often it is sent", async () => {
    const as = { headers: { cookie: teacherCookie } };
    const pdf = new Blob(["%PDF-1.7 Unidad 2"], { type: "application/pdf" });

    const uploaded = await client.uploadFile({ organizationId, file: pdf }, as);
    expect(uploaded).toEqual({
      fileId: createHash("sha256").update("%PDF-1.7 Unidad 2").digest("hex"),
      contentType: "application/pdf",
      size: 17,
    });
    expect(await client.uploadFile({ organizationId, file: pdf }, as)).toEqual(uploaded);

    const sourceId = await client.addSource(
      { organizationId, title: "Unidad 2", text: "Rojo.", original: uploaded.fileId },
      as,
    );
    expect(await client.getSource({ organizationId, sourceId }, as)).toMatchObject({
      original: uploaded.fileId,
    });
    await expect(
      client.addSource(
        { organizationId, title: "Unidad 3", text: "Azul.", original: "0".repeat(64) },
        as,
      ),
    ).rejects.toMatchObject({ status: 400, reason: expect.stringMatching(/upload it first/) });
  });

  test("carries Braivo's explanation of a source or task it cannot store", async () => {
    const as = { headers: { cookie: teacherCookie } };

    await expect(
      client.addSource({ organizationId, title: "Blank", text: "   " }, as),
    ).rejects.toMatchObject({ status: 400, reason: expect.stringMatching(/text is blank/) });
    await expect(
      client.defineTasks(
        {
          organizationId,
          tasks: [
            {
              objectiveId: pastTense,
              kind: "choice",
              prompt: "?",
              options: ["sí", "sí"],
              answer: 0,
            },
          ],
        },
        as,
      ),
    ).rejects.toMatchObject({
      status: 400,
      reason: "Task 0 repeats option 0 as option 1; every option must differ.",
    });
  });
});
