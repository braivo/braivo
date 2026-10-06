# The API, end to end

Braivo's apps use the same HTTP API available to any other application. This walkthrough runs the whole loop against a local server (`bun run dev`, from the [quick start](../../README.md#quick-start)): sign in, author a course, practise it, and read progress. `apps/server/api/quickstart.test.ts` runs the walkthrough as written, keeping its commands in step with the API.

## The walkthrough

Each step returns an ID the next one needs, so they are captured as they go; `jar.txt` carries the session throughout.

```bash
BRAIVO=http://localhost:3000
field() { bun -e "const r = JSON.parse(await Bun.stdin.text()); console.log($1)"; }

# Sign in with a code sent to your email, which makes the account, then have
# the operator create an organization for it to own the content (ADR 0018):
# browsers cannot create one. A local server without BRAIVO_SMTP_URL prints
# the code in its log instead.
curl -s -X POST $BRAIVO/api/auth/email-otp/send-verification-otp -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","type":"sign-in"}' >/dev/null
read -r CODE  # type the code
curl -sc jar.txt -X POST $BRAIVO/api/auth/sign-in/email-otp -H 'content-type: application/json' \
  -d "{\"email\":\"owner@example.com\",\"otp\":\"$CODE\",\"name\":\"Owner\"}" >/dev/null

LEARNER=$(curl -sb jar.txt $BRAIVO/api/auth/get-session | field 'r.user.id')

bun apps/server/cli/index.ts organization create \
  --name "Example School" --slug example-school --owner owner@example.com
ORG=$(curl -sb jar.txt $BRAIVO/api/organizations | field 'r.organizations[0].id')

# Name what is taught, then arrange it into a course. objectiveIds sets the
# introduction order for unseen objectives.
OBJECTIVES=$(curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/objectives \
  -H 'content-type: application/json' -d '{"objectives":[{"title":"Greetings"},{"title":"Numbers"}]}' \
  | field 'JSON.stringify(r.objectiveIds)')
FIRST=$(echo "$OBJECTIVES" | field 'r[0]')
SECOND=$(echo "$OBJECTIVES" | field 'r[1]')

COURSE=$(curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/courses \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Beginners\",\"objectiveIds\":$OBJECTIVES}" | field 'r.courseId')

# Give each objective tasks with one right answer. Greetings gets two: a
# task rests for ten minutes once answered, because the grade reveals the answer, so
# a learner who misses one is asked the other in the meantime.
curl -sb jar.txt -X POST $BRAIVO/api/organizations/$ORG/tasks \
  -H 'content-type: application/json' -d "{\"tasks\":[
    {\"objectiveId\":\"$FIRST\",\"kind\":\"choice\",\"prompt\":\"Hello, in Spanish?\",
     \"options\":[\"Hola\",\"Adiós\"],\"answer\":0,\"explanation\":\"Adiós is goodbye.\"},
    {\"objectiveId\":\"$FIRST\",\"kind\":\"choice\",\"prompt\":\"Goodbye, in Spanish?\",
     \"options\":[\"Hola\",\"Adiós\"],\"answer\":1},
    {\"objectiveId\":\"$SECOND\",\"kind\":\"choice\",\"prompt\":\"Three, in Spanish?\",
     \"options\":[\"Dos\",\"Tres\"],\"answer\":1}]}" >/dev/null

# Ask what to do next: an objective, and a task to practise it.
ACTIVITY=$(curl -sb jar.txt $BRAIVO/api/courses/$COURSE/activity)
echo "$ACTIVITY"
# {"decision":{"objectiveId":"…","modelVersion":"v1","intent":"introduce"},
#  "objective":{"id":"…","title":"Greetings"},
#  "task":{"id":"…","kind":"choice","prompt":"Hello, in Spanish?",
#          "options":[{"choice":1,"text":"Adiós"},{"choice":0,"text":"Hola"}]}}
# Options are shuffled; each carries the `choice` value to submit.

# Answer it, wrongly. Braivo grades the answer and records it as evidence.
TASK=$(echo "$ACTIVITY" | field 'r.task.id')
curl -sb jar.txt -X POST $BRAIVO/api/courses/$COURSE/attempts \
  -H 'content-type: application/json' \
  -d "{\"id\":\"attempt-1\",\"taskId\":\"$TASK\",\"response\":{\"choice\":1}}"
# {"outcome":"failure","correctChoice":0,"explanation":"Adiós is goodbye."}

# What comes next follows from that answer: greetings again, with the other task.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/activity
# {"decision":{…,"intent":"reteach","lastEvidenceAt":"…"},"objective":{…,"title":"Greetings"},
#  "task":{…,"prompt":"Goodbye, in Spanish?",…}}

# See where the learner stands on each objective, as the organization's owner.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/learners/$LEARNER/progress
# {"modelVersion":"v1","objectives":[{…,"title":"Greetings","phase":"acquiring",…},
#  {…,"title":"Numbers","phase":"unseen"}]}

# Or the whole course, counted by standing per member and per objective.
curl -sb jar.txt $BRAIVO/api/courses/$COURSE/progress
# {"modelVersion":"v1","learners":[{"userId":"…","name":"Owner","roles":["owner"],
#  "standings":{"unseen":1,"acquiring":1,"retained":0,"due":0}}],
#  "objectives":[{"objectiveId":"…","title":"Greetings",
#  "standings":{"unseen":0,"acquiring":1,"retained":0,"due":0}},{…,"title":"Numbers",…}]}
```

The same loop runs in the learn app: sign in at `http://localhost:5173` as `owner@example.com` and choose the course.

## What shapes it

- **The session identifies the learner.** `activity` and `attempts` take no learner ID; they always act for the signed-in account. Course access is still checked: a course outside that account's organizations returns 404. Above, one account plays every part: it owns the organization, and owners may practise too.
- **Learners submit responses, not outcomes.** Braivo grades each response and records the evidence. Each attempt carries an ID the client chooses, unique per learner within the organization, so retrying after a lost response records it once.
- **Only content owners record evidence graded elsewhere.** An application with its own tasks asks `GET /api/courses/<id>/next` for the bare learning decision and records outcomes with `POST /api/organizations/<id>/learners/<id>/evidence`, which needs `owner` or `admin`, since a `member` could otherwise grade themselves. The evidence's `at` timestamp must be exactly what `Date#toISOString()` produces; Braivo uses it to order evidence during replay.
- **Learners can read their own progress; owners and admins can read any learner's progress in their organization.** The learn app shows a learner's standing above each question. A `member` asking about someone else gets 404, as for a course that does not exist.
- **New material waits.** While anything in the course is still being acquired, none of its unseen objectives is introduced, so a learner who keeps failing stays within what they have already met instead of being handed more. Above, greetings come back until they are passed, and numbers wait; where several objectives are in progress, re-teaching moves between them, oldest first. So course order decides which unseen objective comes first, not the whole path ([selection rule](../specs/learning-model.md#selection-rule)). Only objectives with tasks to practise count: one whose tasks are all retired drops out of what the learn app offers.

## An organization's domain, locally

The learn app presents itself as the organization whose registered domain serves it ([deployment](deployment.md#an-organizations-domain)). Locally, a `*.localhost` name stands in for the domain: it resolves to this machine, and the dev server passes `Host` through. Continuing the walkthrough:

```bash
bun apps/server/cli/index.ts organization add-domain \
  --slug example-school --hostname example.localhost
# Registered example.localhost for Example School.

curl -s http://example.localhost:3000/api/organization
# {"name":"Example School"}
```

The learn app at `http://example.localhost:5173` now shows that organization's name, and the API there serves its courses only, answering 404 for others. Signing in there does not work locally: it goes to `BRAIVO_URL`'s `/login` and back over HTTPS, which needs a proxy this repository does not set up, so sign in at `http://localhost:5173` instead.
