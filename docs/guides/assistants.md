# Use Braivo from Claude or ChatGPT

An AI app that connects to remote MCP servers by OAuth, such as Claude or ChatGPT, can work with your organization's material in Braivo, using the app's own model and your subscription to it ([ADR 0045](../adr/0045-remote-mcp.md)). Nothing to install: the app needs Braivo's address and your sign-in.

## Connect

1. In the app, add a connector (Claude: Customize, Connectors, Add custom connector; ChatGPT: a connector or app added by URL) with your installation's address followed by `/mcp`, such as `https://braivo.app/mcp`. Once Braivo is listed in the app's directory, adding it from there does the same.
2. Sign in to Braivo in the page that opens.
3. Choose the organization it works in: one you manage. To work in another, reconnect and choose it; whether an app keeps two connections at once is the app's to allow.
4. Allow it. The page names the app and the organization.

The app acts as you, in that organization alone, with the rights you have there: if you stop managing the organization, the connection can no longer list or reach it.

Some installations fetch no client metadata documents, and accept only the apps their operator registered ([deployment](deployment.md#remote-mcp-clients)). There, an unrecognized client or `invalid_client` at sign-in means the app is not registered: ask the installation's operator to register it.

## What it can do

- Find the organization's sources and courses, and read a source in parts, a range of pages, seconds, or characters at a time.
- Add material as text: a document page by page, a transcript with its timings. A document too large for one request is refused; add it in Braivo's console or with [`braivo sources add`](authoring.md#the-braivo-command).
- Define what material teaches (objectives), and cite the passages that teach each, which Braivo checks word for word against the source.
- Arrange objectives into a course outline, which waits for you to review and publish it in Braivo's console before learners see it.
- Read a course's objectives and tasks.

So it prepares a course; it does not finish one. It cannot write practice tasks, publish, or read learners' names or progress: tasks come to it once Braivo's answers say what waits for review, which Braivo already holds a tool's new courses, tasks, and corrections for ([ADR 0039](../adr/0039-published-in-the-console.md)), and learners' data once it has its own permission. A course of new objectives teaches nothing until they have tasks: add them in Braivo, drafted in its console where your installation offers that, or with [`braivo mcp`](authoring.md#let-your-desktop-agent-build-the-course) from a desktop agent, which has every tool.

What the app reads from Braivo, your material included, goes to the AI provider whose app it is, under its terms.

## Disconnect

In Braivo's console, your account's settings, Connected apps: Disconnect ends one connection at once. The app's next request is refused, and it asks you to sign in again.
