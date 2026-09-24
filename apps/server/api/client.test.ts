// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vite-plus/test";

import { type Activity, BraivoError, createClient, type KnowledgeReport } from "./client.ts";

const activity: Activity = {
  decision: {
    objectiveId: "objective-1",
    modelVersion: "v1",
    intent: "reteach",
    lastEvidenceAt: "2026-06-01T00:00:00.000Z",
  },
  task: { id: "task-1", kind: "choice", prompt: "Which?", options: ["a", "b"] },
};

/** Records what the client asked for, and answers with one prepared response. */
function stub(response: Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  // The client only ever passes a URL string.
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  };

  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

function clientFor(response: Response) {
  const stubbed = stub(response);
  return { calls: stubbed.calls, client: createClient({ fetch: stubbed.fetch }) };
}

describe("the Braivo client", () => {
  test("returns the activity Braivo answered with", async () => {
    const { client } = clientFor(Response.json(activity));

    expect(await client.nextActivity("course-1")).toEqual(activity);
  });

  test("reports nothing to practise as undefined rather than an error", async () => {
    const { client } = clientFor(new Response(null, { status: 204 }));

    expect(await client.nextActivity("course-1")).toBeUndefined();
  });

  test("throws for a course the learner cannot see, rather than reading it as nothing to practise", async () => {
    // 404 is how Braivo answers both a missing course and somebody else's, and
    // neither is "nothing to do": a client that read it that way would tell a
    // learner holding a stale course ID to come back later, forever.
    const { client } = clientFor(new Response(null, { status: 404 }));

    const error = await client.nextActivity("course-1").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(404);
  });

  test("throws with the status when Braivo refuses", async () => {
    const { client } = clientFor(new Response(null, { status: 401 }));

    const error = await client.nextActivity("course-1").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(401);
  });

  test("refuses a success Braivo does not send, even one that parses", async () => {
    // Braivo answers 200 or 204; a 202 from something in between is not an
    // answer. Valid JSON on purpose: an empty body would be refused for failing
    // to parse, passing without the status ever being checked.
    const { client } = clientFor(Response.json({ accepted: true }, { status: 202 }));

    const error = await client.nextActivity("course-1").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(202);
  });

  test("throws a BraivoError for a 200 whose body is not JSON", async () => {
    // An empty body, or a page something in between served with a 200: either
    // way nothing the client can use, and it should say so with a status. Only
    // that it parses — a JSON body of the wrong shape is deliberately not
    // checked, here or in the client.
    for (const body of [null, "<html>maintenance</html>"]) {
      const { client } = clientFor(new Response(body, { status: 200 }));

      const error = await client.nextActivity("course-1").catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BraivoError);
      expect((error as BraivoError).status).toBe(200);
    }
  });

  test("throws a BraivoError for a progress answer that is not JSON", async () => {
    const { client } = clientFor(new Response("<html>maintenance</html>", { status: 200 }));

    const error = await client
      .learnerProgress({ courseId: "course-1", learnerId: "learner-1" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(200);
  });

  test("lets a cancelled read stay a cancellation", async () => {
    // Only a body the client parsed itself becomes a BraivoError. Anything that
    // goes wrong while the body is still arriving rejects out of the read and is
    // the caller's, whatever it is made of. The erroring stream stands in for a
    // real abort, which was measured to reject a body read with this same
    // AbortError; what is tested here is that the client passes it through, not
    // the runtime's cancellation itself.
    const aborted = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        },
      }),
      { status: 200 },
    );
    const { client } = clientFor(aborted);

    const error = await client.nextActivity("course-1").catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(BraivoError);
    expect((error as DOMException).name).toBe("AbortError");
  });

  test("addresses a path relative to wherever the app is served, encoding the course", async () => {
    // A course ID is opaque, so it may contain anything a UUID may not: left
    // unencoded, one containing a slash would address a different path.
    const { calls, client } = clientFor(new Response(null, { status: 204 }));

    await client.nextActivity("odd/course id");

    expect(calls[0]!.url).toBe("/api/courses/odd%2Fcourse%20id/activity");
  });

  test("submits an attempt and returns Braivo's grade", async () => {
    const grade = { outcome: "failure", answer: 0 };
    const { calls, client } = clientFor(Response.json(grade));

    const answered = await client.submitAttempt({
      courseId: "course/1",
      id: "attempt-1",
      taskId: "task-1",
      response: { choice: 1 },
    });

    expect(answered).toEqual(grade);
    expect(calls[0]!.url).toBe("/api/courses/course%2F1/attempts");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe("application/json");
    // The course is in the path, never repeated in the body.
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      id: "attempt-1",
      taskId: "task-1",
      response: { choice: 1 },
    });
  });

  test("throws with the status when Braivo refuses the attempt", async () => {
    const { client } = clientFor(new Response(null, { status: 409 }));

    const error = await client
      .submitAttempt({ courseId: "c", id: "a", taskId: "t", response: { choice: 0 } })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(409);
  });

  test("records evidence and resolves when Braivo accepts it", async () => {
    const { calls, client } = clientFor(new Response(null, { status: 204 }));

    await client.recordEvidence({
      organizationId: "org 1",
      learnerId: "learner/1",
      evidence: [
        { id: "e1", objectiveId: "o1", outcome: "failure", at: "2026-06-01T00:00:00.000Z" },
      ],
    });

    expect(calls[0]!.url).toBe("/api/organizations/org%201/learners/learner%2F1/evidence");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      evidence: [
        { id: "e1", objectiveId: "o1", outcome: "failure", at: "2026-06-01T00:00:00.000Z" },
      ],
    });
  });

  test("declares JSON even when the caller passes headers as a Headers", async () => {
    // Braivo refuses a write that is not application/json, because a browser
    // cannot set that cross-origin without a preflight. Spreading a `Headers`
    // would have produced an empty object and a refused request.
    const { calls, client } = clientFor(new Response(null, { status: 204 }));

    await client.recordEvidence(
      { organizationId: "org-1", learnerId: "learner-1", evidence: [] },
      { headers: new Headers({ cookie: "session=abc" }) },
    );

    const sent = new Headers(calls[0]!.init?.headers);
    expect(sent.get("content-type")).toBe("application/json");
    expect(sent.get("cookie")).toBe("session=abc");
  });

  test("does not take a success Braivo does not send as recorded", async () => {
    // Braivo answers 204 once evidence is stored. A 200 page from something in
    // between — a login portal, a misrouted proxy — says nothing was, and read as
    // success it would let a grader move on from evidence that never landed.
    const { client } = clientFor(new Response("<html>sign in</html>", { status: 200 }));

    const error = await client
      .recordEvidence({ organizationId: "org-1", learnerId: "learner-1", evidence: [] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(200);
  });

  test("throws with the status when Braivo refuses the evidence", async () => {
    const { client } = clientFor(new Response(null, { status: 403 }));

    const error = await client
      .recordEvidence({ organizationId: "org-1", learnerId: "learner-1", evidence: [] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(403);
  });

  test("sends credentials and whatever headers it was given", async () => {
    const { calls, client } = clientFor(new Response(null, { status: 204 }));

    await client.nextActivity("course-1", { headers: { cookie: "session=abc" } });

    expect(calls[0]!.init).toMatchObject({
      method: "GET",
      credentials: "include",
      headers: { cookie: "session=abc" },
    });
  });

  test("returns the progress report Braivo answered with", async () => {
    const report: KnowledgeReport = {
      modelVersion: "v1",
      objectives: [
        { objectiveId: "o1", phase: "unseen" },
        { objectiveId: "o2", phase: "acquiring", lastEvidenceAt: "2026-06-01T00:00:00.000Z" },
        {
          objectiveId: "o3",
          phase: "retaining",
          lastEvidenceAt: "2026-06-01T00:00:00.000Z",
          stability: 3.2,
          retrievability: 0.87,
          due: false,
        },
      ],
    };
    const { client } = clientFor(Response.json(report));

    expect(await client.learnerProgress({ courseId: "course-1", learnerId: "learner-1" })).toEqual(
      report,
    );
  });

  test("puts each ID in its own place in the progress URL, encoded", async () => {
    // Two opaque IDs side by side are easy to transpose, and either may hold a
    // character that would otherwise change the path.
    const { calls, client } = clientFor(Response.json({ modelVersion: "v1", objectives: [] }));

    await client.learnerProgress(
      { courseId: "course/1", learnerId: "learner 1" },
      { headers: { cookie: "session=abc" } },
    );

    expect(calls[0]!.url).toBe("/api/courses/course%2F1/learners/learner%201/progress");
    expect(calls[0]!.init).toMatchObject({
      method: "GET",
      credentials: "include",
      headers: { cookie: "session=abc" },
    });
  });

  test("throws with the status when Braivo will not show the progress", async () => {
    const { client } = clientFor(new Response(null, { status: 404 }));

    const error = await client
      .learnerProgress({ courseId: "course-1", learnerId: "learner-1" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(404);
  });

  test("refuses a progress answer with a status Braivo does not send", async () => {
    // A valid JSON body, so the only thing refusing it is the status: an empty
    // one would be refused for failing to parse, whatever the status check did.
    const { client } = clientFor(
      Response.json({ modelVersion: "v1", objectives: [] }, { status: 202 }),
    );

    const error = await client
      .learnerProgress({ courseId: "course-1", learnerId: "learner-1" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(202);
  });

  test("returns the courses Braivo listed", async () => {
    const courses = [{ id: "course-1", title: "Beginners" }];
    const { calls, client } = clientFor(Response.json({ courses }));

    expect(await client.listCourses("org 1")).toEqual(courses);
    expect(calls[0]!.url).toBe("/api/organizations/org%201/courses");
    expect(calls[0]!.init).toMatchObject({ method: "GET", credentials: "include" });
  });

  test("throws with the status when Braivo will not list the courses", async () => {
    const { client } = clientFor(new Response(null, { status: 403 }));

    const error = await client.listCourses("org-1").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(403);
  });

  test("refuses a course listing with a status Braivo does not send", async () => {
    const { client } = clientFor(Response.json({ courses: [] }, { status: 202 }));

    const error = await client.listCourses("org-1").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(202);
  });

  test("returns the objectives Braivo listed", async () => {
    const objectives = [{ id: "objective-1", title: "Past tense" }];
    const { calls, client } = clientFor(Response.json({ objectives }));

    expect(await client.listObjectives("org 1")).toEqual(objectives);
    expect(calls[0]!.url).toBe("/api/organizations/org%201/objectives");
    expect(calls[0]!.init).toMatchObject({ method: "GET", credentials: "include" });
  });

  test("throws with the status when Braivo will not list the objectives", async () => {
    const { client } = clientFor(new Response(null, { status: 403 }));

    const error = await client.listObjectives("org-1").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(403);
  });

  test("refuses an objective listing with a status Braivo does not send", async () => {
    const { client } = clientFor(Response.json({ objectives: [] }, { status: 202 }));

    const error = await client.listObjectives("org-1").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BraivoError);
    expect((error as BraivoError).status).toBe(202);
  });
});

test("loads nothing at runtime, so an app bundling it bundles no server code", async () => {
  // The apps import this file from the server's own package. Types may cross;
  // an import that survives compilation would ship server modules to the
  // browser. Every import is `import type` as written, not only after Bun's
  // transpiler elides it, because an inline `import { type X }` can leave a
  // side-effect import behind in another compiler's output.
  const source = await readFile(new URL("client.ts", import.meta.url), "utf8");
  const imports = source.split("\n").filter((line) => line.startsWith("import "));

  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter((line) => !line.startsWith("import type "))).toEqual([]);
  expect(new Bun.Transpiler({ loader: "ts" }).scanImports(source)).toEqual([]);
});
