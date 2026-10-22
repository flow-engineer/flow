# Flow Framework for coding agents

The published guide is at https://docs.flow.engineer/agents: that is the link to give.

You are building or changing a Flow project for a person (the owner): tools and skills exposed
through an MCP server (Claude, ChatGPT, Cursor, Codex), plugins, a CLI or a messaging agent on
WhatsApp, iMessage, Telegram, SMS or their own app. Start with the interfaces the owner needs.
Every command here runs without a terminal and never reads stdin, except `chat`, which reads the
messages you pipe to it.

Always name the package: `npx @flow-engineer/flow ...`. `npx flow` on its own fetches another npm
package.

## Starting from the owner's product

When the owner has a product (a codebase), the agent is built from it:

1. Read the product's code (what it does, who uses it, its API, how users sign in). Not in its
   folder? Ask the owner for the project's path or a few lines about it.
2. Propose what goes first and wait for a yes: an MCP server and a CLI for a business or developer
   product (SaaS, B2B, a dev tool); a WhatsApp and iMessage agent, plus the MCP server and CLI, for a
   consumer app. Ask what to call the agent in the same message.
3. `npx @flow-engineer/flow@latest new <name>-agent --display-name "<name>"` beside the product's
   code (never inside its package), then `npm install` there.
4. Read the skills as files, `.claude/skills/<skill>/SKILL.md` in that folder: `flow-framework`,
   `flow-framework-context`, `flow-framework-tools`, `flow-framework-auth`, `flow-framework-tests`.
5. Replace the café with the product: context, tools, `agent/AGENTS.md`, sign-in, then check it
   (`npx @flow-engineer/flow check`, `npm run mcp` with `flow inspect`, and the phone below).

## MCP and CLI first

After creating the project and running `npm install`, start the server with `npm run mcp`.
In another terminal, use `npm run cli -- --help` and `npm run cli -- menu --json`. The starter
prints the MCP URL and a command to connect Claude Code. These tool calls need no model key or
Flow account. Replace the café tools and configure account sign-in when needed.

For remote hosts such as Claude or ChatGPT, expose the server over HTTPS and connect its URL in
the host. Generating a plugin does not publish it to a directory; follow the host's installation
or review flow. See [MCP servers](https://docs.flow.engineer/framework/mcp),
[plugins](https://docs.flow.engineer/plugins) and [CLIs](https://docs.flow.engineer/cli).

## Messaging setup

For phone testing, `link` sets up the keys and an outbound event stream, with no tunnel or public
URL needed on the developer's laptop. For the chat agent, it can also supply a trial model key.

```sh
npx @flow-engineer/flow init --display-name "FlatX agent"   # the starter in this (empty) folder; ask the owner what to call it first
npm install
npx @flow-engineer/flow link --channel telegram --json   # or whatsapp, imessage: signs in and sets up if needed (the keys, Flow's trial model key among them), then prints the phone link
npm start                                           # after link: keep it running; the playground link it prints, and the phone link reaches it
npx @flow-engineer/flow status --json               # any time: what the folder has and lacks
printf 'hi\nA latte please\n' | npx @flow-engineer/flow chat   # your own check: talk to it locally, one message per line
```

Before `init` (or `flow new <folder>`), ask the owner what people should call their agent, such as
"FlatX agent", and pass it as `--display-name`. It is kept as `displayName` in `package.json`, and
the message their phone sends to reach the agent is `Hi FlatX agent (ref <code>)`. The name takes the
starter's (Pip) place in the agent's prompt, `agent/AGENTS.md`, and the playground and MCP server
read it from `package.json`. To rename an agent made already, `link --display-name "<name>"` (or
`setup --display-name`) changes both; restart `npm start` after it. Without the flag, `init` asks in
a terminal and otherwise uses the folder's name in words.

`npm start` listens on `PORT`, else 8788: with 8788 taken and no `PORT` set it takes the next free
port and says so, and the playground link it prints has the port it uses. With `PORT` set to a port
that is taken it prints one line, `Port 8788 is in use. Run: PORT=8798 npm start`, and exits 1.
`npm run mcp` does the same with `MCP_PORT` (else 8790).

## How the owner tests it

Match the way they test to the interface they are building. For MCP, connect the server in their
chosen host and try a real product request. For a CLI, show its help and a command that reads data.
For a plugin, install the generated package in the host and exercise its tools and skills.

For a messaging agent, recommend these, in this order:

1. **The playground in the browser**: `npm start`, then open the link it prints. The test people
   (`testPeople`; Maria, Sam and Priya in the starter) and the channels are side by side, and
   **Debug** shows each tool call and how fast each message was answered.
2. **Their phone**: the link from `link` (`say_to_person` in `link --json`), while `npm start` runs.
   It is the channel's own link (`url`): `https://t.me/<bot>?start=<code>` (press Start),
   `https://wa.me/<number>?text=...` or, for iMessage, `sms:<number>?&body=...` (an iPhone or a Mac),
   each with `Hi <displayName> (ref <code>)` filled in (`join_message`). `page` is the same on
   flow.engineer, for a computer without that app.

`flow chat` and `npm test -- --synthetic` (the test cloud) are for you, to check your own work
before you hand it back; run them yourself, and do not offer them to the owner as ways to test.

- The model key: a provider key is optional. `setup` (which `link` runs; alone it needs `login`
  first) writes `FLOW_KEY`, the agent's one Flow key, into `.env` (printed only as its prefix and
  last 4, `FLOW_KEY=flow_test_…abcd  added`; never read or print its value): with no provider key
  the agent calls models through Flow with it, on the account's \$2 of Flow trial credit (printed as
  `Model: Flow trial credit ($1.87 left)`). The owner may add their own: one of `OPENROUTER_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` in `.env` wins over `FLOW_KEY` for the model
  (to switch back, empty that line), and a key they set is never written over. When the credit is
  used up, a model call fails with code `trial_credit_used` (`trial_credit_unavailable` when the account gets none) and the next step: add your own key. With no key, `chat` and `npm start` stop with one sentence and
  `Next: run npx @flow-engineer/flow setup to get Flow's free trial credit, or add your own key.`
  (`chat --json`: `{"error":{"code":"no_model_key","message":...,"next":"npx @flow-engineer/flow setup"}}`),
  and `init`, `setup`, `link` and `status` say so too, with the way to get one first in `next`.
  Each folder's `setup` makes its own `FLOW_KEY` (the credit is the account's);
  `setup --rotate key` replaces a leaked one (the old one works 24 h more; `--now` ends it at once).
- `setup --workspace <name|acc_id>` (and `link --workspace`) puts the agent, its cloud and traces keys in
  that observe workspace of yours and keeps its `acc_` id in `.env` as `FLOW_FRAMEWORK_WORKSPACE`, which later
  runs send; another workspace makes those two keys again (403 `not_a_member`, 409 `workspace_ambiguous`: pass the id).
- `status` reports `FLOW_KEY` and the model key (never their values; `flow_key.set` in `--json`; with
  `FLOW_KEY` the model's key, the credit left from Flow, `model_key.flow_credit`; a key Flow does not
  know gets `setup --rotate key`), the workspace (`FLOW_FRAMEWORK_WORKSPACE`, else `personal`), the sign-in, each channel's sender in `.env`
  and, signed in, which channels are open now with their trial counts. It writes nothing.
- `chat` builds the agent from `src/agent.ts` and writes as its first test person. Each reply is
  printed (`agent: ...`) once the turn is over; `--json` gives one JSON line per thing it sends.
- `link` does the rest when the folder is not set up (no `FLOW_FRAMEWORK_JOIN_CODE` or
  `FLOW_MESSAGING_KEY` in `.env`, or no sender for the WhatsApp or iMessage link asked for): it
  runs `login` (opens the owner's browser itself and prints the link and code at once), then
  `setup` (writes the keys and each open channel's sender into `.env`, and the chosen channel's
  page as `FLOW_FRAMEWORK_TRY_URL`), then prints the link and that channel's free-trial line only.
  `--channel telegram|whatsapp|imessage` picks the channel (Telegram by default). Run it in the
  agent's folder: `setup` and `link` refuse a folder with no `package.json` (`not_an_agent_folder`).
- A channel that is not open yet is said once ("iMessage isn't open yet; here are your Telegram
  and WhatsApp links"), with the open channels' links, and exits 0: `link --json` then has
  `not_open` (the channel asked for), `links` (each open channel's) and `url`/`channel` for the
  first of them. Only when no channel is open does it exit 3 (`channel_not_open`).
- Texting needs only Flow Messaging's part of setup (and a model key). When setup's answer has it
  (the join code, the Messaging key and senders) but observe's part failed (traces and the test
  cloud: `observe_failed`, or observe's own limit), `link` prints one warning line on stderr,
  `Traces and tests won't work until .env has FLOW_FRAMEWORK_CLOUD_KEY and FLOW_FRAMEWORK_TRACES_KEY: <the server's reason>. Then: <its next>`,
  then the link, the channel's trial line and its `Next:`
  as usual, and exits 0; `link --json` has the line in `warnings`, on setup's line and on its own.
  Give it to the owner; `setup` makes the missing keys once it is fixed. Run again, `link` finds
  Messaging's part in `.env` and does not run setup. `setup` on its own still exits 3 for it.
- On WhatsApp and iMessage the agent can only reply after the owner writes first (WhatsApp: within
  24 hours of their last message); it cannot message them first. `link --json` says so
  (`reply_only: true`, and in `say_to_person`): tell the owner.
- The starter's `npm start` is on Telegram, plus WhatsApp and iMessage when `.env` has their senders
  (`FLOW_MESSAGING_WHATSAPP_SENDER`, `FLOW_MESSAGING_IMESSAGE_SENDER`), and reads `.env` once.
  `npm start` marks itself running in `.flow/running.json`, so `link` ends with the step that fits:
  `Next: npm start, then send the link above` when it is not running; when it is,
  `Next: restart npm start (it runs at <url> and lacks iMessage), then send the link above` if `link` just wrote `.env`
  or renamed it, else `Next: send the link above (npm start is running at <url>)` (`link --json`:
  `running`, `false` or `{"url"}`, and `next`). `setup` alone says "If npm start is running, restart it to add
  iMessage."
- Give the owner `say_to_person` from `link --json`, and the sign-in link and code from the
  `pending` line while you wait.
- `npm start` connects to Flow Messaging by an outbound event stream. Messages sent while it was
  stopped arrive when it starts again (for as long as Flow keeps events, 30 days by default).

## Exit codes (login, setup, link)

`status` exits 0 whatever it finds (1 for a wrong flag): read its fields.

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | Go on |
| 1 | Usage, not signed in, not an agent's folder, or a login URL that is not https | Fix the command, or run `next` |
| 2 | flow.engineer could not be reached, or did not answer in time (`timeout`) | Try again |
| 3 | Refused: denied, expired, a product failed (for `link`, only when Messaging's part did: observe's alone is exit 0 with a warning), no channel open yet (one closed while others are open is exit 0 with their links), a server with no CLI sign-in (`server_unsupported`), or a free-trial limit (`sandbox_allowance_used`, the iMessage people cap; HTTP 403) | Run `next`; for a trial limit `next` is a sentence: give it to the owner as it is |
| 4 | Sign-in still waiting for the owner's approval, or flow.engineer asked to wait (`slow_down`, HTTP 429) | Approval: ask the owner to approve, then run `next` (the same code is kept). `slow_down`: wait `retry_after` seconds (printed as `Wait <n> s`), then run `next` |

`login` and `link` wait at most `--timeout` seconds (120 by default) before exit 4, and no single
request waits longer than 30 s. `login --wait` (or `link` again) goes on with the same code: no new
code and no new browser tab. flow.engineer decides when a code has expired (an approved one can be
collected a while after its `expires_in`); a waiting code that has expired is replaced by one new
sign-in, and so is a code from another login URL.

## The `next` lines

Every error is `{"error":{"code","message","next"}}` on stdout with `--json`, and
`<message> Next: <next>` on stderr. A waiting sign-in is `{"status":"pending",...,"next":...}`.
`next` is the exact command or URL to run; when it came from flow.engineer it is the server's.
A run gives one `next`: `setup --json`'s is a list in order (a model key first when there is
none, then `npm start` for the playground, then `link` for the phone); inside `link` setup's line
has none, and `link`'s `next` is one string (a model key first when there is none, then starting or
restarting `npm start`); an error's `next` replaces it.
Run it, or give it to the owner when it needs them (a browser approval, a page to open). A
`slow_down` error also has `retry_after` (seconds, or `null` when the server gave none). A
trial limit's `next` is a sentence, not a command: it is printed on its own line as it came; pass
it on to the owner unchanged.

flow.engineer may add `warnings` (up to 20 lines) to any setup answer. Each is printed on its own
line on stderr; with `--json` setup's line has `warnings` (an empty list when there are none), and
an error line has it when there were any. Pass them on to the owner.

`setup` also shows the free trial: messages used per channel, and on iMessage the people it may
reach (`iMessage: 1 of 2 people`; `trial.imessage.contacts` `{limit, used}` in `--json`).

`chat` exits 1 for anything that stops it before the first message: `no_model_key`, `no_agent`
(no `src/agent.ts`), `not_built`, `no_test_people`, `no_channel`; with `--json` as
`{"error":{"code","message","next"}}` on stdout.

## Keys

- Never ask the owner to paste a key into the chat, and never print, read aloud or commit `.env`.
  `setup` writes the keys itself and prints only their last 4 characters.
- The model key: Flow's trial key from `setup`, or the owner's own, typed into `.env` themselves.
- `setup --rotate cloud,traces,messaging,model` (or `all`) makes those keys again and replaces
  their lines in `.env`.
- `setup` keeps every value already in `.env` (`--replace` takes the new ones), but a name there
  with no value (`cp .env.example .env`) counts as missing and is filled on its own line. Keys
  flow.engineer made are written even when the rest of setup fails, since they are shown only once.
  `.env` is set to mode 0600.
- The sign-in token goes only to the server that issued it, over https (http only to localhost):
  with `FLOW_FRAMEWORK_LOGIN_URL` naming another server, commands stop with `signed_in_elsewhere`.
- CI never signs in: `npx @flow-engineer/flow setup --ci` says how to give it the test cloud key.

## Messages the business starts

A nudge, a scheduled message or any turn the person did not start goes with link previews off
(`preview: false` on the message; Flow Messaging's WhatsApp `preview_url: false`): on WhatsApp a
preview card's title becomes the phone's notification instead of the message's text. For a call to
action use `link` (`agent.nudge({ to, text, link: { label, url } })`, or the agent's send with
`link`), not a URL in the text.

When the business's backend should tell people what happened (an order shipped, an item is back),
mount `flowEvents` instead of writing a route: one signed `POST /v1/events`, each event sent by its
delivery level (critical at once, standard after quiet hours, optional merged or dropped), with the
agent's own wording checked against the template's values. The envelope, signing, answers and a
mounting sample are in `docs/events.md` in the package
(https://github.com/flow-engineer/flow/blob/main/docs/events.md).

## Shared test numbers and privacy

The free trial runs on Flow's shared Telegram bot, WhatsApp number and iMessage line. Sending an
agent's join message (`Hi <name> (ref <code>)`, what the link fills in) binds that phone to that
agent's app on the shared sender, so the person's messages go only to that app; sending another
app's join message moves them there. Trial chats are
test data, kept for the account's retention (30 days by default). Do not use the trial for real
customers' data: connect your own number for that.

## Stability

Flow Framework is 0.x. Existing commands, `--json` fields and exit codes remain compatible;
a breaking change requires a minor version bump and a migration note. Pin the version in
`package.json` for production.

## Host it

`npx @flow-engineer/flow deploy` puts the agent on Flow's hosting, so it answers while the laptop
sleeps. It needs `package.json`, `package-lock.json` and `src/agent.ts`, whose `buildAgent` passes
`options.host` to `createAgent` as `host: options.host` (never spread into its options), and the agent's CI key in `FLOW_FRAMEWORK_CLOUD_KEY` (the
environment, else `.env`; `flow setup` writes it).

One command deploys, the first time included:

```sh
npx @flow-engineer/flow deploy
```

It sends the `.env`'s values as the agent's secrets, then builds and follows it to live. The rest:

```sh
npx @flow-engineer/flow deploy [--env staging|production] [--version <v>] [--no-secrets] [--json]
npx @flow-engineer/flow deploy promote [--no-secrets] [--json]
npx @flow-engineer/flow deploy status [--env staging|production] [--json]
npx @flow-engineer/flow logs [--env staging|production] [--since 1h] [--follow] [--json]
npx @flow-engineer/flow deploy secret NAME [--env staging|production] < value.txt
npx @flow-engineer/flow deploy secrets --from-env [<file>] [--env staging|production] [--json]
```

- `deploy` first sends each non-empty value in the agent's `.env` as a secret for that
  environment, before the service starts, so the first live version has its keys: never the CI
  key, the cloud's address or a name Flow sets itself (`FLOW_FRAMEWORK_TRACES_*`, `FLOW_STORE_*`,
  `PORT`, ...). Later deploys send only the new or changed ones (`.flow/secrets.json` keeps a hash
  per name, never a value). It prints the names it sent, never values; `--no-secrets` sends none.
  A secret the host refuses stops the deploy before it starts, naming it.
- `deploy` packs the folder (without `node_modules`, `.git`, `.env*` and `.flow`, at most 50 MB),
  uploads it, and follows the build until it is live, refused or failed. The default is staging;
  production refuses an agent that ignores `host` or brings its own database, and the build
  refuses an agent on a newer framework than Flow hosts yet. `--json` prints
  `{ ok, deploy: { id, environment, status, version, findings, error }, url, next }` on stdout
  (`url` is null when the cloud does not say it yet; the human output then says "URL: not available
  on this Flow yet"); progress goes to stderr. The deploy's id is kept in `.flow/deploys.json`. The
  version is the folder's git commit, `<sha>+dirty` (with a warning) when the folder has
  uncommitted changes, since what is packed is the folder as it is; `--version` names it yourself.
- `promote` moves staging's live version to production, with no new build. Production keeps its
  own secrets: promote sends the `.env`'s new or changed values there first (`--no-secrets` sends none).
- `status` shows, per environment (both unless `--env`), the deploy serving it (`status`, `version`,
  `id`, `updated_at`), its URL and a newer one still building. `--json` prints
  `{ ok, environments: { staging: { deploy, pending, url, from } | null, production: ... }, next }`;
  `from` is `list` (the cloud's list) or `this_folder` (the last deploy from `.flow/deploys.json`, on
  a Flow whose cloud does not list deploys to a CI key yet).
- `logs` prints the hosted agent's log lines from `--since` (30s, 15m, 1h, 2d; default 1h), and with
  `--follow` keeps printing new ones; `--json` is one `{ time, severity, text }` per line. On a Flow
  whose cloud has no logs route yet it says so: `error.code` `not_available`, exit 1.
- `secret NAME` (one value from stdin) and `secrets --from-env` (every value in a file, now) are for
  changing a secret by hand; `deploy` already sends the `.env`. `--json` prints
  `{ ok, environment, saved, skipped, refused, next }`. Before the agent's first deploy the host has
  no agent to keep them for: they are refused, exit 1, and `next` is `deploy`. A secret takes effect
  on the next deploy.
- Exit codes: 0 live or saved, 1 refused, failed or not reachable, 2 a usage problem (no CI key, a
  missing file, a bad name). On an error, `--json` prints `{ ok: false, error: { code, message }, next }`.

Run each answer's `next`. Promote, or deploy to production, only when the owner says so.
