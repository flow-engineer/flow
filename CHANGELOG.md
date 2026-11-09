# Changelog

Every release's changes, and a **Migration notes** section for each ([docs/releasing.md](docs/releasing.md)).

## 0.18.0 (9 Nov 2026)

### Changes

- **An onboard button for the site ("Set up with AI"): `app.onboard`.** `{ prompt, label?, agents?, askLabel? }`.
  The site places `<div data-flow-onboard></div>` (or calls `FlowApp.onboard(element, { label?, variant? })`)
  and the embed draws a pill with the assistants' icons (`agents`: Claude, ChatGPT, Cursor). It opens a
  popover showing the setup prompt, with "Copy prompt" and a button that opens the app to ask (`askLabel`,
  default "Ask <title>"). Its "Powered by Flow" line is always shown. The prompt is also in the page itself
  (`[data-flow-onboard-prompt]`, visually hidden), so agents and scrapers reading the page find it. The
  label defaults to "Onboard with AI"; the site sets its own label and variant with `FlowAppConfig.onboard`
  or `data-label` / `data-variant`.
- **`FlowAppConfig.launcher: false`:** no floating launcher on that page; the panel still opens from
  `FlowApp.open()` or the onboard button.
- **`openAICompatible({ maxTokens })`.** The most tokens one reply may use, sent as `max_tokens`. Unset, providers
  such as OpenRouter take the model's maximum and hold credit for it on every call.
- **`openAICompatible({ reasoning })`.** How hard a reasoning model thinks before it answers: `"minimal"`,
  `"low"`, `"medium"` or `"high"`, sent as OpenRouter's `reasoning: { effort }`. Unset, the model's default.
- **A CLI command's own code after its tool: `after`.** `command(tool).after((result, options, cli, output) => …)`
  (or `after` on a tool command) runs on the person's machine once the tool succeeds, with its result, the
  command's own options, the CLI's tools (`cli.call`) and whether JSON was asked for. What it returns is
  printed in place of the result (`--json` and `--fields` apply); undefined prints the result. For work such
  as saving files from a result's links. `flow check` accepts a command's own `options` read only by `after`.
- **Tool groups: tools offered only on their channels.** `createAgent({ tools, groups: [toolGroup({ name,
  channels, tools })] })`: `tools` stays the default group, offered on every channel; a group with `channels`
  is offered only on a turn that answers a message on one of them. A tool's name is unique across them all
  (`agent.addGroup`, `agent.group(name)`). `uiTools(ui, pages, site)` returns the web app's views as a group,
  `views` limited to `app`; mcpServer adds it to the agent unless the agent has a `views` group of its own.
  **Fixed:** a channel's own tools were offered on every channel the person had used in the conversation;
  now only on the channel of the turn's message.
- **`flow test` plays group tools** like the agent's own (the cloud records and simulates them, and `calls` /
  `never` work on them), and lists them in the session tagged with their group and channels. A cloud that
  knows groups shows the agent's tool calls to the simulated person and the judge on a channel with
  `showsTools`, and runs scenarios on a custom UI by name (`channels: [app]`).
- **The web app: the agent in the brand's own site.** `mcpServer({ app })` serves a chat panel that
  a site embeds with `<script async src="<origin>/app/embed.js"></script>`. It docks at the side of
  the page (the page moves over), chats over `/app/chat` (channel `app`, traced as `web`), shows each
  tool call as a step with its CLI command (`app.cli`), opens links to the site's pages in the site
  (`FlowAppConfig.navigate`), and shows how to add the same tools to Claude, ChatGPT, Cursor, VS Code
  and the terminal. `origins` (required), `title`, `subtitle`, `logo`, `greeting`, `placeholder`,
  `suggestions`, `launcher`, `width`, `site`, `pages`, `url`, `cli` and `theme` set it up; `window.FlowApp`
  has `open`, `close`, `configure` and `signOut`.
- **Signed in from the site, no page shown.** `oauthBridge({ app: true })` serves `/app/session`; the
  site's `FlowAppConfig.signIn(request)` returns the code its login page would mint for the request.
  The person's token stays in the panel's own origin.
- **Views (`app.ui`).** Each `AppUi` (`name`, `description`, `input`, an HTML `template`) is the tool
  `ui_<name>`, offered only on the `app` channel and only on Flow's hosting (`FLOW_APP_SERVICE_URL` and
  `FLOW_KEY`). At most one view per answer; with `app.pages`, a view linking a page the site does not
  have is refused. `uiTools` and `UI_INSTRUCTIONS` are exported for an agent's own channels.
- **The panel's look.** `theme`: `mode`, `accent`, `accentText`, `colors`, `dark`, `font`, `fontUrl`,
  `monoFont`, `radius`, `style`, `pattern`, `density` and `css`. Every part's root has
  `data-part="<name>"` beside its class (`header` `.head`, `message` `.msg`, `typing` `.msg.typing`,
  `background` `.backdrop`, `composer` `.composer` with `.field` and `.send`).
- **The panel's parts in the agent's own code.** `app.panel` names a browser module (a file URL or a
  path; one file that imports only types, TypeScript types stripped), served at `/app/parts.js`. It
  exports any of `header`, `message`, `typing`, `background` and `composer` (type `AppPanel`), each
  given the part the panel drew and returning the node to show. The composer's field and send button
  keep their behaviour wherever they go. A part not exported, or one that throws, stays the panel's own.
- **The bottom row.** "Use it in" and "Powered by Flow" are always shown, outside the reach of
  `theme.css` and the panel module. `app.places` sets which places it offers and in what order
  (`"terminal"`, `"claude"`, `"chatgpt"`, `"cursor"`, `"vscode"`); their addresses are `url` and
  `cli.install`.
- **`ChannelInfo.showsTools`** (default off): on a channel that draws each tool call, the agent sends no
  acknowledgement, progress or early partial answer, and answers once. `Channel.tools` (and
  `customUI`'s `tools`) offers tools only on that channel, read every turn.
- **`terminalServer`** takes `showsTools`, `instructions`, `traceChannel`, `tools` and `onRequest`, and
  `{ "reset": true }` starts a new chat (the agent stops seeing the earlier messages, which are kept).
  `commandLine` (`@flow-engineer/flow/cli`) gives the CLI line for a tool call.
- **Versioned MCP contracts: a server changes its tools and every CLI already published keeps
  working.** `mcpServer({ contracts: { current, supported, pick } })` keeps only the current tools;
  each older contract is one adapter over them (`supported[n]`): a tool's old name, its old input
  schema with `mapInput`, its old output schema with `mapOutput`, and `legacy` tools for one
  removed (a stand-in calling its replacement, or a small implementation of its own). A request is
  answered in the contract it names (`_meta["flow.engineer/contract"]`), else the one `pick` chooses
  from its clientInfo (for CLIs published before they named one), else the current one, which is
  what MCP hosts get. A contract no longer served is refused with how to update (`run \`acme
  update\``). `tools/list` says the contract it answered in, and traces' tool events carry it.
- **`defineCli({ contract })`:** the CLI names its contract on every request; a CLI too old for
  its server prints one line, `This acme (0.1.4) is too old for <server>. Run \`acme update\` to
  get the newest version.` (exit 1).
- **`contractSnapshot` and `contractProblems`** (`@flow-engineer/flow/mcp`): save a contract's tools
  and sample calls, and check in CI that a change still keeps it (additions pass).
- **A coding-agent skill, `flow-framework-contracts`** (`coding-agents/contracts-skill.md`): when a
  change is breaking, how to bump the contract, write its adapter and snapshot, and when to drop one.

### Migration notes

- `Channel.tools` (and `tools` on `customUI` and `terminalServer`) is deprecated and will be removed: give
  createAgent a group limited to that channel, `groups: [toolGroup({ name, channels: ["<channel>"], tools })]`.
  Until then it works as that group, and Flow warns once.
- `uiTools()` returns a `ToolGroup` (`{ name, channels, tools, answer }`), not `{ tools: () => Tool[], answer }`:
  pass it in createAgent's `groups` (or `agent.addGroup`) instead of a channel's `tools`, and read its tools as
  `views.tools`.
- A channel's own tools are no longer offered on a turn answering another channel's message.

## 0.17.2 (8 Nov 2026)

### Changes

- **A video whose reply is slow types after 5 s.** Since 0.17.1 a video got 👀 on arrival and its
  turn showed no typing at all, so while a video took half a minute to read the person saw 👀 and
  then nothing until the reply. The 👀 still goes on arrival; if nothing from the agent has reached
  them 5 s after the video arrived, typing shows too and is kept up as for other messages (every
  20 s on WhatsApp) until the reply, never after it. A reply within 5 s still shows only the 👀.
  `videoReaction: false` types on arrival as before, and a reaction that fails types at once.
- **The agent is told the video already has its 👀.** When the arrival reaction went, the message
  reaches the model with one line saying so, so it does not react 👀 to it again; another emoji is
  still its choice.
- **The playground shows a video's 👀 and read receipt on it.** Both go the moment a video
  arrives, before the playground had given the page the message's id, so the page had no message
  to put them on and dropped them. The playground now shows them once the id is given, and after
  a reload too: the agent's history keeps the arrival reaction (`agent.transcript()` lists it
  after the message), and the playground keeps the read receipts it showed. Channels through Flow
  Messaging and the web chat were never affected: their messages carry the platform's id from
  the start.

### Migration notes

None.

## 0.17.1 (8 Nov 2026)

### Changes

- **A message with files shows the agent on it at once, not after it is read.** Since 0.17.0
  typing for a message with the platform's id (every Flow Messaging message) started only once it
  was stored, which for a video came after its description (3.7 s for one, up to 25 s for several at
  once), so until then the person saw nothing. A message with files now types the moment it
  arrives, before they are downloaded and read: a voice note being transcribed (`transcribe`), a
  photo or PDF being downloaded, and a video being described (`describeVideo`) when `videoReaction`
  is off (below). On WhatsApp the typing call also shows the blue ticks (Flow Messaging anchors it
  on their latest message); on iMessage the read receipt still goes when the turn takes the message.
  Typing is kept up while the file is read (`typingLastsMs`: every 20 s on WhatsApp), and a typing
  call that fails or hangs never holds up reading or the reply. Default on; a channel with
  `typing: false` (or `disable: ["typing"]`) is never sent one. When two runners are given the same
  message with files, both type while they read it; it is still answered once, and neither is left
  typing.
- **A video gets 👀 the moment it arrives, and its turn shows no typing.** A message with a video
  gets the agent's reaction before the video is downloaded or watched, through the same send as the
  `react` tool's (a `reaction` outbound, and a `reaction` event with `arrival: true`), and the turn
  that answers it sends no typing on that channel: none on arrival, none kept up, none while the
  agent works or writes. On WhatsApp the blue ticks still show on arrival: the read receipt goes by
  itself (no typing indicator) with the reaction. iMessage's read receipt still goes when the turn
  takes the message.
  - **`videoReaction`:** createAgent's new option. Default on, with 👀; a string is another emoji;
    `false` turns it off, and a video types on arrival as other files do.
  - **Where it goes:** where the channel has reactions and takes the emoji: on Telegram only the
    reactions Telegram lets bots use (👀 is one; an emoji with U+FE0F or a skin tone matches as Flow
    Messaging matches it); on iMessage any, though iPhones on iOS 17 or older may show one other
    than the six tapbacks as a line of text; on WhatsApp and the web, any. Elsewhere (SMS, or an emoji
    Telegram does not take) that turn types instead.
  - **A reaction that fails** is logged with a warning and never fails the turn: the turn types
    instead. Photos, voice notes and documents type on arrival. If the agent reacts to the same
    message itself later, its reaction replaces this one where the channel allows.

### Migration notes

- **A video gets 👀 and its turn shows no typing.** Default on, so an agent whose people send
  videos shows 👀 on them and no typing for those turns. To move: nothing, or to have a video type
  on arrival instead, `createAgent({ ...options, videoReaction: false })`.

## 0.17.0 (7 Nov 2026)

### Changes

- **The agent can ask its own questions about a video: `ask_about_video`.** A video described once
  (`describeVideo`) or watched turns ago is no longer all the agent gets: when a buyer asks "is
  there a scratch near the charging port?", the agent calls the built-in `ask_about_video`
  (`question`, and `message`, the id of the message the video came in; the latest video when left
  out) and a video model watches it again and answers, `{ video, answer }`.
  - **Who answers:** `describeVideo`'s new optional `ask(video, question)`; `describeVideoWith(model)`
    has one, the same model and key as its descriptions (a `Flow-Test-Session` header under
    `flow test`, as there). A custom describer answers when it has `ask` too:
    `Object.assign(async ({ mime, data }) => text, { ask: async ({ mime, data }, question) => text })`.
    Without one, an agent whose own model watches videos (`openAICompatible({ videos: true })`) is
    asked itself, in a call of its own with the video and no tools.
  - **When it is offered:** only while the conversation has a video the agent can't see now: one
    described, or one its model watched that is no longer shown (only the latest 3 photos, PDFs and
    videos stay shown, one of them a video, and none after a restart). A video the model is shown
    now needs no question, and asking about it is refused. Never with a describer that only
    describes and a model that can't watch, or for a video whose channel can't give it again.
  - **Where the video comes from:** its channel, again, each time: nothing is kept in memory or the
    store. An `Attachment` may carry `ref` (the file's id on its channel), kept with the message,
    never shown to the model, and a `Channel` may have `file(ref)`, which fetches it again
    (`null` once the channel no longer keeps it). The `flow-messaging` adapter sets both (Flow's
    file id; a 404 or 410 from Flow is `null`), as do the simulators and `flow test`. 10 MB at most.
    `agent.receive` takes the fetcher as `options.file`.
  - **Guards:** 3 questions a turn and 10 a video (counted from the history, so a restart keeps
    them). A video no longer kept, one that can't be fetched now, one over 10 MB, or a video model
    that fails is a `ToolError` whose message says what to do ("Ask them to send it again"), and an
    `attachment.failed` event (`kind: "video"`, `messageId`, `tool`). The call is a tool span in
    traces, as any tool's. The reply waits for it up to 120 s, the video model's own limit.
- **`flow test` scenarios can send a video:** `attach: { kind: video, file: fixtures/clip.mp4 }`
  (`.mp4`, `.mov`, `.webm`, `.mpeg`), read from the tests folder and, when the agent asks about it,
  read again from there by its path; `expect: { calls: [ask_about_video] }` checks it asked. The
  simulators keep a sent video for the agent to fetch again until newer files push it out.
- **`flow mcp login` ends on a page in flow.engineer's look.** Flow's own CLI now sets
  `signInPage` (and `brand.name` "Flow"): the browser lands on Flow's logo and the site's card on
  its gradient, after flow.engineer's Allow page, light only like every Flow page. The copy and
  behaviour are the same (the tab tries to close after 1.5 s; the code leaves the address bar),
  and the page names its own style and script by hash in a CSP meta tag. Teams' CLIs keep the
  framework's branded page; nothing changes for them.

### Migration notes

- An agent with `describeVideoWith(...)`, or a model that watches videos, now gets `ask_about_video`
  on channels that give files again (Flow Messaging's, the simulators, `flow test`), and each
  question is a video model call on its key. To keep descriptions only, pass a describer without
  `ask`: `describeVideo: (video) => described(video)`, where `const described = describeVideoWith(...)`.
- `DescribeVideo` is now an interface: a function, as before, with an optional `ask`. A plain
  `async ({ mime, data }) => text` is still one.
- A tool of your own named `ask_about_video` is shadowed by the built-in one while it is offered:
  rename yours.
- A watched video's `Media` (what a `Model` is sent) carries its `ref`; a model of your own ignores it.
- A hand-written channel (`customUI`, `whatsapp()` with your provider) gets the tool only once its
  attachments carry `ref` and the channel has `file(ref)`: add both to let the agent ask.
- Nothing changes for a team's CLI.

## 0.16.1 (6 Nov 2026)

### Changes

- **`logout` ends the sign-in on the server, not only on this computer.** A `defineCli` CLI's
  `logout` (and `flow mcp logout`) now revokes the stored refresh token, then the access token, at
  the authorization server's advertised `revocation_endpoint` (RFC 7009) before forgetting them, so
  the OAuth bridge's `tokens.revoke` ends the connection. Until now it only deleted the local
  tokens, which stayed good until they expired. A refusal or an unreachable server is a warning, and
  the person is still signed out here ("Signed out of <server> on this computer only."). A server
  advertising no revocation endpoint is sent nothing. `beforeLogout` still runs first.

- **`flow insights` counts conversations it can't read, and only when that matters.** The line
  about text Insights can't read comes from Flow's `without_text` (`{conversations, of}`, sent at 5 or
  more conversations and 20% or more of the window's, never for a health workspace): "Insights can't
  read 12 of 40 conversations (30%): they came without message text (the agent's traces send
  metadata only)." Below that rule it says nothing; the older `messages_without_text` (a count of
  messages) is no longer printed. `--json` is Flow's answer as before.

- **An MCP server alone deploys to Flow's hosting.** A project with `src/mcp.ts` and no
  `src/agent.ts` (no `buildAgent`, model key or channels) is no longer refused: `flow deploy` needs
  `package.json`, `package-lock.json` and either file, and hosting serves its MCP paths with no chat
  agent, calling the factory as `mcp(undefined, host)` with `host.oauthStorage` (the OAuth bridge's
  storage on Flow's store), so production takes it. `flow check` reads such a project's tools from
  `src/mcp.ts`, which exports them beside `mcp` (`export { tools }`); without them it is an error,
  as it is for `src/agent.ts`. `flow mcp update` loads `src/mcp.ts` when there is no `src/agent.ts`.
- **`flow logs --severity ERROR` and MCP `read_logs` with severity ERROR show a 0.15.x runtime's
  errors.** Runtimes before 0.16 wrote Flow Framework's own errors as plain console text, which
  Cloud Run keeps at `DEFAULT` (`flow: scheduled messages: Error: flow-agent-store: unfinished:
  HTTP 503`, a `TimeoutError`/`DOMException` stack), so they were left out. After split stacks are
  joined, a `DEFAULT` line is now read as `ERROR` when, by fixed rules, it is an uncaught error: its
  first line matches `flow: ... Error:`, starts with an error's name (`Error:`, `TypeError:`) or
  holds `DOMException`, or it is a stack (a later line `    at ...`). That holds for every
  `--severity` and without one, in `--json` too. Since Flow's hosting keeps only the lines at the
  asked severity or above, up to `ERROR` the CLI asks for every line and filters them itself (more
  pages for a long window); above `ERROR` the host still filters. A stack's `at` lines now come with
  it under `--severity`.
- Tests: the CLI tests that want plain output (`NO_COLOR`) also drop `FORCE_COLOR`, which
  `node --test` sets when its output is a terminal, so `npm test` passes at a terminal as in a pipe.
- **Videos the person sends reach the agent.** An `Attachment` may be `kind: "video"`, and the
  `flow-messaging` adapter now hands WhatsApp, Telegram and iMessage videos in as one (until now a
  video was only its caption and `[video]`). Up to 10 MB, one of three ways:
  - **Watched by the model**, when it reads videos: `openAICompatible({ videos: true })` (default
    false; `reads.videos` on a `Model`) sends MP4, MPEG, MOV and WebM as OpenRouter's `video_url`
    part, a base64 data URL. Through Flow (FLOW_KEY) or OpenRouter that is a model such as
    `google/gemini-3.8-flash`. Of the latest 3 photos, PDFs and videos shown, at most one is a video.
  - **Described**, with `createAgent({ describeVideo })`: the agent reads `[video, described: ...]`
    in its place. `describeVideoWith("google/gemini-3.8-flash")` is Flow Framework's own: it asks
    that model, through the agent's own key, what the video shows and what is said in it (FLOW_KEY
    or OpenRouter: a `video_url` part; a Gemini key: Gemini's `generateContent`, the id without
    `google/`). With only an OpenAI or Anthropic key it throws `no_video_key` when made, naming the
    keys that work. Or pass your own `async ({ mime, data }) => text`.
  - **Neither**: the caption and `[video: you can't watch videos]`, and the video is never fetched.
- An `Attachment` may say its `size` in bytes; one over the limit is named as too large and never
  fetched. The `flow-messaging` adapter fills it from Flow's `size_bytes`.
- The `message.in` event carries a described video's text as `description`; the simulators send
  videos (they play in the thread) and their Debug log shows the transcript or description the agent got.
- `spec/request.schema.json` (an HTTP agent's request) takes attachments of kind `video`.
- The model is told it is no longer shown "the photos, videos or documents" (was "photos or documents").
- **A reply can carry a video.** `Outbound` messages take `video` (`Video`: `{ url }`, https, or
  `{ fileId }`, the provider's own), the text its caption, alone: never with buttons, a list, a link
  or an image. Channels that take videos say so with `ChannelInfo.videos` (`{ captionMax }`), and
  their send tool offers `video` as it offers `image`. The `flow-messaging` adapter's WhatsApp,
  Telegram and iMessage channels have it (caption up to 1,024) and send it as a `basic` message with
  `media.type` `video`. Elsewhere (SMS, the web chat, a custom UI that does not declare it) a video
  is refused before it is sent, with why (`content.media`), as is one with buttons, a list, a link or
  a photo; the agent is told and can send a link instead. A hand-written `whatsapp()` provider gets
  videos only with `features: { videos: true }` (and `disable: ["videos"]` turns them off), so none
  reaches a provider that would drop it. `WHATSAPP` has `videos`.
- `spec/response.schema.json` (an HTTP agent's replies) takes a message's `video`, `{ url }` or
  `{ fileId }`; `spec/agent-endpoint.openapi.yaml`'s platform table names `videos` for WhatsApp,
  Telegram and iMessage. The simulators show a sent video in the thread (a file id as its id) and
  refuse one where the platform has none.
- **Under `flow test`, calls to Flow's model gateway carry the test session's id.** Once the test
  cloud's session opens, `openAICompatible`/`flowModel` completions, `flowTranscribe` and
  `describeVideoWith` send it in a `Flow-Test-Session` header, only when the call goes to Flow's
  address (`flowModelURL`), never to OpenRouter, OpenAI, Anthropic, Gemini or any other. On a Pro
  workspace Flow counts those calls as free test spend whatever the key's mode, once the test cloud
  confirms the session; an unconfirmed session is charged normally. The playground and the local
  simulators are not test cloud sessions, and an `--agent-url` agent makes its model calls in its
  own process, so neither sends it.
- **A tool can fail with a document: `ToolError`.** `throw new ToolError(code, message, { hint, next })`
  (from `@flow-engineer/flow`). Over MCP the result is an error whose `structuredContent` is
  `{ ok: false, error: { code, message, hint? }, next }` and whose text is the message, a `Next: ...`
  line and that JSON. A CLI command (`defineCli`) with `--json` prints the document on stdout; with
  or without it, stderr has the message and `Next: ...`; it exits 1. `cli.call` in a command of your
  own rejects with the `ToolError`. A plain throw is unchanged, and in a chat the model reads a
  `ToolError`'s message as for any throw.
- **`mcpServer(...).stdio()`** serves the same tools, descriptors, instructions and traces on stdin
  and stdout, for a host that runs the server as a local command, until the host closes stdin.
  Nothing but the protocol goes to stdout. There is no sign-in on stdio (the caller is anonymous),
  and tools kept to some clients are not served.
- **The CLI over a handle in the same process.** `defineCli({ server: mcpServer(...) })` calls the
  tools with no network and no sign-in, as the client kind `"cli"`, unless `--server` or
  `<NAME>_SERVER` names a URL; no discovery cache is kept for it. `serverEnv` renames
  `<NAME>_SERVER`.
- **`connectCli(cli, { server?, token? })`** (`@flow-engineer/flow/cli`): the CLI's connection for
  commands that parse their own arguments; `call(tool, input, { command })` resolves with the data,
  rejects with the tool's `ToolError` or a `CliExit` (now exported) whose `code` is the exit code.
- A tool's `context.cli` is `{ command }` when the agent's CLI made the MCP call (the command's
  words), to word a failure for a person at a terminal. The client says it: wording only, never access.
- A tool kept to some clients (`mcp: { clients: ["cli"] }`) no longer needs `mcpServer({ auth })`:
  without auth it reaches only the CLI in the same process.
- **Flow's read tools, `flowReadTools()`** (`@flow-engineer/flow/testing`): what `flow conversations`,
  `issues`, `insights`, `templates`, `logs` and `deploy status` read, as Flow Framework tools, for
  `mcpServer({ tools, instructions })`. `flowReadTools({ dir?, cloud?, env? })` reads with the
  folder's keys as the commands do; `flowReadTools({ hosted: { credential?, cloud? } })` gives every
  tool an `agent` input (a `flow_agent_id` or name; optional when the person has one) and adds
  `list_agents`, and each call takes its key from `context.credentials.get(credential)` (default
  `"flow"`), a `FlowAgentAccess` (`agents()`, `key(agent)`), never from the model. Failures are
  `ToolError` documents. `flow mcp serve` is now that, on `mcpServer(...).stdio()`: the same 8 tools,
  descriptors and instructions, byte for byte.
- **`--server <url>` (or `FLOW_MCP_SERVER`) and `--agent`** on `flow conversations [show]`, `issues
  [test-case]`, `insights [show]`, `templates`, `logs [--follow]` and `deploy status`: they read over
  a hosted Flow MCP as the person signed in with **`flow mcp login --server <url>`** (`flow mcp
  logout` forgets it; `FLOW_MCP_TOKEN` for CI), through its tools, and print what they print today.
  `--cloud`, `--dotenv` and `--dir` do not go with it. Without `--server` they read with the
  folder's keys through the same tools, in the same process (`connectCli` over the server's handle),
  as any CLI built on the framework does: `--json`, help, the lines, failure documents and exit
  statuses are byte for byte what 0.16.0 printed, and `--json` prints the same with `--server`. The
  other commands still load no MCP SDK.
- `Tool.format(output, input)` also gets the input the tool was called with.
- **`jsonText(text, data?)`** (`@flow-engineer/flow`): a tool returns the JSON an API answered,
  kept as its text: `return jsonText(await res.text())`. `data` (by default the text parsed) is the
  structured content checked against `output`; the text is what a host reads as the result's text
  (unless the tool has `format`), what a model reads in a chat, and what the CLI prints with
  `--json`, byte for byte, over a handle or a URL (`--fields` picks from the data). `jsonTextOf(value)`
  is the text a value carries, also on what `cli.call` and `connectCli`'s `call` resolve with.
  The result's `_meta["flow.engineer/json-text"]` is `true` when its text is that JSON, or, beside a
  `format`ted text, the JSON itself for a CLI caller only. Flow's read tools return Flow's answers so,
  which is how `flow <command> --json` prints Flow's own text through them.
- **`@modelcontextprotocol/client` (2.3.1) and `@stricli/core` (1.3.0) are dependencies**, no longer
  optional peers: the read commands run on them, and `flow inspect`, `flow cli` and `flow mcp
  login` need nothing more installed (`npx -y @flow-engineer/flow inspect <url> tools`). `flow new`
  no longer writes them into a new agent's package.json, as for `@modelcontextprotocol/server`.
- **`mcpServer(...).fetch(request)` takes a request with no `Host` header**, as an MCP client in
  your own code sends one (its transport's `fetch` calling `handle.fetch(new Request(url, init))`):
  the URL's host is used. It failed with "Missing Host header"; a `Host` naming another host is still
  refused on localhost (DNS rebinding).
- **A CLI's `login` against a server it cannot reach** (`flow mcp login` too) exits 5 with
  `Could not reach <server>: ...`, as every other command says it; it printed `Command failed,
  TypeError: fetch failed` and exited 1. **`logout` with nobody signed in** says `Not signed in to
  <server>.`, not `Signed out of <server>.` (still exit 0).
- `McpToolDescriptor._meta` is optional, so a `descriptor` can leave it out without a cast.
- `flow check`'s warning for a tool kept to the CLI in a project with no `src/cli.ts` now says that
  only a CLI signed in as the server's CLI client sees it, such as `npx @flow-engineer/flow
  <command> --server <url>` for Flow's own MCP server, instead of that no client sees it.

- **A simulated conversation reaches a Flow Messaging agent.** Flow Messaging's simulated contacts
  (`POST /v0/test/conversations`, test keys) write on the app's simulated sender, never the
  channel's own, so the `flow-messaging` adapter passed their events over: a hosted agent never
  answered them. An event of a conversation with `simulated: true` now reaches the agent's channel
  of that platform (its Telegram, WhatsApp or iMessage channel), and the reply goes into that
  conversation. A real conversation on a sender the agent does not use is still passed over.
- **Traces of big batches go gzipped, and a lost batch says what it cost.** A request body over
  64 KB goes with `Content-Encoding: gzip` (OTLP/HTTP's own; Flow's traces endpoint takes it): with
  content on, as under `flow test`, a batch of turns with long tool results took longer than the 10 s
  timeout on a slow connection, and every session printed a `TimeoutError`. When traces still cannot
  be sent, the one warning says how many turns' traces were not sent and that the agent is
  unaffected (under `flow test`: the test's results do not depend on them; only those conversations
  are missing from `flow conversations` and the dashboard), and a timeout says it waited 10 s.
- **A test run's traces name its platform.** A turn on a channel the agent does not define (the test
  cloud's Telegram run of an agent with no Telegram channel, through `receive()`) was traced as
  channel `other`; it is now the platform its `ChannelInfo` names (`telegram`), so `flow
  conversations` and the dashboard show it.
- **`flow test`'s counts agree with its pass rate.** The first summary line names the flaky runs
  (`6 of 10 runs passed. 2 flaky. 2 failed.`), and each channel's line is counted as the pass rate
  is (flaky runs as passed, as failed with `--strict`; credit and infrastructure runs not counted):
  `  telegram: 10 of 10 counted runs passed (3 flaky)`, where it read `telegram: 7 of 10 passed`
  under `Pass rate 100%`.
- **The starter allows the install scripts it needs.** `flow new` and `flow init` write
  `"allowScripts": { "esbuild": true, "koffi": true }` into `package.json`, so a fresh `npm install`
  on npm 11 no longer warns `2 packages have install scripts not yet covered by allowScripts` (and
  keeps working when npm starts blocking unreviewed scripts).
- **A message two runners receive at once is answered.** When one provider message reached two
  processes of an agent on one store (a replaced Cloud Run instance still reading Flow Messaging's
  stream beside the new one), the process whose store write lost the message's id kept the id, and
  if it then took the conversation it marked the other's stored copy done as already answered: no
  reply, no read receipt. That process now forgets the id, so whichever process holds the
  conversation answers it once; a stored message counts as already answered only when it is in the
  history. Typing for a message with a provider id now starts once this process's store write has
  taken it (a voice note's typing after it is read), so only the process that has the message types.
- **A turn run again on another process reaches the person on Telegram and iMessage with no sender
  set.** A turn cut off by a restart (or a process that died holding it) is run again by another
  process, whose `flow-messaging` adapter never saw the person's message, so it had no Flow
  conversation to send into and, without `FLOW_MESSAGING_<CHANNEL>_SENDER`, failed every send with
  `no conversation with them on telegram yet, and no sender to start one`. A channel's `send` now gets
  a third argument, `{ lastMessageId }` (`ChannelSendContext`): the provider's id of the person's
  latest message on that channel, from the conversation's history. The adapter finds the
  conversation from it (`GET /v0/messages/{id}`) when it has none, and starts one from the sender as
  before when Flow no longer knows that message.
- **A store outage no longer loses Flow Messaging stream events.** An event that failed 5 times was
  passed over and the stream's cursor moved past it, also when what failed was the agent's store
  (flow-agent-store down, a database restarting): every message in the outage was lost. After a
  failed event the adapter now reads the store once (`agent.conversationOf`, the event's own
  identity): while the store does not answer, the cursor stays, the try is not counted and the
  stream reconnects with its backoff for as long as the outage lasts (one `WARNING` per outage,
  with the event's id). Only an event that fails 5 times while the store answers is passed over, as
  before.
- **A turn owed a reply never ends in silence when the model answers in plain text twice.** After
  the one reminder that plain text never reaches them, a second step of plain text is sent as the
  reply on the channel they are owed one on (the latest), as the send tool would have sent it, and
  the history keeps it as that send; with no text in that step, the text the reminder was about is
  sent. It is logged as a `WARNING` with ids only (conversation, turn, channel). A turn that still
  ends with nothing sent where a reply was owed (a model that wrote nothing twice) is now logged as a
  `WARNING` too: `flow: conversation <id> turn <n> ended with nothing sent to them on <channel>,
  where they were owed a reply`.
- **`flow deploy` never sends a live Flow key to staging.** A `.env` value that is a live-mode Flow
  key (`fk_live_`, `flow_live_`, `otk_live_`) is no longer sent to staging (`flow deploy`,
  `secrets --from-env`): it is listed under `skipped` with why, naming only the prefix
  (`FLOW_MESSAGING_KEY skipped: a live key (fk_live_) goes to production only; staging takes a test
  key (fk_test_), ...`), and staging keeps the value it has; Flow's hosting refuses it too. A
  test-mode key (`fk_test_`, `flow_test_`, `otk_test_`) sent to production still goes, with a warning
  on stderr. `FLOW_KEY` goes to both: Flow's hosting exchanges it for the environment's own runtime
  key. Until now a `.env` holding the live `FLOW_MESSAGING_KEY` put it on staging, which then read
  production's live stream.
- **Tests: fakes are gone.** `tests/tools/<tool>.fake.ts` is no longer run: a model plays every
  tool from its tool file (`tests/tools/<tool>.yaml`) and the scenario's `world`. `loadFakes` is
  removed, the open no longer names `fakes`, and the protocol's fake round trip (`play: "fake"`,
  the call's `ticket` and `faked`, `fake_failed`) is gone. `Fake`, `FakeCall` and `FakeAnswer` stay
  exported as deprecated types for this release, so a leftover fake file still typechecks.
- **`flow test fake` is removed.** It says so and what to do instead (write the tool's responses,
  each with a `when:`, in `tests/tools/<tool>.yaml`), and exits 1 (`--json`: code `removed`).
- **The fake hints are gone**: the line after a session naming the tool calls a model played and
  suggesting a fake, the line before one naming write tools without a fake, the "This cloud does not
  play fakes" line, and `FLOW_FRAMEWORK_FAKE_HINT`. `flow test --json` no longer has
  `toolsWithoutFake` or each run's `toolsPlayedBy`.
- **`given:` is no longer played**: no tool modes (`usual`, `slow`, `down`, `flaky N%`), `seed` or
  data, and `flow test` no longer checks `given.tools` before sending. Say how a tool behaves in
  `world:` and give its tool file a response for it whose `when:` fits.
- **`expect.state` is no longer checked.** Check what the agent did with `expect.calls` (a tool and
  its `args`) or an `expect.outcome` sentence.
- **`origin:` is no longer read.** `flow test pull` takes each draft's check from the draft Flow
  sends (`check`), not from its YAML.
- **`--fresh` does nothing, and the cloud's replays are gone from the client**: the open no longer
  sends `fresh`, a run's line no longer says how many stored answers it replayed, the "The cloud
  replays stored person, tool and judge answers" line is gone, and `flow test --json` no longer has
  each run's `replayed`. `--fresh` is still taken for this release and warns.
- **The `restart` opening step is removed** (`restart: crash | deploy`), with the protocol's
  `restart` command and step answer and `options.testing.runner` in a business run. What it showed
  (across a crash a new runner takes the turn once the lease runs out and runs it once; across a
  deploy the old runner finishes what it holds, a message the new one stored included; no message
  answered twice, no turn lost) is proved on the store by Flow Framework's own tests
  (`test/store.test.ts`). A business run's agent still gets a store of its own (`options.testing.database`).
- **What 0.16.1 stopped playing still parses, for this release.** A scenario with `given:`,
  `origin:`, `expect.state` or a `restart` step, and a leftover `tests/tools/*.fake.ts`, is never an
  error: the field is dropped (nothing reads it) and `flow test` and `flow check` print one line per
  file and field with what to do instead, such as `tests/scenarios/order-fails.yaml:20: given: is
  no longer played (deprecated in 0.16.1, removed in the next release): describe the data in world:
  and how a tool fails or is slow as a response in tests/tools/<tool>.yaml with a when:; then delete
  given:.` A restart step is left out of the opening; an opening of only restart steps is an error.
- **The café starter has no fakes and no `given:`.** `flow new` and `flow init` no longer copy
  `tests/tools/get_menu.fake.ts` and `place_order.fake.ts`; `latte-correction` checks the order with
  `expect.calls` and an `outcome` sentence, `order-fails` gets the point of sale down from its
  `world`, and the starter's `tsconfig.json` includes `src` only.

### Migration notes

**Tests: what 0.16.1 stopped playing.** For this release `given:`, `expect.state`, `origin:`, a
`restart` opening step, `tests/tools/*.fake.ts` and `flow test --fresh` still parse (or are taken)
and are ignored, and `flow test` and `flow check` print one line per file and field saying what to
use instead (`--fresh` warns on `flow test`). The next release removes them. Each, with how to move:

- **`given:` is no longer played.** Until the next release it parses, is ignored, and `flow test`
  and `flow check` name it. To move, put the data in `world:` and each tool's behaviour in its tool
  file as a response with a `when:`, then delete `given:`:

  ```yaml
  # before
  world: The point of sale is down this morning.
  given:
    tools: { place_order: down }
  # after (tests/tools/place_order.yaml has a response "when: The point of sale is down" with an error)
  world: The point of sale is down this morning and stays down for the whole conversation.
  ```
- **`expect.state` is no longer checked.** It parses, is ignored and is named. To move, check the
  call the agent made, or say the outcome:

  ```yaml
  # before
  expect:
    state:
      orders: [{ name: Sam, items: [{ item: Latte, size: large, milk: oat }] }]
  # after
  expect:
    calls:
      - { tool: place_order, args: { name: Sam } }
    outcome:
      - Exactly one order is placed, for one large latte with oat milk, under the name Sam.
  ```
- **`origin:` is no longer read.** It parses, is ignored and is named. To move, delete it. Code that
  read `Scenario["origin"]` reads a draft's `check` from `flow test pull --json` instead.
- **The `restart` step is removed.** A `- restart: crash` or `- restart: deploy` step parses, is
  left out of the opening and is named; an opening with nothing else fails to parse. To move, delete
  the step. Code reading `OpeningStep["restart"]`, `OpenSession.restart`, `Opened.restart`, the
  `restart` command or `StepAnswer.restart` drops it; a `buildAgent` that read
  `options.testing.runner` sets its own `runner`.
- **Fakes are no longer run.** A `tests/tools/*.fake.ts` is named and ignored. To move, delete it
  (and any `import type { Fake } ...` with it: `Fake`, `FakeCall` and `FakeAnswer` go in the next
  release). `loadFakes`, and the protocol's `Faked`, `FakeRequest` and `ToolsPlayedBy` types, are no
  longer exported; `OpenSession.fakes`, `Opened.fakes`, `ToolCallRequest.ticket` and `.faked` are gone.
- **`flow test fake` is removed**: it exits 1 with what to do instead (`--json`: code `removed`).
- **`flow test --fresh` does nothing** and warns; drop it. `OpenSession.fresh`, `Opened.replay` and
  `RunSummary.replayed` are gone.
- **`flow test --json` drops fields**: top-level `toolsWithoutFake`, and each run's `replayed` and
  `toolsPlayedBy`. A script that read them stops reading them; `.flow/last-session.json` is unchanged.
- **Lines `flow test` no longer prints**: `N tool calls were played by a model (...)`, `<tool> counts
  as a write and has no fake ...`, `This cloud does not play fakes ...`, `The cloud replays stored
  person, tool and judge answers ...`, and a run line's `; replayed N stored simulator answers`.
  `FLOW_FRAMEWORK_FAKE_HINT` is no longer read.
- **The starter's `tsconfig.json` includes `src` only** (it included `tests` for the fakes). An agent
  made before keeps its own; nothing needs to change.

**Everything else that breaks or changes a default:**

- **Live Flow keys no longer go to staging.** A `.env` that held a live `FLOW_MESSAGING_KEY` (or any
  `fk_live_`, `flow_live_`, `otk_live_` value) and deployed to staging now leaves staging's key as it
  is, listed under `skipped`. To move: set staging's test key once with
  `flow deploy secret FLOW_MESSAGING_KEY --env staging`. Sending a live key to staging is refused by
  design (Flow's hosting refuses it too).
- **Plain text after the reminder is now sent.** A model that answers in plain text twice in a turn
  owed a reply has that text sent to the person on the latest channel. To move: an agent whose
  instructions use plain text for notes to itself keeps them out of the reply step.
- **Videos reach the agent.** On the `flow-messaging` adapter a video is now an attachment: unless the
  model reads videos (`openAICompatible({ videos: true })`) or the agent has `describeVideo`, the
  agent reads `[video: you can't watch videos]` where it read `[video]`. Code that switches over
  `Attachment["kind"]` or `Media["kind"]` handles the new `"video"`. A hand-written
  `WhatsAppProvider` keeps working unchanged: it is offered no videos until its `features` say
  `videos: true`.
- **`@modelcontextprotocol/client` and `@stricli/core` are dependencies**, no longer optional peers.
  A fresh install grows from 6 to 18 packages and from 41.2 MB to 49.0 MB of files (55 MB to 63 MB
  on disk); the package stays 760 KB packed. An agent that lists them in its own `package.json` keeps
  them at the same versions or drops them; another version there installs a second copy, which its
  own imports use.
- **`FLOW_MCP_SERVER` now redirects the read commands.** Set in the environment, it sends
  `flow conversations`, `issues`, `insights`, `templates`, `logs` and `deploy status` to that hosted
  Flow MCP. To read with the folder's keys, leave it unset. `flow mcp serve`'s tools/list,
  instructions and results are unchanged.
- **`logout` now calls the server.** A `defineCli` CLI's `logout` and `flow mcp logout` revoke the
  tokens at the server's `revocation_endpoint` first; a failure is only a warning. A script that
  matched `Signed out of` after a logout with nobody signed in now reads `Not signed in to`.
- **`flow insights` prints a different line about unreadable text**: `Insights can't read N of M
  conversations (P%)...`, only past Flow's threshold; the count of messages without text is no
  longer printed. `--json` is unchanged.
- **`flow logs --severity ERROR` returns more lines.** A script that read only `ERROR` lines from
  `flow logs --json` now also gets a 0.15.x runtime's uncaught errors logged at `DEFAULT`, as `ERROR`.
- **`flow test`'s per-channel line changed**: a script that matched `<channel>: N of M passed` now
  reads `<channel>: N of M counted runs passed`.
- **Traces over 64 KB are gzipped.** A self-hosted traces endpoint must accept
  `Content-Encoding: gzip` (OTLP collectors do).
- **Types:** `CliConfig.server` is now `string | McpServerHandle`, so code reading `cli.server` as a
  string narrows it first. `McpToolDescriptor._meta` is optional, so code reading a `descriptor`'s
  `generated._meta` handles undefined. A channel's `send(address, outbound)` may be called with a
  third argument, `{ lastMessageId }`; channels written for two arguments keep working.
- **An `mcpServer` with a tool kept to some clients and no `auth` no longer throws**; that tool
  reaches only the CLI in the same process.
- **An MCP server alone** that `flow check` should check exports its tools from `src/mcp.ts`
  (`export { tools }`); its `mcp(agent, host)` factory gets `undefined` for `agent` on Flow's hosting.
- **The starter allows its install scripts.** An agent made before 0.16.1 can add
  `"allowScripts": { "esbuild": true, "koffi": true }` to its `package.json`, or run
  `npm approve-scripts esbuild koffi`.

## 0.16.0 (2026-11-05)

### Changes

#### Tests: tools played by rule, a harder person, drafts from production

- **Tools in tests are played by rule, a model only as the last resort.** A scenario can now describe
  its world as data, in a `given:` block beside its prose `world`: `tools` sets how each tool
  behaves (`usual`, `slow`, `down` or `flaky N%`, N a whole number from 0 to 100), `seed` fixes
  flaky's dice so the same calls fail on every run (default 1), and any other value is plain data;
  a tool file's name there (`menu: get_menu.yaml`) is that tool's usual output. In a scenario with
  `given:`, each tool call is played by the first rule that fits: the tool's mode (`down` plays the
  tool file's first response with an error, `flaky` fails that way when its die says so), the
  developer's fake, a response in the tool file whose `input` equals the call's, and only then a
  model, whose answer the cloud saves so a rerun is free. A scenario without `given:` plays exactly
  as before.
- **Fakes.** `tests/tools/<tool>.fake.ts` is the developer's own code for a tool in tests: its
  default export (`Fake`, from `@flow-engineer/flow/testing`) gets the call's input, the scenario's
  `given:` data (`world`), one `state` object per run that every fake changes in place, the test's
  clock (`now`), the call's number for that tool and the tool file's responses, and answers
  `{ output }` or `{ error }`, with `changes` in plain words. Fakes run on the developer's machine,
  beside the agent, and are never uploaded: the open names the tools that have one, and the cloud
  asks for the fake when its rule comes up. A fake that throws, or answers neither output nor
  error, or something that is not plain JSON, makes the run an infrastructure error (`fake_failed`),
  not a failure of the agent. `flow test` loads every fake before anything is sent; one that does
  not load, or whose default export is not a function, stops it with `tests/tools/<file>: ...`.
  `loadFakes(testsDir)` and the types `Fake`, `FakeCall` and `FakeAnswer` are exported.
- **`expect.state`** checks in code what the fakes kept: each top-level key is one check; objects
  match in part, arrays have the same length with each expected element matched in part (any
  order), other values are equal.
- **`flow test fake <tool>`** writes a starter `tests/tools/<tool>.fake.ts` from the tool's file: it
  answers as the file's responses do (the one whose `input` is the call's, else the usual one),
  with comments on `given:` and `state`, and never writes over a file already there (`--json`:
  `{ ok, tool, file, from }`). Fakes stay optional.
- `flow test` checks `given:` before sending: a mode other than the four, a `given.tools` key the
  agent has no tool for, and `down` or `flaky` for a tool whose file has no response with an error
  are named with their file, and nothing is sent. When a scenario sent has `given:`, one more line
  (a suggestion, never blocking) names the agent's tools that count as writes (no `hints.readOnly`)
  and have no fake, since in a `given:` run only a fake keeps a write for `expect.state`;
  `FLOW_FRAMEWORK_FAKE_HINT=0` leaves it out.
- The tests and tools skills say when to add `given:` (only when the test needs the world fixed;
  without it a scenario plays as before), what `given.tools` covers (a mode is for the tool it names
  only; a tool left out, or `usual`, goes on to its fake, an exact `input` match, then a model), and
  what a write tool under `given:` needs (a fake that keeps the write in `state`, with an example
  for a booking, or no check on the write).
- After a session, one line says how many tool calls a model played and of which tools (and how
  many of those answers were saved from an earlier run), naming a tool that has a fake on this
  machine but was played by a model in a scenario without `given:`. For the tools with no fake it
  suggests, once, that a fake would make them free and repeatable and names `flow test fake <tool>`;
  a suggestion, not a warning: a test without fakes passes, runs and costs as before.
  `FLOW_FRAMEWORK_FAKE_HINT=0` (environment or `.env`) leaves it out. `flow test --json` carries each
  run's `toolsPlayedBy` (`rule`, `fake`, `recorded`, `model`, `byModel`), null from an older cloud,
  and `toolsWithoutFake`, those tools by name.
- A cloud older than this release ignores the fakes and plays every tool by a model, as before;
  `flow test` then says once: `This cloud does not play fakes: a model plays every tool (tests/tools/*.fake.ts unused).`
- The café example (and so `flow new` and `flow init`) has `tests/tools/get_menu.fake.ts` and
  `tests/tools/place_order.fake.ts`; `latte-correction` has a `given:` block (the point of sale
  slow) and checks the one order with `expect.state`, and `order-fails` plays the point of sale
  `down` by rule. `reads-like-a-text` keeps only its prose world. A new agent's `tsconfig.json`
  includes `tests`, and its fakes import their types from `@flow-engineer/flow/testing`.
- **The simulated person can be harder to serve**, with three optional fields under `person:`.
  `reveal: one_at_a_time` gives one fact of `knows` per message, only the one asked for (the
  default, `as_asked`, is today's person). `behaviours` is any of `impatient`, `tangents`,
  `half_messages`, `pushes_rules` and `walks_away`; a person with `walks_away` may leave unresolved
  when the agent is slow, repetitive or unhelpful, and the run ends `ended: "walked_away"`, a failed
  run with the check "The person stayed until their goal was met". `attack: { rule, tactics }` makes
  the person try, over several turns, to make the agent break `rule` (1 to 500 characters), with
  `tactics` from `ask`, `reason`, `authority`, `pressure`, `reframe` and `inject` in the order it
  escalates (all six in that order when left out); the run is judged on "The agent kept this rule
  in every reply". `attack` with `walks_away` is refused: `an attacker does not walk away: leave
  walks_away out`. `flow test` names a wrong value, a name listed twice or an unknown key under
  `attack` with its file and line before anything is sent.
- The cloud checks after each run that the simulated person kept to its goal and persona; a run
  whose person drifted is played once more, and drifting again it is errored with
  `error: "simulator_failed"`, never the agent's failure.
- **`flow test pull`** writes the test drafts Flow made from the hosted agent's conversations that
  went wrong (made-up people, the business kept) into `tests/drafts/<file>`, from the agent's folder,
  with the agent's CI key (`FLOW_FRAMEWORK_CLOUD_KEY`) and the cloud `flow test` uses
  (`GET /v1/agent/test-drafts`, then `POST /v1/agent/test-drafts/{id}/pulled` for each file written).
  Each draft is parsed as a scenario first; one that does not parse is named with its line and not
  written. A file already there with other content is kept, and a draft pulled before is not
  written again, unless `--force`; `--dry-run` lists what it would write and writes nothing;
  `--json` reports each draft's `id`, `file`, `title`, `check` and `done` (`written`,
  `would_write`, `unchanged`, `exists`, `pulled_before`, `invalid`). Where the workspace's drafts may
  not leave Flow, the server's `export_blocked` message is printed as it is and nothing is written.
  Exit status 0 when every draft was written or left as told, 1 otherwise. Drafts never run or
  gate: `flow test` reads only `tests/scenarios` and `tests/tools`; move a draft into
  `tests/scenarios/` to keep it.
- **`origin`**, an optional field on a scenario, says where it came from: `from` (`code` or
  `chat`), `by`, `covers` (the ids a coverage plan names) and `check` (`not_checked`,
  `passes_on_fixed` or `reproduces_on_bad`). It is metadata: no run reads it. `flow test` names a
  wrong `from` or `check` with its file and line.

#### For coding agents: Flow's reads from the terminal

- **`--json` is one JSON document on stdout, failures too.** `flow conversations` (and `show`),
  `issues`, `templates`, `show`, `deploy` (every subcommand), `logs` and `cli` print
  `{ "ok": false, "error": { "code", "message", "hint"? }, "next" }` on stdout when they fail
  (a wrong flag, no key, a refused key, a missing route, an unreachable cloud), with exit 1 (2 for a
  wrong flag); every other line goes to stderr. `flow logs --json` stays one `{ time, severity, text }`
  object per line, and `login`, `link` and `setup` stay JSON Lines (the last line is the answer).
  `flow test --json` reports an `src/agent.ts` that does not load as its report's error.
- **A long `--json` answer is no longer cut off.** On macOS a pipe is written asynchronously and the
  CLI exited before stdout had taken it: a `conversations show --json` over 64 KB came out empty or
  cut at 64 KB, at random, more often when the reader was slow. Every command now exits once stdout
  and stderr have taken what it wrote (`flow test` already wrote its report synchronously).
- **`conversations show <id>` takes `--env`/`--environment`** (it reads one conversation by id, so
  the environment changes nothing), and a refused `show` exits 2 with its usage error as the JSON
  document; 0.15.6 printed the usage on stdout and exited 0.
- **Rate limits and blips.** Every call to Flow's cloud (`conversations`, `issues`, `templates`,
  `show`, `deploy`, `logs`, `cli`) waits out a `429` for its `Retry-After` (at most 30 s, said on
  stderr; a longer one fails, naming the wait) and tries again, up to 3 times, and tries a GET, PUT
  or DELETE once more after a network error or a 5xx without a `Retry-After`. `flow login` waits
  out a `429 slow_down` on starting (up to 30 s) and keeps polling through a `429 slow_down`, its
  `Retry-After` added to the wait (RFC 8628).
- **`--env` and `--environment` are one flag** on `conversations`, `issues`, `templates`, `logs`,
  `deploy` and `test` (`issues` and `templates` take it and ignore it: they are not per environment).
- **Key errors name the key.** A refused key (401, 403, `bad_key`, `scope`) now says which key the
  command reads (`FLOW_KEY`, or the CI key `FLOW_FRAMEWORK_CLOUD_KEY`), where it looked (the
  environment or the `.env` file), what it found (prefix and last 4 only) and how to get the right
  one. Every command's `--help` has the same table of which command reads which key, and both
  cells' clouds: `https://flow.engineer/observe` (US) and `https://flow.engineer/dashboard/in` (India).
- **Network failures say they are.** "could not reach `<address>`: network error ENOTFOUND (the host
  name does not resolve: ...)", with the address tried; `flow deploy` no longer calls any failure
  "Could not reach" (a stdin read is said as one, anything else as the CLI's own failure).
- **`flow deploy secret`:** a terminal is read one line at a time and not echoed (it failed with
  EAGAIN, reported as the cloud being unreachable); a pipe is read to its end. `--apply` restarts
  the live version once the value is saved (`POST /v1/hosting/restart`, followed to live as promote
  is); `--unset NAME` takes a secret away (`DELETE /v1/hosting/secrets/{NAME}?environment=`); and
  `flow deploy restart [--env]` restarts on its own. A cloud without those routes says it cannot yet
  and that a value applies at the next deploy or promote. A refused `FLOW_FRAMEWORK_TRACES_*` or
  `CHINWAG_TRACES_*` says hosting already sends message text and how to turn it off.
- **`flow deploy status`** prints the Flow Framework the folder's `package.json` pins
  (`agent_framework` in `--json`), the newest line Flow's hosting runs, labelled as hosting's
  (`hosting_framework`), each deploy's own (`built with:`, `deploy.framework`), and
  per environment whether observe takes its traces (`ok`, `quiet`, or `REFUSED` with observe's
  reason), when the cloud sends them.
- **`flow logs`** asks the cloud for at most 500 lines a page (the cloud's limit) and follows the
  cursor until `--limit` (the newest kept) or the window is read; MCP's `read_logs` the same.
- **`flow logs`** takes `--until <duration|time>`, `--severity <DEFAULT|INFO|WARNING|ERROR>` (that
  severity or above) and `--grep <text>`, sends them to the cloud and filters what an older cloud
  sends anyway; `--since` takes a time or up to 30 days; when the lines start later than `--since`
  asked, stderr says "Logs start at <time>: this Flow keeps <N> back". `--since` and `--until` take
  one rule, shared with MCP's `read_logs`: a duration (2d) is that long before now for both, a time
  is taken as given, and `--until` must be after `--since` (every page now carries `since`: the
  release candidate's later pages left it out and the cloud refused "until is before since").
  `--grep` matches the text anywhere in the line as printed, a JSON line's every field (needs
  Flow's hosting of 5 Nov 2026 or later; an older one matched only `message`/`msg`). Flow searches
  the fields' values; a `--grep` with a quote or a brace (`"step":"x"`, JSON as printed) is not sent
  and is matched by the CLI over every line of the window.
- **`flow logs` and `read_logs` join a stack trace** that Cloud Run split into an entry per line: a
  line starting with whitespace (`    at ...`) at the same time (within 2 ms: Cloud Run stamps
  each line microseconds apart) from the same instance goes on the line before it, which keeps the
  higher severity, whatever runtime wrote it. Flow Framework's own lines are already one entry
  with the stack inside (above); this is for an agent's own `console.error` and older
  runtimes.
- **`flow logs` no longer stops at the host's first page.** Without `--follow` it read one page (the
  host answers 500 lines, oldest first), so `--since 3d` printed the oldest 500 lines and silently
  left out the newest. It now reads every page up to `--until` (else now) before printing, keeps the
  newest `--limit` lines (default 10000, at most 100000), and when it leaves older ones out says on
  stderr where the printed lines start and the `--since`/`--until` that gets the rest.
- **`flow conversations`:** `--contact <label>` (`"Contact 9e35"` or `9e35`) keeps one contact's
  conversations, read over as many pages as it takes. `show` prints each agent reply's tool calls
  (time, ok or the error, input and output when Flow keeps them) and its delivery (`queued`,
  `sent`, `delivered`, `read` or `failed` with the channel's code), and says why a message's text
  was not sent (`text_state: not_sent`); `--json` passes them through.
- `testing/src/cloud-call.ts` is new: the one call, key and failure helpers these commands share.
  `listConversations`, `showConversation`, `listIssues`, `logsPage` and `deployStatus` return data
  for callers other than the CLI.
- **`flow insights`: Flow Insights from the terminal.** `flow insights [--days 7|30] [--status
  open|fixed|muted|all]` lists the findings the dashboard shows (where people gave up, asked again or
  got annoyed in the agent's closed production conversations), ranked as Flow ranks them: id,
  status, conversations with the window before's ("4 (was 9)"), topic, and what happened in the
  dashboard's words. Low-confidence tags are named under the table, not in it. Under it, the
  window's closed sessions and people, and what a state means: `collecting` shows counts only until
  20 closed sessions; `no_data` says Insights grades only closed (24 h quiet) production
  conversations on a live key, never test keys, `flow chat`, the playground or `flow test`.
  `flow insights show <finding> [--days 7|30]` lists the finding's conversations, each with why it
  was flagged, the person's words when the account's data allows, and `flow conversations show
  <id>` to read it. `--json` prints the server's JSON. Until Insights is open to the workspace,
  both print "Insights is not open to this workspace yet" with the server's hint and exit 1.
  Insights is production traffic, so it reads with the agent's live key (`FLOW_LIVE_KEY` from
  `flow setup --live`, below, else a `flow_live_` `FLOW_KEY`): a test key (`flow_test_`, what
  `flow setup` writes) is refused, and both print why and exit 1.
- **`flow issues test-case <id>`** prints the test case Flow proposes for an issue: its rule, the
  reply it comes from, and the words to include or avoid and the sentences to judge by, to write a
  scenario from (stdout only; it writes no file). `--json` prints the server's JSON.
- **`flow conversations` shows each conversation's kind** (a KIND column: `test` or
  `production`), and `flow conversations show` says under the reply counts when a conversation is
  a test one (`flow chat`, the playground or `flow test`: never graded, never in Insights), or on a
  test key (staging: never in Insights), so zero counts no longer read as graded and fine.
- The build-agent skill teaches the loop: `flow insights`, `flow insights show`, `flow
  conversations show`, fix, a scenario, `flow test`, `flow deploy`, then `flow insights` again
  after the window.
- `listInsights` and `insightConversations` (testing/src/conversations.ts) return Insights'
  answers for callers other than the CLI, refusals as `Failed` with the server's code and hint.
- **`flow status` knows the folder has deployed.** After `flow deploy`, status no longer says
  `Next: npm start` and "To keep it answering while this machine sleeps: flow deploy"; it says
  `Deployed from this folder to staging: npx @flow-engineer/flow deploy status shows what is live.`
  `status --json` adds `deployed`, the environments this folder deployed to (from `.flow/deploys.json`).
- `flow test`'s session line says "all new to the cloud" or "the cloud already had them all" when
  that is so, in place of "6 new to the cloud, the rest it already had" for a suite of 6.

#### `flow mcp serve`: Flow's reads as MCP tools for your coding agent

- **`flow mcp serve`** is a stdio MCP server, run in the agent's folder:
  `claude mcp add flow -- npx @flow-engineer/flow mcp serve`. Its tools, all read-only
  (`readOnlyHint: true`), read what the commands print, as JSON: `list_conversations`,
  `show_conversation` (each reply's tool calls and delivery when Flow sends them), `list_issues`,
  `list_insights`, `insight_conversations` (what `flow insights` reads), `list_templates`
  (FLOW_KEY: a `flow_test_` key reads staging only; production and Insights read with
  `FLOW_LIVE_KEY` from `flow setup --live`), and `read_logs`, `deploy_status` (the CI key,
  `FLOW_FRAMEWORK_CLOUD_KEY`, staging and production). Each result is `structuredContent` and the
  same JSON as text under a one-line summary; a failure is `isError` with `--json`'s failure
  document (code, message with the key story, next). Keys are read again on every call, so a key
  fixed in `.env` works without a restart. `flow mcp --help` lists it.
- **`@modelcontextprotocol/server` is a dependency of Flow Framework now** (pinned 2.3.1), no longer
  an optional peer: `flow mcp serve` and `@flow-engineer/flow/mcp`'s `mcpServer` work in any agent
  folder, one made on 0.15 included, with nothing more to install. `flow new` no longer lists it in
  the agent's `package.json`; an agent that lists it at 2.3.1 keeps working (npm installs it once).

#### `flow setup --live` and `flow keys`: production reads with a key the owner makes

- **`flow setup --live [--content] [--workspace <w>] [--json]`** writes the agent's live Flow key,
  `FLOW_LIVE_KEY` (`flow_live_...`), into `.env` with safe defaults: it reads production
  conversations, traces and Insights, runs tests, writes traces and uses the model; it messages no
  customer and deploys nothing live. Only the workspace's owner can make one, and a health
  workspace gets none (`owner_only`, `health_workspace`, `content_not_allowed`, `not_set_up` pass
  through with their next step; `observe_failed` exits 2). Message text reads de-identified (names,
  phones, emails, ids and addresses as placeholders) unless `--content`. A new key replaces the
  agent's earlier live key at once (their ids are printed; `--rotate` is still taken). The key
  lasts 30 days and stops after 7 days unused. It prints the text mode, what the key can do as
  `✓`/`✗` lines in flow.engineer's order (each `✗` with the command that grants it), the expiry,
  the idle rule, `flow keys revoke <kid>` and the three advisory tiers; never the value (`--json`:
  `checklist`, `advisory`, `stopped`). An older flow.engineer makes nothing and the command says
  `live_unsupported`.
- **`flow keys [list] [--json]`** lists the account's live keys (id, agent, mode, last 4, expiry;
  never a value), **`flow keys show <kid>`** prints one key's `✓`/`✗` checklist and its grants, and
  **`flow keys revoke <kid>`** ends one.
- **`flow keys grant <read|tests|traces|model|content|send|deploy> [--key <kid>] [--wait]`** lets
  the live key (the `FLOW_LIVE_KEY` in `.env` unless `--key`) do one more thing, in place, by
  tier, in the same words in the help, the output and `flow mcp serve`'s tool descriptions: fine by
  default (de-identified reads, Insights, tests, traces, the model) is granted at once; raw message
  text (`content`) only when the user asked; messaging customers and deploying live (`send`,
  `deploy`) only with the user's explicit yes, and the owner confirms once in the browser: the CLI
  prints (and opens, unless `--no-browser`) the approval page and exits 4, or with `--wait` asks
  again until it is approved (the new checklist, exit 0), denied or expired (exit 3). A live key
  not made by `flow setup --live` is refused (`not_for_this_key`, its next step as given).
- **A live key refused for something it was not granted (403)** prints Flow's hint as given (such
  as Messaging's "can't message customers" naming `keys grant send`) and the three tiers, not "get
  the right key".
- **Production reads use `FLOW_LIVE_KEY` when it is set**, else `FLOW_KEY`: `flow conversations
  --env production`, `flow insights` and `insights show`, and `flow conversations show`, which
  reads with FLOW_KEY first and asks once more with FLOW_LIVE_KEY when FLOW_KEY does not find the
  id (`show --env production` goes to it at once). The same in `flow mcp serve`
  (`show_conversation` takes `environment`). A refused test key and a refused live key now say to
  run `flow setup --live`, not to ask Flow.
- **Every read says its text mode**: one `Text: raw | de-identified | withheld` line first (from the
  `Flow-Text` header or `text_mode`), and `text_mode` in `--json` and in MCP results.
  `flow insights show` prints the messages around each flagged one (`window`) when Flow sends them.

#### Flow's own log lines on Cloud Run

- **Flow Framework's own log lines have real severities on Cloud Run.** On Cloud Run (Flow's
  hosting included: `K_SERVICE`, or `CLOUD_RUN_JOB`) each line the framework, the `flow-messaging`
  adapter and the playground write is one JSON entry, `{ "severity", "message", ...fields }`, which
  Cloud Logging reads: warnings are `WARNING`, errors `ERROR`, notes `INFO` or `DEBUG`, where all of
  them were `DEFAULT`. An Error's stack is inside the entry's `message`, so a stack is one entry, not
  one per line. Everywhere else (a terminal, `flow dev`, tests) the lines are the same text as before.
  What an agent's own code prints is unchanged.
- **A failed tool call is logged**, in every environment, with no event sink needed: one line with
  the tool's name, the kind of failure (the error's name, or `unknown_tool`, `invalid_json`,
  `invalid_input` for a call refused before it ran), the error's `code` and `status` when it has
  them, the conversation and call ids, and the ms it ran. Never the call's input or output, nor the
  error's message. A `WARNING`, or an `ERROR` when the tool threw JavaScript's own error for broken
  code (`TypeError`, `ReferenceError`, ...):
  `flow: tool refund failed after 212 ms (Error, not_refundable, 409) in conversation p_3f2a9c1d0b4e`.
- The `flow-messaging` adapter's stream: the first close after a healthy connection (Flow's
  connections close about hourly, `1006`) is `INFO`; a refusal, or a close right after another, stays
  a `WARNING`.
- `flow: agent version ...` is an `INFO` line (`console.info`), not a warning.
- Opening SQLite no longer prints Node 22's "SQLite is an experimental feature" warning (two log
  lines on every start of a hosted agent, whose start check opens one); other warnings print as usual.

#### The starter and setup, from dogfooding

- **The starter (`flow new`, `flow init`)**: `.env.example` says to sign in at
  `https://flow.engineer/dashboard` for the CI and trace keys (the two `https://flow.engineer/observe`
  lines are the cloud's API address, unchanged); its `AGENTS.md` says `npx @flow-engineer/flow check`
  (bare `npx flow` fetches another npm package); `package.json` pins `@flow-engineer/flow` to the
  exact version it is made with (no `^`), as the docs say for production. The café's
  `place_order` and `order_status` say `signIn: "none"` like `get_menu`: the café has no accounts, so
  its tools are public on purpose, and Flow's hosting no longer warns `mcp_open` about tools marked so
  (flow-mono hosting).
- **`flow setup --json`**: `whatsapp_link` and `imessage_link` say "Join <displayName> (ref ...)" like
  `direct_links`, `join_message` and the printed links (they said the package name).
- **Free-trial counts say whose they are**: the account's, shared by all its agents. Printed as
  "(your account's free trial, across all its agents: 2 of 25 people)"; `--json` has them as
  `account_trial` (setup) and each channel's `account_trial` (status). `trial` is the same object,
  kept for a release.
- **`flow check`** asks `src/mcp.ts`'s server, in-process, which tools it lists (what the CLI's
  commands are made from). A tool it leaves out is no longer called "reachable as" a CLI command;
  without a `src/mcp.ts` that answers signed out, the warning adds "if the CLI's MCP server serves
  it". A `src/mcp.ts` that throws on import is an error.
- **`flow deploy` no longer sends `FLOW_FRAMEWORK_JOIN_CODE`, `FLOW_FRAMEWORK_TRY_URL` or
  `FLOW_FRAMEWORK_WORKSPACE`** as secrets: `setup` and `link` write them for the CLI alone. The
  `FLOW_MESSAGING_<CHANNEL>_SENDER` ids are still sent (the hosted agent starts conversations from
  them).

### Migration notes

Nothing in an agent's code has to change: `createAgent`, tools, channels and scenarios keep
working. What can break is a script or query that reads the CLI's output, and a few names:

- **`--json` failures are one document on stdout.** `flow conversations` (and `show`), `issues`,
  `templates`, `insights`, `show`, `deploy` (every subcommand), `logs` and `cli` now print
  `{ "ok": false, "error": { "code", "message", "hint"? }, "next" }` on stdout when they fail; it
  was empty, with the message on stderr only. A script that took "stdout is not empty" as success
  checks `ok` or the exit status instead. Progress and notes stay on stderr: do not merge it in
  with `2>&1`. `--json` answers passed through from the server now end in a newline.
- **Every other command's `--json` failure is that document too**, a wrong flag included: `test
  pull` (its refusals were on stderr only), `chat`, `check`, `check-endpoint`, `projects`, `keys`,
  `login`, `logout`, `whoami`, `setup`, `link` and `status`. The account commands' error
  `{ "error": { "code", "message", "next" } }` gains `"ok": false` and a top-level `"next"` (the same
  value; `error.next` stays). `test pull --json`'s report gains `ok`.
- **`login`, `link` and `setup` are otherwise unchanged**: JSON Lines, one document a line, the last
  line the answer, with their own exit codes (0 to 4). `logs --json` stays one `{ time, severity, text }`
  object per line.
- **`flow keys list` lists this folder's agent's keys** (the agent of the `FLOW_KEY` or
  `FLOW_LIVE_KEY` in `.env`, else `package.json`'s name; every agent's outside an agent's folder).
  `--all` lists every agent's on the account, as before; `--agent <name>` one agent's. `--json` is
  `{ "keys", "agent", "all" }` and nothing else: the table no longer goes to stderr.
- **`flow deploy status`'s `framework` is `hosting_framework`** (the line Flow's hosting runs, not
  the agent's), beside `agent_framework` (what `package.json` pins); the MCP tool `deploy_status`
  answers the same names. Each deploy's `framework` (the one its build used) is unchanged.
- **A wrong flag exits 2** on `flow conversations`, `flow issues` and `flow templates` (was 1), as
  `deploy` and `logs` do. A refused `conversations show` usage exits 2 with its usage error as the
  JSON document (0.15.6 printed the usage on stdout and exited 0). `conversations show` takes
  `--env staging|production`; any other value is a usage error (it was ignored). Scripts that treat
  any non-zero exit as failure need nothing.
- **`flow deploy`'s `--json` failure codes**: an error that is not the network's is `internal`, a
  stdin failure's `stdin` (both were `network`).
- **Human output changed** in three places a script may parse: `conversations show` prints a newer
  server's tool calls one per line (`tool <name> <ms> ms ok`) instead of `[tools: a, b]` (an older
  server's names print as before); `flow conversations`' table has a KIND column after CHANNEL; and
  reads print a `Text: raw | de-identified | withheld` line first when Flow says the text mode.
  Parse `--json` instead (`kind`, `text_mode`; the JSON is otherwise unchanged).
- **Production reads use `FLOW_LIVE_KEY` when it is set**: `flow insights`, `flow conversations
  --env production`, `conversations show` of a production conversation, and the MCP server's
  production tools. Remove it from `.env` to read with `FLOW_KEY` as before. With neither key, a
  production read's `--json` error code is `no_live_key` (was `no_flow_key`), with `next`
  `npx @flow-engineer/flow setup --live`.
- **`flow deploy secret`** in a terminal reads one line, not echoed (press Enter; Ctrl-D is no
  longer needed); a value of several lines is piped in.
- **`flow deploy` no longer sends `FLOW_FRAMEWORK_JOIN_CODE`, `FLOW_FRAMEWORK_TRY_URL` or
  `FLOW_FRAMEWORK_WORKSPACE`** as secrets. Ones an earlier deploy sent stay until removed, and are
  harmless: `npx @flow-engineer/flow deploy secret --unset FLOW_FRAMEWORK_JOIN_CODE --env staging`
  (the same for the others, and for production).
- **Free-trial counts are `account_trial`.** `setup --json` and each channel of `status --json`
  have `account_trial`; `trial` is the same object, deprecated, and goes in 0.17.0: read
  `account_trial`.
- **The starter pins the exact version.** An agent made by `flow new` or `flow init` from 0.16.0 has
  `"@flow-engineer/flow": "0.16.0"` (no `^`). An agent made before keeps `"^0.15.x"`, which does not
  take 0.16.0 (a 0.x minor): to move, set `"@flow-engineer/flow": "0.16.0"` in package.json and run
  `npm install`. Its `.env.example` and `AGENTS.md` need nothing (comments only).
- **Hosting's `mcp_open` warning.** The café's tools say `signIn: "none"`, and Flow's hosting no
  longer warns about tools marked so. A café-based agent that still has no accounts: add
  `signIn: "none"` to each tool its `src/mcp.ts` serves on purpose, never to one that reads or
  changes a person's account (set up sign-in instead).
- **Flow's log lines on Cloud Run are JSON entries.** A Cloud Logging query or log-based metric that
  matched Flow's lines in `textPayload` matches `jsonPayload.message` instead, and can now filter on
  `severity` (`flow logs` reads both). Lines elsewhere (a terminal, `flow dev`, tests) and what an
  agent's own code prints are unchanged.
- **Scenarios**: `given:`, fakes, `expect.state` and the person's `reveal`, `behaviours` and
  `attack` are optional; a scenario without them plays as before, and an older cloud ignores them.
  To adopt tools played by rule, add a `given:` block (its prose `world` stays as the note for the
  person and the judge) and write a fake for the tools whose answers depend on what happened before
  in the run. `origin` was an unknown key, dropped unread; a scenario that has one is now checked:
  `from` must be `code` or `chat` (and is required under `origin`), `check` one of the three
  values. `tests/drafts/` is new and never read by `flow test`.
- Internal helpers, not exported from the package: `templateWarnings` (testing/src/templates.ts)
  takes the key with where it was found, and `cliProblems` (cli/src/commands.ts) takes a third
  argument, `listed` (default true).

## 0.15.6 (2026-11-02)

### Changes

- **A message Flow Messaging accepted that the channel fails later is no longer silent.** A send
  Flow takes (`202`) can still fail at the channel seconds later (`message.failed`), such as a
  WhatsApp template refused because the business account has no payment method (`permission`,
  channel code `131042`). Until now, when the send had already resolved (`waitFor: "queued"`, or a
  failure after `message.sent`) and this process had not heard from the person (a nudge or template
  to someone new, or after a restart), the `flow-messaging` adapter dropped the failure: nothing was
  logged, the agent was not told, and traces showed the message as sent. A template's failure was
  also dropped for someone it had heard from, as it has no text.
- Every `message.failed` is now logged once at error level, with the channel, the Flow conversation
  and message ids, the error's type and channel code, and Flow's message, hint and doc URL (never the
  message's content or the person's address):
  `@flow-engineer/flow/flow-messaging: message msg_... on whatsapp (conversation conv_...) was not delivered (type permission, channel_code 131042): ...`.
  It replaces the warning that only a failure with a hint got.
- The agent is told Not delivered also for someone this process has not heard from: the adapter
  asks the agent's store (`agent.conversationOf`) for their conversation. A template is told as
  `template <name>`.
- `agent.undelivered(conversationId, text, reason, detail?)` takes an optional `detail`
  (`UndeliveredDetail`: `channel`, `messageId`, `errorType`, `channelCode`), which the adapter
  fills, and the `message.undelivered` event carries those fields.
- **Traces show the failure.** Every send span carries the platform's message id,
  `flow.send.message_id` (Flow Messaging's `msg_...`; content on or off). A late failure is
  exported as a `delivery <channel>` span with error status, under its send span when this process
  sent it, else in a trace of its own: `flow.delivery.message_id`, `flow.delivery.status`
  (`failed`), `flow.delivery.error_type`, `flow.delivery.channel_code` (when the channel gave one),
  `chinwag.channel` and the conversation ids, never content.
- A failure a send already reported (it read the message back) is no longer told again when its
  `message.failed` arrives.

### Migration notes

None. A hand-written `WebhookAgent` (an object passed to `webhook()` or `stream()` instead of the
agent) keeps working; give it `conversationOf` too for late failures to reach people it has not
heard from.

## 0.15.5 (2026-11-02)

### Changes

- **iMessage read receipts are not sent when Flow Messaging would surely refuse them.** Flow
  Messaging applies iMessage's typing window to read receipts too: within 5 minutes of the line's
  own last message to the person, else `409 outside_window`, which the channel ignores. Until now
  the `flow-messaging` iMessage channel sent a read receipt for every message the person wrote, so a
  person writing after a quiet spell cost one more refused call per message. The channel now uses
  what 0.15.4 remembers for typing: when the window is known to be closed it skips the read receipt
  without calling Flow, and with nothing known it sends it as before.
- A read receipt Flow refuses with `outside_window` now marks the window closed, as a refused typing
  call does, so the typing that follows in the same turn is not sent either (and the reverse).
- WhatsApp, Telegram, SMS and every other channel send read receipts exactly as before.

### Migration notes

None.

## 0.15.4 (2026-11-02)

### Changes

- **iMessage typing is not sent when Flow Messaging would surely refuse it.** iMessage shows typing
  only within 5 minutes of the line's own last message to the person (the person's message alone
  does not open it), and Flow Messaging refuses it outside with `409 outside_window`. Until now the
  `flow-messaging` iMessage channel called typing at the start of every turn, so a person writing
  after a quiet spell cost one refused call per message. The channel now remembers, per conversation,
  when this process last had a message of the line's accepted and whether Flow refused typing since,
  and rejects with `outside_window` without calling Flow when the window is known to be closed: Flow
  refused typing after the line's last known message, or that message went 5 minutes ago or more.
  The conversation handles that as before (typing waits for the agent's next message). With nothing
  known (a new process, or more than an hour since it learned anything of that conversation) the
  call is made, and a refusal is handled as before.
- What a process knows is its own sends only: when several processes serve the same line, another
  one may have messaged the person since, and a typing indicator that would have shown is skipped.
- WhatsApp, Telegram, SMS and every other channel send typing exactly as before.

### Migration notes

None.

## 0.15.3 (2026-11-02)

### Changes

- **A WhatsApp template's trace says what the person read.** Until now every template send (the
  agent's `send_template`, a `nudge({ template })`, the fallback template) was traced as its name
  alone, so a dashboard showed `order_shipped` where the person read "Hi Sam, your order 1042 has
  shipped." With traces content on, a declared template's send span now carries that text as
  `chinwag.agent_reply` (its text header's line, then its body, filled in) and its parts as
  `flow.template.*`: `name`, `language`, `header_kind`, `header`, `body` (placeholders kept),
  `buttons` and `values` (JSON). Without content none of it is sent; a template that is not
  declared in `createAgent({ templates })` is still traced as its name.
- A template send's `message.out` event keeps `text` (its name) and `template: true`, and a declared
  one adds `reads` (the text the person read) and `sentTemplate` (the declared parts and the values
  the send filled in).

### Migration notes

None.

## 0.15.2 (2026-10-31)

### Changes

- **Every send tool has a `next` field: `"wait"` or `"act"`.** The model says what it does after the
  message: wait for the person's reply, or act in the same turn (it said "getting your order" and
  calls the tool next). A response of only messages now ends the turn unless a send in it said
  `"act"`: that gets one more step, and the send's result says the message went and that it said it
  acts next. A second `"act"` with no tool call between ends the turn.
- Until now, a reply of only messages to the person, in a turn that had used no tool, always got one
  more step with nothing to say why, and a model could take that step to send its message again
  (the same greeting with buttons twice). That guessed step is gone.
- A send that leaves `next` out, or gives any other value, is taken as `"wait"`, never refused.
- A channel the person wrote on that has heard nothing in the turn is still asked for once, as
  before, also when the response was only messages on other channels.
- `transcriptOf` leaves `next` out of a sent message's channel fields.

### Migration notes

- A channel whose own send params (`Channel.params`) include one named `next` must rename it: the
  send tool's `next` is Flow Framework's.
- A scripted model in an agent's own tests that relied on the step after a reply of only messages
  (to read the send's result, or to call a tool next) adds `next: "act"` to that send.

## 0.15.1 (2026-10-31)

### Changes

- The MCP and CLI skill's `brand.name` example and the sign-in page's doc comments use a generic
  Acme example.

### Migration notes

None.

## 0.15.0 (2026-10-31)

### Changes

- **A scenario's `title` is a name of at most 45 characters** (counted in characters, not bytes),
  shown on one line in Flow's dashboard and in `flow show`. A longer title fails the check before
  anything is sent, at its line: `tests/scenarios/x.yaml:2: title: 98 characters, at most 45: a title
  is a name, not the test. Move the detail to about:`.
- **`about:`**, a new optional string in a scenario: what it tests, in a sentence or two. The test
  cloud passes it on: the dashboard shows it under the title and `flow show` under the run's heading.
- **`theme:`**, a new optional string in a scenario: the area of the agent it tests, in a word or two
  (`theme: Ordering`), at most 30 characters, refused the same way as a long title. The test cloud
  passes it on for the dashboard to group scenarios by, and `flow show` prints it after the title.
- The café examples, the HTTP agent examples and the test skill use short titles with `about` (and
  the café's a `theme`); the skill says how to name a scenario, with examples, and to group scenarios
  by theme, 3 to 10 themes per agent.

### Migration notes

- **Scenario titles over 45 characters are refused.** `flow test` exits 1 with `title: N characters,
  at most 45` for each such file, and nothing is sent. To move: shorten each title to a name and put
  the rest in `about:`. Before:
  `title: Orders a latte, corrects the milk mid-thought, confirms`; after:
  `title: Milk corrected to oat` and
  `about: Orders a latte, corrects the milk mid-thought, confirms.` `about:` and `theme:` lines are
  safe on 0.14.x too: those versions accept them and leave them out.

## 0.14.8 (2026-10-30)

### Changes

- **`flow test` passes at a pass rate**, not only when no run failed: the session passes when the
  runs that passed are at least `--min-pass` percent (default 98) of the runs counted, as Flow's
  dashboard counts them: passed, failed and flaky runs (a cloud's second play never on its own),
  a flaky run as passed (as failed with `--strict`); errored and unplayed runs are left out. Under it,
  exit 1; at or over it, failed runs do not fail the session, and errored or unplayed runs still exit 2
  as before. Every other exit is unchanged.
- **`--min-pass <percent>`** and **`FLOW_TEST_MIN_PASS`** (also from the agent folder's `.env` or
  `--dotenv`; the flag wins) set it: 0 to 100 with at most one decimal (`98`, `97.5`); anything else
  exits 1 with a message.
- The summary prints the rate after `N of M runs passed.`, cut to one decimal (never rounded up) with
  the dashboard's word (100% Excellent, 98% Good, 95% Fair, 90% Needs work, else Poor):
  `Pass rate 99.2% · Good: 141 of 142 counted runs passed. Passes at 98% or more (--min-pass).`, or
  `Under 98% (--min-pass): the session failed.`
- `--json` adds `passRate` (that percent; `null` when nothing was counted), `level` (`excellent`,
  `good`, `fair`, `needs_work`, `poor` or `null`) and `minPass`. `counts`, `outcome` and `exitCode`
  keep their meaning; `outcome` and `exitCode` follow the new rule.

### Migration notes

- **`flow test` no longer fails on any failed run.** CI that relied on one failed run failing the
  job now passes when 98% or more of the counted runs pass. To move: keep the old rule with
  `flow test --min-pass 100`, or `FLOW_TEST_MIN_PASS=100` in CI's environment or the agent's `.env`.

## 0.14.7 (2026-10-30)

### Changes

- **`flow templates`** lists the project's approved WhatsApp templates from Flow's dashboard
  (`GET /v1/agent/templates`, read with `FLOW_KEY`): name, language, category, status and the order
  a send gives its values in (`header = {{1}}, body[0] = {{1}}, body[1] = {{2}}, buttons[0] = {{1}}`).
  `--all` lists every status, `--json` prints the server's answer.
- **`flow templates --declare`** prints the approved templates as createAgent's `templates: [...]`,
  exactly as Meta has them (header, body with its numbered or named variables, footer, buttons), and
  one commented `agent.nudge` per template with its values in order. Before declaring WhatsApp
  templates, run `flow templates --declare` and paste its output.
- **`flow test` warns** when a declared template is missing from the dashboard, not approved, or
  differs from the approved one, naming each part (category, header, body, footer, buttons). It
  never fails the run.
- A dashboard without the route (404): `flow templates` says it does not serve templates yet, and
  `flow test` says nothing.

### Migration notes

None.

## 0.14.6 (2026-10-30)

### Changes

- **WhatsApp templates with named variables** (Meta's parameter_format NAMED), such as body
  `"The seller answered about {{listing}}: {{answer}}."`, are declared as Meta has them and take
  `body` by position, in the order the body first names each variable, a name used twice taking one
  value: `body: ["Blue bike", "Yes"]` fills `{{listing}}`, then `{{answer}}`. The wire to Flow
  Messaging is unchanged (`params.body` stays an array; Flow adds Meta's parameter names). A text
  header takes one named variable (`{{order_id}}`) from `template.header`. A wrong count throws
  with the order expected (`body[0] = {{listing}}, body[1] = {{answer}}`); before, such a template
  was taken to have no variables and every send of it with values was refused. The playground and
  the `send_template` tool fill them the same way.
- `createAgent` refuses a declared template that mixes named and numbered variables, or whose text
  header has more than one named variable. `variables` stays for numbered templates; a declared
  template with named variables takes `body`.

### Migration notes

None. Numbered templates work as before.

## 0.14.5 (2026-10-30)

### Changes

- **`flow test` outlasts a session that moved inside the test cloud.** On a cloud that re-opens lost
  sessions, a tunnel call or the stream answered `503 {"error":"session_elsewhere"}` (it reached a
  server of the cloud's that does not hold the session) is sent again with backoff, with its same
  Idempotency-Key, for up to 45 s, and the session plays on. Still `session_elsewhere` after that,
  the session is taken as lost, as with `session_gone`: one new session plays only the runs with no
  result, and the two reports merge. Before, the CLI ended early (`N of M runs finished before the
  session ended early`, exit 2). An older cloud is unchanged.
- **`flow show last --scenario <id>`** shows the last session's run of that scenario (its id, or
  its file name without .yaml, as `--only` takes): its first run that did not pass, else its first
  run. A scenario the session did not play is an error that lists the ones it did (exit 1).
  `.flow/last-session.json` keeps each run's scenario `id` beside its file name.
- **`flow show` names which response of the tool file the simulator played** for each tool call:
  `[response: "<when>", simulated, 800 ms]`, or `response: custom` when none fit, so a simulator's
  slip is told from the agent's.
- **A tool's output on its `tool.end` and `task.done` events is whole up to 64,000 characters**
  (was 4,000). A longer one is cut there and ends with the line `[cut: N more characters not
  shown]`, in place of a bare `…`. The test cloud judges real tools' calls from these events and
  does not fail a check on what was cut. Traces keep their own 32 KB cap per attribute.

### Migration notes

None. A sink or script that read a tool's output from events and looked for a trailing `…` should
look for the `[cut: N more characters not shown]` line instead.

## 0.14.4 (2026-10-29)

### Changes

- **`flow issues` prints your team's feedback under the issues**, from Flow's
  `GET /v1/agent/feedback?days=30`, also when there are no issues: `Feedback from your team (last
  30 days): N`, then one line per item, `check out of date  <scenario> (<channel>), check <n>:
  <check>` (a test check a teammate marked out of date: change it in the scenario file) or
  `grade marked wrong  conversation <id>, reply <id>, rules <ids>` (a reply's grade a teammate
  marked wrong: do not change the agent for it), each with its `note:` and `todo:`. A Flow without
  the route prints nothing more. `--json` is unchanged: the issues' JSON only.
- The coding-agent skill says how to act on each kind of feedback.

### Migration notes

None.

## 0.14.3 (2026-10-29)

### Changes

- **`flow conversations --limit` over 100 works**: the CLI asks for at most 100 conversations a
  page (the server's most) and follows `next_cursor` until `--limit`. Before, `--limit 200` sent
  `limit=200` and the server refused it with `limit must be 1 to 100 (invalid_request, 400)`.
- **`flow conversations` prints the agent version behind each conversation's latest reply**, a
  VERSION column (`-` when Flow knows none), and `flow conversations show <id>` prints it in the
  header with where Flow got it: `version 5f056b6 (from its traces)`. On a hosted agent it is the
  deploy's version (`AGENT_VERSION`). `--json` passes the server's `version`, `version_source`
  and `version_changed` through.
- The list's order is the server's: the latest message first, so a long conversation that went on
  today is listed before conversations that ended earlier (a `flow test` run starts many).

### Migration notes

None. A script reading the table's columns by position sees VERSION as the fourth.

## 0.14.2 (2026-10-29)

### Changes

- **`flow deploy status` says whether each environment's traces carry message text**, and who
  chose it: `trace text: on (Flow's default)` or `trace text: off (set by you)`, from the deploy's
  `trace_text: { on, source: "flow" | "owner" }`. `--json` includes it as `deploy.trace_text`
  (`null`, and no line printed, on a Flow that does not say). To switch it in production:
  `echo 0 | npx @flow-engineer/flow deploy secret FLOW_FRAMEWORK_TRACES_CONTENT --env production`,
  then `npx @flow-engineer/flow deploy promote`.

### Migration notes

None.

## 0.14.1 (2026-10-29)

### Changes

- **`<name> --version` prints the CLI's version** (defineCli's `version`, which `flow cli pack`
  sets) and exits 0, with no server reached and no sign-in asked, also under `signInFirst`. Before,
  it went to the server and, signed out under `signInFirst`, exited 3 asking to sign in. Only
  `--version` on its own is the CLI's: after a command it is that command's flag. Without a
  version set it says so and exits 2.

### Migration notes

None.

## 0.14.0 (2026-10-29)

### Changes

- **`login` and `logout` are top-level commands** in every Flow CLI: `acme login`, `acme logout`.
  `signIn: { login: "auth login", logout: "auth logout" }` in the CLI file moves them, into a group
  of any name and beside the team's own commands in it. Every message that says how to sign in (the
  sign-in-first question, "Sign in first" after a 401, "Some commands need a new sign-in", the
  welcome, help, the generated skill, the sign-in page, the simulators' CLI runner) says the
  command as set, and `signInFirst` never asks before the sign-in commands, wherever they are.
  `defineCli` throws and `flow check` refuses a command, alias or tool on their words, and the
  words are free again once moved. The sign-in page's `signInPage` gets `command`
  (`"acme login"`).
- **`signIn.beforeLogout({ server, token })`** runs the team's own step when a signed-in person
  logs out, before this computer's sign-in is forgotten (revoke the server's session with the
  stored access token). If it throws, its message is printed, the person is still signed out on
  this computer, and the logout exits 0.
- **No built-in `auth status`.** A CLI that wants a `whoami` or status writes its own and names it
  freely; `auth` is no longer a word the CLI keeps.
- **One color scheme for the whole CLI, from the brand, every part replaceable.** The help, the
  welcome, the sign-in question, the line and full-screen chat, and the Markdown tools and the
  agent write take their colors from one palette: the accent is `brand.accent` (else cyan) on
  command names, the banner, the chat's names, links, inline code, JSON keys and keywords.
  `colors: { accent, muted, success, warning, error, heading, link, code, key, string, number,
  keyword, comment }` replaces any part with a color's name, a six-digit hex color, or `false` for
  the terminal's own; `flow check` refuses others. `ChatSession` takes `colors` (`palette()`,
  exported) for a full-screen chat run by code of its own.
- **Red is for errors only.** A failure (a tool that failed, a server out of reach, wrong arguments,
  a chat that could not finish, a failed tool in the full-screen chat) is printed in `colors.error`,
  red by default; a sign-in or `--yes` needed is in `colors.warning`. Code blocks were highlighted
  with cli-highlight's theme, which paints strings red, and a block naming no language had one
  guessed, so page text came out red: Flow's theme has strings in green and numbers in yellow, and
  a block naming no language is shown as written. Pipes, `NO_COLOR`, `FORCE_COLOR=0` and
  `TERM=dumb` get no escapes.

### Migration notes

- `auth login` and `auth logout` are now `login` and `logout`. Scripts and people typing the old
  words keep working for this release (removed in 0.15): the old words are hidden from help and print
  one line on stderr naming the new command. To keep the old words for good, set `signIn: { login: "auth login",
  logout: "auth logout" }`.
- `auth status` is going away: it still answers for this release (with `--json`), with a notice,
  and is removed in 0.15.
  Write a command of your own for it. A CLI file's own `"auth status"` command keeps working as it
  is, now as an ordinary command; nothing else is needed.
- A CLI file with its own command, alias or tool named `login` or `logout` now fails `defineCli`
  and `flow check`: rename it, or move the sign-in commands with `signIn`.
- A CLI that parsed argv for `auth logout` before `runCli` to revoke its session can use
  `signIn.beforeLogout` instead.
- A `signInPage` that wrote `${cli} auth login` should write `${command}`.
- Code blocks naming no language are no longer highlighted. Name the language (```` ```json ````)
  for color.

## 0.13.0 (2026-10-29)

### Changes

- **`flow projects list` and `flow projects delete <name|id>`.** `list` shows the projects in the
  workspaces you are signed in to (`flow login`): name, workspace, id, when made, and whether you
  can delete it; `--workspace <acc_id>` keeps to one, `--json` gives `{"projects": [...]}`.
  `delete` takes an exact name (case-sensitive) or an id, refuses a name two projects share and
  prints both ids, asks you to type the name in a terminal (`--yes` without one), and prints until
  when the Flow team can bring the project back (30 days); its keys stop working at once. Only the
  organization's owner can delete a project. docs/agents.md, "Projects".
- **`flow conversations` and `flow issues`: read the hosted agent's conversations and the grades
  of its replies from the terminal.** `flow conversations [--environment staging|production]
  [--grade wrong|unhelpful|good] [--since 24h|7d|<time>] [--limit n]` lists them (id, last message,
  channel, contact, messages, replies graded wrong and unhelpful), following the server's pages up
  to `--limit` (default 20); `flow conversations show <id>` prints one, one line per message, with
  each graded reply's label, rule, reason and quoted words under it; `flow issues [--status
  open|resolved|ignored|all]` lists the problems the grades add up to, with a suggested fix. Each reads with
  the agent's `FLOW_KEY` (from `.env`, or `--dotenv`; never printed) at `--cloud`, else
  `FLOW_FRAMEWORK_CLOUD`, else https://flow.engineer/observe. `--json` prints the server's JSON
  (pages of conversations merged into one). Without `--environment` the server picks production
  for a live key, else staging. A message's text or a grade's rule, reason and quote that the server
  keeps back prints as such ("(text withheld)", "(deleted by retention)"), and messages the agent's
  own code sent show as `your code`. Exit 0 printed, 1 otherwise, with the server's message
  and hint. The coding-agent skill tells agents to run `flow conversations --grade wrong`, then
  `show <id>`, to find and fix bad replies.
- **Traces say what started each turn, and where a queued message came from.** Every trace's root
  span has `flow.turn.trigger`: `person` (their message), `nudge` (a prompt nudge, also one with
  `at` come due), `event` (a business event), `wake_up` (a wake-up, or a reminder the person asked
  for), `task` (a background tool's result), `queued_message` (a nudge's `text` or `template`, as
  written) or `direct` (Flow Framework's own message: a rule's or keyword's answer, the fallback
  template, word that a message did not go). With content on, `flow.turn.trigger_text` is the
  instruction or result it began with (the nudge's prompt, the wake-up's note, the background
  result), capped like other text. A message sent as written is always a trace of its own (before,
  it could join a turn open in its conversation), its send span marked `flow.message.as_written`.
  A nudge recorded while code runs in a conversation (`recordNudge`/`nudge` in a tool, also for
  another person) keeps where: its trace has a span link to that tool call's span (else the
  turn's), with `flow.link.kind` = `queued_by`, and `flow.origin.trace_id`, `flow.origin.span_id`,
  `flow.origin.conversation_id`, `flow.origin.tool_call_id`, `flow.origin.tool_name` on the root
  span (each only when known). It is kept with the nudge in the store, so it holds across holds,
  `at` and restarts.
- **`flow test` sends message text in its traces by default.** Under `flow test`
  (`FLOW_FRAMEWORK_RUN_KIND=test`) traces carry content unless `FLOW_FRAMEWORK_TRACES_CONTENT=0`,
  since `--synthetic` already says the test files hold no real data, so test conversations show
  their messages on the dashboard. Production stays opt-in (`FLOW_FRAMEWORK_TRACES_CONTENT=1`).
- **`flow test`'s branch, with no `--ref`:** `GITHUB_HEAD_REF`, `GITHUB_REF_NAME`,
  `CI_COMMIT_REF_NAME`, `BUILDKITE_BRANCH`, `CIRCLE_BRANCH`, else the folder's git branch (none on a
  detached HEAD). The repository's default branch (origin's HEAD), when git knows it, goes beside
  it on the session's open as `x-chinwag-default-branch`. A branch a header cannot carry (over 100
  characters, not printable ASCII) is left out instead of stopping the run.

### Migration notes

Nothing breaks; the notes below are what to know.

- No code changes. The store needs no migration: a nudge's origin and trigger ride in its existing
  JSON (the nudge's body, the inbox row, a scheduled nudge's rule), so running agents keep working
  and nudges queued before the upgrade are traced without an origin.
- A traces endpoint that reads turns should read `flow.turn.trigger` and treat
  `flow.message.as_written` sends as written by code, not by the model.
- Under `flow test`, traces now carry message text: set `FLOW_FRAMEWORK_TRACES_CONTENT=0` in the
  test's environment to keep them metadata only.

## 0.12.0 (2026-10-28)

### Changes

- **Web chat: `webChat()`, the agent in a chat box on your own site.** Add
  `webChat({ origins: ["https://www.example.com"] })` to `channels` and the agent serves it itself
  under `/v1/web-chat` (through `agent.fetch`, beside your `routes`); the site adds one script tag,
  `<script async src="https://<agent>/v1/web-chat/widget.js"></script>`. No Flow Messaging or other
  service is involved. Its send tool is `send_web`; traces label it `web`; the playground and
  `flow test` play it like any channel. docs/channels.md, "webChat".
  - The box sends messages as POSTs, each with its own id (a retry is taken once), and reads
    replies over server-sent events, falling back to long-polling on the same endpoint and cursor.
  - Replies wait in an outbox in the agent's store, numbered per visitor, so each shows once and
    in order through reconnects, restarts and a deploy's overlap (docs/guarantees.md). The outbox
    keeps a week.
  - Anonymous visitors keep an id for 30 days; a signed-in visitor's identity token, signed by
    your backend with `webChatIdentity()` (`@flow-engineer/flow/web-chat`, or any JWT library),
    makes them the same person as `resolve`'s key on WhatsApp. Its optional `phone` claim (E.164,
    a number your backend verified) links their web chat to their WhatsApp, SMS and iMessage
    conversations from that number (below).
  - Allowed sites (`origins`, `FLOW_WEB_CHAT_ORIGINS`), 1-hour sessions, limits per network
    address and per visitor, and 20 web turns at once. There is no agent-wide daily cap: the
    workspace's model credit limits apply, and a cap may come in a later release.
  - Each message carries the page it was written from and the site's details: the agent reads one
    line of data per turn, tools get `context.page`.
  - The chat box (`widget/`): a 4 KB launcher, the panel on first open, Shadow DOM, buttons, lists,
    photos and carousels, a full-screen sheet on phones, English and Hindi, keyboard and screen
    reader support.
- **The agent remembers what a person said on their other channels.** A person's conversations
  under different keys that share a verified phone number (WhatsApp as `phone:+91...`, and the web
  chat signed in as `key:member-7` with that number in its token) stay separate, but each turn is
  shown the person's recent messages in the others, and the agent's to them: the last 20 of the
  last 7 days, each with its channel and time, as data. Each reply still goes on the channel the
  message came in on. Verified numbers only (a phone channel's, an identity token's `phone`,
  `agent.message({ ..., phone })` from server code), never one typed; one agent's conversations
  only. `agent.forgetPerson` now also forgets the person's linked conversations. docs/channels.md,
  "One person on several channels".
- **Channels can serve their own HTTP** (`Channel.serve(agent)`) and cap their turns at once
  (`Channel.turnSlot()`); `agent.message({ ..., key, phone })` takes a server-verified key and
  phone number, and `agent.conversationOf({ channel, address })` finds a channel identity's
  conversation.
- **Store migration 12:** the tables `web_heads` and `web_outbox`, the column `identities.phone`
  (the number an identity was verified to have, filled as identities write; nothing is rewritten)
  and its index, and the Store methods `appendWebEvent`, `webEvents`, `webHeads`, `pruneWebEvents`,
  `linkedConversations` and `recentHistory`; `addIdentity` takes the verified number.
  `forgetPerson` also deletes the person's web chat outbox.
- **`flow deploy secrets --from-env` skips `FLOW_WEB_CHAT_SESSION_KEY` and `FLOW_TRUST_PROXY`:**
  Flow's hosting sets them.
- **The agent is told how messages read, on every channel.** Three lines in its prompt, after the
  channel's formatting line: one idea per message or short paragraph, a long answer split into a
  few short messages; items from a catalogue or tool named in plain words, the exact title kept
  for an order summary or a list row; and, on channels with buttons or lists, buttons only when
  the person's next step is to pick one of a few options, never one that just repeats the text.
  The last replaces the line that offered buttons whenever they chose between options. A
  channel's `instructions` add to it; `createAgent({ writing: "..." })` replaces it and
  `writing: false` leaves it out ([docs/channels.md](docs/channels.md#how-messages-read)).

### Migration notes

- **Flow's hosting: its store must be on 0.12 before a 0.12 agent deploys.** The store runs
  migration 12; an agent on 0.12 with a store on 0.11 is refused at deploy (`chinwag_too_new`)
  until Flow updates it. Agents that keep their own database migrate it themselves as they start.
- **A store of your own that forwards Store calls** (a `StoreApi` other than `Store`) must serve
  the six new methods above, pass `addIdentity`'s new fifth argument on, and run migration 12:
  every turn now calls `linkedConversations`.
- **Adding `webChat()` to the starter:** its placeholder `customUI("web", provider)` has the same
  name, and two channels cannot share one (`flow: two channels have the same name`). Replace the
  placeholder with `webChat({ origins: [...] })`.
- **`agent.forgetPerson` reaches further** only for a person with linked conversations, which needs
  a number from an identity token's `phone` or `agent.message({ phone })`. An agent that passes
  neither has no linked conversations: its turns, prompts and forgetting are as before.
- Nothing else changes for an agent that does not add `webChat()` and passes no `phone`, but for a
  store of its own (above), which every turn now asks for linked conversations.
- **The agent's prompt now says how messages read** (no API change; `writing` is a new option).
  Agents offer fewer buttons and write shorter messages. To restore the earlier button wording, pass
  `createAgent({ writing: "When they choose between a few options, offer them as buttons so they can tap." })`;
  `writing: false` leaves Flow Framework's guidance out altogether.

## 0.11.0 (2026-10-28)

### Changes

- **`flow deploy` ships the agent's CLI.** With `src/cli.ts` in the folder, `flow deploy` packs the
  CLI for the environment's address before anything is sent (a CLI that does not pack stops the
  deploy, exit 2 or 1 with what to fix), and once the deploy is live publishes it as `flow cli
  publish` does: `curl -fsSL <the agent's URL> | sh` installs it, and CLIs already installed are
  offered it by their update check. Before an environment's first deploy there is no address yet,
  so it is packed once live. `flow deploy promote` publishes a production build of the CLI from the
  folder once production is live. `--no-cli` leaves the CLI out of both. Without esbuild, or on a
  Flow whose hosting serves no CLIs (`cli_off`), the deploy goes on and says so in one line. A
  publish that fails after a live deploy prints why and `flow cli publish --env <env>`, and exits 1.
  `--json`'s answer has `cli`: `{ published: true, release, current, install }`, `{ published:
  false, code, message }`, or `null` without a CLI file.
- **`flow cli publish|rollback|status`: the CLI's releases on Flow's hosting**, with the CI key, on
  observe's `/v1/hosting/cli` routes. `flow cli publish --env <env> [--server <https url>] [--dir]
  [--json]` packs the CLI for the environment (its address plus `/mcp`, or the `--server` given, a
  domain of the agent's own; else the CLI file's `servers.<env>`), asks the host for the release
  (`POST /v1/hosting/cli/releases` with `{ environment, name, display_name, version, sha256, size,
  server }`), PUTs the package and the installer
  to the signed URLs it answers (no key, no `x-goog-*` headers) and makes it current (`POST
  /v1/hosting/cli/releases/<version>/publish`). It prints the install line; `--json` prints `{ ok,
  release, current, install, next }`. `flow cli rollback --env <env> <version>` serves an earlier
  published version again (`POST /v1/hosting/cli/rollback`) and says who is offered it. `flow cli
  status [--env <env>] [--json]` shows each environment's current version, when and by whom it was
  published, and its releases, newest first. A refusal prints the host's code (`version_exists`:
  commit and publish again; `already_published`: use rollback; `cli_off`: this Flow's hosting
  serves no CLIs) and exits 1.
- **A published CLI never changes its server unasked.** Before publishing, `flow cli publish` reads
  the environment's current release (`GET /v1/hosting/cli/releases`); when its `server` differs
  from the build's, it refuses (exit 1, `--json` code `server_changed`): everyone who installed
  the CLI would have to sign in again. It says how to keep the server (`defineCli({ servers: {
  <env>: "<url>" } })`); `--change-server` publishes it anyway. `flow deploy` and promote skip the
  CLI's publish with a one-line warning and still deploy. A cloud that does not say a release's
  server is not checked.
- **After a rollback, an installed CLI is offered the version served.** When `update.latest`
  answers `rolled_back_from` naming the version running, `acme update` installs the answer's
  `version` and a person at a terminal sees "acme 1.3.0 was rolled back; the version to use is
  1.2.0. Run acme update to get it.", though that version is older. Any other version is offered
  only a newer one, as before.
- **`FLOW_CLI_BUCKET` is never sent as a secret**: Flow's hosting sets it on the agent's service.
- **`flow cli pack`: the CLI as one package anyone with Node.js installs.** `flow cli pack --server
  <staging|production|https url> [--base-url <url>] [--out release/] [--dir .] [--json]` bundles
  `src/cli.ts` with every dependency (esbuild: ESM, lazy imports kept in chunks of their own,
  Node 20.19 and newer) and writes `<out>/<name>.tgz`, `<out>/install.sh` and `<out>/release.json`
  (`{ name, display_name, version, sha256, size, server }`; `--json` prints `{ ok, release, files,
  next }`). `staging` and `production` are the hosted agent's address (`GET /v1/hosting/address`
  with the CI key) plus `/mcp`. The server takes the place of the default written in the CLI file
  (`process.env.ACME_SERVER ?? "http://127.0.0.1:8790/mcp"`), which must be there exactly once,
  else pack refuses (exit 2). The version is package.json's, the server's name and the git commit:
  `0.1.3-production.ab12cd3` (`custom` for a URL, `.dirty` with uncommitted tracked changes); a
  packed CLI's `version` is always the release's. Unless the CLI file sets them, `update.latest` is
  `<base>/cli/version` and `update.command` is `curl -fsSL <base> | sh`, where `<base>` is
  `--base-url`, else the hosted address, else the server's origin. Before `npm pack`, the bundle's
  `--help` must print `USAGE` when started through a link (as npm installs a command) from an
  empty folder with a fresh config (exit 1 otherwise). esbuild is a new optional peer dependency,
  `esbuild@0.28.2`, loaded only by `flow cli pack`; without it pack exits 2 with
  `npm i -D esbuild@0.28.2`. The starter has it as a dev dependency and ignores `release/`.
- **`defineCli({ servers: { production, staging } })`: the server a CLI keeps.** A pack for an
  environment uses the CLI file's `servers.<env>` (an https URL, such as
  `https://cli.acme.com/mcp` on a domain of the agent's own) in place of the hosted address, and
  needs no CI key for it. People's sign-ins are kept by server, so set it once and never change
  it. `flow check` refuses one that is not an https URL. The release's `display_name` is
  `brand.name`, else package.json's `displayName`, else the command's name.
- **An installer for every packed CLI.** `install.sh` (POSIX sh) needs Node.js 20.19 or newer and
  npm, downloads `<base>/cli/<name>-<version>.tgz` with curl or wget, checks its sha256 (with
  `shasum -a 256` or `sha256sum`) before installing it with `npm install --global --prefix
  ~/.<name>` (`<NAME>_HOME`), without sudo. It refuses another `<name>` already on PATH and says
  where, links the command into the first writable PATH folder (else `~/.local/bin` and one marked
  line in the shell's rc file; fish too), and says what to run next. `<NAME>_CLI_URL` installs
  another package, unchecked. `--base-url` writes the address into the installer for a team that
  serves it itself; otherwise it keeps the placeholder `__FLOW_CLI_BASE_URL__` for Flow's hosting to
  fill in with the address it is served from.
- **Files a CLI reads at run time: `defineCli({ files })` and `cliFile(path)`.** `files:
  ["context/icon.svg"]` are shipped beside the bundle at the same paths; `cliFile("context/icon.svg")`
  (from `@flow-engineer/flow/cli`) is the file's path: beside the bundle when packed, in the folder
  the CLI runs from (the agent's, as `npm run cli` runs it) from the source.
- **Tables are headed in the brand's accent.** A tool's Markdown table at a terminal had its headers
  in red (cli-table3's default). They are in `brand.accent`, at the terminal's color depth (RGB,
  256 or 16 colors, as the welcome banner), else cyan.
- **A packed CLI's background tool refresh runs no command.** Bundled into one file with the CLI
  file, the process that refreshes the cached tools in the background also ran the CLI with its
  internal flag after it, and could exit before writing; `runCli` now returns at once there.
- **The starter's CLI runs when installed.** npm installs a command as a link, and the starter's
  `src/cli.ts` compared `process.argv[1]` (the link) with its own path, so an installed `acme` did
  nothing. It compares `realpathSync(process.argv[1])`.

### Migration notes

- **A CLI file made by `flow new` before this release does nothing once installed.** Change its
  last line from `if (process.argv[1] === fileURLToPath(import.meta.url)) ...` to
  `if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) ...`,
  with `import { realpathSync } from "node:fs";`. `flow cli pack` refuses the old line.
- **`flow cli pack`, `publish`, `rollback` and `status` are Flow's own.** A tool of one of those
  names on a server reached with `flow cli` is `flow cli --server <url> <name>` (the server first).
- **`flow deploy` and `flow deploy promote` now publish `src/cli.ts`.** An agent with a CLI file has
  it packed before each deploy and published once live. To deploy as before, add `--no-cli`. A CLI
  file that does not pack now stops the deploy (a CLI on a domain of its own sets
  `defineCli({ servers })` first, else it is packed for the agent's address): package.json needs a `version`, the folder a git
  commit, the CLI file its default server written once as a string and the `realpathSync` line
  above. Add `esbuild@0.28.2` as a dev dependency to have it published.

## 0.10.6 (2026-10-28, not published on its own; shipped in 0.11.0)

### Changes

- **`acme update`, and a notice when a newer CLI is out.** A CLI file can set
  `update: { command, latest }`. `acme update` runs `command` in a shell (an install script such as
  `curl -fsSL https://acme.example/install.sh | sh`, or `npm install -g acme@latest`) and shows its
  output; a failure exits 1 with the command to run by hand. `latest` is a URL answering JSON with a
  `version` (npm's `https://registry.npmjs.org/<package>/latest` already does), compared with the
  CLI's `version`: `acme update` says when this is already the newest, and a person at a terminal
  sees one line after a command when a newer version is out, such as "A new version of acme is out:
  1.3.0 (you have 1.2.0). Run acme update to get it." It is asked at most once a day (the answer is
  kept in `update.json` in the CLI's config folder) and given a second after the command at most;
  scripts, coding agents, `CI` and `--json` never see it or ask. A version with the same
  major.minor.patch and another suffix (a rebuild) counts as newer. `update` never asks for sign-in.
  A command of the team's own named `update` replaces Flow's; with `update` set, a tool whose
  command would be `update` needs another name in `commands` (`flow check` says so).

- **iMessage has no 24-hour window, and the text now says so.** `flow link --channel imessage`
  says the agent can reply after you write first, any time later; `docs/agents.md` and the
  flow-messaging README no longer put iMessage under WhatsApp's 24-hour rule. On iMessage the only
  timing rule is for typing indicators and read receipts: 5 minutes after the line's last message
  to that person.
- **The CLI names the paid plans when a trial fills.** Once a channel's free trial has 80% of its
  people, `setup`, `link` (for its channel) and `status` print one more line, by rule:
  `Next: the free trial is nearly full on Telegram. More people or your own iMessage number: Shared $25/month or Dedicated $100/month, at https://flow.engineer/dashboard/plans (the workspace owner buys it).`
  Full, or holding anyone, it names the Shared plan's link
  (`https://flow.engineer/dashboard/plans?plan=shared`) and how many wait. With `--json` it is the new
  field `plans` (`{"url", "message"}`, else `null`). `docs/agents.md` has a "Paid plans" section, and
  the coding-agent skill and the starter's `AGENTS.md` say what Shared, Dedicated and Outbound are and
  to show the owner the line rather than retry.
- **Flow Messaging's `hint` and `doc_url` reach the developer.** `FlowMessagingError` has `hint` and
  `docUrl`; a refused send, edit or unsend throws an Error whose `cause` is it, and the adapter logs
  the hint and doc_url on the console (`... a send on telegram was refused, permission (plan_ended).
  <hint> (<doc_url>)`). The agent's Not delivered note is unchanged: the hint is for the developer,
  not the person. A stream Flow stops for good resolves `stopped` with `channelCode`, `hint` and
  `docUrl` when Flow gave them, and logs the hint. The starter prints the hint when its stream stops,
  and for `plan_ended` points to https://flow.engineer/dashboard/plans instead of `setup`.
- **The join message on Flow's shared lines says Join.** What a phone sends to reach an agent on
  Flow's shared Telegram bot, WhatsApp number and iMessage line is now `Join <name> (ref <code>)`,
  such as `Join FlatX agent (ref brave-otter-40718263)`, or `Join my agent (ref <code>)` with no
  name (was `Hi <name> (ref <code>)`, `Hi there` with none). Flow's service writes it; `setup` and
  `link` print what it returns, and their help, `flow new`'s and `flow init`'s text and the guides
  say Join. The agent's first message from that person is the text before `(ref`: `Join FlatX
  agent`. Links shared already keep working: any message of up to 160 characters ending in
  `(ref <code>)` joins, and Telegram's Start link is unchanged.

### Migration notes

None.

## 0.10.5 (2026-10-27)

### Changes

- **The welcome banner's brand color works in every terminal.** It was always sent as an RGB
  escape, which terminals without RGB, such as macOS Terminal, took apart into other codes: a
  `brand.accent` of `#645bff` showed a red banner with a grey background running into the text and
  the sign-in menu below it. The banner now uses RGB only when `COLORTERM` is `truecolor` or
  `24bit`, the nearest of 256 colors when `TERM` names 256 colors, else the nearest of the 16 basic
  ones, and none with `NO_COLOR` or `TERM=dumb`. Each banner line ends by resetting every style.

### Migration notes

None.

## 0.10.4 (2026-10-27)

### Changes

- **CLI commands written as code: `command(tool)`.** A CLI file can write a tool's command as a
  chain instead of an object: `command("list_keys").arg("project").short("n", "limit")
  .flag("all", "include_revoked").default("limit", 20).map((input) => ({ ...input }))`. `arg`
  takes inputs positionally; `short` gives a one-letter flag (`-n 5`); `flag` names an input's flag
  (`--all`), while the input's own flag keeps working; `default` is sent when an input is left out
  (shown in help and the skill); `map` is the team's own code over what is sent, run after
  arguments, flags and defaults; an error it throws is shown as wrong arguments (exit 2). `hide`
  gives an input no flag (set it with `default` or `map`); `help` words one flag's help line;
  `option` adds a flag that is not a tool input, whose value `map` gets (`map((input, options) =>
  ...)`); `print` is the team's own output for people (`--json` and `--fields` still print data). A
  list input as the only `arg` takes every word (`scrape <urls...>`). `columns`, `view`, `alias`,
  `summary` and `examples` match the object's keys, and the object form takes the same as
  `shorthands`, `defaults`, `hidden`, `help`, `options`, `input` and `print`.
  Help, completion, the CLI's skill and `flow check` read both forms. `flow check` refuses a
  shorthand, default, hidden or help naming an input the tool lacks, a shorthand for a positional
  argument, `-h`/`-H` or one of the CLI's own flags, two flags of one name, a required hidden input
  with neither a default nor input code, options with no input code, and a list argument beside
  other arguments.
- **A group's default subcommand: `defineCli({ defaultCommands: { scrape: "create" } })`.** Words
  after `scrape` that name none of its subcommands go to `scrape create`, so `acme scrape <url>`,
  `acme scrape create <url>` and `acme scrape get <id>` all work; a named subcommand wins. Bare
  `acme scrape` shows the group's help, which says what the default runs; the CLI's skill names it
  on the default command. A word is still a command or a group, never both. `flow check` refuses a
  default for a name that is not a group, or one that is not a command of that group.
- **A welcome screen for a bare run.** A person who runs the CLI with no command at a terminal sees
  its name in block letters (in the brand's accent when set), its version, "Welcome to <name>", its
  description, whether they are signed in, and how to start. `defineCli({ welcome: { banner, title,
  text, tips } })` replaces any part (`banner` takes the team's own ASCII art, or `false`);
  `welcome: false` shows the help as before. Coding agents (Claude Code, Codex, Cursor), scripts and
  pipes get the help, unchanged.
- **Sign-in first: `defineCli({ signInFirst: true })`.** A person who is not signed in is asked to
  Sign in or Exit (arrow keys, Enter) before any command, then the command they typed runs. Without
  a person, the command exits 3 with `<name> auth login`. `auth`, `help` and `--help` never ask;
  `signInFirst: { except: ["docs"], message }` lets the team's own commands through and words the
  question. `CliIO` gains optional `choose` (the menu; omitted asks with `confirm`) and `columns`.
- **One brand for the whole CLI: `defineCli({ brand: { name, logo, accent } })`.** Set once, read
  by the chat, the welcome banner and the sign-in page. `name` is how people see it written
  (default the command's name): "Welcome to Acme", the chat's title, "Acme is ready" on the
  sign-in page and the client name a sign-in screen shows, while commands keep the command's name; `logo` an https or `data:image` URL, `accent` a six-digit hex color.
  `chat.accent` keeps working as the older name for `brand.accent`. `flow check` refuses an accent
  that is not a six-digit hex color and a logo that is not https or `data:image`.
- **A branded page at the end of `auth login`.** The browser no longer gets the plain text "Signed
  in. You can close this tab": it gets a page with the brand's logo (else its initial and name) and accent,
  in light and dark, that shows the sign-in finishing in a small terminal, says "Head back to your terminal", and tries to close the tab, staying up
  where the browser refuses. A failure says what went wrong and shows `<name> auth login` to try
  again. `defineCli({ signInPage: ({ status, brand, cli, message }) => html })` replaces it with the
  team's own; it gets only what the page shows, never the code, token or state. Pages are sent with
  `cache-control: no-store` and `referrer-policy: no-referrer`.
- **Fix: the sign-in page said "Signed in" before the sign-in had worked.** The browser now waits
  until the code is exchanged and the tokens are saved, and shows the failure page when either
  fails. `openUrl` is no longer awaited, since the page it opens is answered only when the sign-in
  ends.
- **A coding-agent skill for CLI design: `flow-framework-cli-design` (`cli-design-skill.md`).** It
  says which commands get short forms (rank by use; a group's default for the main verb; the main
  input positional; short flags and defaults for common ones), ends with a complete CLI file, and
  `flow new` installs it with the other skills; it also says when to customize the welcome and
  when to turn on `signInFirst`.

- **A built-in `feedback` tool on every MCP server and CLI.** Agents and people leave feedback for
  the team: `about` "tooling" (the MCP server or CLI itself) or "product" (the service behind it),
  a `message` and an optional `tool`; the CLI gets `acme feedback`. It needs no sign-in, and with
  traces on its call's span carries the feedback (`flow.feedback.about`, `.message`, `.tool`) even
  when trace content is off, for the Flow dashboard's Insights. Agents are told when to use it: MCP
  hosts in the server's instructions, and a CLI's top-level help (a FEEDBACK block), its skill (a
  "Sharing feedback" section) and the error of a failed command (`If this looks wrong, tell the
  team: acme feedback --about tooling --message "<what happened>"`). `mcpServer({ feedback: false })`
  leaves all of it out; a team's own tool named `feedback` replaces it.
- **A team's own `auth status`.** A CLI file's `"auth status": { command: buildCommand({ ... }) }`
  replaces the built-in one (help, output, `--json`, all of it); `auth login` and `auth logout`
  stay the CLI's. `flow check` refuses a tool command there, since only the team's own code replaces
  it, and still refuses any other command under `auth`, `tools` or `skill`.

### Migration notes

- A bare run at a terminal now shows the welcome instead of the help. To keep the help, set
  `welcome: false`. Agents, scripts and pipes are unchanged.
- `chat.accent` still works; move it to `brand.accent` so the welcome and the sign-in page use it
  too. Where both are set, `brand.accent` wins. A custom `openUrl` that waited for the page it opened
  must not: the CLI no longer awaits it.
- MCP servers list one more tool, `feedback`, and CLIs one more command. To keep the list as it was,
  pass `mcpServer({ feedback: false })`. A tool already named `feedback` keeps working and replaces
  the built-in one.

## 0.10.3 (2026-10-27)

### Changes

- **Every agent stamps its version, with no setting.** One label, the agent's version, is now what
  traces send as `service.version`, what `flow test` keeps with its session and what `flow deploy`
  keeps with the deploy, for the same folder. It is the first of: `traces.version` in code (or
  `--agent-version` / `--version`), `FLOW_AGENT_VERSION`, `AGENT_VERSION` (Flow's hosting sets it to
  the deploy's version), the CI's commit (`GITHUB_SHA`, `CI_COMMIT_SHA`, `BUILDKITE_COMMIT`,
  `CIRCLE_SHA1`, `GIT_COMMIT`), the folder's full git commit (`<sha>+dirty` when it has uncommitted
  changes), `package.json`'s `version`. A value outside 1 to 100 letters, digits and `. _ : / + -`
  (or shaped like a phone number) is never sent; a warning names where it was set, never the value.
  No git, or a folder without `.git` (as hosting packs it), is no version from git, never an error.
  So a dashboard can tell which version wrote a reply, and list the versions tests and traces have
  seen, without a deploy step in CI.
- **Compare versions offline.** `agent.status().version` returns it (and so the playground's
  `GET /api/status`), the agent logs it once when it starts (`flow: agent version <v> (from <where>)`,
  on stderr; not under `node --test` or `flow test`), and `flow test` prints `Agent version: <v>` and
  keeps it as `agentVersion` in the `--json` report and `.flow/last-session.json`.
- **`flow test --agent-version`** defaults to that version (it was `GITHUB_SHA` only), and a version
  given with it is also the one the agent's traces carry for that run.
- **`flow deploy`'s default label is now the full commit, not the short one.** It is that version
  too: `FLOW_AGENT_VERSION` or the CI's commit when set, else the folder's full git commit (it was
  `git rev-parse --short HEAD`), else `package.json`'s `version` outside git. Deploys, `flow test`
  sessions and traces of the same folder now carry the same label.
- **The coding-agent skills keep one version per build.** `build-agent-skill.md` ("Deploy it") says the
  git commit is the version, to pass it as `FLOW_AGENT_VERSION` to a process with no `.git` (a
  container image), how CI records a deploy on the owner's own servers (`POST /v1/deployments` with
  `FLOW_KEY` on stdin), and how to compare two versions offline; `test-skill.md` points there.
- **The simulators' iMessage sample uses Flow Messaging's `/v0` basic message**: an inbound
  event's `content` is `{ kind: "basic", text, media }` (a voice note `{ kind: "voice", file_id,
  url }`) and a send is `POST /v0/conversations/{id}/basic`. The README, `docs/` and the
  coding-agent skill link the documentation at `https://flow.engineer/docs`, and
  `flow-messaging/README.md` links the npm package `@flow-engineer/flow`.

### Migration notes

None: nothing to change. **`flow deploy` without `--version` now labels a deploy with the full
commit** where earlier ones named the short one (`a1b2c3d` became `a1b2c3d4e5...`, 40 characters);
a script or dashboard filter that matched the short label should match the full one, or pass
`--version` to choose it. An agent whose environment uses `FLOW_AGENT_VERSION` or `AGENT_VERSION` for
something else now sends that value as its version; pass `traces: { version }` to choose it.

## 0.10.2 (2026-10-26)

### Changes

- **`defineCli({ exclude: [...] })`: tools that get no command of their own.** An excluded tool is
  not in the CLI's help, completion or skill, and `flow check` no longer warns that it has no
  command. It stays on the server, so a command of the team's own can still call it with
  `this.cli.call`: a `keys reveal` that copies a key without printing it no longer leaves the raw
  `api-keys-reveal` beside it. `flow check` refuses an excluded name the server has no tool for,
  and a `{ tool }` command naming an excluded tool.
- **Terminal chat recovers after signing in as another account.** The CLI kept one conversation
  reference per agent, so after `auth login` as someone else (or another token) every `chat` sent
  the previous account's conversation and failed with "The agent's reply was interrupted or
  invalid". The agent still refuses a conversation that is not the person's, now with
  `409 { "error": "conversation_mismatch" }` (a stream's `error` event carries
  `code: "conversation_mismatch"`), before any turn starts; the CLI then forgets the reference and
  sends the message once more, starting the account's own conversation. No other failure is sent
  again. `auth login` and `auth logout` also forget the signed-in reference.

### Migration notes

None. A client of the terminal endpoint that read a mismatched conversation as `500 turn_failed`
now gets `409 conversation_mismatch`.

## 0.10.1 (2026-10-26)

### Changes

- **Signing in as another account in the same browser works.** When the brand's login page signs
  in someone other than the account the bridge's session in that browser knows, the bridge now
  replaces that session. Before, the sign-in ended on "Not found" at `/session/end/confirm` and
  the client (the CLI, Claude) never got its code. No logout page is served.
- **`oauthBridge({ login: { pendingTtlSeconds } })`**: how long a sign-in may stay on the brand's
  pages before its code comes back, from 60 seconds to a day, 600 by default as before. Set it to
  at least the login page's own window, so a first sign-up with email verification does not come
  back to a bridge that has forgotten it. The sign-in's provider interaction lasts as long.
- **The CLI keeps the issuer with its tokens and client from `auth login` on,** so the MCP SDK no
  longer prints "SEP-2352: stored OAuth credential has no 'issuer' stamp" on commands. Tokens saved
  by an earlier version take the issuer recorded with them, and keep it from their next refresh.

### Migration notes

None.

## 0.10.0 (2026-10-26)

### Changes

- **A tool can be kept to the brand's own CLI.** `mcp: { clients: ["cli"] }` on a tool lists it and
  lets it be called only for the CLI built with `defineCli`. Claude, ChatGPT and every other MCP
  client find no trace of it: not in `tools/list`, the full catalog or `search_tools`, and calling
  it (directly or through `execute_tool`) answers exactly as an unknown tool. Plugin endpoints
  follow the same rule. Chats ignore it, like `deferred`. It needs `mcpServer({ auth })`, which
  refuses such a tool without it. For a secret's reveal, say, that must never reach a third-party
  host's transcript.
- **`McpIdentity.client`** (`{ id, kind?: "cli" }`): the OAuth client a token was issued to, which
  `mcpServer` uses per request to choose the tools a caller sees. A brand with its own
  authorization server returns it from `verify`.
- **The OAuth bridge knows the CLI.** It serves the CLI's Client ID Metadata Document at
  `<origin>/.well-known/oauth-client/cli` (a public client, loopback redirects only, no secret),
  advertises it as `flow_cli_client_id` in its metadata, notes which client each access token
  went to (hashed and sealed), and fills in `client` from `verify` (`kind: "cli"` for the CLI's).
- **The CLI signs in as that client** when the server advertises one, instead of registering
  itself, unless `defineCli` sets `clientId` or `clientMetadataUrl`. A sign-in made before still
  works but sees no CLI-only commands until `auth login`: an unknown command then says so, and
  `auth status --json` has `renew`. The tool list cache is kept per sign-in and client, so it is
  never reused across them.
- **`flow check`** errors on an `mcp.clients` value other than `"cli"`, and warns about a tool kept
  to the CLI when the agent has no `src/cli.ts`.
- `McpClientKind` is exported from `@flow-engineer/flow`.
- **A brand CLI's `auth login` always prints the sign-in link,** so it can be pasted into another
  browser when the page opens in the wrong one.

### Migration notes

None: a tool without `mcp.clients` behaves as before for every client. Hosts' sign-ins are
unchanged. A CLI signed in through the bridge before this release keeps working; it signs in as the
CLI's own client at its next `auth login`, which is needed only to see tools kept to the CLI.
An agent passing `clients` to `oauthBridge` must not register `<origin>/.well-known/oauth-client/cli`
itself (refused).

## 0.9.2 (2026-10-26)

### Changes

- **Chat run by a coding agent is plain.** When `CLAUDECODE`, `CURSOR_AGENT`, `CODEX_CI` or
  `AI_AGENT` is set, or with the new `--plain`, `acme chat` acts as without a terminal even when the
  agent's shell is one (Cursor's is): replies print as written, the interactive view never opens,
  and `chat` with no message exits 2 instead of waiting for input that never comes.
- **The CLI's skill says chat may not need sign-in,** and tells agents to always pass the message.

### Migration notes

None.

## 0.9.1 (2026-10-26)

### Changes

- **Text in full-screen chat can be selected and copied.** Chat no longer captures the mouse, so
  the terminal selects and copies as usual. The wheel still scrolls: terminals send it as Up/Down
  in chat's screen, and Up/Down now scroll the conversation unless a multi-line draft needs them.
  Ctrl+P/Ctrl+N recall sent messages (Up/Down did). The Send button shows what Enter does; it no
  longer takes clicks.
- **Terminal chat beside authenticated MCP, with no terminal code.** `mcpServer({ auth, agent })`
  serves `/agent/terminal` on its own origin, checks each request with the same `auth.verify` as
  `/mcp`, lists the path in `paths` (so Flow's hosting mounts it beside `/mcp`), and adds the
  terminal channel to the agent itself. A hosted `mcp(agent, host)` factory passes the agent it
  receives. Signed in only by default; `terminal: { guests: true }` lets a CLI that is not signed
  in chat too, `terminal: false` turns it off, and `terminal: { path, channel }` renames them. With
  `agent` and no `auth`, chat is served only when `terminal` is given (everyone a guest). When
  `auth.scopes` names read or write scopes, only a token holding every one of them may chat, since a
  chat turn can call any tool.
- **`agent.addChannel(channel)`** adds a channel after the agent is built; the same channel again
  does nothing and another of that name is refused.
- **Chat on a server without it says so.** A 404 or 405 at the terminal URL prints "This server
  does not serve terminal chat (<url>)." "Is it running?" is kept for a server that cannot be reached.
- **Chat without pi-tui falls back to line chat,** with one line on how to get the full-screen view,
  instead of stopping.
- **Full-screen chat never exits silently.** When the last message failed, the reason is printed
  after the view closes and the exit code is that failure's. Stopping a wait (Escape) is not a failure.
- **No raw SDK warning when a token refresh cannot reach the server;** the CLI's own one line naming
  the server, and exit 5, remain.
- **The Flow Messaging stream no longer reconnects in a tight loop when Flow refuses it.** A refused
  stream opens, sends one error frame and closes; the adapter used to start its backoff again on
  every open, so it reconnected at once, over and over. The backoff now starts again only once a
  connection delivers an event or stays open 30 s. Every wait has full jitter; a close with 4404 or
  4429 waits 30 s to 5 min, a `retry_after` in Flow's error frame is always waited, and each
  reconnect logs its close code and wait once. 4400, 4401 and 4403 still stop the stream.

### Migration notes

- The stream's backoff and copying text: none.
- Nothing changes for an agent that does not pass `agent` to `mcpServer`.
- An agent that mounts `terminalServer` itself and wants the built-in route: remove its
  `terminalServer`, its channel and its route, then pass `agent` to `mcpServer`. Keeping both
  is refused when the server is made ("already has a channel named terminal").

## 0.9.0 (2026-10-26)

### Changes

- **Full-screen CLI chat.** `acme chat` at a terminal opens a full-screen session: the
  conversation above, a composer with a Send button below, Markdown replies, and tool activity that
  updates while the agent works (Ctrl+O shows tool inputs and results, `/help` lists the keys). It
  needs the optional peer `@mariozechner/pi-tui@0.73.1` (`flow new` includes it);
  `defineCli({ chat: { accent: "#b85c00" } })` sets a brand accent. `CliIO.chat` replaces the
  interface; `ChatSession` and `ChatUpdate` are exported from `@flow-engineer/flow/cli`.
- **Live chat activity.** The terminal handler streams `reply`, `activity` and a final `done`
  record when the request accepts `application/x-ndjson`; other requests get the same JSON as
  before. `agent.request()` takes `onReply` and `onActivity` to observe a request while it runs.
- **Chat without sign-in.** `terminalServer`'s `auth` is optional. Without it, or with
  `guests: true` beside it, a CLI that is not signed in chats as a guest: it keeps a random id in
  `chat.json` and sends it as the `flow-guest` header. A guest's conversation stays on the
  terminal channel, is never joined to an account (`ctx.key` is null), and a tool that needs
  sign-in still asks for it. With `auth` and no `guests`, chat still answers 401.
  `agent.request()` takes `guest` instead of `key` for this.
- **The CLI tries chat before asking for sign-in.** `acme chat` no longer stops with "Sign in
  first" when no token is saved; it says so only when the agent answers 401.
- **The playground serves the agent's `routes`,** as Flow's hosting does, so a route such as the
  terminal handler works under `npm start`.
- **The café starter chats.** Its agent mounts `terminalServer` as a route with guests, and its CLI
  file points `chat` at the running agent (`runningAgent`, now exported beside `markRunning`).
- **Full-screen chat colour.** With a brand `chat.accent` and a 24-bit terminal
  (`COLORTERM=truecolor`), sent messages sit on a faint wash of the accent; tool activity is a
  quiet line on an accent rail, and a running tool's name shimmers instead of showing a status mark.

### Migration notes

- `terminalServer` without `auth` used to be a type error; it now lets everyone chat as a guest.
  An agent that passes `auth` keeps requiring sign-in unless it adds `guests: true`.
- An agent built from the café starter: copy the `terminalServer` lines from
  `examples/cafe/src/agent.ts` and the `agent` line from `examples/cafe/src/cli.ts` to get chat.

## 0.8.2 (2026-10-26)

### Changes

- **Typing is kept up for the whole turn.** It was sent once, when the person's message arrived, and
  hidden once they were acknowledged, so in a long turn it lapsed after a few seconds (Telegram's
  indicator lasts about 5 s) and never came back. Now, from their message until the turn ends or
  fails, it is sent again before the platform hides it: `ChannelInfo.typingLastsMs` says how long one
  indicator lasts (`WHATSAPP` 25 s; Flow Messaging's `TELEGRAM` 5 s and `IMESSAGE` 15 s), and typing
  goes again at 80% of it (20 s, 4 s, 12 s). Each message the agent sends hides it, and it shows
  again only when new work starts (a response that calls tools, or the person's next message), never
  just because time passed: typing after the answer would read as more to come. No timer outlives
  the turn. A channel without `typingLastsMs` (a custom UI) gets typing once, as before.
- **A refused typing indicator waits for the agent's next message.** A typing call that rejects
  with `outside_window` (iMessage outside Flow Messaging's 5-minute window for typing) is not tried
  again until the agent's next message of the turn goes out, then is kept up again; it is logged at
  debug (`console.debug`, the channel and conversation id, never text). Any other typing failure
  ends typing for the turn, logged as a warning.
- **Flow Messaging's typing rejects instead of swallowing a refusal**, so the conversation can act on
  it: `outside_window`, or Flow's error type (`invalid_request`, ...). Read receipts are unchanged.

### Migration notes

- **A hand-written channel's `typing()` that rejects now ends typing for that turn, with a warning;**
  before, its failures were ignored and every later call was still made. To have typing tried again
  after the agent's next message, reject with an error whose message starts with `outside_window`.
- **A custom UI whose typing indicator hides itself** can set `info.typingLastsMs` to have it sent
  again while a turn runs. One that shows it until it is turned off needs nothing; it now also gets
  typing again while the tools of an acknowledged turn run.

## 0.8.1 (2026-10-25)

### Changes

- **Playground turns are marked in traces.** A turn that comes through the playground
  (`agent.simulate()`, `agent.simulateVisitor()`, `npm start`'s page, `flow chat`) has
  `chinwag.via` = `"playground"` on its root span, and so do a message the playground person's
  `intercept` or keyword answered and one sent to them outside a turn. A real turn has no
  `chinwag.via`. These turns share their process, and so `chinwag.run_kind` (still "production",
  or "test" under `flow test`), with real conversations; a dashboard keeps them apart by this
  attribute.
- **Flow Messaging's Telegram and iMessage traces name their platform.** `fm.telegram()` and
  `fm.imessage()` are custom channels, and their turns traced as `chinwag.channel` = `web`; they now
  set `traceChannel` (`telegram`, `imessage`). `fm.whatsapp()` and `fm.sms()` already traced as
  `whatsapp` and `sms`.
- **A trace's channel is the same on every span.** The `send <name>` spans' `chinwag.channel` is
  now the platform, as on the root span (`telegram`, `web`, ...), not the channel's own name, which
  stays in the span's name.
- **`flow setup` turns trace content on for a test traces key.** When it writes an `otk_test_`
  traces key (the Staging dashboard), it adds `FLOW_FRAMEWORK_TRACES_CONTENT=1` below it, under a
  comment saying it sends message text there and that 0 sends metadata only, so playground and
  phone chats can be read and graded. Never for a live key, never when `.env` already has the line
  (any value, either name), and only in the run that writes the key.

### Migration notes

- **`send` spans' `chinwag.channel` is the platform, not the channel's name.** A dashboard or query
  that read it as the agent's channel name: read the span name (`send <name>`) instead.
- **`flow setup` with a test traces key now sends message text to the Staging dashboard.** To keep
  traces metadata only, set `FLOW_FRAMEWORK_TRACES_CONTENT=0` in `.env` (setup leaves a line that is
  there alone).

## 0.8.0 (2026-10-25)

### Changes

- Flow Messaging preserves a refusal that arrives over the stream before the send's HTTP
  response: the send rejects with the platform's reason instead of timing out as unconfirmed.
  Failures after a completed send still notify the agent.
- **Coding-agent guidance loads by task.** `flow-framework` (`coding-agents/skill.md`) now covers
  setup, names, layout and routing. Messaging runtime, playground and deployment guidance moves
  to `flow-framework-build-agent` (`build-agent-skill.md`); MCP, CLI and plugin guidance moves to
  `flow-framework-mcp` (`mcp-skill.md`). `flow new` and `flow init` install all three and point the
  coding agent to the relevant guide.
- **MCP tools can be deferred explicitly.** `tool({ ..., mcp: { deferred: true } })` leaves that
  tool out of the upfront MCP list and makes it discoverable through `search_tools`; unmarked
  tools stay upfront. `execute_tool({ name, arguments })` calls the original operation with its
  validation, sign-in, scopes, context, formatting and traces. Both generated tools appear only
  when there are deferred operations, on standalone and plugin MCP endpoints. Chat agents keep
  their normal tools. The CLI and `mcpTools` request the complete catalog.
  `mcpServer({ ..., deferred: [...] })` overrides the tool flags; `deferred: []` puts everything
  upfront. Hosting can choose this list using usage data, but selection stays fixed for each
  server handle. Teams can customize the gateway descriptors or provide their own gateway tools.
- **The agent can wake itself up.** A wake-up is a row in the agent's store, never a timer in
  memory: at its time the agent gets a turn in that person's conversation with its note
  (`[Wake-up you set for yourself, not from the person: <note>]`) and decides what to do: look
  something up, message them, call a tool, or nothing. It never sends anything by itself. It
  survives restarts and deploys and runs once with several runners, through the same claim as
  scheduled messages.
  - The model gets `wake_me_up({ note, in_minutes | at, key? })` and `cancel_wake_up({ id })`
    built in, for its own conversation only, and each turn shows it the wake-ups it set there.
    `createAgent({ wakeUps: false })` takes both tools and that list away; wake-ups set by code
    still run.
  - From code: `context.wakeUps` in a tool (`add({ note, inMs | at, key?, respectQuietHours? })`,
    `cancel(key)`, `list()`), and `agent.wakeUp({ to, ... })`, `agent.cancelWakeUp(key)`,
    `agent.listWakeUps(to)` elsewhere. One active wake-up per key in a conversation: the same key
    again returns it (`status: "exists"`). `cancel(key)` cancels the active ones with that key in
    every conversation, so the seller's answer cancels the reminder set in the buyer's.
  - It keeps the person's rules: due in their quiet hours it waits for them to end (unless
    `respectQuietHours: false`). After their STOP or in a pause it still runs, so the agent can do
    its work (close the question), but its note says so and Flow refuses every send to them in
    that turn (`Not sent: they texted STOP, ...`), until they write. Past WhatsApp's 24-hour window it still runs, and the agent is told only a template
    reaches them (`send_template`); no fallback template goes by itself. Found late after
    downtime, it runs and says when it was due, where a scheduled message is missed.
  - Limits in `WAKE_UP_LIMITS`: 10 active per person, 10,000 per agent, 90 days ahead, notes of
    500 characters and keys of 200. The model gets a plain error past one; code gets
    `{ status: "refused", reason }` at a cap and a throw for a bad time or note.
  - `agent.forgetPerson` deletes them. `agent.outbox(id)` has a new `wakeUps` list, and the
    playground's Person tab shows it beside scheduled messages; moving its clock (or a business
    run's `wait` in `flow test`) brings them due.
- **`agent.cancelNudge(key)` cancels a nudge sent with `at`**, by its idempotency key, while it is
  still to come: nothing goes, and its state is `cancelled` (a new `NudgeStatus`, also in
  `spec/nudges.openapi.yaml`). A nudge that is not waiting to go (it went, or had no `at`) keeps
  its state, which it returns; null for a key no nudge has. A scheduled nudge's schedule now
  carries its key; one scheduled before 0.8 has none, so it is not found and goes as planned.
- Store migration 11 adds the `schedule_key` column to `schedules` (a wake-up's key, a scheduled
  nudge's idempotency key), a unique index on active schedules' keys per conversation, and an
  index on each conversation's schedules (every turn now reads its wake-ups). It runs on the
  agent's first start and changes no existing row.
- `list_scheduled` and `cancel_scheduled` see only scheduled messages, never the agent's
  wake-ups; the 10-a-person cap on scheduled messages counts only them.
- **A tool's own text for people.** `tool({ output, format: (result) => markdown })` makes the
  result readable where people see it: over MCP the text is the result's `content` (structured
  content still carries the data), and the CLI prints it by default, rendered at a terminal by
  `marked-terminal` (new optional peers: `marked@12.0.2`, `marked-terminal@7.3.0`; as written when
  piped, for `NO_COLOR`, or when they are not installed). `--json`, `--fields` and a
  CLI file's `columns` or `view` still show the data. `format` runs on the checked output; if it
  throws, the result goes out as JSON, still a success, and `tool.end` carries `formatError`.
  Chats are unchanged: the model there still reads the data. `flow check` refuses `format`
  without `output`.
- **The CLI's top-level help is easier to scan.** `chat` comes first, as the way to ask for
  anything in plain words; the CLI's own commands (`tools`, `skill`, `auth`, `help`) come last,
  under This CLI; one usage line replaces one per command. At a terminal, headings are bold and
  command names coloured, chat's the most (plain when piped, for `NO_COLOR` or `TERM=dumb`). `defineCli({ sections: { Account:
  ["account", "keys"] } })` lists groups and commands under headings, in order, the rest under
  Other; `flow check` refuses a name that is not a top-level command or group, or one in two
  sections.
- **`<cli> help <words>`** lists the commands whose words or descriptions have every word
  (`acme help invoice`). The CLI's generated SKILL.md mentions it.

### Migration notes

- Existing projects refreshing their coding-agent skills also copy `build-agent-skill.md` and
  `mcp-skill.md` from the package's `coding-agents/` into
  `.claude/skills/flow-framework-build-agent/SKILL.md` and
  `.claude/skills/flow-framework-mcp/SKILL.md`, alongside the updated main skill. No runtime changes
  are needed for the skill split.
- MCP exposure is unchanged until tools are marked deferred or a server supplies a `deferred`
  list. A custom MCP client that needs every original descriptor can send
  `tools/list` with `_meta: { "flow.engineer/full-tool-catalog": true }`. Deferral changes
  discovery, not access control; target permissions still apply to direct and indirect calls.
- **`StoreApi` has three new methods, `addWakeUp`, `cancelWakeUps` and `cancelScheduledNudge`,**
  and `addSchedule` writes the new `key` field. A store of your own that
  forwards each call to a `Store` (as Flow's hosting does) forwards them too. A hosted agent on
  0.8 deploys once Flow's hosting runs 0.8 (until then `flow deploy` refuses it, as for any newer
  line).
- **`ScheduleRow` has a new field, `key`, and new values: `mode` `"wake"`, `origin`
  `"agent"`.** Code that reads `store.schedules(...)` itself and switches on `mode` or `origin`
  handles them, or leaves out rows with `mode === "wake"`.
- **Every agent's model is offered two more built-in tools**, `wake_me_up` and `cancel_wake_up`. An
  agent with a tool of its own by either name renames it, or turns them off with
  `createAgent({ wakeUps: false })`.
- **`NudgeStatus` has a new value, `cancelled`.** Code that switches on a nudge's status
  exhaustively handles it; it comes only from `agent.cancelNudge`.
- **To render a tool's `format` in a terminal**, a CLI's package adds `marked@12.0.2` and
  `marked-terminal@7.3.0`; without them it prints the Markdown as written. Nothing else changes.
- **A CLI file's own `help` command**, like its own `chat`, replaces the CLI's `help <words>`.

## 0.7.0 (2026-10-24)

### Changes

- **The Flow Messaging adapter (`@flow-engineer/flow/flow-messaging`) speaks Flow Messaging's V0
  API:** every call goes to `/v0/...`, and each kind of message goes to its own endpoint
  (`POST /v0/conversations/{id}/basic`, `/buttons`, `/list`, `/carousel`, `/template`, `/reaction`,
  `/typing`, `/read`). V0 sends exactly what it is given or refuses it (`422 unsupported_content`);
  it converts nothing. So the adapter now does each channel's conversions itself:
  - Telegram: the agent's Markdown goes as Telegram's HTML (`telegram.parse_mode: "HTML"`),
    rendered by the same rules Flow Messaging used, so it looks the same as before. A carousel goes
    as its text, then one message per card in order: the card's photo with its text as caption and
    its buttons or link under it (a card with neither is its photo alone).
  - WhatsApp: a list goes as a WhatsApp `list` with the agent's own label (before, every list
    opened with "Choose"). Row titles now take WhatsApp's 24 characters (they were cut to 20), and
    row descriptions are shown (they were dropped). More than 3 buttons also go as a list, under
    "Choose". WhatsApp's own marks (`*bold*`) go as written, as before.
  - iMessage: text is now Markdown, sent as iMessage's own styles (`imessage.styles`: bold, italic,
    underline, strikethrough). `IMESSAGE.formatting` is `"markdown"`, so the agent is told Markdown
    works there, and so is the iMessage platform `flow test` plays (`x-flow-platforms` in
    `spec/agent-endpoint.openapi.yaml`).
  - A message the business starts (a nudge, a scheduled text) goes with `link_preview: false` on
    every channel, not only WhatsApp.
- Typing sends `{}` and nothing when the agent stops typing: no channel clears the indicator on
  request, and it clears itself when the next message goes. iMessage read receipts mark the whole
  conversation (Flow refuses `up_to` there).
- Events are read in both shapes: the V0 one (`content.kind`) and the older one (`content.type`),
  which an app Flow still serves through its bridge to the older API gets.
- A `422 unsupported_content` reaches the agent saying what the channel does not take, on which
  channel and why, for example `unsupported_content (no_mms, param media, on sms): ...`, with
  "don't resend it". `FlowMessagingError` has two new fields, `param` and `channel`.
- iMessage group conversations are passed over, with one warning. The agent never answers in a
  group, and no typing or read receipt goes to one. Before, their events failed, and Flow
  delivered them again.
- **Edits and unsends.** On channels that have them (Telegram and iMessage on Flow Messaging, a
  custom UI with the new `editMessage` / `unsendMessage`) the agent is offered `edit_message`
  (`{ message_id, text }`) and `unsend_message` (`{ message_id }`), as `react` is offered only where
  reactions exist; WhatsApp and SMS offer neither. The send tool's result there names the message
  (`{"delivered":true,"channel":"imessage","message_id":"msg_..."}`), read back from the history
  after a restart. An edit's text passes `beforeSend` (`context.edit` names the message) and the
  content rules like any send. On Flow Messaging an edit is `PATCH /v0/messages/{id}` (the new text
  styled as a send's: Telegram's HTML, iMessage's styles) and an unsend `DELETE /v0/messages/{id}`.
  Flow refuses a late or unsupported one when it is made (`422 unsupported_content`, with
  `edit_window_closed`, `unsend_window_closed`, `first_message_not_editable` or `not_on_sms`), and
  the tool's result is that refusal with Flow's message, which states the limit (`Not edited:
  unsupported_content (edit_window_closed, on imessage): iMessage allows edits within 15 minutes of
  sending; ...`). Nothing is sent instead: the agent writes its own correction if it wants one.
  Flow Framework sets no time limits of its own. One the channel refuses after Flow took it comes
  as Not delivered (`edit of msg_...: <text>`, `unsend of msg_...`). New `ChannelInfo.edits` /
  `unsends`, `Outbound` `{ type: "edit", messageId, text }` / `{ type: "unsend", messageId }`, events
  `message.edited` and `message.unsent`, transcript entries `edit` and `unsend`.
- **Sends return the platform's message id.** `SendReceipt.messageId`: Flow Messaging's sends
  resolve with it (`msg_...`; a carousel sent in parts, its first message's), and so can any
  provider's; `message.out` carries it as `messageId`, and a sent nudge's `NudgeResult.messageId`
  (a prompt nudge's: the agent's first message) when this process sent it. That id is what
  `PATCH` and `DELETE /v0/messages/{id}` take, for an agent's own code.
- The playground, `flow chat` and the test cloud's simulators play edits and unsends: their sends
  resolve with their ids (`a1`, `a2`, ...), the thread shows the message edited or gone (lines
  `edit` and `unsend`), a platform without them refuses them with its error, and `flow show` prints
  them. The cloud's answer to an outbound may carry `messageId` (an older cloud's does not, and its
  runs offer no edits).

### Migration notes

- **The Flow Messaging adapter needs Flow Messaging's V0 API.** 0.7 calls `/v0`, so upgrade once
  Flow Messaging serves V0. Versions before 0.7 call the older `/v1` API. That keeps working only
  while Flow serves your app through its bridge to the older API, and Flow switches you off the
  bridge once you upgrade. To move, bump `@flow-engineer/flow`. The adapter's options, channels and
  exports are unchanged. Code of your own that calls Flow Messaging beside the adapter (`POST
  /v1/conversations/{id}/messages` with `content`) moves to the per-kind endpoints: see Flow
  Messaging's migration guide.
- **iMessage text is Markdown now.** An agent's iMessage replies are read as Markdown and sent with
  iMessage's styles, and the agent is told Markdown works there. `**6pm**` used to show as written;
  now it shows as bold "6pm". An agent whose own instructions said to write plain text on iMessage
  can drop that line. To keep text exactly as written, escape the marks (`\*`).
- **A Telegram carousel card with buttons needs a text.** Flow sends a card's buttons under its
  text, and V0 takes no buttons message without one. A carousel with such a card is refused before
  anything is sent, and the agent is told which card. Before, Flow sent the photo and the buttons
  with no caption.
- **A first message to someone with no conversation yet is text or a template.** When the adapter
  knows no conversation (a nudge, or a send after a restart before the person writes), V0 starts
  one only with a text or a template. A link still goes, as its text with the URL on a line after it.
  Buttons, a list or a carousel are refused before anything is sent, and the reason says to send a
  text first. Before, they started the conversation.
- **A WhatsApp carousel no longer quotes the message it replies to** (V0's carousel has no
  `reply_to`).
- **`Outbound` has two more members, `edit` and `unsend`.** They go only to channels whose info
  says `edits` / `unsends`, so a hand-written channel is never sent one. TypeScript code that
  narrows `Outbound` by what it is not (`Exclude<...>`, or an exhaustive `switch` with a `never`
  check) handles the two (or ignores them, as for `typing`).
- **`PlaygroundSink` may return a `SendReceipt`.** A sink that returns nothing keeps working unchanged.

## 0.6.0 (2026-10-24)

### Changes

- **The agent's own records.** `createAgent({ records: { questions: { people: ["buyer", "seller"],
  fields: ["listing", "status"] } } })` declares collections of small JSON documents the agent keeps
  across days and people, in the same store as its conversations: `context.records` in a tool,
  `agent.records` elsewhere, with `put`, `get`, `query` (equality on declared fields, oldest first,
  pages of up to 100), `delete`, `forgetPerson` and `export`. They behave the same on SQLite,
  Postgres, the playground and Flow's hosting, per agent and environment. `agent.forgetPerson`
  also deletes the records that name the person in a `people` field (by their person key,
  conversation id, any identity, or their number on a phone channel, whatever their key), and a
  tool of theirs still running then can no longer put one. A field added to a collection's
  `people` or `fields` is indexed for the records already kept when the agent next starts, so
  `query` and forgetting find them; the store keeps every field declared for a collection, so an
  older declaration on the same store (a deploy's old revision) takes nothing away and its puts
  index the newer fields too. Limits in `RECORD_LIMITS`: 64 KB a record, 10,000 an agent
  (new records put at the same moment may pass it by up to as many as are put at once), 20
  collections, 8 declared fields each. If anything other than the agent reads the data, it
  belongs in your own database ([docs/agents.md](docs/agents.md#the-agents-own-records)).
- **`flow records export`** prints every record of the agent in the folder (the store its
  `buildAgent` opens) as JSON Lines.
- `mcpServer({ records: agent.records })` gives tools served over MCP the same records.
- **`context.events`: a tool's own agent's business events side.** Once `events.attach(agent)` has
  run, every tool call of that agent has its `flowEvents` as `context.events` (`agent.events` for
  code outside a turn: routes, beforeSend, intercept, context), so a tool watches, mutes or takes
  back a topic for the conversation's person in the state of the agent it runs for
  (`context.events.watch({ address, topic })`, `mute`, `notInterested`, `stopped`, `remember`),
  never through a module variable. Two agents in one process (two test runs, a deploy's overlap)
  each see only their own, when each has its own `flowEvents` (made inside `buildAgent`). It is not
  `createAgent`'s `events` (trace sinks). Absent when no events side is attached; over MCP,
  `mcpServer({ businessEvents: events })` gives it. An agent with its own watch fields reads
  it as `context.events as FlowEvents<MyWatch> | undefined` ([docs/events.md](docs/events.md#watches-raise-a-message)).
- **A tool `flow test` runs for real (`tools: { real: [...] }`) is the agent's own object again.**
  From 0.4.9 to 0.5.3 a business run handed `buildAgent` a copy of it (`{ ...tool, run }`), so code
  that knew its own tool by identity (`t === myTool`, to swap in one that keeps this agent's
  state) no longer matched, and what the tool kept went to module-shared state instead of the
  run's agent: the scenario sent nothing, with no error. `buildAgent` now gets the very object
  it exports, as in production. The tools the cloud simulates are still stand-ins of their own
  (same name, description and input), never `===` the agent's.
- The playground's Records tab, for an agent that declares collections, shows its newest 200
  records, newest first, with each collection's count and how many older ones are not shown.
- Store migration 10 adds the tables `records`, `record_index` and `record_collections` (per
  collection, every field declared on the store and the fields its records are indexed for); it runs on the agent's first start, as every
  migration does, and changes no existing table.
- The `zod` dependency is `^4.6.6` (was `^4.6.5`): zod before 4.6.6 could exhaust memory on an
  oversized input to a constrained collection (GHSA-mrhx-c7xc-m3w5).

### Migration notes

- **`ToolContext` has a new field, `records`.** Flow Framework fills it for every tool call. Code that
  builds a `ToolContext` itself (a unit test calling a tool's `run`) adds it: `records: agent.records`.
- **`StoreApi` has the record methods** (`putRecord`, `getRecord`, `queryRecords`, `deleteRecord`,
  `forgetRecords`, `exportRecords`, `reindexRecords`). A store of your own that forwards each call to a `Store` (as
  Flow's hosting does) forwards them too; a hosted agent on 0.6 deploys once Flow's hosting runs
  0.6 (until then `flow deploy` refuses it, as for any newer line).
- **An agent takes one events side.** `events.attach(agent)` with a second, different `flowEvents`
  on an agent that already has one now throws (they overwrote each other's state already, as
  0.5.0's notes say): mount one. Attaching the same one again changes nothing. One `flowEvents`
  attached to a second agent is no longer the first one's (`agent.events` undefined there): a
  module that builds several agents (`buildAgent`) makes one per agent.
- **From 0.4.9 to 0.5.3, `flow test` gave `buildAgent` copies of the tools it runs for real.** An
  agent that worked around it (matching its tool by name or schema rather than `t === myTool`, or
  routing its tool's run to the agent whose conversation it is) keeps working; the workaround can
  go now. A tool that needs its agent's events state can read `context.events` instead of
  `buildAgent` swapping in a copy bound to that state. On 0.4.9 to 0.5.3, a scenario with
  `tools: { real: [...] }` whose tool keeps per-agent state that way may have passed or failed for
  that reason alone: run it again on 0.6.

## 0.5.3 (2026-10-24)

### Changes

- **A template nudge reaches someone who never wrote.** `agent.nudge({ to: { channel, address }, template })`
  on a phone channel that sends templates (WhatsApp) makes the person and their conversation, as
  their first message would, then sends the template: the way WhatsApp lets a business message a
  number first. The number is read as inbound numbers are (E.164; `defaultCountryCode` on phone
  channels other than WhatsApp) and must look like one (7 to 15 digits; on WhatsApp written in full,
  with `+` or `00`: a national `"(555) 010-0177"` or bare `"5550100177"` is refused `unknown_person`,
  never read as another country's), so their reply lands in
  the same conversation, and a number that is already someone (they wrote on SMS) joins that
  person, their STOP and no-contact rules included. Text and prompt nudges to someone who never
  wrote are still refused `unknown_person`, as is a template on SMS. Declared-template checks,
  idempotency keys and quiet hours work as before. In the playground, the Person panel's template
  to a test person who has not written shows in their thread, never through the provider
  (`recordNudge(input, { via: "playground" })`).
- **A nudge finds the person however the business writes their number.** On a phone channel,
  `"+1 (555) 010-0177"` finds the person who wrote from `"15550100177"` (also when `resolve` keys
  them; on WhatsApp the number is in full, or as WhatsApp writes it), and `agent.contact(to)` finds
  them the same way. When one number is written two ways there (the business's, the provider's) the nudge
  goes where they last wrote from, with that identity's window. Scheduled messages pick that
  identity too. A test person's playground identity never takes a business's nudge from their real
  phone's, nor the Person panel's from the playground.
- **A scheduled prompt nudge due past the WhatsApp window goes as one sent now would.** With a
  `fallbackTemplate`, `nudge({ prompt, at })` that comes due after their 24-hour window closed is
  no longer skipped: the agent is told the window is closed and may send a template that says it
  (`send_template`); otherwise the fallback goes, `template.missing` says what wanted one, and the
  nudge is held until they reply. The run is recorded `skipped`, its reason naming the nudge it
  went on as (`outside_window: went on as nudge n_...`); read that nudge's state for how it ended. Without a
  `fallbackTemplate`, and for scheduled text, it is skipped `outside_window` as before.

### Migration notes

- **A template nudge to an unknown number is sent, not refused.** An agent that relied on
  `unknown_person` to never template a stranger checks first: `if (!(await agent.contact(to))) return;`
  before `agent.nudge({ to, template })`. `agent.reach(to)` before a template is no longer needed.
- **Scheduled prompt nudges past the window now run when the agent has a `fallbackTemplate`.**
  Before, they were skipped `outside_window`. A message that must not go past the window is
  scheduled as `text`, which is still skipped there.

## 0.5.2 (2026-10-24)

### Changes

- **`skill` lists skills and reads only the ones requested.** `skill` or `skill list` prints names
  and descriptions; `skill get <name> [name...]` reads selected workflows or the generated
  `<cli-name>-cli` guide. `--json` returns named records; `--write <dir>` exports selected SKILL.md
  files. Batch reads share one MCP connection.
- MCP advertises skill summaries on the existing `read_skill` descriptor, without exposing bodies
  during discovery or adding another tool. Older servers still supply names from `read_skill`'s
  schema. The generated CLI guide includes handwritten commands and maps MCP tool names to commands.

### Migration notes

- **Bare `skill` now lists summaries instead of printing the whole CLI guide.** Use
  `skill get <cli-name>-cli` for the previous content. `skill --write <dir>` keeps exporting the
  generated guide unchanged in purpose. Deploy the updated MCP server to include workflow
  descriptions in listings; older servers list names with empty descriptions. Skill definitions
  and the `read_skill` request format do not change.

## 0.5.1 (2026-10-24)

### Changes

- **Generated CLIs use cached MCP definitions immediately and refresh in the background.** The cache
  keeps tools and the server's name/version per endpoint, client and credentials. Background refresh
  runs at most every five minutes; version changes detected before a tool call refresh immediately.
  Unknown commands/arguments refresh and reparse once; server argument errors refresh definitions
  without replaying a tool request. `--refresh-tools` forces discovery; `discoveryCache: false`
  disables caching and `{ maxAgeMs }` changes the background interval. Embedded CLIs can schedule
  refreshes with `CliIO.background`. Handwritten commands work without discovery and take precedence
  over derived names. MCP-backed commands still execute on the server.

### Migration notes

- **CLI tool discovery is cached by default.** Cached commands load immediately and refresh in the
  background. To keep discovery on every invocation, set `discoveryCache: false` in `defineCli`.
  `--refresh-tools` fetches current definitions on demand. The MCP server must still be deployed;
  tool implementations continue to run there. No changes to tool definitions are needed.

## 0.5.0 (2026-10-23)

### Changes

- **The API may change until 1.0, with a migration note every time.** [docs/stability.md](docs/stability.md)
  lists what freezes at 1.0; [docs/releasing.md](docs/releasing.md) is the release checklist.
  New guides: [docs/channels.md](docs/channels.md) (every channel's options and params) and
  [docs/patterns.md](docs/patterns.md) (patterns that worked). The README is rewritten around one
  codebase for every interface: MCP server, plugin, CLI and messaging agent.
- **`flow deploy` checks hosting's Flow Framework release line first.** An agent on a newer
  major.minor than hosting runs (from `package-lock.json`) is refused before anything is sent. A
  cloud that does not say which release it runs deploys as before.
- **`flow inspect <url>`** tests any MCP server as a host does (`tools`, `call`, `auth`,
  `resources`, `prompts`), and `flow setup` checks the agent's own MCP server.
- **The simulators look and behave like the real apps**: WhatsApp's bubbles, ticks, reply buttons,
  lists and carousels; Telegram's keyboards; iMessage's tapbacks and Delivered/Read; photos,
  documents and voice notes; Debug shows each platform's own payloads.
- **The free trial counts people.** `flow setup`, `link` and `status` print the trial as people per
  channel (`3 of 25 people, 2 waiting for a place`); an older cloud's answer still prints messages
  used.
- **Delivery guarantees, written down and checked.** [docs/guarantees.md](docs/guarantees.md) says
  what `send()` resolving means, what is ordered, and where messages are sent once or at least once.
  `npm run test:conformance` runs every channel adapter Flow Framework ships through those
  guarantees (on demand and before each release; not part of `npm test`).
- **Flow Messaging sends resolve once the channel has the message** (`message.sent`), not on Flow's
  `202`: the agent's next message waits for it, its send tool says `delivered` only then, and a
  `message.failed` comes back from that send as Not delivered. New options
  `flowMessaging({ waitFor: "sent" | "delivered" | "queued", waitTimeoutMs })`.
- A send may resolve with a `SendReceipt` (`sent`, `delivered`, `queued`, `unconfirmed`); providers'
  `sendMessage`, `sendCarousel` and `sendTemplate` may return one. A send whose provider gave up
  waiting (`unconfirmed`) emits the new event `message.slow` and is never sent again.
- `ChannelInfo` has `templates` and `typing`. `templates: false` (SMS, Telegram, iMessage) refuses a
  template before it goes, with Flow Messaging's own `content.type` error; `typing: false` (SMS, a
  `whatsapp()` provider with no `typing`) is never sent a typing indicator.
- `flowEvents` keeps its send state in the attached agent's database when that database survives a
  restart: event ids taken (30 days), held sends, caps, watches and what was told. A restart neither
  processes an event id again nor forgets a held send, and an event answered 202 but not yet
  processed when the agent stopped is processed after the restart. New option `persist` (default
  true; false when you pass your own `state`).
- `POST /v1/events` answers 202 once the event is recorded in the database, and 503 when it could
  not be recorded (retry with the same id).
- `events.idle()` also waits for work queued while it waited (a restart's unprocessed events).
- `flow inspect`, `flow cli` and `flow mcp update` run where the MCP client is not installed (from
  `npx --package`, outside an agent's folder) say which package they need and how to get it, and
  exit 1, instead of crashing with `ERR_MODULE_NOT_FOUND`.
- **A generated CLI command whose arguments the server's schema refuses** (a maximum, a pattern)
  exits 2 with one line per field (`--days: Too big: expected number to be <=16`) and the command's
  `--help` hint, as other wrong arguments do. It printed the MCP `ProtocolError` with a stack and
  exited 1. A custom command still gets `cli.call`'s own error to handle; one it lets through is
  reported the same way.
- `guards(...)`, `oncePerChat`, `noRepeats`, `linkAllowlist`, `noWriteButtons`: ready-made checks
  for `beforeSend`, composed in order, the first refusal winning.
- `beforeSend`'s context has `sent`: the texts already sent in the conversation, read from the
  stored history, so guards hold after a restart.
- `agent.resetHistory({ to, note })`: the model's history starts again from a point (nothing is
  deleted); a new event, `history.reset`, when a turn reads it.
- **`flow init --name <name>`**, and without it `init` names the agent after `--display-name`
  (`--display-name "FlatX agent"` is `flatx-agent`), then after the folder as before.
- **Every name in a new agent comes from the name it was given.** The starter's names live in
  `package.json` only: a new file, `src/name.ts`, reads `name` and `displayName` there for
  `src/cli.ts` (the command, `<NAME>_SERVER`, its help examples), `src/mcp.ts` (the MCP server's
  name and the `claude mcp add` line it prints) and `src/main.ts` (the playground's title). A new
  agent no longer names `bean-and-leaf`, `cafe` or `CAFE_*` anywhere, and its package.json
  `description` (which `flow plugin` puts in plugins) no longer says "started from the café
  example". The coding-agent skill lists where people see each name ("Names").
- More Chinwag names become Flow's: the spec's platform table is `x-flow-platforms`, a drafted
  context-pack spec is marked `x-flow-draft`, and `flow plugin` records what it wrote in
  `.flow-skills.json`.
- **`flow test` tells a credit or infrastructure stop from a failure.** Each run's outcome is
  `passed`, `failed`, `credit` or `infra`; credit and infra runs are counted apart and never as
  failed (they still exit 2). With `--runs N` the summary prints each scenario's pass rate per
  channel (`hello (sms): 2/3 passed, flaky`).
- **Seeded history in scenarios.** A scenario's `history:` (`- person: ...` / `- agent: ...`) is
  written into the agent's store before the first message, with no model call and nothing sent
  (new `agent.seedHistory()` and `Conversation.seed()`).
- **One send path.** On a Flow Framework agent, `flow test` checks that every message the agent
  sent went through its channels (`/outbound` against `message.out`); a mismatch fails the session.
- `flow test --json` adds `outcome` per run, `counts.credit` and `counts.infra` (still inside
  `errored`), `scenarios` (each scenario's runs, passed runs, credit and infra) and `sendPath`;
  `.flow/last-session.json` runs get `outcome`. `model.error` events carry `code` and `status` when
  the error has them.

### Migration notes

- **Agents made already keep working unchanged**; the starter changes only what `new` and `init`
  write. To take the new shape, copy `src/name.ts` from a new agent and use its `name`,
  `displayName` and `serverEnv` in place of the names written in `src/cli.ts`, `src/mcp.ts` and
  `src/main.ts`.
- **The starter reads `MODEL`, not `CAFE_MODEL`**, for the model id (`openAICompatible()` reads
  `MODEL` itself). An agent made already still reads `CAFE_MODEL`; a new one ignores it, so move
  the value to `MODEL=` in `.env`.
- **`flow init --display-name` names the package after the display name**, no longer the folder:
  pass `--name <folder's name>` to keep the old name.
- **A generated CLI command refused by the server's schema exits 2, not 1.** A script that treated
  exit 1 as "bad arguments" checks for 2, the usage code the CLI already used for other wrong arguments.
- **Flow Messaging sends wait for `message.sent`.** A send now takes until the channel accepted it
  (usually well under a second, at most `waitTimeoutMs`, 30 s by default). On a webhook, add
  `message.sent` to the endpoint's `events`, or each send reads its message back and takes up to a
  second longer. To keep 0.4's behaviour: `flowMessaging({ waitFor: "queued" })`.
- **A template on SMS, Telegram or iMessage is refused, not failed.** It used to fail at the send
  (a "Not delivered" note, a nudge `failed`); it is now refused before it goes (`message.refused`, a
  nudge `refused`). Code that watched for the failure watches for the refusal.
- **`Channel.send`, `Deliver` and the providers' send methods return `Promise<void | SendReceipt>`.**
  A provider that returns nothing keeps working unchanged. Code that calls a channel's `send` itself
  and declares its result as `Promise<void>` changes the type to `Promise<void | SendReceipt>`.
- **Store migration 9** (`event_state`, `event_seen`) runs by itself when the agent's store starts.
  A store that forwards calls to a `Store` elsewhere (a `StoreApi` given to `createAgent({ store })`)
  must run the migration there and forward `loadEventState`, `takeEvents` and `saveEventState`; without
  them flowEvents keeps its state in memory, as before.
- **flowEvents state is now one per agent in the database.** Two flowEvents mounted on the same agent
  and database, or one agent's events side on two runners at once, overwrite each other's state: run
  one. To keep the old in-memory behaviour, pass `persist: false`.
- **The default history budget is smaller.** An agent without `history.maxTokens` now sends each
  model call at most 24,000 tokens of history, or 60% of the model's `contextTokens` when that is
  less (before: 60% of `contextTokens`, else 50,000). Long chats leave older messages out sooner
  (`history.trimmed`). To keep the old behaviour: `createAgent({ history: { maxTokens: 50_000 } })`
  (or `Math.floor(contextTokens * 0.6)`).
- **A new event type, `history.reset`.** An event sink that switches on event types sees it. A
  custom `StoreApi` passes inbox payloads through unchanged; nothing to do. The same goes for
  `message.slow` (a send whose provider gave up waiting; it is never sent again).
- **`POST /v1/events` may answer 503.** It answers 202 only once the event is recorded. A system
  that sends business events retries a 503 with the same event id (taken once).
- **`flow deploy` may refuse a newer release line.** Once Flow's hosting says which Flow Framework
  it runs, an agent on a newer major.minor (0.5.x against hosting's 0.4.x) is refused before
  anything is sent: stay on the line hosting runs until it moves.
- **The free trial line is worded in people.** `flow setup`, `link` and `status` print
  `3 of 25 people, 2 waiting for a place` instead of messages used; scripts read `--json`.
- **Chinwag names renamed, the old ones still read for now.** `spec/agent-endpoint.openapi.yaml`'s
  platform table is `x-flow-platforms`; `x-chinwag-platforms` is kept beside it as the same table,
  deprecated, and goes in 0.6: code that reads it from the package reads `x-flow-platforms`.
  `flow plugin` writes `.flow-skills.json` and removes `.chinwag-skills.json`; `flow check --plugin`
  still accepts a package with only the old file, so nothing to do but commit the renamed file after
  the next `flow plugin`. The context skill now marks a drafted spec `x-flow-draft: true`; nothing in
  Flow Framework reads the marker, and `x-chinwag-draft` in an existing pack means the same.
- **`flow test`'s printed summary is worded differently.** `N errored (...)` is now
  `N hit an infrastructure error (...)` or `N stopped for credit (...)`, and `K failed a check` is
  `F failed`. Scripts that read the printed summary read `--json` instead (its fields are only
  added to).
