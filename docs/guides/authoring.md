# Authoring a course from existing material

There are four ways to turn material a content owner already has into a course. All go through the same API and the same checks: every quote must be found in its source, and every task must pass the same validation, such as one right answer among its options ([ADR 0021](../adr/0021-citations.md)). A course or task a tool creates, as an agent, a script, or a connected assistant does, waits until its owner publishes it in the console, from the course's page; one created there from Braivo's draft is published as it is ([ADR 0039](../adr/0039-published-in-the-console.md)). A tool's correction of a published task waits too, the task still published until you publish the correction, and only the console retires a published task.

- **In the console, with Braivo's AI.** Under an organization's Sources, add material with its PDF or a photo attached and no text: Braivo reads it page by page. On the source page, describe the learners and draft a course. Deselect anything that is wrong, name the course, and create it. From the course page, review each objective's passages and tasks, and retire any incorrect task. Needs `ANTHROPIC_API_KEY` on the server ([deployment](deployment.md#configuration)).
- **With your own desktop agent.** `braivo mcp` exposes Braivo's authoring tools to MCP clients such as Claude Desktop, Codex, and Grok; drafting runs on your machine, using that client's model and account ([below](#let-your-desktop-agent-build-the-course)).
- **From Claude or ChatGPT.** Connect Braivo by its address and your sign-in, for one organization; it reads and adds material, defines and cites objectives, writes tasks, and arranges them into a course, which waits for your review in Braivo ([guide](assistants.md)).
- **From the command line.** `braivo sources add` adds text, `pdftotext`'s pages, or a caption file, with its original; objectives and tasks then come from either way above, or from your own scripts over the [API](api.md).

To practise on your own, without a school, set up an organization of your own where your installation offers it: you are its owner, so everything here is yours to do.

## Choose how to prepare material

What a file holds, not its type, decides how it becomes practice, and one file can serve several purposes: a driving-theory question bank in a language the learner is still learning can become both the exam's practice and practice of the words its statements use. Tell whoever prepares it — Braivo's AI or your own — what learners should be able to do, and which part of the material matters.

- **Teaching material** (a textbook chapter, notes, a lesson's transcript): _generate_ objectives and new questions from it. Keep each request to a part: "From pages 12–18 of _Spanish A1_, prepare practice on definite articles for adult beginners who speak English: narrow objectives, and questions grounded in the book's examples."
- **Questions you already have** (a question bank, past exams): _convert_ them, keeping each question's wording, answer key, and number. Have your agent write a converter rather than retype them: "Write a script that converts this question bank: every statement and its answer verbatim, quoted by its item number, grouped by topic. Rewrite nothing. Leave out items that need a picture, and list them. Keep a manifest of what you imported, and on a re-import skip what I corrected or retired; stop and ask when unsure." Braivo cannot tell a question never imported from one you rejected; the manifest can. A model retyping a statement can drop a "not" while quoting it correctly, and Braivo checks the quote, not the answer key. A bank's false statements are practice, not teaching: never cite one as the explanation of a rule.
- **The same material for another purpose**: add it once and prepare again from the same source: "From the source _Driving theory questions_, choose the words a learner must know to read its statements, most frequent first, and write recognition questions citing a statement each occurs in."

Bring large material in as a file, not through a chat: add it in the console or with `braivo sources add`, then let the assistant read it a part at a time. An assistant that writes a book's text, or thousands of questions, into its replies spends that many output tokens, and can change words as it goes. A converter needs an agent that can run code on your machine; a hosted assistant without one prepares a small, reviewed batch at a time.

Some things do not carry over yet. A source is text: questions that depend on a picture cannot be practised, so leave them out and keep the list. Check a source's text against the original before drafting from it, columns and tables especially, since a misreading reaches every question citing it. A source cannot be changed: to correct one that tasks already cite, add the corrected text as another source and write the corrected tasks citing it, each as a correction of the task it replaces; publishing a correction in the console retires that task.

Process only material you may, and remember that what an assistant reads goes to its provider. Braivo's AI being off for your organization says what the installation pays for, not whether your school lets you send its material to another AI.

## The `braivo` command

Braivo works with source content as text. Extract it with the tools you already use — `pdftotext` for PDFs, `yt-dlp` for video captions, Whisper for speech, or a desktop agent — then add it to any Braivo installation with the `braivo` command, which acts as you over the API.

Install it, or update it, with one command ([ADR 0027](../adr/0027-standalone-cli.md)):

```sh
# macOS and Linux: into ~/.local/bin
curl -fsSL https://braivo.app/install.sh | bash
```

```powershell
# Windows: into %LOCALAPPDATA%\Programs\Braivo, added to your Path
irm https://braivo.app/install.ps1 | iex
```

On macOS and Linux, add `~/.local/bin` to your `PATH` if the installer says it is missing, or install elsewhere with `BRAIVO_INSTALL_DIR`. `BRAIVO_VERSION=v0.1.0` installs that release rather than the latest. From a clone, run it as `bun packages/cli/index.ts`, or build this machine's with `bun run build`, as `packages/cli/dist/braivo`.

```sh
# Sign in at the address you open Braivo's console at: braivo.app, as below, your
# installation's if you run one, http://localhost:5174 under `bun run dev`.
# Then open the link it prints, check the code, and approve.
braivo login https://braivo.app

# Fetch a video's Spanish captions.
yt-dlp --skip-download --write-auto-subs --sub-langs es --sub-format vtt -o lesson \
  "https://www.youtube.com/watch?v=…"

# Add the transcript to the organization at …/my-school in the console,
# keeping where it came from and its language.
braivo sources add lesson.es.vtt --organization my-school \
  --title "Los saludos" --url "https://www.youtube.com/watch?v=…" --language es
# prints the new source's ID
```

A `.vtt` or `.srt` file is read into timed lines — markup dropped, and the rolling repeats of auto-generated captions skipped, though a line really said twice is kept — so a passage cited from it opens the video where it is said ([ADR 0025](../adr/0025-timed-transcripts.md)). A book's text from `pdftotext`, whose form feeds separate its pages, is added page by page, so a passage names the page to turn to ([ADR 0026](../adr/0026-paged-documents.md)):

```sh
pdftotext libro.pdf - | braivo sources add - --organization my-school \
  --title "Mi primer libro" --language es --original libro.pdf
```

`--original` keeps the PDF itself with the text, so whoever reviews the source, or re-extracts it later, has what it came from.

By default, the first extracted page is page 1. Where the book's numbering differs — after front matter, or for one chapter extracted alone — give the book's number of the first extracted page, printed or blank, with `--first-page`:

```sh
pdftotext -f 40 -l 61 libro.pdf - | braivo sources add - --organization my-school \
  --title "Capítulo 3" --language es --first-page 28
```

Other text is added as is. Running the same command again adds nothing: if identical source content already exists, Braivo returns its ID ([ADR 0024](../adr/0024-idempotent-authoring.md)).

The command keeps your session in `~/.config/braivo/credentials.json` and acts with your account's roles ([ADR 0022](../adr/0022-machine-access.md)); `braivo logout` ends it on the server and deletes the file.

## Let your desktop agent build the course

`braivo mcp` exposes Braivo's authoring as tools to clients that speak the Model Context Protocol, such as Claude Desktop, Codex, and Grok, using your Braivo session: [install `braivo`](#the-braivo-command) and sign in with `braivo login` and your console's address first. For Claude Desktop, add to `claude_desktop_config.json`, with the full path `command -v braivo` prints (`(Get-Command braivo).Source` in PowerShell):

```json
{
  "mcpServers": {
    "braivo": {
      "command": "/Users/you/.local/bin/braivo",
      "args": ["mcp"]
    }
  }
}
```

Then ask it for a bounded piece of work, say "turn chapter 2 of this PDF into a Braivo course for adult beginners: what to say when meeting someone" ([choose how](#choose-how-to-prepare-material)). It reads the PDF, adds its text page by page, defines what it teaches, cites the words that teach each objective, writes questions that cite them too, and orders them into a course. Braivo checks every quote against the source and tells the agent which one it could not find, so a model's paraphrase never passes for the source's words ([ADR 0023](../adr/0023-mcp-server.md)). The course then waits under the organization's **Courses**, marked **Needs review**, and the agent can give you the link to it: open it, review its questions, listed first under **Waiting for review**, and publish it with all of them (**Publish with all**) or with those you select; learners reach only what you publish. A course you do not want, such as one the agent replaced with a rearranged copy (a course cannot be changed), goes with **Delete course** on its page, before publishing; its objectives and questions stay, for other courses. Questions the agent adds later to a published course wait too: **Courses** says how many need review (those of objectives in that course alone), and the course's page lists them first, under **Waiting for review**, each correction above the question as published now. Select the ones you have checked, or an objective's all at once, and **Publish selected**; the rest wait. **Publish all** publishes every one shown. Questions of an objective in no course, or in several, are listed once under **Other objectives**, below the courses, an objective in several only while some wait: its page publishes them, for every course it is in, and learners are asked them only once a published course includes it. An objective in no course stays listed there once its questions are published, so you can still edit or retire them. A question you retired and the agent sends again waits like any other, marked as identical to one retired before. A published course that went out by mistake is hidden with **Hide from learners** on its page, and **Show to learners** brings it back; what learners learned stays.

The same session reads progress too: ask it, say, "who in Beginners is falling behind, and on what?". `course_progress` counts each member's objectives by standing, and `learner_progress` gives one learner's, with the dated evidence behind it: what the console's progress pages show an owner or admin of the course's organization, and a teacher their groups' learners ([progress spec](../specs/progress.md)). That sends learners' names, roles, and standings to the AI you connect and, unless the agent asks `learner_progress` for standings alone (`includeHistory: false`), each answer's outcome and time, though never what they typed: connect it only where your school allows that.

The agent reads the file locally and sends Braivo the text it extracts; `braivo mcp` has no tool to upload a file, since the material an agent reads could steer it to any file on your machine. To keep the original PDF with its source, add the source with `braivo sources add --original`, or in the console ([ADR 0028](../adr/0028-original-files.md)).
