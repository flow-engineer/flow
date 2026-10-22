---
name: flow-framework
description: Build or change a chat agent on Flow Framework (WhatsApp, SMS, iMessage, Telegram, web), and serve its tools as an MCP server for Claude and ChatGPT or as a CLI. Load when creating a Flow Framework agent, editing its prompt or skills, wiring it into the playground, adding MCP or a CLI, or when code imports @flow-engineer/flow. Also load the flow-framework-tools skill (tools-skill.md) before writing tools and flow-framework-tests (test-skill.md) before writing tests.
---

# Building an agent on Flow Framework

Flow Framework runs chat agents that feel like a person texting back: it folds double texts into one
reply, acknowledges people fast, runs tools in parallel and waits for them, moving one to the
background only when the person writes again or it passes its limit.
You write the agent's prompt, skills and tools; Flow Framework handles the conversation.

More skills go with this one: `flow-framework-tools` (`tools-skill.md`) before writing or changing a
tool, `flow-framework-tests` (`test-skill.md`) before writing or changing a test, `flow-framework-context`
(`context-skill.md`) before writing tools for a company that already has an app, API or database,
and `flow-framework-auth` (`auth-skill.md`) when tools need to know who the person is.

## Start a new agent

`npx @flow-engineer/flow new <name>` (lowercase letters, digits and dashes) makes `./<name>/` from the café
example: a complete agent with tools and tests that depends on the `@flow-engineer/flow` package and imports
`@flow-engineer/flow` and `@flow-engineer/flow/simulators`, with these skills in `.claude/skills/`. Run `npm install` there.
Build in it, changing the café agent's prompt, skills, tools and tests into yours. A provider key is optional:
`npx @flow-engineer/flow link` (or `setup`) writes `FLOW_KEY`, the agent's one Flow key, into `.env` (never
read or print it), and the agent calls models through Flow with it on $2 of Flow trial credit. A key of the owner's own wins over it, made
at the provider: `OPENROUTER_API_KEY` at https://openrouter.ai/keys,
`OPENAI_API_KEY` at https://platform.openai.com/api-keys, `ANTHROPIC_API_KEY` at
https://console.anthropic.com/settings/keys, or `GEMINI_API_KEY` at https://aistudio.google.com/apikey.
The first one with a value is used, and `CAFE_MODEL` sets the café's model id. Then `npm start`
opens the playground; `npm run typecheck` checks the types.

Inside a clone of Flow Framework itself, `npm run new -- <name>` copies the café to `agents/<name>/`
instead (git-ignored, so it never collides with a pull). Its imports of `../../../src/` and
`../../../simulators/src/` stay as they are, so changes to Flow Framework show at once; the key goes in
`agents/<name>/.env`. The snippets below import `@flow-engineer/flow` and `@flow-engineer/flow/simulators`; in a clone's
agent, keep its relative imports.

## Layout

```
my-agent/
  agent/AGENTS.md              the agent's prompt (the model reads it every turn)
  agent/skills/<name>/SKILL.md skills the agent loads when it needs them
  src/tools.ts                 the agent's tools (see tools-skill.md)
  src/agent.ts                 buildAgent(): the one place the agent is built
  src/main.ts                  runs it in the playground
  src/mcp.ts                   optional: the tools as an MCP server (below)
  src/cli.ts                   optional: the CLI file, for the organization's command line (below)
  context/                     optional: the context pack the tools are written from (context-skill.md)
  mcp.lock.json                optional: the tools of other MCP servers the agent uses (tools-skill.md)
  tests/tools/*.yaml           how each tool behaves in tests (see tools-skill.md)
  tests/scenarios/*.yaml       the tests (see test-skill.md)
```

`agent/AGENTS.md` is the agent's prompt, not instructions for coding agents. Keep it short: what
the agent is for, what it may and may not do. Don't explain messaging in it: Flow Framework adds how to
talk to the person (send_<channel>, react, acknowledging first, channel formatting) on its own.

A skill's `SKILL.md` starts with `name` and `description`; the agent sees every description and
loads the full skill only when it decides it needs it. Put rules for one kind of request in a
skill, not in AGENTS.md.

## buildAgent

Build the agent in one function that the playground and the tests both call, so they never
drift apart. Tests pass their own model, events and simulated tools; a test the business starts
also passes `channels` and `testing` (the run's clock, store and runner name), which go on to `createAgent` as they are
(the `flow-framework-tests` skill):

```ts
import { fileURLToPath } from "node:url";
import { createAgent, openAICompatible, type AgentOptions, type Channel, type EventSink, type Model, type Tool } from "@flow-engineer/flow";
import { tools as myTools } from "./tools.ts";

export const tools = myTools;

export function buildAgent(options: { model?: Model; events?: EventSink[]; tools?: Tool[]; channels?: Channel[]; testing?: Partial<AgentOptions> } = {}) {
  return createAgent({
    dir: fileURLToPath(new URL("../agent", import.meta.url)),
    model: options.model ?? openAICompatible({ model: "anthropic/claude-haiku-5.5" }),
    tools: options.tools ?? myTools,
    events: options.events ?? [],
    ...(options.channels ? { channels: options.channels } : {}),
    ...options.testing,
  });
}
```

Other `createAgent` options: `files` replaces `dir` on hosts with no file system (the folder's
text by path: `{ "AGENTS.md": ..., "skills/<name>/SKILL.md": ... }`); `profile({ conversationId, person, channel })` is what the business knows about
the person, offered as the built-in tool `get_user_profile` and run only when the agent calls it (put
lookups here, not in `context`); `context(conversationId)` adds small facts to the system prompt at
every turn, before every reply, so it must not call APIs; Flow Framework already tells the agent the time; `intercept(conversationId, text, message)` answers a
message without the model (return the reply, `""` for silence, or `null` to let the agent answer;
the message and the reply are kept in the history, so the next turn knows, and in the transcript,
and are `message.in`/`message.out` events marked `answered: true`);
`deadlineMs` (default 60,000) is the longest a reply waits for a tool before it moves to the
background (set a tool's own `deadlineMs` for a known-slow one); `partialAfterMs` (default 5,000)
is how long a finished tool's result waits for the others of its response; `shareUpdates` turns live status lines on web and app UIs off, or replaces their
guidance with a string; `routes` (`{ "/v1/events": (request) => Response }`) are HTTP routes the
agent serves beside its chat, such as a business's event push, answered by `agent.fetch(request)`
(and by the test cloud with a test's events); `onTick(now)` is work of your own on the agent's clock
(held sends, reminders timed from your data), run with each check for due scheduled messages.
`agent.reach({ channel, address })` makes the conversation of someone the business may message
before they have written; until they write, only a template reaches them on WhatsApp.

Models are reached through any OpenAI-compatible API. `openAICompatible()` with no key reads the
first of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and
`FLOW_KEY` (the agent's Flow key, on its trial credit, from `setup`) that has a value, and uses that provider's
default model (`MODEL` overrides it). `flowModel()` uses Flow alone; when its credit is used up a
call fails with code `trial_credit_used` and a next step (tell the owner to add their own key). With none it stops at once and
names them. Pass `apiKey` and `baseURL` for anywhere else (`baseURL` alone for a local server that needs no key).
`flowTranscribe(audio, { language })` turns a voice note (at most 15 MB) into `{ text }` through Flow
with FLOW_KEY, failing the same way.

Which model: recommend Claude Haiku 5.5 (`anthropic/claude-haiku-5.5`, the default above) or OpenAI
GPT-6.1 Sol (`openai/gpt-6.1-sol`, about 3x the cost, the most exact). If the owner asks for Luna
(`~openai/gpt-luna-latest`, `openai/gpt-6-luna`), advise against it before using it: with tools
that run in the background it repeats tool calls, sends extra "on it" messages and answers twice,
where Haiku and Sol send one acknowledgement and one answer (measured on Flow Framework's own checks, 12 Oct
2026). Use it only if they still want it.

## Channels, people and the database

In production, give the agent its channels once and hand it each incoming message. Each channel
is a definition in its own file; Flow Framework knows the platform (WhatsApp's limits, SMS segments), your
provider only says how to send:

```ts
// src/channels/whatsapp.ts: one sendMessage, plus whatever else your provider can do
export const wa = whatsapp({
  sendMessage: (to, m) => api.send(to, m),        // m: { text, replyTo?, buttons?: (label | { id, label })[], list?, link?, image? }
  react: (to, id, emoji) => api.react(to, id, emoji),
  // no typing() or markRead(): those features are off, and the agent is never offered them
}, { disable: ["lists"] });

// src/channels/app.ts: your own web or mobile UI, with params of your own
export const app = customUI("app", {
  params: { app_link: z.string().describe("A link a tool result gave you; the app shows it as a button") },
  instructions: "Only fill app_link with a URL from a tool result in this conversation; never make one up.",
  sendMessage: (to, m) => myApp.push(to, m),      // m.text, m.app_link
});

createAgent({ ..., channels: [wa, sms(twilioLike), app], database: sqlite("data/chinwag.db"),
  resolve: ({ channel, address }) => members.idFor(channel, address), timeZone: "America/New_York" });
// A person's time zone is never guessed from timeZone (the business's): set it when you know it,
// agent.setTimeZone({ to, timeZone }) or peopleHandler over HTTP; else the agent asks them.
await agent.resume();                     // a durable database: always before the first message
await agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
```

- Several processes or machines need Postgres, not a SQLite file: `database: postgres(pool)`
  with the app's own node-postgres `Pool` (Flow Framework adds no Postgres dependency). An agent that must
  not hold database credentials gets `store` instead of `database`: any object with Store's
  methods (`StoreApi`), such as a client that forwards each call to a service running `new
  Store(postgres(pool), agentId)`.
- Every send tool can carry a `link` ({ label, url }, https): a URL button where the channel has
  one (`linkButton`, WhatsApp's cta_url), else Flow Framework puts the URL on a line after the text. Channels
  with `images` also offer an `image` ({ url }, https, or { file_id }, the provider's own id for a
  file it holds), the text its caption; with buttons or a link the photo heads that same message.
  The provider gets it as `image: { url }` or `image: { fileId }`; elsewhere the text goes alone.
  WhatsApp's rules hold everywhere: a link never with buttons or a list, an image never with a
  list. A provider without them says so (`features: { links: false, images: false }`) and never
  gets them; the URLs and file ids come from your tools' results, like app_link's.
- Carousels (WhatsApp's media carousel): a WhatsApp provider with `sendCarousel(to, { text, cards })`,
  or a customUI whose `info` has `carousels`, offers the agent a `carousel` of 2 to 10 cards, each
  `{ image, text?, buttons? | link? }` with the same kind and number of buttons on every card
  (`WHATSAPP_CAROUSELS` has WhatsApp's limits).
- A reply button (a message's or a card's) is a label, whose id is the label, or `{ id, label }`;
  the agent's send tool takes both. Ids are 1 to 64 bytes and unique within a message and across a
  carousel; labels may repeat, so every card can say "Details" with ids `details:<listing>`. A tap
  comes back as `Incoming.choice: { id, title }` (`message.in`'s `choice`, the transcript's
  `choiceId`), and the model reads `tapped] Details (details:b)`. A provider reads `m.buttons` with
  `replyButton(b)`, which gives `{ id, label }` either way. `ChannelInfo.buttonIds` is true where the
  tap gives the id back (Flow Messaging's WhatsApp and Telegram, the simulators); a channel of your own
  (a customUI) sets it in its `info` once it does, else number labels where taps must be told apart. A channel that gets a carousel without a way to show
  one sends its text, then each card as a message, in order (`carouselMessages`).
- The simulators and the test cloud play an agent's own channels with these definitions (a customUI
  on Telegram or iMessage, as Flow Messaging's are, plays in that platform's simulator; any other in the web one), so the model sees the production tools; they show params such as
  app_link under the message instead of calling your sendMessage.
- Every send is checked against its platform's content rules, Flow Messaging's (`ChannelInfo.platform`,
  `CONTENT_LIMITS`, `contentRefusal`): what WhatsApp, Telegram, iMessage or SMS would refuse (a
  carousel card's text over 2 line breaks, buttons whose text is over 1,024 characters on WhatsApp,
  the same button id on two cards, an SMS over 10 segments) is refused before it goes, with
  Flow Messaging's own error, in the playground, the test cloud and production alike; the agent is
  told it and sends again.
- To check, rewrite or refuse messages yourself (card text, links, wording), use `createAgent`'s
  `beforeSend: (message, { channel, address, info, origin }) => ...`: return nothing to send it,
  another message to send that, or `{ refuse: "why" }`. Never wrap a channel's `send` for it: the
  playground and the test cloud never call it, and what you change there is not what the
  transcript and the judge see. What `beforeSend` returns is what is checked, sent and recorded
  (`message.out`, the history, the transcript); a refusal is a `message.refused` event.
- `instructions` (on `customUI`, and in `whatsapp()`'s and `sms()`'s options) is your guidance for
  the agent on that channel, in its prompt only while the person uses it. Data a param carries,
  such as a link, comes from your tools' results: a tool that has a screen returns its link
  (`{ ..., app_link }`), and the agent only passes it on.
- One person is one conversation across every channel they use. Channels are joined only by what
  each verified: your `resolve` key, else the same phone number on channels marked `phone`. Never
  join people any other way. When the SMS provider gives national numbers, set
  `defaultCountryCode` ("+91") so they match the full number WhatsApp gives.
- Tools key a person's data by `context.person`, their stable id: `key:<resolve's value>`, else
  `phone:<E.164>`, else `<channel>:<address>`. `context.key` is `resolve`'s value as returned, or
  null without one: look them up in the backend by that, never by `context.person`.
- With several channels the agent gets a send tool per channel (`send_sms`, `send_web`) and
  answers each message where it came. Don't add your own.
- Run exactly one copy of the agent per database (one instance, kept warm, CPU always on). A
  conversation lives in one process at a time (its lease in the database), so the old and new
  copy beside each other during a deploy never answer one message twice; events name their `runner`.
- After a restart, `resume()` carries on: cut-off turns run again, background tools that were
  running are reported as interrupted (never rerun).
- `agent.receive(conversationId, message, deliver)` still works for one channel at a time (the
  test cloud uses it).
- Photos, voice notes and documents: hand them in on the message, `message: { text: caption, attachments: [{ kind: "image" | "audio" | "document", mime, name?, data: () => provider.download(id) }] }`.
  `data` is a loader your provider fetches with its own credentials; never put a media URL where
  the model sees it. Photos (JPEG, PNG, WebP, GIF, up to 5 MB) and PDFs (up to 10 MB) go to the
  model when it reads them (`openAICompatible({ images, pdfs })`: images default on, PDFs on with
  OpenRouter; set `images: false` for a text-only model). Voice notes need
  `createAgent({ transcribe: async ({ mime, data }) => text })` with the speech-to-text the owner
  picks; Flow Framework has none. Anything the agent can't read reaches it named, with why, so it asks
  for text. The latest 3 photos and PDFs stay shown; their bytes are never stored.

Built in, so don't build them as tools: what the business knows about the person (`profile`, as
`get_user_profile`), scheduled messages (`schedule_message`, `list_scheduled`,
`cancel_scheduled`, in the person's local time), and what a person asked not to be messaged about
(`add_no_contact`, `remove_no_contact`), quiet hours they set (`set_quiet_hours`) and pauses
(`pause_messages`). STOP, START and HELP are built in on `sms()` and
`whatsapp()`: don't build them in `intercept`. STOP stops every message the business starts, with
no model call, until START; set the replies with `keywords: { replies: { stop, start, help } }`.
`intercept` sees them first, with `message.keyword` `"stop"`, `"start"` or `"help"` (else `null`)
and `message.channel` (the channel's name in `channels`, on every message): an agent with its own
opt-out flag sets it there
(`if (message.keyword === "stop") optedOut.add(conversationId)`; only on SMS:
`message.channel === "sms" && ...`). Flow Framework keeps or lifts the STOP
whatever the hook returns or throws; a reply it returns goes instead of Flow Framework's, never both.
SMS takes only STOP by default; the words carriers or regulators expect differ by country, so
check the market's rules (`keywords: US_CARRIER_KEYWORDS` adds STOPALL, UNSUBSCRIBE, CANCEL, END
and QUIT, as some US carrier rules expect; `keywords: { stop: [...] }` sets your own).

Messages the business starts are nudges: `agent.nudge({ to: { channel, address }, text })` sends
as written; `prompt` instead lets the agent write it (or decide not to); `template` sends a
WhatsApp template you already set up. Pass `idempotencyKey` when your system may retry, and `at`
to send later. Prefer `prompt`; use `text` only when the wording must be exact. Outside WhatsApp's
24-hour window only templates go out: declare a `fallbackTemplate` ("You have a new message. Reply to
see it.", no values) so a nudge is held until they reply instead of refused (`outside_window`); the
agent may send a fitting template itself (`send_template`), and `template.missing` events say which
messages want one. Held nudges (quiet hours, a closed window) settle as `held`, then `sent` or `expired`.
For a call to action use `link` (`text` with `link: { label, url }`, or the agent's send with
`link`), never a URL in the text: what the business starts goes with link previews off, since on
WhatsApp a preview card's title becomes the phone's notification instead of the message.

When the owner's backend is a separate service, mount `nudgeHandler(agent, { token })` (from
`@flow-engineer/flow`; a token of at least 32 characters, from a secret; `base` is `/nudges` by default) in the
agent's server rather than writing a route: `POST /nudges` takes the same fields with
`idempotency_key` and `at` in ms since the epoch, and answers `202 { id, status }` once recorded,
before any send or turn (`queued`, or `refused`/`dropped`/`scheduled` decided then: still a 202);
`GET /nudges/<id>` reads its state. Both need `Authorization: Bearer <token>`. Contract:
`spec/nudges.openapi.yaml`.

When the backend posts what happened (an order shipped, an item is back in stock) rather than what
to send, mount `flowEvents({ secret, catalog, timezone })` (from `@flow-engineer/flow`): its
`routes` (`POST /v1/events`, signed with `Flow-Signature`), `onTick` and `context(conversationId)`
go on `createAgent`, `events.phrasing.check(address, message)` in `createAgent`'s `beforeSend`
(return `{ refuse: reason }`), then `events.attach(agent)`. Each type in the catalog has a delivery level
(critical, standard, optional), its template and its values; the guide is `docs/events.md` in the
package (`../docs/events.md` from this file).

Templates are WhatsApp only. Declare the ones the owner set up with Meta beside `testPeople`, so
Flow Framework checks each send against them and the playground shows them as WhatsApp does:

```ts
createAgent({
  ...,
  templates: [{
    name: "order_ready", language: "en", category: "utility",   // or marketing, authentication
    header: { kind: "text", text: "Order {{1}}" },              // or { kind: "image" | "video" | "document" }
    body: "Hi {{1}}, your {{2}} is ready.",
    footer: "Reply STOP to opt out",
    buttons: [
      { type: "quick_reply", text: "On my way" },
      { type: "url", text: "Track", url: "https://example.com/o/{{1}}" },
      { type: "phone", text: "Call us", phone: "+15555550100" },
    ],
  }],
});

await agent.nudge({ to, template: {
  name: "order_ready",
  header: { kind: "text", text: "1042" },                     // media: { kind: "image", url } or { kind, fileId }
  body: ["Maria", "latte"],                                   // {{1}}, {{2}}, ... in order
  buttons: [{ index: 0, value: "omw_1042" }, { index: 1, value: "1042" }],   // a quick reply's payload, a URL's end
} });
```

A declared template sent with the wrong values (a body value too few or many, a missing header or
URL value) throws from `nudge` before anything is sent, in the playground and live alike. One not
declared goes as it is (the provider checks it) and the playground shows its name and values. A
quick-reply tap comes back as the person's message with `choice: { id: payload, title }`, like a
reply button, and the agent is told what the template said. An ordinary message has one kind of
button: up to 3 reply buttons OR one link button, never both. A template may mix quick replies and
URL buttons.

## Ask the owner when you set an agent up

Before the agent sends anything people did not ask for (nudges, follow-ups), ask the owner these
two, with these options, and build what they pick:

1. **Quiet hours** (what the business starts waits for them, in each person's own time):
   "22:00–07:00 (recommended)", "other hours", or "none" (`quietHours: false`). For US marketing,
   say that 8am–9pm the recipient's time is, as far as we know, the legal window, and check theirs.
2. **Where people's time zones come from**, since quiet hours apply only where it is known:
   "our database" (sync it with `agent.setTimeZone` or `peopleHandler`), or "we don't know" (the
   agent asks people when it needs it; until then nothing is held for quiet hours).

## The playground

Every agent ships a test playground: people test it as real users before its numbers are live.
Declare who may be played in `createAgent({ testPeople: [{ name: "Maria", phone: "+15555550101" }] })`;
no one else can be. A test person is a real person to the agent: the same identity, `resolve`,
`intercept`, history and schedules as when that number writes through a provider (the playground
is just another phone; they may be test members in your real backend). On phone channels their
address is the number; on others `test:<number>`, joined to the same person. One person is one
conversation across every channel: switch channels and the chat resumes. A listed number may also
write from a real provider once a channel is live; replies, scheduled messages and nudges go back
wherever that person last wrote from on that channel.

`src/main.ts` serves it with the simulators (SMS, WhatsApp, Telegram and iMessage, and the web
simulator for a custom UI), each drawn like its app and with that platform's real rules, on the agent's own `channels` (declare them, with a provider
that is not connected yet if the numbers are not ready: test people never reach it):

```ts
import { simulators } from "@flow-engineer/flow/simulators";
import { buildAgent } from "./agent.ts";

const play = simulators({ title: "My agent" });
const agent = buildAgent({ events: [play.events] });
await play.listen(agent, 8788);           // 127.0.0.1 only, its own page only; no token needed there
```

Open the printed link, pick a test person and a channel, and chat; `/person` shows every channel
side by side. The page shows the person's conversation from the agent's store, so it survives
restarts (with a durable `database`), and Clear history forgets the person entirely
(`agent.forgetPerson(conversationId)`: history, schedules, everything). The side panel shows how
fast each message was acknowledged and a trace of every model call and tool. `cards` says how a
custom UI shows a link in its params: `{ match: "/video/", label: "Start video call", kind: "call" }`;
any other link is "Open in app".

The Person tab also moves the agent's clock when you give it one (`const clock = playgroundClock()`,
`simulators({ clock })` and `createAgent({ now: clock.now })`), lists what is scheduled or held for
the person, sets their time zone and quiet hours, and sends nudges with every field the API takes.

To demo what your backend does (an order ships), send the nudge it would send from the Person tab.

On a deployed agent, mount it in your own server with a token of at least 32 characters, from a
secret: `const playground = play.handler(agent, { token: process.env.PLAYGROUND_TOKEN!, base: "/playground" })`,
and hand it the requests under `/playground` (`if (url.pathname.startsWith("/playground")) return playground(req, res)`).
Open `/playground/?token=...` once (it becomes an HttpOnly, SameSite=Lax cookie and leaves the URL) or call the API
with `Authorization: Bearer <token>`. The cookie survives a top-level return from sign-in on another site;
the API still accepts only requests from the playground’s own origin. Wrong tokens are limited per address,
and every simulated message is logged with the person, channel, time and address.

## Put it on a phone

To chat with the agent from the owner's phone, with no tunnel and no key made by hand, run these
from the agent's folder (`npx @flow-engineer/flow init --display-name "<name>"` makes a starter in
an empty one: first ask the owner what people should call their agent, such as "FlatX agent"; the
phone's first message is `Hi FlatX agent (ref <code>)`, and `package.json`'s `displayName` keeps it;
`link --display-name "<name>"` renames it later, in `package.json` and `agent/AGENTS.md`).
Only `chat` reads stdin; `init` asks for the name only in a terminal, and nothing else asks for input.

```sh
npx @flow-engineer/flow link --channel telegram --json   # or whatsapp, imessage: signs in and runs setup when needed (Flow's trial model key too), then the channel's own link (t.me, wa.me, sms:); give its say_to_person to the owner, and run its next
npm start                                    # after link: its playground link, and the owner texts it while it runs (PORT, else 8788 or the next free port)
npx @flow-engineer/flow status --json        # what the folder has and lacks, at any time
printf 'hi\nA latte please\n' | npx @flow-engineer/flow chat   # your own check: one message per line, replies printed
npx @flow-engineer/flow test --synthetic     # your own check: the tests, on the key setup wrote
npx @flow-engineer/flow deploy --json        # when the owner wants it hosted: staging on Flow's cloud (see "Deploy it")
```

When the owner asks how to test it, recommend first the playground (`npm start`, then open the
link it prints: the test people and the channels side by side, with Debug), then their phone (the
`link`, while `npm start` runs). `chat` and `test --synthetic` are for you to check your own work;
do not offer them to the owner as ways to test.

`link` runs `login` first when not signed in: it opens the owner's browser itself and prints the
link and code at once (with `--json` the first line is `{"status":"pending","verification_uri":...,
"user_code":...,"next":...}`), waits at most 120 s (`--timeout <s>`), then exits 4 with the code
kept: give the owner the link and code, and run `link` again (it polls the same code). Then it runs
`setup`, which writes the test cloud, traces and Flow Messaging keys into `.env`, prints names and
last 4 characters only, keeps values already there (`--replace` takes the new ones), and is safe to
run again. `--channel telegram|whatsapp|imessage` picks the channel; a channel flow.engineer cannot
open yet exits 3 with its `next`. When only observe's part of setup fails (traces and the test cloud),
`link` still prints the link and exits 0, with one warning saying what is missing and the server's
fix (`warnings` in `--json`): pass it on to the owner. `login`, `setup` and `link` also run on their own.
When the owner names a team's observe workspace, pass `--workspace <name|acc_id>` to `setup` or `link`
once: its `acc_` id is kept in `.env` (`FLOW_FRAMEWORK_WORKSPACE`) for later runs, and `status` shows it.

In `src/main.ts`, put `fm.telegram()` from `@flow-engineer/flow/flow-messaging` in the agent's
channels and call `fm.start(agent, { cursorFile: ".flow/flow-messaging-cursor" })`: with no webhook
secret it opens Flow Messaging's event stream, an outbound connection, so the laptop needs no public
URL, and the cursor file lets messages sent while it was stopped arrive when it starts again. The
starter does this when `.env` has `FLOW_MESSAGING_KEY`. Each error is
`{"error":{"code","message","next"}}`: run its `next`. Exit codes: 0 done, 1 usage or not signed in,
2 network, 3 refused, 4 sign-in waiting. Never ask the owner to paste a key into the chat. Always
name the package (`npx @flow-engineer/flow ...`): `npx flow` on its own fetches another npm package.
CI never logs in: `setup --ci` says how to give it the cloud key.

## Deploy it

Flow hosts Flow Framework agents: `npx @flow-engineer/flow deploy` runs the agent's folder on Flow's
cloud, with its state kept for it, Flow Messaging's stream held, and its secrets kept apart from
every other agent's. Do not pick a VPS, Fly or Render on the owner's behalf: ask the owner whether
the agent goes on Flow's cloud or their own servers.

On Flow's cloud the agent needs only what `flow test` already loads: `src/agent.ts` exports
`buildAgent({ events, tools, host })` and passes it to `createAgent` as `host: options.host`, keeping
its own `dir`. Hosting's `host` brings the store, which replaces the agent's database, and, when the
agent has `FLOW_MESSAGING_KEY`, `host.messaging`, whose channels (Telegram, plus WhatsApp and iMessage
with their senders) `createAgent` adds unless the agent declares one of that name itself. Do not
spread `host` into the options: `createAgent` reads it as one option. An agent that drops
`host`, or brings a database of its own, is refused in production (a warning in staging). The CI
key is `FLOW_FRAMEWORK_CLOUD_KEY` (`flow setup` writes it into `.env`).

```sh
npx @flow-engineer/flow deploy --json                           # staging, the first time too: sends .env's values as secrets
                                                                # (names printed, never values), builds, follows it to live; run its next
npx @flow-engineer/flow deploy promote --json                   # staging's live version to production, once the owner has tried it
npx @flow-engineer/flow deploy status --json                    # what is live in each environment: version, when, URL
npx @flow-engineer/flow logs --since 15m                        # the hosted agent's log lines (--follow for new ones)
printf '%s' "$VALUE" | npx @flow-engineer/flow deploy secret NAME --env production   # one secret by hand, from stdin
```

Promote, or `deploy --env production`, only when the owner says so. A refused deploy lists the
hosting lint's findings (`deploy.findings`): fix the errors and deploy again. An agent locked to a
newer Flow Framework release line than hosting runs is refused before anything is sent
(`error.code` `chinwag_too_new`): run its `next` (pin the version hosting runs) and deploy again. One `deploy` is the whole first deploy: there is no
separate secrets step (it sends only new or changed `.env` values each time; promote sends them to
production). Commit first, or the version reads `<sha>+dirty`. Stop the laptop's `npm start` once the deployed one is live: two copies on one key
both answer every message.

On the owner's own servers: one instance, kept warm, CPU always on, a durable `database`
(`postgres(pool)`), `await agent.resume()` at start, the secrets from the platform's secret store
(never the `.env`), and Flow Messaging's stream (`fm.start`) with its cursor file on a disk that
survives a restart, or its webhook (`FLOW_MESSAGING_WEBHOOK_SECRET`) on a public https address.

## Send traces to a dashboard

Every turn can go to a traces endpoint as an OTLP/JSON trace, posted to `<url>/v1/traces`, so
playground and real chats show up in a dashboard and can be graded. No code: set these in the
agent's environment. The address is https://flow.engineer/observe unless `FLOW_FRAMEWORK_TRACES_URL`
names another; the trace key is made on that same site (never print it):

```sh
FLOW_FRAMEWORK_TRACES_KEY=...
FLOW_FRAMEWORK_TRACES_URL=https://flow.engineer/observe  # the default; set it only to send them elsewhere
FLOW_FRAMEWORK_TRACES_CONTENT=1                          # send what was written; without it, metadata only
```

Without `FLOW_FRAMEWORK_TRACES_CONTENT=1` the dashboard
gets ids, timing, model calls and tool names but no messages, so nothing to show or grade. Or in
code: `createAgent({ ..., traces: { url, key, content: true, version: "v3" } })`. Traces are sent in the
background after each turn and a failed send is dropped (logged once), so a dashboard outage never
touches a chat; call `await agent.flushTraces()` before the process exits. Tests run under
`node --test` never send from the environment. Under `flow test` the traces say they are a test's
(`chinwag.run_kind` is "test", else "production", and each turn names the test session as
`chinwag.test.session`), so the dashboard keeps them apart from real conversations.

## Serve the tools over MCP

The same tools and skills go to Claude, ChatGPT and any MCP host as an MCP server. Install the
SDK it runs on (`npm i @modelcontextprotocol/server@2.3.1`, the version Flow Framework pins) and add
`src/mcp.ts`:

```ts
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mcpServer } from "@flow-engineer/flow/mcp";
import { tools } from "./tools.ts";

export const mcp = mcpServer({
  name: "acme",
  version: "1.0.0",
  tools,
  dir: fileURLToPath(new URL("../agent", import.meta.url)),   // its skills; AGENTS.md is not sent
  // auth: { issuer, resource, scopes, verify }               // sign-in: the flow-framework-auth skill
});
createServer((req, res) => void mcp.node(req, res)).listen(8790);   // Streamable HTTP at /mcp
```

- `mcp.fetch(request)` serves a web-standard `Request` instead (Cloudflare Workers, Deno, Bun), so
  it mounts beside the chat agent in one process or runs on its own: it needs no model, channels
  or store.
- Hosts get the skills as the server's instructions (each one's description) and read one with the
  `read_skill` tool. A skill that tells the chat agent to use `send_*` or `share_updates` makes
  no sense to a host: `flow check` warns about it.
- Every part can be changed: `instructions` replaces the instructions, `descriptor(tool, generated)`
  changes any tool's MCP descriptor, `extend(server)` adds handlers of your own (resources,
  prompts) to the SDK's server, `path` moves the endpoint, `allowedHosts` checks the Host header.
- Try it locally with `claude mcp add --transport http acme http://localhost:8790/mcp`.
- Run `npx flow check` from the agent's folder before serving: it refuses tools that cannot be
  described exactly (the `flow-framework-tools` skill lists the rules).

## A CLI for the organization

The same tools as commands, over the organization's MCP server, with the same sign-in and gating.
It runs on Stricli (`@stricli/core`, the framework Sentry's CLI is built on). Every tool is already a
command under its own name (`place_order` is `acme place-order`); a CLI file adds what needs
judgement. Install `@modelcontextprotocol/client@2.3.1` and `@stricli/core@1.3.0` (the versions
Flow Framework pins) and write `src/cli.ts`:

```ts
#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { defineCli, runCli } from "@flow-engineer/flow/cli";

export const cli = defineCli({
  name: "acme",
  server: process.env.ACME_SERVER ?? "https://acme.example.com/mcp",
  description: "Acme's orders and customers",
  groups: { order: "Place and track orders" },
  commands: {
    "order list": { tool: "list_orders", columns: ["order_id", "status", "total"], alias: "orders" },
    "order view": { tool: "get_order", args: ["order_id"], examples: ["acme order view BL-1042 --json"] },
    "order place": { tool: "place_order" },
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await runCli(cli, process.argv.slice(2)));
```

- Words are groups then a verb: `order` is a **command group**, `list`, `view` and `place` its
  subcommands. `acme order` and `acme order -h` list the group's subcommands, `acme order place -h`
  that command's flags and examples, and `acme -h` the groups and top-level commands. A word is a
  group or a command, never both. `groups` gives each group its line in help.
- `args` are the input fields taken as positional arguments, `columns` a list's table, `view` one
  record's fields, `alias` another name, `examples` lines for help. Every other input field is a
  flag (`order_id` is `--order-id`); a list is a repeatable or comma-separated flag; an object or a
  list of objects takes JSON, or `@file.json`, and its help shows the shape
  (`JSON list of {item, size, milk?}`).
- A command of the team's own is any Stricli command: `"report daily": { command: buildCommand({ ... }) }`
  with `buildCommand` from `@stricli/core`; inside it, `this.cli.call(tool, input)` calls the server's
  tools and `this.cli.print(value, { json })` prints like the rest.
- Installed, it is the organization's own command: `"bin": { "acme": "src/cli.ts" }` in its package
  (node runs `.ts` files outside `node_modules`; publish a compiled `.js` bin to npm). While building
  it, run it with `npm run cli -- order -h`: npm takes flags before `--` as its own.
- Every tool command takes `--json` and `--fields a,b`; one that changes things takes `--dry-run`; one
  that may delete or overwrite asks first in a terminal and needs `--yes` without one. Exit codes: 0
  done, 1 the tool failed, 2 wrong command or arguments (with the help to read), 3 sign-in needed, 4
  needs `--yes`, 5 the server could not be reached. `--server <url>` and `--token <token>` work on
  every command. `acme auth login` signs in on the organization's own login (tokens in
  `~/.config/acme/`, mode 600), `ACME_TOKEN` is for CI, `acme tools` lists every tool and schema, and
  `acme skill --write ~/.claude/skills` installs the CLI's SKILL.md, made from the tools and the CLI
  file, for coding agents. For any MCP server without a CLI file, `npx flow cli --server <url> -h`.
- `npx flow check` checks the CLI file against the tools: a command naming a tool that does not
  exist, an `args` field the input lacks, a `columns` or `view` field the output lacks, two commands
  with one name, a word that is both a command and a group, or one of the CLI's own words (`auth`,
  `tools`, `skill`) is an error; a tool no command names is a warning (it keeps its own name).


### Native plugins and standalone MCP

The standalone `/mcp` endpoint includes the skills list and `read_skill`. Native plugins
copy the agent's `agent/skills/` folder and connect to `/mcp/plugin`, which serves tools only,
so a host receives each skill once. Both paths share tools, auth and descriptor overrides.
`mcpServer({ ..., plugin: false })` disables the plugin path; `plugin: { path: "/native" }`
moves it. `handle.plugin` exposes its path and descriptors. Your `instructions` override
applies to both endpoints, and `extend` can add SDK handlers on both.

From the agent folder, run:

```sh
flow plugin --server https://agent.example.com/mcp --out plugins
flow check --plugin plugins
```

`plugins/claude/` uses Claude Code's `.claude-plugin/plugin.json` and `.mcp.json` with
`type: "http"`. `plugins/agent-plugins/` uses Agent Plugins 1.0.0 root `plugin.json` and
`mcp.json` with `type: "streamable-http"`; Codex supports this portable format.
Pass `--name` to override the package name. For a custom plugin route, pass its URL ending
in `/plugin`, or edit the generated MCP config. No token is written into either package.
Regenerate after changing a skill or its assets; `check --plugin` compares content hashes.
Generated files remain plain files in your repository: customize manifests and add components
alongside them. Regeneration rewrites manifests and source skill copies; keep hand-written
skills outside those source paths.

Formats checked 18 October 2026: [Agent Plugins 1.0.0](https://agent-plugins.org/specification),
[OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), and
[Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference).

MCP calls emit `tool.start`/`tool.end` with surface (`mcp`, `mcp-plugin`, `cli`), client name
and version, session, person, duration, outcome and error. CLI calls send command and an
idempotency key in `_meta`; a caller can reuse its key on a retry. `defineCli`'s `version`
sets its client version (default `"1"`). Neither CLI arguments nor trace credentials go in `_meta`.
`mcpServer` uses `FLOW_FRAMEWORK_TRACES_*`, like chat agents, or explicit `traces` options;
`traces: false` disables export without disabling your event sinks. `await handle.flushTraces()`
flushes its bounded background queue. Each tool call is a root trace without a conversation;
arguments and results require `FLOW_FRAMEWORK_TRACES_CONTENT=1`. Legacy clients' initialization
metadata is retained for up to 24 hours in at most 4,096 sessions; bearer tokens are never cached.

### Local playground CLI

To exercise the real CLI on your computer, pass `localCli: { channel: "terminal", config: cli }`
to `play.listen(agent, port, options)` or a locally mounted `play.handler(agent, options)`.
`cli` is the team's existing `defineCli` configuration, with its server URL; the named channel
must exist. This opens an independent CLI session in that tab, with real stdout/stderr, exit
codes, interactive input and confirmation prompts. It does not use the selected test person's
identity. Run `auth login`, open the login link and return, then use commands or `chat` (`/exit`
leaves chat). Reload reconnects. New CLI session discards only this runner's temporary sign-in;
server restart or 30 minutes without browser activity also ends it. Clear output keeps sign-in.
An operation already accepted by the agent may still complete after its client session ends.

Enable this only in local startup code. The runner is off by default, rejects non-loopback or
forwarded connections, and is not part of the hosted test cloud. It calls the actual CLI runner
only locally. Hosted CLI support is deferred pending security review; do not add it to cloud startup
or deployment wiring (that is `flow deploy`). See the hosted CLI TODO in the README. The runner invokes the CLI
without a shell: quoting works, pipelines/expansion do not. The browser cannot override server
or token flags, or use `skill --write` to write onto the developer's computer.
For other embedded clients, `CliConfig.directory` overrides credential/conversation storage;
`CliIO.env` overrides the inherited process environment and `CliIO.signal` cancels sign-in and
terminal HTTP requests. Installed CLI defaults stay unchanged.

### Terminal conversations

`chat` talks directly to the agent, using the same bearer as MCP; it is not an MCP tool. `defineCli({ name: "acme", server, agent: "https://agent.example.com/agent/terminal" })`
overrides the terminal URL; the default is the MCP server's origin plus `/agent/terminal`.
`acme chat "Which orders are ready?" --json` prints one response; `acme chat` reads a TTY until
Ctrl-D or `/exit`. Without a TTY pass a message to `chat` (an interactive chat exits 2); sign-in failures exit 3.
Human chat shows a `You ›` input prompt, a waiting indicator and agent replies under the CLI's
name. `--json` keeps stdout as one JSON response per line, without those labels. Embedded CLIs
can supply `CliIO.lines(prompt?)` and their own output handlers to replace the presentation.
`chat.json` is mode 600 and scoped by terminal endpoint. `--new` forgets the terminal's saved
reference; the agent keeps its one-person history across channels. It does not erase a person's
WhatsApp history. Teams can replace `chat` with their own Stricli command in `commands`.

Mount the optional terminal handler beside MCP (no model or extra dependency in the CLI):

```ts
import { terminalServer } from "@flow-engineer/flow/mcp";
const terminal = terminalServer({ agent: () => agent, auth });
const agent = createAgent({ ...options, channels: [...channels, terminal.channel] });
// Route terminal.path to terminal.fetch(request), and MCP's paths to mcp.fetch(request).
```

`terminalServer` accepts `path` and `channel` overrides. It verifies auth on every POST,
serializes concurrent requests per person, and returns `{ conversationId, replies }` after the
turn settles. The authenticated key becomes the same person that `resolve` returns on other
channels. A body cannot choose its own person; a conversation reference from another person is
refused. Its custom UI uses Markdown and exports turns as channel `cli`.
For your own HTTP adapters, `agent.request({ channel, key, text, conversationId? })` exposes this
without the handler. Supply a verified key and serialize calls for that channel and person.
