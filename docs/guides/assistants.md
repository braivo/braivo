# Use Braivo from your AI app

An AI app that connects to remote MCP servers by OAuth, such as Claude, ChatGPT, or a desktop agent like Claude Code, can work with your organization's material in Braivo, using the app's own model and your subscription to it ([ADR 0045](../adr/0045-remote-mcp.md)). Nothing to install: the app needs Braivo's address and your sign-in.

## Connect

1. In the app, add a connector (Claude: Customize, Connectors, Add custom connector; ChatGPT: a connector or app added by URL) with your installation's address followed by `/mcp`, such as `https://braivo.app/mcp`. In Claude Code, run `claude mcp add --transport http braivo https://braivo.app/mcp` with your installation's address, then its `/mcp` command to sign in. Braivo's console shows it, ready to copy, in your account's settings, Connected apps. Once Braivo is listed in the app's directory, adding it from there does the same.
2. Sign in to Braivo in the page that opens.
3. Choose the organization it works in: one where you prepare content (as its owner, an admin, or an author). To work in another, reconnect and choose it; whether an app keeps two connections at once is the app's to allow.
4. Approve it. The page names the app and the organization.

The app acts as you, in that organization alone, with the rights you have there: once you no longer prepare its content, the connection can no longer list or reach it.

Some installations fetch no client metadata documents, and accept only the apps their operator registered ([deployment](deployment.md#remote-mcp-clients)). There, an unrecognized client or `invalid_client` at sign-in means the app is not registered: ask the installation's operator to register it.

## What it can do

- Find the organization's sources and courses, and read a source in parts, a range of pages, seconds, or characters at a time.
- Add material as text: a document page by page, a transcript with its timings. A document too large for one request is refused; add it in Braivo's console or with [`braivo sources add`](authoring.md#the-braivo-command).
- Define what material teaches (objectives), and cite the passages that teach each, which Braivo checks word for word against the source.
- Write practice tasks that cite those passages, correct one, or withdraw one still waiting.
- Arrange objectives into a course.
- Read a course's objectives and tasks.

What it adds waits for you: a course, a task, or a correction of a published task reaches no learner until you publish it in Braivo's console ([ADR 0039](../adr/0039-published-in-the-console.md)). For each course and task it writes, Braivo tells the app whether it is new or was there already, whether it is published, and usually the link to the console page where you review it, which the app can pass on to you; open it and publish as in [authoring](authoring.md#let-your-ai-app-build-the-course). It cannot publish anything or retire a published task: both stay yours in the console. Nor can it read learners' names or progress, which wait for their own permission.

What the app reads from Braivo, your material included, goes to the AI provider whose app it is, under its terms.

## On your desktop

A desktop agent can also run the [`braivo` command](authoring.md#the-braivo-command) on your machine, signed in apart with `braivo login`, for what takes your files: adding a PDF's text with the PDF itself, or a book too long to send through its replies. The agent then reads and builds from the source through Braivo's tools, as above. The command acts as you in every organization where you prepare content, not only the connection's, so let it upload only files you name.

## Disconnect

In Braivo's console, your account's settings, Connected apps: Disconnect ends one connection at once. The app's next request is refused, and it asks you to sign in again.
