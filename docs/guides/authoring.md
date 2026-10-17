# Authoring a course from existing material

There are four ways to turn material a content owner already has into a course. All go through the same API and the same checks: every quote must be found in its source, and every task must pass the same validation, such as one right answer among its options ([ADR 0021](../adr/0021-citations.md)). A course or task a tool creates, as an agent, a script, or a connected assistant does, waits until its owner publishes it in the console, from the course's page; one created there from Braivo's draft is published as it is ([ADR 0039](../adr/0039-published-in-the-console.md)). A tool's correction of a published task waits too, the task still published until you publish the correction, and only the console retires a published task.

- **In the console, with Braivo's AI.** Under an organization's Sources, add material with its PDF or a photo attached and no text: Braivo reads it page by page. On the source page, describe the learners and draft a course. Deselect anything that is wrong, name the course, and create it. From the course page, review each objective's passages and tasks, and retire any incorrect task. Needs `ANTHROPIC_API_KEY` on the server ([deployment](deployment.md#configuration)).
- **With your own desktop agent.** `braivo mcp` exposes Braivo's authoring tools to MCP clients such as Claude Desktop, Codex, and Grok; drafting runs on your machine, using that client's model and account ([below](#let-your-desktop-agent-build-the-course)).
- **From Claude or ChatGPT.** Connect Braivo by its address and your sign-in, for one organization; it reads and adds material, defines and cites objectives, and arranges them into a course outline that waits for review in Braivo, but writes no tasks yet: a course prepared there gets its tasks from one of the two ways above ([guide](assistants.md)).
- **From the command line.** `braivo sources add` adds text, `pdftotext`'s pages, or a caption file, with its original; objectives and tasks then come from either way above, or from your own scripts over the [API](api.md).

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

Then ask it, say, to "turn this PDF into a Braivo course for beginners". It reads the PDF, adds its text page by page, defines what it teaches, cites the words that teach each objective, writes questions that cite them too, and orders them into a course. Braivo checks every quote against the source and tells the agent which one it could not find, so a model's paraphrase never passes for the source's words ([ADR 0023](../adr/0023-mcp-server.md)). The course then waits under the organization's **Courses**, marked **Needs review**, and the agent can give you the link to it: open it, review its questions, listed first under **Waiting for review**, and publish it with all of them (**Publish with all**) or with those you select; learners reach only what you publish. A course you do not want, such as one the agent replaced with a rearranged copy (a course cannot be changed), goes with **Delete course** on its page, before publishing; its objectives and questions stay, for other courses. Questions the agent adds later to a published course wait too: **Courses** says how many need review, and the course's page lists them first, under **Waiting for review**, each correction above the question as published now. Select the ones you have checked, or an objective's all at once, and **Publish selected**; the rest wait. **Publish all** publishes every one shown.

The same session reads progress too: ask it, say, "who in Beginners is falling behind, and on what?". `course_progress` counts each member's objectives by standing, and `learner_progress` gives one learner's, with the dated evidence behind it: what the console's progress pages show an owner or admin of the course's organization, and a teacher their groups' learners ([progress spec](../specs/progress.md)). That sends learners' names, roles, and standings to the AI you connect and, unless the agent asks `learner_progress` for standings alone (`includeHistory: false`), each answer's outcome and time, though never what they typed: connect it only where your school allows that.

The agent reads the file locally and sends Braivo the text it extracts; `braivo mcp` has no tool to upload a file, since the material an agent reads could steer it to any file on your machine. To keep the original PDF with its source, add the source with `braivo sources add --original`, or in the console ([ADR 0028](../adr/0028-original-files.md)).
