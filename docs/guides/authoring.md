# Authoring a course from existing material

There are three ways to turn material a content owner already has into a course. All go through the same API and the same checks: every quote must be found in its source, and every task must pass the same validation, such as one right answer among its options ([ADR 0021](../adr/0021-citations.md)). Reviewing before learners see a course is the console's workflow; the API and agents create courses as the person they act for ([ADR 0029](../adr/0029-server-drafting.md)).

- **In the console, with Braivo's AI.** Under an organization's Sources, add material with its PDF or a photo attached and no text: Braivo reads it page by page. On the source page, describe the learners and draft a course. Deselect anything that is wrong, name the course, and create it. From the course page, review each objective's passages and tasks, and retire any incorrect task. Needs `ANTHROPIC_API_KEY` on the server ([deployment](deployment.md#configuration)).
- **With your own desktop agent.** `braivo mcp` exposes Braivo's authoring tools to MCP clients such as Claude Desktop, Codex, and Grok; drafting runs on your machine, using that client's model and account ([below](#let-your-desktop-agent-build-the-course)).
- **From the command line.** `braivo sources add` adds text, `pdftotext`'s pages, or a caption file, with its original; objectives and tasks then come from either way above, or from your own scripts over the [API](api.md).

## The `braivo` command

Braivo works with source content as text. Extract it with the tools you already use — `pdftotext` for PDFs, `yt-dlp` for video captions, Whisper for speech, or a desktop agent — then add it to any Braivo installation with the `braivo` command, which acts as you over the API.

Releases will carry `braivo` as one file per platform, with nothing else to install ([ADR 0027](../adr/0027-standalone-cli.md)). Until the first, run it from a clone as `bun apps/server/cli/index.ts`, or build it with `bun run build` as `apps/server/dist/braivo`.

```sh
# Sign in against the installation's API, then open the link it prints, check
# the code, and approve.
braivo login http://localhost:3000
# Under `bun run dev`, replace :3000 with :5174 in the approval URL it prints;
# the console runs on :5174, while :3000 serves only the API.

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

`braivo mcp` exposes Braivo's authoring as tools to clients that speak the Model Context Protocol, such as Claude Desktop, Codex, and Grok, using your Braivo session: run `braivo login` first. For Claude Desktop, add to `claude_desktop_config.json`, with the path to your `braivo`:

```json
{
  "mcpServers": {
    "braivo": {
      "command": "/usr/local/bin/braivo",
      "args": ["mcp"]
    }
  }
}
```

Then ask it, say, to "turn this PDF into a Braivo course for beginners". It reads the PDF, adds its text page by page, defines what it teaches, cites the words that teach each objective, writes questions that cite them too, and orders them into a course. Braivo checks every quote against the source and tells the agent which one it could not find, so a model's paraphrase never passes for the source's words ([ADR 0023](../adr/0023-mcp-server.md)).

The same session can also read progress: ask it, say, "who in Beginners is falling behind, and on what?". `course_progress` answers for a whole course, every member by name with their objectives counted by standing, and `learner_progress` for one learner, objective by objective with the dated evidence behind each. They read what the API's progress routes answer, to whoever the API lets read it: an owner or admin of the course's organization, or the learner for their own report ([progress spec](../specs/progress.md)). Both send learners' names, standings, and dated learning history to the AI you connect, so connect it only where your school allows that.

The agent reads the file locally and sends Braivo the text it extracts; `braivo mcp` has no tool to upload a file, since the material an agent reads could steer it to any file on your machine. To keep the original PDF with its source, add the source with `braivo sources add --original`, or in the console ([ADR 0028](../adr/0028-original-files.md)).
