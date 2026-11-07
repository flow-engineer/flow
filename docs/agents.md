# Flow Framework for coding agents

The published guide is at https://flow.engineer/docs/agents: that is the link to give.

You are building or changing a Flow project for a person (the owner): tools and skills exposed
through an MCP server (Claude, ChatGPT, Cursor, Codex), plugins, a CLI or a messaging agent on
WhatsApp, iMessage, Telegram, SMS or their own app. Start with the interfaces the owner needs.
Every command here runs without a terminal and never reads stdin, except `chat`, which reads the
messages you pipe to it, and `projects delete`, which asks for the project's name in a terminal
(without one it needs `--yes`).

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
4. Read `.claude/skills/flow-framework/SKILL.md` for setup and routing. Then load only the relevant
   skills: `flow-framework-build-agent` for messaging runtime and operations, `flow-framework-mcp` for
   MCP, CLI and plugins, and the context, tools, auth or tests skills when those tasks apply.
5. Replace the café with the product: context, tools, `agent/AGENTS.md`, sign-in, then check it
   (`npx @flow-engineer/flow check`, `npm run mcp` with `flow inspect`, and the phone below).

## MCP and CLI first

After creating the project and running `npm install`, start the server with `npm run mcp`.
In another terminal, use `npm run cli -- --help` and `npm run cli -- menu --json`. The starter
prints the MCP URL and a command to connect Claude Code. These tool calls need no model key or
Flow account. Replace the café tools and configure account sign-in when needed.

For remote hosts such as Claude or ChatGPT, expose the server over HTTPS and connect its URL in
the host. Generating a plugin does not publish it to a directory; follow the host's installation
or review flow. See [MCP servers](https://flow.engineer/docs/framework/mcp),
[plugins](https://flow.engineer/docs/plugins) and [CLIs](https://flow.engineer/docs/cli).

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
the message their phone sends to reach the agent is `Join FlatX agent (ref <code>)`. The name takes the
starter's (Pip) place in the agent's prompt, `agent/AGENTS.md`, and the playground and MCP server
read it from `package.json`. `init` names the package, its CLI command and its MCP server after it
(`flatx-agent`), or after `--name <name>` when given, else after the folder. To rename an agent made already, `link --display-name "<name>"` (or
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
   each with `Join <displayName> (ref <code>)` filled in (`join_message`). `page` is the same on
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
- With a test traces key (`otk_test_`, the Staging dashboard), `setup` also writes
  `FLOW_FRAMEWORK_TRACES_CONTENT=1` below it, under a comment saying it sends message text there
  and that 0 sends metadata only, so playground and phone chats can be read and graded. It never
  does for a live key, or when `.env` already has the line (any value, also as
  `CHINWAG_TRACES_CONTENT`), and only in the run that writes the key: a later run that keeps the key
  does not put back a line the owner deleted (to keep content off across `--rotate traces`, set it to 0).
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
- On iMessage the agent can reply after the owner writes first, any time later. On WhatsApp it can
  reply within 24 hours of the owner's last message. On both it cannot message them first. `link --json` says so
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
| 3 | Refused: denied, expired, a product failed (for `link`, only when Messaging's part did: observe's alone is exit 0 with a warning), no channel open yet (one closed while others are open is exit 0 with their links), a server with no CLI sign-in (`server_unsupported`), or a free-trial limit (`sandbox_allowance_used`; HTTP 403) | Run `next`; for a trial limit `next` is a sentence: give it to the owner as it is, with the plans link ([Paid plans](#paid-plans)); do not retry |
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

`setup` also shows the free trial: the people on each channel and those waiting for a place. The
counts are the account's, shared by all its agents, so a brand-new agent can show people already
(`your account's free trial, across all its agents: 3 of 25 people, 2 waiting for a place`;
`account_trial.<channel>` `{limit, used, held}` in `--json`, and in `status --json` each channel's
`account_trial`; `trial` is the older name of the same object, kept for a release). A person past the limit is held: their messages are kept, not delivered, and reach the
agent once a place frees up (a contact removed) or the owner buys a paid plan. An older flow.engineer counts messages instead (`3 of 300 messages used`, no
`held`), and on iMessage the people it may reach (`iMessage (your account's free trial, across all its agents): 1 of 2 people`, `account_trial.imessage.contacts`).

### Paid plans

The free trial takes 25 people per channel in all. More is a paid Flow Messaging plan, which only
the workspace owner buys, self-serve, at https://flow.engineer/dashboard/plans (the Plans dialog
in the Flow dashboard; `?plan=shared` or `?plan=dedicated` opens it on that plan):

- **Shared**, $25/month: more people on Flow's shared lines (300 a month and 200 a day per
  channel), with live keys, live at once.
- **Dedicated**, $100/month: your own iMessage number, 1,000 people a day, SMS/RCS fallback and
  call forwarding. Flow reviews it before ordering, usually within a day.
- **Outbound** add-on, +$40/month: the agent messages people first.

`setup`, `link` (for its channel) and `status` add one line, by rule, once a channel's trial has
80% of its people (`Next: the free trial is nearly full on Telegram. More people or your own
iMessage number: Shared $25/month or Dedicated $100/month, at https://flow.engineer/dashboard/plans
(the workspace owner buys it).`), and once it is full or holds anyone, the Shared plan's link:

```
Next: the free trial is full on Telegram, so new people wait for a place (2 waiting now). More people: Shared $25/month, or Dedicated $100/month with your own iMessage number, at https://flow.engineer/dashboard/plans?plan=shared (the workspace owner buys it).
```

With `--json` it is `plans` (`{"url", "message"}`, else `null`). Give the line and its link to the
owner: running `setup` again or retrying does not make room. A live key whose plan ended is
refused with `channel_code` `plan_ended` (the event stream stops, a send fails); Flow's `hint`
says where to choose a plan again (the adapter logs it, and `stopped` carries it): show the owner
the hint and the plans link rather than retrying. Test keys keep working meanwhile.

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
- `setup`'s Flow key is a test key (`flow_test_`), which reads staging. To read production and
  Insights, the workspace's owner runs `npx @flow-engineer/flow setup --live` once (0.16.0 on): it
  writes `FLOW_LIVE_KEY`, de-identified unless `--content`, for 30 days, ending after 7 days
  unused, and messaging no customer and deploying nothing live. `flow keys` lists this folder's
  agent's live keys (`--all` every agent's on the account, `--agent <name>` one agent's), `flow keys show <kid>` one key's checklist, `flow keys revoke <kid>` ends one, and
  `flow keys grant <name>` asks for more by tier ([Read production with a live
  key](https://flow.engineer/docs/hosting#read-production-with-a-live-key)).

## Projects

```sh
npx @flow-engineer/flow projects list --json                       # every project in your workspaces: id, name, workspace, created_at, owner
npx @flow-engineer/flow projects delete <name|id> --yes --json     # only when the owner has said to delete that project
```

`list` takes `--workspace <acc_id>` to keep to one workspace; `owner` says whether this account
may delete the project (only the organization's owner can). `delete` matches a name exactly
(case-sensitive) and refuses a name two projects share (`ambiguous_name`, with each one's id and
workspace in `matches`: pass the id). A deleted project's keys stop working at once; the Flow team can bring it back until
`restore_until` (30 days). In a terminal it asks for the name to be typed; without one it needs
`--yes`. Never pass `--yes` without the owner's word for that project.

Exit codes: 0 done; 1 usage, not signed in (`not_signed_in`: run `next`), no such project
(`not_found`), `ambiguous_name`, or not confirmed (`confirm_needed`, `not_confirmed`); 2
flow.engineer could not be reached or could not reach its projects (try again); 3 refused:
`owner_only`, or the sign-in ended (`signed_out`: run `next`).

## Videos people send

The agent reacts 👀 to a video the moment it arrives, before it is downloaded or watched, and the
turn that answers it shows no typing: the 👀 says it is on it, and the reply follows once the agent
has seen or read the video. It is on by default; `createAgent({ videoReaction: false })` turns it off,
and the video then types on arrival, kept up while it is described (on WhatsApp, with the blue
ticks, which Flow Messaging sends with typing; with the reaction the blue ticks go on arrival by
themselves). On Telegram 👀 is one of the reactions Telegram lets bots use; another emoji you pass must
be one too. On iMessage, iOS 18 and later show 👀 as a reaction; older iPhones may show it as a line of
text. Where the channel has no reactions (SMS) or the reaction fails, that turn types instead.
Photos, voice notes and documents type on arrival as other messages do.

A video reaches the agent one of three ways: watched by its model (`openAICompatible({ videos: true })`),
described once (`createAgent({ describeVideo: describeVideoWith("google/gemini-3.8-flash") })`), or
named as one it can't watch. With a describer that has `ask` (describeVideoWith's does) or a model
that watches videos, the agent also gets `ask_about_video` for a video it can't see now, such as
"is there a scratch near the charging port?" about a video described earlier, or one its model saw
several turns ago (only the latest 3 photos, PDFs and videos, one of them a video, stay shown):

- Input: `question`, and `message`, the id of the message the video came in (`m3`, `msg_...`); the
  latest video when left out. Its result is `{ video, answer }`.
- The video is fetched again from its channel by the attachment's `ref` (Flow Messaging's file id)
  each time, up to 10 MB, and never kept. Once the channel no longer keeps it, the agent is told
  to ask for it again.
- 3 questions a turn and 10 a video; every failure is a `ToolError` the agent reads, and an
  `attachment.failed` event (`kind: "video"`, `messageId`).
- Under `flow test`, a scenario sends one with `attach: { kind: video, file: fixtures/clip.mp4 }`, and
  `expect: { calls: [ask_about_video] }` checks the agent asked.

## Messages the business starts

A nudge, a scheduled message or any turn the person did not start goes with link previews off
(`preview: false` on the message; Flow Messaging's `link_preview: false`): on WhatsApp a
preview card's title becomes the phone's notification instead of the message's text. For a call to
action use `link` (`agent.nudge({ to, text, link: { label, url } })`, or the agent's send with
`link`), not a URL in the text.

When the business's backend should tell people what happened (an order shipped, an item is back),
mount `flowEvents` instead of writing a route: one signed `POST /v1/events`, each event sent by its
delivery level (critical at once, standard after quiet hours, optional merged or dropped), with the
agent's own wording checked against the template's values. Once `events.attach(agent)` ran, the
agent's tools reach it as `context.events` (other code as `agent.events`): a tool that keeps what
a person watches saves it there, in the state of the agent it runs for, never in a module
variable. The envelope, signing, answers and a mounting sample are in `docs/events.md` in the
package (https://github.com/flow-engineer/flow/blob/main/docs/events.md).

## The agent's own records

What the agent must remember across days and people, and nothing else reads (a buyer's question
relayed to a seller, waiting for the answer), it keeps as records: small JSON documents in
collections declared on `createAgent`, in the same store as its conversations. They survive
restarts and deploys, and behave the same in the playground and the test cloud (each with an empty
store of its own), self-hosted (the agent's SQLite or Postgres) and on Flow's hosting, per agent
and per environment.

```ts
const agent = createAgent({
  // ...
  records: { questions: { people: ["buyer", "seller"], fields: ["listing", "status"] } },
});

// In a tool: context.records. Outside a turn (a route, beforeSend, intercept): agent.records.
await context.records.put("questions", id, { listing, buyer: context.person, seller, status: "waiting", askedAt: Date.now() });
await context.records.get("questions", id);                              // the value, or null
await context.records.query("questions", { seller, status: "waiting" }); // [{ id, value, createdAt, updatedAt }]
await context.records.delete("questions", id);
```

**What goes where: if anything other than the agent reads it, it belongs in your own database.**
Records are the agent's working memory: read by id, or matched by equality on the fields a
collection declares (`people` and `fields`), oldest first (by when each was first put, then id),
50 at a time (`{ limit, after }`: up to 100, `after` the last entry of the page before). No
ranges, sorting, joins, search or transactions across records; a put replaces the whole value.

- `people` are the top-level fields that hold a person, as a string: their `context.person`
  (`phone:+15550100100`, `key:<your id>`, `<channel>:<address>`). `agent.forgetPerson` deletes,
  with everything else about them, every record that names them there (by that id, their
  conversation id, any identity as `<channel>:<address>`, or their number in E.164 on a phone
  channel, also when their key is `key:...`; never a bare chat id, which another channel may
  use); `agent.records.forgetPerson(person)` does it for someone who never wrote. A tool of
  theirs still running when they are forgotten cannot put a record after it: the put is refused
  saying they were forgotten.
- A field added to a collection's `people` or `fields` counts for the records already kept from
  the agent's next start: it indexes them again before anything runs, so `query` and forgetting
  find them. A value the new declaration refuses (a person field holding a number) is kept, left
  out of the index. The store keeps every field ever declared for a collection and keeps indexing
  it (a person field if any declaration said so), so an older declaration on the same store (a
  deploy's old revision, a stale checkout running `flow records export`) takes nothing away, and
  what it puts is indexed for the newer fields too.
- Values are plain JSON: no Dates (a time is milliseconds or ISO text), NaN, Maps or class
  instances; keys whose value is undefined are left out. A declared field holds a string (at most
  256 characters), a number, a boolean or null; `1` and `"1"` differ.
- Limits (`RECORD_LIMITS`): 64 KB a record as JSON, 10,000 records an agent (per environment), 20
  collections, 8 declared fields each, ids of at most 128 characters. A put past one is refused
  saying what to change. The count of records takes no lock, so new ones put at the same moment
  may pass 10,000 by up to as many as are put at once.
- `npx @flow-engineer/flow records export` prints every record of the agent in the folder (the
  store its `buildAgent` opens) as JSON Lines; in code, `for await (const r of
  agent.records.export())`. Put them into another store with `agent.records.put(r.collection,
  r.id, r.value)`: each gets a new `createdAt` and `updatedAt` there (the time of that put), so
  put them oldest first, as export gives them, to keep their order.
- A follow-up at a time is not a record: a wake-up (below) gives the agent a turn then, and that
  turn reads the records.

## The agent's own wake-ups

When the agent must look at something later and no one will write (24 hours after a buyer's
question, check whether the seller answered), it sets a wake-up: a row in its store, never a timer
in memory, so it survives restarts and deploys and runs once with several runners. At its time the
agent gets a turn in that person's conversation with its note, `[Wake-up you set for yourself, not
from the person: <note>]`, and decides: look something up, message them, call a tool that tells someone else, or
nothing. **A wake-up never sends anything by itself.**

The model has `wake_me_up({ note, in_minutes | at, key? })` and `cancel_wake_up({ id })` built in,
for its own conversation only, and every turn shows it the wake-ups it set there
(`createAgent({ wakeUps: false })` takes both away; wake-ups your code sets still run). Code sets
them too:

```ts
// In a tool, for this person: context.wakeUps (absent outside a conversation, such as over MCP).
await context.wakeUps?.add({ inMs: 24 * HOUR, note: `check question ${id}; if it still waits, remind the seller`, key: `remind:${id}` });
// The seller answered, in their own conversation: cancel by key, whoever the wake-up is for.
await context.wakeUps?.cancel(`remind:${id}`);   // resolves to how many
await context.wakeUps?.list();                    // this person's, soonest first

// Outside a turn (a route, your backend's event), by a channel identity they wrote from:
await agent.wakeUp({ to: { channel: "whatsapp", address: buyer }, at: askedAt + 2 * DAY, note: `close question ${id} if it still waits, and tell them`, key: `close:${id}` });
await agent.cancelWakeUp(`close:${id}`);
await agent.listWakeUps({ channel: "whatsapp", address: buyer });
```

- `add` and `wakeUp` resolve to `{ status: "scheduled", wakeUp }`, `{ status: "exists", wakeUp }`
  (an active wake-up of that person's already has the key: that one, unchanged; once it ran or was
  cancelled the key is free again), or `{ status: "refused", reason }` (`too_many_for_person`,
  `too_many_for_agent`, `unknown_person` for someone who never wrote). A note that is empty or
  too long, or a time under a minute away or more than 90 days ahead, throws.
- It keeps the person's rules: due in their quiet hours, it waits for them to end
  (`respectQuietHours: false` runs it at its time, for work that messages no one). After they
  texted STOP, or while they paused messages, it still runs so the agent can do its work (close
  the question in your system), but the note says so and Flow refuses every send to them in that
  turn until they write. Past their
  WhatsApp 24-hour window it still runs, and the agent is told only a template reaches them
  (`send_template` when templates are declared); no fallback template goes by itself.
- Found late (the agent was down), it still runs, and the note says when it was due: unlike a
  scheduled message, which is missed rather than sent late.
- Limits (`WAKE_UP_LIMITS`): 10 active per person, 10,000 per agent (per environment), 90 days
  ahead, notes of 500 characters, keys of 200. The model is told plainly when it hits one.
- A nudge sent with `at` is cancelled the same way, by its idempotency key, while it is still to
  come: `await agent.cancelNudge("session-1")` resolves to its state, `cancelled` (null for a key
  no nudge has; one that went keeps its state).
- `agent.forgetPerson` deletes their wake-ups with everything else. The playground's Person tab
  lists them beside scheduled messages, and moving its clock brings them due; in `flow test`, a
  business run's `wait` does the same.

## Shared test numbers and privacy

The free trial runs on Flow's shared Telegram bot, WhatsApp number and iMessage line. Sending an
agent's join message (`Join <name> (ref <code>)`, what the link fills in) binds that phone to that
agent's app on the shared sender, so the person's messages go only to that app; sending another
app's join message moves them there. The agent gets the text before `(ref` as the person's first
message (`Join <name>`; Telegram's Start sends `/start`); an older `Hi <name> (ref <code>)` still
joins. Trial chats are
test data, kept for the account's retention (30 days by default). Do not use the trial for real
customers' data: connect your own number for that, or, for iMessage, the Dedicated plan's own
number ([Paid plans](#paid-plans)).

## Stability

Flow Framework is 0.x: until 1.0, the commands, `--json` fields and exit codes in this guide (and the
rest of its API) may change between releases. Every release's notes call out each breaking change
with a migration note saying what to change. The API freezes at 1.0. Pin the exact version in
`package.json` for production, and read the notes before you move it. What freezes at 1.0:
[stability.md](stability.md).

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
npx @flow-engineer/flow deploy restart [--env staging|production] [--json]
npx @flow-engineer/flow logs [--env staging|production] [--since 1h] [--until <t>] [--severity WARNING] [--grep <text>] [--limit n] [--follow] [--json]
npx @flow-engineer/flow conversations [--env staging|production] [--grade wrong|unhelpful|good] [--since 24h] [--limit n] [--contact <label>] [--json]
npx @flow-engineer/flow conversations show <id> [--env staging|production] [--json]
npx @flow-engineer/flow issues [--status open|resolved|ignored|all] [--json]
npx @flow-engineer/flow issues test-case <id> [--json]
npx @flow-engineer/flow insights [--days 7|30] [--status open|fixed|muted|all] [--json]
npx @flow-engineer/flow insights show <finding> [--days 7|30] [--json]
npx @flow-engineer/flow deploy secret NAME [--env staging|production] [--apply] < value.txt
npx @flow-engineer/flow deploy secret --unset NAME [--env staging|production] [--json]
npx @flow-engineer/flow deploy secrets --from-env [<file>] [--env staging|production] [--json]
```

- `deploy` first sends each non-empty value in the agent's `.env` as a secret for that
  environment, before the service starts, so the first live version has its keys: never the CI
  key, the cloud's address, what `setup` and `link` write for the CLI alone
  (`FLOW_FRAMEWORK_JOIN_CODE`, `FLOW_FRAMEWORK_TRY_URL`, `FLOW_FRAMEWORK_WORKSPACE`) or a name Flow
  sets itself (`FLOW_FRAMEWORK_TRACES_*`, `FLOW_STORE_*`, `PORT`, ...). The
  `FLOW_MESSAGING_<CHANNEL>_SENDER` ids are sent: the hosted agent starts conversations from them.
  A live Flow key (`fk_live_`, `flow_live_`, `otk_live_`) is never sent to staging: it is skipped
  with why (naming only its prefix), staging keeps the value it has, and Flow's hosting refuses it
  too. A test key sent to production goes, with a warning. `FLOW_KEY` goes to both: the host
  exchanges it for the environment's own runtime key.
  An earlier deploy may have sent those three CLI names; they are harmless, and
  `npx @flow-engineer/flow deploy secret --unset FLOW_FRAMEWORK_JOIN_CODE --env staging` removes one.
  Later deploys send only the new or changed ones (`.flow/secrets.json` keeps a hash
  per name, never a value). It prints the names it sent, never values; `--no-secrets` sends none.
  A secret the host refuses stops the deploy before it starts, naming it.
- `deploy` packs the folder (without `node_modules`, `.git`, `.env*` and `.flow`, at most 50 MB),
  uploads it, and follows the build until it is live, refused or failed. The default is staging;
  production refuses an agent that ignores `host` or brings its own database, and the build
  refuses an agent on a newer framework than Flow hosts yet. `--json` prints
  `{ ok, deploy: { id, environment, status, version, findings, error }, url, next }` on stdout
  (`url` is null when the cloud does not say it yet; the human output then says "URL: not available
  on this Flow yet"); progress goes to stderr. The deploy's id is kept in `.flow/deploys.json`. The
  version is the agent's version, the label its traces and `flow test` send: `FLOW_AGENT_VERSION`,
  else the CI's commit (`GITHUB_SHA`, ...), else the folder's full git commit, `<sha>+dirty` (with a
  warning) when the folder has uncommitted changes, since what is packed is the folder as it is, else
  `package.json`'s `version`; `--version` names it yourself. Hosting gives it to the agent as
  `AGENT_VERSION`, so its traces carry it.
- `promote` moves staging's live version to production, with no new build. Production keeps its
  own secrets: promote sends the `.env`'s new or changed values there first (`--no-secrets` sends none).
- `status` shows, per environment (both unless `--env`), the deploy serving it (`status`, `version`,
  `id`, `updated_at`), its URL and a newer one still building, and whether its traces carry message
  text: `trace text: on (Flow's default)` or `trace text: off (set by you)` (`deploy.trace_text`,
  `{ on, source: "flow" | "owner" }`; nothing, and `null` in `--json`, on a Flow that does not say).
  `--json` prints
  `{ ok, agent_framework, hosting_framework, environments: { staging: { deploy, pending, url, from } | null, production: ... }, next }`;
  `from` is `list` (the cloud's list) or `this_folder` (the last deploy from `.flow/deploys.json`, on
  a Flow whose cloud does not list deploys to a CI key yet). First, the Flow Framework this folder's
  `package.json` pins (`agent_framework` in `--json`), then, when the cloud says them (0.16.0 on), the
  newest line Flow's hosting runs, which is hosting's and not the agent's (`hosting_framework`),
  each deploy's `built with:` line (the framework its build used, `deploy.framework`), and `traces:` per environment, whether Flow's dashboard takes its traces: `ok`
  (with when it last took one), `quiet` (none yet), or `REFUSED (<status> <code>)` with the reason
  and hint (`environments.<env>.traces`).
- Trace text is on by default in hosting. To switch it off in production, set the secret, then
  promote: `echo 0 | npx @flow-engineer/flow deploy secret FLOW_FRAMEWORK_TRACES_CONTENT --env production`,
  then `npx @flow-engineer/flow deploy promote` (`echo 1` switches it back on). Deleting that secret
  on the dashboard (the agent's secrets) goes back to Flow's default at the next deploy.
- `logs` prints the hosted agent's log lines from `--since` (30s, 15m, 1h, 2d, up to 30d, or an RFC
  3339 time; default 1h) to `--until` (the same forms; not with `--follow`), and with `--follow`
  keeps printing new ones. `--severity DEFAULT|INFO|WARNING|ERROR` keeps that severity and above;
  a `DEFAULT` line that is plainly an uncaught error (`Error:`, `DOMException`, a stack: how
  runtimes before 0.16 wrote Flow's own errors) counts as `ERROR`.
  `--grep <text>` keeps lines containing it (case-insensitive, at most 200 characters). The cloud
  filters; the CLI filters again, so an older cloud's answer is right too. When the lines start later
  than `--since` asked, stderr says `Logs start at <time>: this Flow keeps <N> back`. Every page
  up to `--until` (else now) is read before printing; past `--limit` lines (default 10000, at most
  100000) the newest are kept and stderr says where they start and the `--since`/`--until` for the
  older ones. `--json` is one
  `{ time, severity, text }` per line. On a Flow whose cloud has no logs route yet it says so:
  `error.code` `not_available`, exit 1. Flow's own
  lines carry their real severity, and a failed tool call is one `WARNING` or `ERROR` line
  ([Framework log lines](https://flow.engineer/docs/traces#framework-log-lines)), so
  `npx @flow-engineer/flow logs --since 1h --json | jq -c 'select(.severity == "ERROR" or .severity == "WARNING")'`
  lists only the problems.
- `conversations` lists the hosted agent's conversations, newest first (id, last message, channel,
  contact, messages, and how many replies were graded wrong and unhelpful), over as many pages as
  `--limit` needs (default 20, at most 1000). `--since` is 30m, 24h, 7d or an RFC 3339 time.
  `--contact "Contact 4f1c"` (or `4f1c`) keeps one contact's conversations, read over as many pages
  as it takes. `--env` and `--environment` are one flag.
  `conversations show <id>` prints one, one line per message, and under each graded agent reply its
  label, rule, reason and quoted words. When the cloud sends them, each agent reply also shows its
  tool calls (`tool <name> <ms> ms ok`, or `FAILED: <code>: <message>`, then its `input:` and
  `output:` when Flow keeps them, masked and cut at 2 KB, `(cut by Flow)`) and its delivery
  (`queued`, `sent`, `delivered`, `read`, or `FAILED <channel code> (<type>)`); a message whose
  text was not sent to Flow says why (metadata-only traces, `FLOW_FRAMEWORK_TRACES_CONTENT` off, or
  a photo, video or voice note with no caption). `--json` passes `tools` and `delivery` through. `issues` lists the problems the grades add up to, each with
  a suggested fix (`--status open` by default), then the team's feedback of the last 30 days
  (Framework 0.14.4 on): `check out of date <scenario> (<channel>), check <n>: <check>` (update that
  scenario check) and `grade marked wrong conversation <id>, reply <id>, rules <ids>` (do not change
  the agent for it), each with its `note:` and `todo:`; `--json` stays the issues only. They read with the agent's `FLOW_KEY` (`.env`, or
  `--dotenv`; never printed) at `--cloud`, else `FLOW_FRAMEWORK_CLOUD`, else flow.engineer. Without
  `--environment`, a live key reads production and a test key staging. Contacts show only as a label
  (`Contact 4f1c`), never an address. Text Flow keeps back prints as `(text withheld)` or
  `(deleted by retention)`, and messages the agent's own code sent show as `your code`. `--json` is
  the server's JSON (pages merged into one). Exit codes: 0 printed, 1 no key, refused or not
  reachable, 2 a wrong flag (0.16.0 on; 1 before), with the server's message and hint, and
  on a refused key which key the command reads, which one it found (prefix and last 4) and where. To fix bad replies: `conversations --grade wrong`, then
  `conversations show <id>`; fix the instructions, skill or tool the rule points at, add a scenario
  that plays that conversation, run `flow test`, and deploy. The list's KIND is `test` for `flow
  chat`, the playground and `flow test` (never graded, never in Insights; `show` says so), else
  `production`. `issues test-case <id>` prints the test case Flow proposes for an issue (rule, the
  reply it comes from, `includes`, `must_not`, `expect`, `rubrics`), to write a scenario from; it
  writes no file (0.16.0 on).
- `insights` lists Flow Insights' findings (where people gave up, asked again or got annoyed in
  closed production conversations on a live key, by topic), ranked as the dashboard ranks them: id,
  status, conversations with the window before's (`4 (was 9)`), topic and what happened;
  low-confidence tags are named under the table. `--days 7|30`, `--status open|fixed|muted|all`
  (default open). `collecting` (under 20 closed sessions) shows counts only. `insights show
  <finding>` lists its conversations, each with why it was flagged, the person's words when allowed
  and `flow conversations show <id>`. Before Insights is open to the workspace both print `Insights
  is not open to this workspace yet` and exit 1 (0.16.0 on). They read with
  `FLOW_LIVE_KEY` when it is set (`flow setup --live`), else a `flow_live_` `FLOW_KEY`: with only a
  test key (`flow_test_`) both say so, naming `flow setup --live`, and exit 1. The loop: `insights`, `insights
  show`, `conversations show`, fix, a scenario, `flow test`, deploy, and `insights` again after the
  window.
- `secret NAME` (one value from stdin) and `secrets --from-env` (every value in a file, now) are for
  changing a secret by hand; `deploy` already sends the `.env`. In a terminal `secret` asks for the
  value without echoing it (one line); a value of several lines is piped in. `--json` prints
  `{ ok, environment, saved, skipped, refused, next }`. Before the agent's first deploy the host has
  no agent to keep them for: they are refused, exit 1, and `next` is `deploy`. A secret takes effect
  on the next deploy or promote, unless `--apply` restarts the live version with it now.
- `restart` (and `secret --apply`) restarts an environment's live version with its secrets as they
  are now, no new build, and follows it to live like `promote`; with nothing live it says so and
  exits 0. `secret --unset NAME` takes a secret away (it applies at the next deploy or restart). A
  Flow whose cloud cannot do either yet says so (`not_available`, exit 1).
- Exit codes: 0 live or saved, 1 refused, failed or not reachable, 2 a usage problem (no CI key, a
  missing file, a bad name). On an error, `--json` prints `{ ok: false, error: { code, message }, next }`.

Run each answer's `next`. Promote, or deploy to production, only when the owner says so.

### For coding agents: JSON, waits and keys

- **`--json` is one JSON document on stdout**, a failure's too: `{ "ok": false, "error": { "code",
  "message", "hint"? }, "next" }`, exit 1 (2 for a wrong flag), from `conversations`, `issues`,
  `templates`, `show`, `deploy` and its subcommands (0.16.0 on). Progress and notes go to
  stderr, so read stdout alone; do not merge it with `2>&1`. Two commands are JSON Lines instead:
  `logs --json` (one line per log line) and `login`, `link` and `setup` (one complete document a
  line; the last line is the answer).
- **Rate limits.** Flow's cloud reads 60 times a minute per key. A `429` is waited out for its
  `Retry-After` (at most 30 s, said on stderr) and sent again, up to 3 times; a GET is tried once
  more after a network error or a 5xx. `login` keeps polling through `slow_down`.
- **Which key.** `conversations`, `issues` and `templates` read with `FLOW_KEY`: `flow setup` makes a
  `flow_test_` key, which reads staging. Production reads (`conversations --env production`,
  `insights`, and `conversations show` of a production conversation) use `FLOW_LIVE_KEY` when it is
  set, else `FLOW_KEY`: the workspace's owner makes it with `flow setup --live`, for 30 days and
  de-identified text by default ([the key table and its limits](https://flow.engineer/docs/hosting#read-production-with-a-live-key)).
  It messages no customer and deploys nothing live: ask for more with `flow keys grant <name>`, by
  tier. Fine by default (de-identified reads, Insights, tests, traces, the model): granted at once.
  Only when the user asked: raw message text (`keys grant content`). Only with the user's explicit
  yes: messaging customers and deploying live (`keys grant send|deploy`); the owner confirms once in
  the browser ([granting more](https://flow.engineer/docs/hosting#grant-a-live-key-more)).
  Every read prints a `Text:` line and `--json` carries `text_mode`. `test`, `show`, `deploy`, `logs` and `cli
  publish|rollback|status` use the CI key `FLOW_FRAMEWORK_CLOUD_KEY` (`oci_...`), from the agent's
  Developers page on the dashboard or `flow setup`. A refused key's error names the key wanted, the
  one found (prefix and last 4, never the value) and whether it came from the environment or `.env`.
- **Cells.** The US cloud is `https://flow.engineer/observe` (the default; `/dashboard` is the same);
  the India cell's is `https://flow.engineer/dashboard/in`: set `FLOW_FRAMEWORK_CLOUD` (or `--cloud`)
  to it for an agent there. A network failure names the address tried and the error (`ENOTFOUND`,
  `ECONNREFUSED`, ...).

Run each answer's `next`. Promote, or deploy to production, only when the owner says so.

## Flow's MCP server for your coding agent

`flow mcp serve` gives a coding agent the same reads as typed MCP tools, so it calls a tool
instead of running a command and parsing `--json` (0.16.0 on). Add it from the agent's folder:

```sh
claude mcp add flow -- npx @flow-engineer/flow mcp serve
```

Any other MCP host: the command `npx`, the arguments `@flow-engineer/flow mcp serve`, started in the
agent's folder (or add `--dir <folder>`; `--cloud <url>` as for the other commands). It speaks
MCP on stdio on `@modelcontextprotocol/server`, which comes with Flow Framework: nothing more to install.

| Tool | Reads | Key |
| --- | --- | --- |
| `list_conversations` | `flow conversations`: `environment`, `since`, `grade`, `contact`, `limit` (default 20, at most 200) | `FLOW_KEY`; production: `FLOW_LIVE_KEY` when set |
| `show_conversation` | `flow conversations show <id>`: `id`, `environment`; each reply's tool calls (name, ms, ok, error) and delivery (queued, sent, delivered, read, failed with the channel's code) | `FLOW_KEY`, then `FLOW_LIVE_KEY` when `FLOW_KEY` does not find it; production: `FLOW_LIVE_KEY` first |
| `list_issues` | `flow issues`: `status` (default `open`) | `FLOW_KEY` |
| `list_insights` | `flow insights`: `days` 7 or 30 (default 7), `status` `open` (default), `fixed`, `muted` or `all` | `FLOW_LIVE_KEY` when set, else a `flow_live_` `FLOW_KEY` |
| `insight_conversations` | `flow insights show <finding>`: `finding`, `days`; each conversation's `window`, the 3 messages before the flagged one and 2 after, when Flow sends it | `FLOW_LIVE_KEY` when set, else a `flow_live_` `FLOW_KEY` |
| `list_templates` | `flow templates`: `status` `approved` (default) or `all` | `FLOW_KEY` |
| `read_logs` | `flow logs`: `environment` (default staging), `since` (default 1h, at most 30d), `until`, `severity`, `grep`, `limit` (default 200, the newest; `truncated` says when more matched) | CI key |
| `deploy_status` | `flow deploy status`: `environment` (default both) | CI key |

- Every tool only reads (`readOnlyHint: true`). Nothing here deploys, changes a secret or sends a message.
- The same tools are `flowReadTools()` (`@flow-engineer/flow/testing`), for your own
  `mcpServer({ tools })`; `flowReadTools({ hosted: {} })` adds an `agent` input and `list_agents`, and
  takes each call's key from the signed-in person's credentials, never from the model (0.16.1 on).
- The read commands (`conversations`, `issues`, `insights`, `templates`, `logs`, `deploy status`)
  read over a hosted Flow MCP with `--server <url>` (or `FLOW_MCP_SERVER`) and `--agent`, as the
  person signed in with `flow mcp login --server <url>` (`FLOW_MCP_TOKEN` in CI); their output is
  the same (0.16.1 on).
- `FLOW_KEY`: a `flow_test_` key, the one `flow setup` writes, reads staging only. Production, and
  Insights (closed production conversations only), read with `FLOW_LIVE_KEY` when it is set: the
  workspace's owner makes it with `npx @flow-engineer/flow setup --live`
  ([its limits](https://flow.engineer/docs/hosting#read-production-with-a-live-key)). The tool descriptions repeat its three
  tiers in the CLI's words, so a coding agent asks for a `flow keys grant` only as its tier allows.
  Each result carries `text_mode`
  (`raw`, `deidentified` or `withheld`). The CI
  key, `FLOW_FRAMEWORK_CLOUD_KEY` (`oci_...`), reads logs and deploys in both environments.
- The keys are read again on every call, from the environment the server started with, then the
  folder's `.env`: a key fixed in `.env` works on the next call, without restarting the server.
  No tool returns a key; errors name one by its prefix and last 4 only.
- A result is `structuredContent` (what the command's `--json` prints) and the same JSON as text
  under a one-line summary, such as `1 conversation, 1 reply graded wrong. Read one: show_conversation.`
- A failure is a tool error (`isError: true`) whose `structuredContent` is `--json`'s failure
  document, `{ ok: false, error: { code, message, hint? }, next }`: a refused key says which key the
  tool reads, what it found and how to get the right one (a live key refused for something it was
  not granted: Flow's hint naming the `keys grant`, and the three tiers); `no_flow_key` and `no_ci_key` have `next`
  `npx @flow-engineer/flow setup`, and `no_live_key` (a production read with neither key)
  `npx @flow-engineer/flow setup --live`.
- Message text is as the agent API sends it: de-identified on a live key made without `--content`,
  withheld for accounts that keep it back, and contacts only as a label (`Contact 4f1c`).

Expected result: `/mcp` in Claude Code lists `flow` with eight tools, and "did the booking tool fail
in the last conversation?" runs `list_conversations`, then `show_conversation`.

## WhatsApp templates

Before declaring WhatsApp templates, run `flow templates --declare` and paste its output.

```sh
npx @flow-engineer/flow templates [--all] [--json]   # name, language, category, status, send order
npx @flow-engineer/flow templates --declare          # the approved ones as createAgent's templates: [...]
```

- It reads the project's templates from Flow's dashboard (`GET /v1/agent/templates`) with the
  agent's `FLOW_KEY`, at `--cloud`, else `FLOW_FRAMEWORK_CLOUD`, else `https://flow.engineer/observe`.
- The list shows approved templates; `--all` every status; `--json` the server's answer.
- `--declare` prints each approved template exactly as Meta has it (header, body with its numbered
  or named variables, footer, buttons), then one commented `agent.nudge` per template with the
  order its values go in, such as `body[0] = {{listing}}, body[1] = {{answer}}`.
- `flow test` compares the templates the agent declares with the approved ones and warns, never
  fails, for each one missing, not approved, or differing in its category, header, body, footer or
  buttons.
- A dashboard without the route answers 404: `flow templates` says it does not serve templates yet
  (exit 1), and `flow test` says nothing.

## Send Flow feedback

When Flow gets in your way, tell the Flow team directly: a command that failed or printed the
wrong `next`, a guide that was wrong or missing, an error that did not say what to do, or a part
that worked well. POST it as JSON; no key or account is needed.

```sh
curl -sS https://api.flow.engineer/v1/feedback \
  -H 'content-type: application/json' \
  -d '{"feedback": "flow link --channel imessage --json exited 0 but next was empty.", "kind": "bug", "agent": "Claude Code", "flow_version": "0.9.0", "about": "flow link"}'
```

Expected result: `201` with `{ "id": "fbk_...", "received": true }`. Only `feedback` is required (up to
4,000 characters); `kind` is `bug`, `docs`, `feature` or `other`; `agent`, `flow_version` and
`about` (the command, API, page or file) are optional.

- Describe Flow's behaviour, not the owner's product: never include keys, tokens, `.env` values,
  customers' data or the owner's private code. Tell the owner in one line what you sent.
- Send one post per problem, once. The sender's IP address is kept with the feedback for 180 days.
- `400` names the field to fix in `error.param`, `429` means too many posts (wait `Retry-After`
  seconds), and `500` means it was not stored: try once more a minute later.
