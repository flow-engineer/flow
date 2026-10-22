# Flow Framework

**Chat agents that feel like a person texting back**, on WhatsApp, SMS, iMessage, Telegram and your own app.

Flow Framework (`npm i @flow-engineer/flow`). Formerly chinwag: see [Moving from chinwag](#moving-from-chinwag).

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/flow-engineer/flow/blob/main/LICENSE) ![Node 22.18+](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg) ![TypeScript](https://img.shields.io/badge/TypeScript-yes-3178c6.svg)

![Pip, the café example, in the WhatsApp simulator: a double text folded into one reply, a menu lookup, and the order with reply buttons](https://raw.githubusercontent.com/flow-engineer/flow/main/docs/playground.png)

## Why

Agent SDKs are built for agents that work alone on long tasks. Put one in a chat and it shows:

- Someone sends "hi", then "I need to move my booking", and gets two replies, the first already wrong.
- A tool is slow and the chat goes silent for forty seconds.
- They text on SMS, then WhatsApp, and the agent has never met them.
- "Remind me at 9 tomorrow" never arrives, because the agent has no clock.

Flow Framework makes the chat behaviour the default. You write the agent's prompt, skills and tools; Flow Framework handles the conversation.

![What Flow Framework handles: double texts, fast acknowledgements, tools that never stall the chat, one person across channels, each platform's rules, restarts, reminders, nudges, skills on demand, and a playground](https://raw.githubusercontent.com/flow-engineer/flow/main/docs/features.svg)

## Quick start

Node 22.18 or later. Your agent is TypeScript that Node runs as it is, with no build step.

```bash
npx @flow-engineer/flow new my-agent --display-name "My agent" && cd my-agent && npm install
npx @flow-engineer/flow link --channel telegram   # or whatsapp, imessage: signs in; writes Flow's free trial model key and a phone link (or put your own key in .env)
npm start
```

`flow new <name>` makes `./<name>/` from the café example (lowercase letters, digits and dashes); `--display-name` is what people call it, kept as `displayName` in its `package.json`, and a phone reaches it by sending `Hi <that name> (ref <code>)`. Open the link `npm start` prints (it uses `PORT`, else 8788 or the next free port) and text your agent, the café's ordering assistant under the name you gave it (Pip in the example): your starting point; `flow link --display-name <name>` renames it later. Pick a platform at the top (SMS, WhatsApp, iMessage, Telegram, web), and turn on **Debug** to see every tool call and how fast each message was answered. A model call that fails (a wrong or expired key, say) shows in the chat, in Debug and on the terminal. The café's `src/agent.ts` reads its model id from `CAFE_MODEL` (default: the model for the key you set, see [Models](#models)). The new folder has the coding-agent skills in `.claude/skills/` and an `AGENTS.md` pointing at them, so you can tell Claude Code, Codex or any coding agent what to build.

### On your phone, from your laptop

```bash
npx @flow-engineer/flow init                 # the same starter in the current folder; then npm install
npx @flow-engineer/flow link --channel telegram   # signs in (opens the browser), writes its keys and Flow's trial model key into .env, prints a link
npm start                                    # try it in the playground link it prints, then open the phone link and text the agent
npx @flow-engineer/flow status               # what the folder has and lacks
```

Test it first in the playground (the link `npm start` prints: the test people and the channels side by side), then on your phone. `flow chat` (the agent in the terminal) and `npm test -- --synthetic` are how a coding agent checks its own work.

`flow chat` builds the agent from `src/agent.ts` and writes as its first test person, one message per line of stdin. `flow link` signs in and runs `flow setup` when the folder is not set up yet, then prints the link for `--channel telegram` (the default), `whatsapp` or `imessage`; a channel flow.engineer cannot open yet answers with what to do instead. With `FLOW_MESSAGING_KEY` in `.env`, the starter's `npm start` is on Telegram, plus WhatsApp and iMessage when `.env` has their senders, and connects to Flow Messaging by its outbound event stream, so there is no tunnel or public URL, and messages sent while it was stopped arrive when it starts again ([flow-messaging/README.md](flow-messaging/README.md)). Coding agents: [docs/agents.md](docs/agents.md) (https://flow.engineer/flow-framework/agents.md) has the exit codes and `next` steps.

**Shared test numbers and privacy.** The free trial runs on Flow's shared Telegram bot, WhatsApp number and iMessage line. A join code binds that phone to one app, so its messages go only to that app's agent; sending another app's code moves it. Trial chats are test data, kept for the account's retention (30 days by default). Do not use the trial for real customers' data: connect your own number for that.

**Stability.** 0.x: the CLI's commands, `--json` fields and exit codes in [docs/agents.md](docs/agents.md) stay compatible within 0.2.x; a breaking change comes with a minor version bump and a release note. Pin the version in `package.json` for production.

**Host it.** `npx @flow-engineer/flow deploy` puts the agent on Flow's hosting, so it keeps answering while the laptop sleeps: staging first, then `deploy promote` to production; it sends the `.env`'s keys as the agent's secrets itself. `deploy status` shows what is live and its URL, `flow logs` its log lines. It needs the agent's CI key (`FLOW_FRAMEWORK_CLOUD_KEY`, which `flow setup` writes) and a `buildAgent` that passes `options.host` on to `createAgent` ([docs/agents.md](docs/agents.md), "Host it").

### In a folder of your own

```bash
npm init -y && npm pkg set type=module && npm i @flow-engineer/flow
```

`src/main.ts`:

```ts
import { createAgent, openAICompatible, sms, whatsapp } from "@flow-engineer/flow";
import { simulators } from "@flow-engineer/flow/simulators";

// No provider connected yet: only the playground's test people reach the agent.
const notConnected = async () => {
  throw new Error("not connected yet");
};

const play = simulators({ title: "Ada" });
const agent = createAgent({
  files: { "AGENTS.md": "# Ada\n\nYou take table bookings for Luigi's, a small restaurant. Be brief and warm." },
  model: openAICompatible({ model: "anthropic/claude-haiku-5.5" }),
  channels: [whatsapp({ sendMessage: notConnected }), sms({ sendMessage: notConnected })],
  testPeople: [{ name: "Sam", phone: "+15555550102" }],
  events: [play.events],
});
const { url } = await play.listen(agent, 8788);
console.log(`Playground: ${url}/`);
```

```bash
npx @flow-engineer/flow setup      # writes FLOW_KEY (the agent's Flow key, on Flow's trial credit), or: echo "OPENROUTER_API_KEY=sk-or-..." > .env
node --env-file=.env src/main.ts
```

Tests run with `npx @flow-engineer/flow test` (see [Testing](#testing)); `npx @flow-engineer/flow --help` lists everything the command does.

## How a turn works

![One turn: two quick messages fold into one turn, an acknowledgement goes out with the tool call, the tool runs, one answer follows; if they write again while a tool runs, the tool moves to the background and its result comes back later](https://raw.githubusercontent.com/flow-engineer/flow/main/docs/turn.svg)

| When | Flow Framework does |
|---|---|
| They send several messages in a row | Folds them into one turn; a model step in flight restarts with all of them |
| They write | Shows typing at once; the first thing they get is an answer, or an acknowledgement sent with the tool calls |
| The agent calls tools | Runs them in parallel and waits for them, so they get one answer, not an "on it" and a result later |
| They write again while a tool runs | The agent reads it at once; the tool carries on in the background and its result comes back into the chat |
| A tool passes its limit (`deadlineMs`, 60 s by default) | It moves to the background the same way |
| The model writes text without sending it | It is reminded once to send it; text it already sent is not repeated |

## Build an agent

An agent is a prompt, a few skills and plain functions, so a coding agent can build and change one end to end. This is what `flow new` makes:

```
my-agent/
  agent/AGENTS.md                the agent's prompt
  agent/skills/<name>/SKILL.md   rules for one kind of request, loaded only when needed
  src/tools.ts                   tools: plain functions with a zod input
  src/agent.ts                   buildAgent(): the one place the agent is built
  src/main.ts                    runs it in the playground
  tests/scenarios/*.yaml         tests: one situation each
  tests/tools/*.yaml             how each tool behaves in tests
```

**Tools** are functions with a zod input. Return anything; it is shown to the model as JSON.

```ts
import { tool, z } from "@flow-engineer/flow";

export const tools = [
  tool({
    name: "get_menu",
    description: "The full menu: items, sizes with prices, milk options and allergens.",
    input: z.object({}),
    run: async () => ({ menu: await pos.menu() }),
  }),
];
```

**The agent** is built in one function, which the playground and the tests both call:

```ts
import { fileURLToPath } from "node:url";
import { createAgent, openAICompatible, type EventSink, type Model, type Tool } from "@flow-engineer/flow";
import { tools as myTools } from "./tools.ts";

export const tools = myTools;

export function buildAgent(options: { model?: Model; events?: EventSink[]; tools?: Tool[] } = {}) {
  return createAgent({
    dir: fileURLToPath(new URL("../agent", import.meta.url)),
    model: options.model ?? openAICompatible({ model: "anthropic/claude-haiku-5.5" }),
    tools: options.tools ?? myTools,
    events: options.events ?? [],
  });
}
```

**The playground** serves it in every simulator:

```ts
import { simulators } from "@flow-engineer/flow/simulators";
import { buildAgent } from "./agent.ts";

const play = simulators({ title: "My agent" });
await play.listen(buildAgent({ events: [play.events] }), 8788);
```

Each simulator looks and behaves like its app: WhatsApp's bubbles, ticks, reply buttons, list sheet and swipeable carousels; Telegram's inline keyboards and Markdown; iMessage's tapbacks and Delivered/Read; Google Messages' segments and carrier keywords. The person sends photos, documents and voice notes (recorded from the microphone, or picked, pasted or dropped), and the agent gets them as the real channel would hand them over. In Debug mode every message also shows what the platform's API carried: the WhatsApp Cloud API webhook or Graph request, the Telegram Bot API update or call, the SMS provider's (Twilio's) fields, or Flow Messaging's for iMessage.

The playground plays only the test people you declare (`testPeople: [{ name, phone }]`) on the agent's own channels. A test person is a real person to the agent: the same identity, `resolve` and history as if they wrote from their phone, one conversation on every channel, and "Clear history" to start again. Replies go back where the person last wrote from, the playground or the real channel. The playground's Person tab moves the agent's clock (`simulators({ clock: playgroundClock() })`, with `createAgent({ now: clock.now })`), lists what is scheduled or held for them, sets their time zone and quiet hours, and sends nudges with every field the API takes. Locally it answers only on localhost, and its API only its own page, so a site you visit cannot send it messages. On a deployed agent, mount `play.handler(agent, { token })`: it refuses requests without the token (at least 32 characters), swaps `?token=` for a cookie on the playground's path, and limits wrong tries.

To test account sign-in, give `simulators` an `authentication({ channel, visitor })` hook. The person picker gains **New user · signed out**: the hook returns a sign-in URL until the application verifies the visitor, then its account `key` and channel `address`. The playground uses that account's existing conversation and keeps replies inside the simulator. Each interface authenticates independently; verified-phone channels can resolve the account directly. Existing test people keep their identity shortcut. See [setting up authentication](coding-agents/auth-skill.md#exercise-sign-in-in-the-playground).

`AGENTS.md` says what the agent is for and what it may and may not do. Leave messaging out of it: Flow Framework adds how to talk on each channel (its send tool, reactions, formatting, acknowledging first). A skill's `SKILL.md` starts with a `name` and `description`; the agent sees every description and loads a skill when it needs it (`inlineSkills: true` puts them all in the prompt instead).

## Channels and people

![One person: SMS and WhatsApp from the same number, and a signed-in app session, all lead to one conversation; each reply goes out on the channel the message came in on](https://raw.githubusercontent.com/flow-engineer/flow/main/docs/one-person.svg)

A channel is a definition: Flow Framework knows the platform's rules, your provider only says how to send.

```ts
const wa = whatsapp({
  sendMessage: (to, m) => api.send(to, m),            // m: { text, replyTo?, buttons?: (label | { id, label })[], list?, link?, image?: { url } | { fileId } }
  sendCarousel: (to, c) => api.carousel(to, c),       // optional: offers carousels; c: { text, cards: [{ image, text?, buttons? | link? }] }
  react: (to, id, emoji) => api.react(to, id, emoji),
});
const text = sms({ sendMessage: (to, m) => smsApi.send(to, m.text) });
const app = customUI("app", {
  params: { app_link: z.string().describe("A link a tool result gave you") },
  instructions: "Only fill app_link with a URL from a tool result; never make one up.",
  sendMessage: (to, m) => myApp.push(to, m),          // m.text, m.app_link
});

const agent = createAgent({
  dir, model, tools,
  channels: [wa, text, app],
  database: sqlite("data/agent.db"),
  resolve: ({ channel, address }) => members.idFor(channel, address),
  timeZone: "America/New_York",
});
await agent.resume();
await agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
```

- **Reply buttons carry their own id:** a button is a label, or `{ id, label }` when taps must be told apart (a carousel's cards may all say "Details", with ids `details:a`, `details:b`). A tap comes back as `choice: { id, title }`, and the model reads `tapped] Details (details:b)`. Ids are 1 to 64 bytes, unique within a message and across a carousel; labels may repeat. A channel whose `info.buttonIds` is true gives the id back on the tap (Flow Messaging's WhatsApp and Telegram, the simulators); elsewhere a provider may know only the label, so number labels yourself where taps must be told apart.
- **Each platform's rules are built in:** WhatsApp buttons, lists, replies, reactions and its 24-hour window; SMS as plain text in segments; your app's own fields. Features your provider lacks are never offered to the model.
- **What the platform refuses is refused before it goes,** with the same error Flow Messaging gives (`content.cards[0].text has more than 2 line breaks.`), in the playground, the test cloud and production alike, and the agent sends again. The limits are one table, `CONTENT_LIMITS`; `contentRefusal(info, outbound)` checks one send.
- **Your own checks go in `beforeSend`,** not in a wrapper around a channel's send (see [`createAgent` options](#createagent-options)): what it returns is what is checked, sent and recorded.
- **One person, one conversation.** The same number on SMS and WhatsApp is one person, however each provider writes it (`+1 555 010 0100`, `15550100100`: both are `+15550100100`), also when their first messages on both arrive at once. If your SMS provider gives national numbers (`098765 43210`), set `createAgent({ defaultCountryCode: "+91" })`: on every phone channel but WhatsApp, a number with no `+` or `00` is then read as that country's (its trunk 0 dropped), so it joins `919876543210` on WhatsApp; without it, bare digits are taken as international. Anything else (your app, your website) is joined only by your `resolve`. Flow Framework never guesses. A tool sees who the person is as `context.person`, the stable id to key their data by: `key:<your resolve's value>`, else `phone:<E.164>` (`phone:+15550100100`), else `<channel>:<address>`. `context.key` is your `resolve`'s value as it returned it (`customer-7`), or null when the person is known only by phone or channel, so `members.get(context.key)` finds them.
- **The agent gets one send tool per channel** (`send_sms`, `send_whatsapp`, `send_app`) and answers each message where it came in. `instructions` guide the agent on that channel only.

## What the agent knows about the person

Give the agent what your business knows about someone (their account, plan, orders, preferences) with `profile`. Flow Framework offers it as a built-in tool, `get_user_profile`, which the agent calls when it needs it; it has no input, so it is always about the person in this conversation:

```ts
createAgent({
  // ...
  resolve: ({ channel, address }) => members.idFor(channel, address),
  profile: async ({ person }) => members.profile(person), // person: what tools get as context.person
});
```

A tool of yours named `get_user_profile` is used instead. In `flow test` runs the profile is played by the test cloud from the scenario's `world`, like your tools, so a test never reads a real one.

`context(conversationId)` is still there for small facts at hand, added to the system prompt at the start of every turn. It runs before every reply, so a lookup in it (an API call, a slow query) delays every reply: put those in `profile` or a tool. What is the same for everyone (opening hours, policies) belongs in the agent's `AGENTS.md`.

## Time zones

Flow Framework tells the agent the time at every turn: in the person's time zone when it is known, else in the business's (`timeZone`), saying theirs is not known. A person's zone is never guessed from the business's. It is known when:

- **You set it.** Many businesses already know it: `await agent.setTimeZone({ to: { channel: "sms", address: "+15550100100" }, timeZone: "Asia/Kolkata" })`, or over HTTP (below). It answers `{ status: "set" }`, or `{ status: "refused", reason: "unknown_person" }` for someone who has never written; a name that is not an IANA zone throws.
- **They say it.** When they name a place for a reminder, the agent keeps their zone.

Without it, a reminder at a clock time ("at 9 tomorrow") makes the agent ask where they are first; one "in 30 minutes" needs no zone. A no-contact rule that lasts "until Friday" ends where Friday ends last (UTC-12), so it never lifts early.

## Reminders and nudges

Built in, so you don't write them as tools:

- **Scheduled messages.** People ask ("remind me at 9 tomorrow"); the agent schedules, lists and cancels them in the person's own time zone. When one is due, the agent writes it in the context of the chat.
- **No-contact rules.** "No promotions", "nothing before 9am": the agent keeps them per person, and they apply on every channel to everything the business starts, sent now or scheduled.
- **STOP, START and HELP.** On SMS (STOP; START; HELP, INFO) and WhatsApp (STOP, UNSUBSCRIBE; START), a message that is only the keyword is answered with no model call. STOP keeps a hard rule: no nudge, scheduled message or reminder goes to that person, on any channel, until they text START; the agent still answers when they write, and cannot lift it. Set the replies, or other words, with `sms(provider, { keywords: { replies: { stop, start, help } } })` (`keywords: false` turns them off); without a `help` reply the agent answers HELP. A reply left out sends nothing, for providers that send their own. Which words carriers or regulators expect differs by country (some US carrier rules expect STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT too), so check your market's rules; Flow Framework's default on SMS is STOP only. For the fuller list, `sms(provider, { keywords: US_CARRIER_KEYWORDS })` (with your replies: `{ ...US_CARRIER_KEYWORDS, replies }`), or name your own words: `keywords: { stop: ["STOP", "ARRET"] }`.

  Your `intercept` sees these words first, with `message.keyword` set to `"stop"`, `"start"` or `"help"` (`null` for any other message), so an agent that keeps its own opt-out state can update it. `message.channel` is the channel every message came in on, by its name in `channels`. Flow Framework keeps or lifts the STOP whatever the hook returns, and also when it throws; a reply the hook returns goes instead of Flow Framework's, never both. The keyword and its reply are kept in the history and the transcript, as any message answered without the model is. An agent that keeps its own opt-out for texts only:

  ```ts
  const optedOutOfSms = new Set<string>();
  createAgent({
    // ...
    intercept: (conversationId, text, message) => {
      if (message.channel !== "sms") return null; // a STOP on WhatsApp is Flow Framework's alone
      if (message.keyword === "stop") optedOutOfSms.add(conversationId);
      if (message.keyword === "start") optedOutOfSms.delete(conversationId);
      return null; // Flow Framework's own reply goes
    },
  });
  ```
- **Nudges, messages your business starts:**

```ts
await agent.nudge({ to: { channel: "whatsapp", address: "+15550100100" }, prompt: "Their order is ready for pickup." });
```

`text` sends it as written, `prompt` lets the agent write it (or decide not to), `template` sends a WhatsApp template with its header, body and button values (`{ name, header?, body?: [...], buttons?: [{ index, value }] }`; a declared one sent with the wrong values throws before it goes). `at` sends it later, and `idempotencyKey` makes a retry safe: the same key sends once, also from two calls at once, and every call gets the first one's result. A nudge a no-contact rule covers, or to someone who texted STOP, is dropped. `nudge()` always settles, with `status` `sent`, `silent`, `dropped`, `refused`, `failed`, `scheduled`, `held` or `expired` and a `reason`: when the model fails during a nudge, it is `failed`, and the person is sent nothing (only someone who wrote is told something went wrong).

Prefer `prompt`: the agent writes it in the context of the chat, in their language, and may hold back what no longer fits. Use `text` only where the wording must be exact (a code, a legal notice), and `template` for campaigns and notifications you set up with Meta, which go as they are.

### WhatsApp's 24-hour window

Outside it, WhatsApp delivers only templates. Declare a fallback, a template with no values that says something is waiting ("You have a new message. Reply to see it."), and a nudge still reaches the person:

```ts
createAgent({
  // ...
  templates: [
    { name: "message_waiting", language: "en", category: "utility", body: "You have a new message. Reply to see it." },
    { name: "order_shipped", language: "en", category: "utility", body: "Hi {{1}}, your order {{2}} has shipped." },
  ],
  fallbackTemplate: { name: "message_waiting" },
});
```

- **A `prompt` nudge**: the agent is told the window is closed and may send one of your templates that says the same thing, its values filled in (`send_template`, built in).
- **When none fits** (or for a `text` nudge), Flow Framework sends the fallback, and the nudge is held (`held`, `window_closed`) until they reply, when the agent tells them (or the text goes as written). Past its `expiresAt` (24 hours by default) it expires.
- **Each fallback emits a `template.missing` event** with what the nudge said: the messages worth a template of their own.

Without a fallback, a `text` or `prompt` nudge outside the window is refused (`outside_window`). A template nudge always goes as it is. Meta decides each template's category from its text and may charge or limit it as marketing: check yours.

### Quiet hours

What the business starts waits for each person's quiet hours: 22:00 to 07:00 in their own time by default (`createAgent({ quietHours: { from: "21:00", to: "08:00" } })` to change it, `false` for none). They apply only where the person's time zone is known (see [Time zones](#time-zones)): without it nothing is held.

- **A nudge in their quiet hours is held** (`status: "held"`), and goes when the hours end or as soon as they write, whichever comes first. Everything held reaches one turn: the agent writes one short message for all of it, not a text each, after answering whatever they just asked. A `text` or template nudge goes as written.
- **It can go stale.** A held nudge past its `expiresAt` (default 24 hours) is dropped as `expired`; give a short one to "your table is ready". `respectQuietHours: false` sends it now, quiet hours or not, for what cannot wait (a security alert).
- **A scheduled nudge** (`at`) that comes due in their quiet hours moves to when they end.
- **Their own reminders** go at the time they asked for, quiet hours or not, unless the agent marks one as able to wait (`respect_quiet_hours` on `schedule_message`: "check for new listings and let me know"); a repeat like that skips its runs in their quiet hours.
- **People set their own.** "Not after 9pm" sets theirs (`set_quiet_hours`, built in), "no messages this week" pauses everything the business starts (`pause_messages`), with no model call to check either. Your backend sets or reads them too: `agent.setQuietHours({ to, quietHours })`, `agent.contact(to)`.

The contact record (`agent.contact(to)`, or `GET /people/contact`) is what the agent goes by for a person: `timeZone` and `timeZoneSource` (`business` or `person`), `quietHours` and `quietHoursSource` (`person`, `agent`, `off`, or `no_time_zone`), `stop`, `pauses` and `topics` (what they asked not to be messaged about, in their words).

Rules on when marketing may be sent differ by country, and by US state: check yours. US telemarketing rules, as far as we know, allow calls and texts only from 8am to 9pm the recipient's time, which is narrower than the default.

### Nudges over HTTP

When the system that decides to nudge is a separate service, mount `nudgeHandler` in the agent's server and call it over HTTP. It is a plain `(req, res)` handler; hand it the requests under its `base` (`/nudges` by default; anything else gets 404). It needs a token of at least 32 characters, from a secret, or it throws at setup:

```ts
import { createServer } from "node:http";
import { nudgeHandler } from "@flow-engineer/flow";

const nudges = nudgeHandler(agent, { token: process.env.NUDGE_TOKEN! });
createServer((req, res) => {
  if (req.url?.startsWith("/nudges")) return nudges(req, res);
  // ... your webhooks
}).listen(3000);
```

- `POST /nudges` with `{ to: { channel, address }, text | prompt | template, at?, idempotency_key?, respect_quiet_hours?, expires_at? }`: exactly one of `text`, `prompt` or `template`, as in `agent.nudge()`; `at` is milliseconds since the epoch; unknown fields are refused; at most 16 KB. It answers `202 { id, status, reason? }` as soon as the nudge is recorded, without waiting for the send or the agent's turn: usually `queued`. What is decided as it is recorded is in that answer too, still a 202, since it is the nudge's state and not an error: `refused` (`unknown_person`, with `id` `""` since nothing is recorded; `outside_window`), `dropped` (they texted STOP, or paused messages), `held` (their quiet hours) or `scheduled`. A bad body, a channel the agent does not have, or a declared template's wrong values get `400 { error }`.
- `GET /nudges/<id>`: `200 { id, status, reason? }`, its state now: `queued`, `sent`, `silent`, `dropped`, `refused`, `failed`, `scheduled`, `held` or `expired`. An id it never recorded gets 404.
- The same `idempotency_key` returns the first nudge's id and its state now, and sends once.
- Every request needs `Authorization: Bearer <token>`, compared in constant time; wrong tokens are limited per address (10 in 15 minutes, then 429), as on the playground. Answers are JSON with `cache-control: no-store`. Each accepted nudge is logged (id, status, channel, kind, time and the caller's IP address), never its text or the token.

```sh
curl -s -X POST https://agent.example.com/nudges \
  -H "Authorization: Bearer $NUDGE_TOKEN" -H "content-type: application/json" \
  -d '{"to":{"channel":"whatsapp","address":"+15550100100"},"prompt":"Their order is ready for pickup.","idempotency_key":"order-1042-ready"}'
# {"id":"n_3f9c2a1b","status":"queued"}
curl -s https://agent.example.com/nudges/n_3f9c2a1b -H "Authorization: Bearer $NUDGE_TOKEN"
# {"id":"n_3f9c2a1b","status":"sent"}
```

What you know about people goes the same way, for a business that keeps it in its own database: mount `peopleHandler(agent, { token })` and

- `PUT /people/time-zone` with `{ to: { channel, address }, time_zone }`;
- `PUT /people/quiet-hours` with `{ to, quiet_hours: { from, to } | "off" | null }` (null: back to the agent's);
- `GET /people/contact?channel=&address=`: their contact record (below).

Each answers `200`, or `404 { status: "refused", reason: "unknown_person" }` for someone who has never written, or `400 { error }` (a name that is not a time zone, hours that are not `HH:MM`).

```sh
curl -s -X PUT https://agent.example.com/people/time-zone \
  -H "Authorization: Bearer $NUDGE_TOKEN" -H "content-type: application/json" \
  -d '{"to":{"channel":"sms","address":"+15550100100"},"time_zone":"Asia/Kolkata"}'
# {"status":"set"}
```

The contract is [`spec/nudges.openapi.yaml`](spec/nudges.openapi.yaml). In code, `agent.recordNudge(input)` is the same early answer and `agent.nudgeState(id)` the same read.

## State, restarts and hosting

- Everything is stored as it happens: history, messages not yet handled, background tools, schedules. SQLite is built in (`sqlite("file.db")`; in memory by default). Postgres: `postgres(pool)` over your own node-postgres pool. Any other engine: implement the three-method `Database` interface, or pass a whole `store` of your own.
- After a restart, `await agent.resume()` carries on: cut-off turns run again, and background tools that were running are reported as interrupted, never silently rerun. A tool's `context.idempotencyKey` is the same when the agent calls it again with the same input in that turn, so your backend can do it once; `context.callId` and `context.signal` (aborted when the person is forgotten) are there too.
- Pass the provider's own id as `messageId` to `agent.message()`: a webhook the provider sends again is taken once. Ids are kept 7 days (`keepMessageIdsDays`); once an hour one runner deletes older ones, a batch at a time, on the scheduled messages' timer.
- Run one copy of an agent per database. Scheduled messages, upkeep and a provider's retried webhooks are claimed in the database, so they happen once whichever copy takes them; a conversation lives in one process at a time (its turn, folded double texts, background tools): the copy working on it holds its lease in the database, renewed while it is busy, and another copy leaves it alone, so the old and new copy side by side during a deploy never answer one message twice. A copy that dies mid-turn leaves the turn to another once its lease runs out (15 s). Each copy is a `runner` (createAgent's option, else `FLOW_RUNNER`, else the host's name, with a random suffix), named on every event. On a platform that adds instances under load, still set it to exactly one instance, kept warm, with CPU always on, and use a durable `database`.
- `agent.status()` says whether anything is running and for how long it has been idle, so your platform can stop idle agents and start them on the next message.
- Every message, turn, model call (tokens and cost), tool and schedule is an event. Send events wherever you like; `jsonlSink(path)` writes them to a file. An `EventSink` is a function that gets each event (`{ type, conversationId, at, runner, ... }`) and must not throw; `turn.start` and `turn.end` carry the turn's number (`turn`), the same when a turn cut off by a restart runs again:

  ```ts
  const log: EventSink = (event) => console.log(event.type, event.conversationId);
  createAgent({ /* ... */ events: [log] });
  ```
- Traces: with `FLOW_FRAMEWORK_TRACES_KEY` set, every turn is posted as an OTLP/JSON trace to `<url>/v1/traces`, where the URL is `FLOW_FRAMEWORK_TRACES_URL`, else https://flow.engineer/observe (the trace key is made there). `FLOW_FRAMEWORK_TRACES_CONTENT=1` adds what was written; without it, metadata only. Under `flow test` every trace is marked as a test's (`chinwag.run_kind` "test" and the session as `chinwag.test.session`; otherwise `chinwag.run_kind` is "production"), so the dashboard can keep tests apart from real conversations.

## Testing

Write tests as situations, not scripts. A model plays the person, another plays your tools from the scenario's world, and a judge grades the run.

```yaml
id: latte-correction
channels: [whatsapp]
person:
  persona: Sam, in a hurry; types in short bursts.
  goal: Get a large oat latte for pickup, under the name Sam.
opening:
  - say: "can i get a large latte"
  - say: "oat milk actually"
    after_ms: 1200
world: The point of sale is slow this morning, but orders go through.
expect:
  outcome:
    - Exactly one order is placed, for one large latte with oat milk.
  judge:
    - The agent asks Sam to confirm before placing the order.
```

`expect.calls` and `expect.never` name tools that must or must not be called, checked by code from the recorded calls. An opening step `restart: crash` or `restart: deploy` restarts the agent mid-conversation on the same store, and the cloud checks that every message was answered once and no turn was lost. `now` and `timezone` set the test's clock, and dates in test files are written against it (`{{now + 1d | date}}`), so they never go stale ([coding-agents/test-skill.md](coding-agents/test-skill.md)). `tests/tools/*.yaml` describe how each tool behaves (normal, slow, each error). Run the suite from the agent's folder:

```bash
npx @flow-engineer/flow test --cloud https://flow.engineer/observe --synthetic --runs 3 --only latte-correction
```

Your agent stays on your machine with its own model and key; the test cloud ([get one](#get-a-test-cloud)) plays the person and the tools and judges each run. The cloud is a hosted service, not part of this package. The command prints pass or fail per run, with the judge's reasons, the cost, and a link to watch each conversation. Before anything is sent it reads every test file as the cloud does, and a mistake stops it with the file and line (`tests/scenarios/latte-correction.yaml:3: person.goal: missing`).

Exit status:

| Exit | Meaning |
|---|---|
| 0 | Every run passed, or was flaky (without `--strict`). |
| 1 | A run failed (with `--strict`, or was flaky). Or nothing was sent: a wrong flag, a test file that does not parse, no `FLOW_FRAMEWORK_CLOUD_KEY`; the message is printed on its own. |
| 2 | The connection, the tunnel or the stream failed (before or after the session opened), the cloud answered 5xx or no JSON, the cloud ended the session for its own failure, or runs errored (the cloud could not play or judge them) or were not played (the session ended early), and none failed. |
| 3 | The cloud refused: the open (a bad or wrong key, 401/403; an invalid request, 400; busy, 429 `rate_limited`; the spend cap, 429 `spend_cap`; 503 `capacity`), or it ended the session for the spend cap or capacity. |
| 130 | Interrupted (Ctrl-C). |

A busy cloud's refused open (429 other than the spend cap, or 503 `capacity`) with a Retry-After of 60 s or less is sent once more after it, with one line saying so; the spend cap never is. On a cloud that resumes, a dropped stream is opened again for up to 2 minutes, picking up after the last command. On a cloud that can re-open, a session the cloud lost is opened once more for only the runs with no result (the log names them, since they are played and paid for again), and the report covers both sessions with both dashboard links. Whenever a session ends before every run played (the tunnel, the stream or the connection failed, the cloud stopped it, or its summary left runs out), the runs that had already finished are printed, then `N of M runs finished before the session ended early (K not played): <reason>`, with the cloud's error as the reason when it sent one, then the dashboard link; it exits 2 (3 when the cloud stopped it for the spend cap or capacity). Ctrl-C prints that same partial report, says the cloud keeps playing until it is stopped from the dashboard, and exits 130.

**Flaky runs.** The cloud plays a run that failed once more. When the second play passes the run is flaky: its line reads `FLAKY`, with `played again: passed <watch>` under it, and the summary lists it in its own section (`1 flaky (failed once, passed when played again):` with both watch links), apart from the failures. A flaky run does not fail the session (exit 0 when it is all that did not pass); `--strict` counts it as failed (exit 1). When the second play fails too, the run failed. The cloud also replays the person's, the tools' and the judge's stored answers for a scenario it has played unchanged, so runs vary less and `--runs 3` with a "2 of 3" bar should rarely be needed; `--fresh` plays every simulator anew. An older cloud does neither, and the output is as before.

Each run's line carries its id (`FAIL  latte-correction #1 (whatsapp) trn_…: 6 turns, …`). `--dotenv <path>` reads the environment from that file instead of the folder's `.env` (variables already set still win; no value is printed), and `--verbose` also prints slow event uploads.

`--json` prints one JSON document on stdout when the command ends, on every exit once its flags are read; every other line goes to stderr:

```json
{
  "version": 1, "outcome": "failed", "exitCode": 1,
  "sessionId": "tse_…", "agent": "agt_…", "dashboard": "https://…", "suiteHash": "…",
  "error": null,
  "counts": { "runs": 2, "passed": 1, "failed": 1, "flaky": 0, "errored": 0, "notPlayed": 0 },
  "strict": false,
  "costUsd": { "agent": 0.0123, "test": 0.0456 },
  "runs": [
    { "runId": "trn_…", "scenario": "latte-correction", "channel": "whatsapp", "run": 1, "verdict": "failed",
      "error": null, "ended": "goal_met", "turns": 6, "watch": "https://…",
      "failedChecks": [{ "kind": "judge", "text": "The agent asks Sam to confirm before placing the order.", "reason": "…" }],
      "invalid": null, "rerun": { "runId": "trn_…", "passed": false, "watch": "https://…" }, "label": "failing",
      "replayed": { "person": 3, "tools": 1, "judge": 0 } }
  ],
  "invalid": [],
  "sessionInvalid": null
}
```

`outcome` is `passed` (exit 0), `failed` or `invalid` (1), `errored` or `transport` (2), `refused` (3) or `interrupted` (130). A run's `verdict` is `errored` whenever the cloud names an `error` for it (such as `judge_failed`, `simulator_failed` or `spend_cap`), whatever it `ended` as: the cloud could not play or judge it, so it says nothing about the agent. Its line reads `ERROR` instead of `PASS` or `FAIL`, and the run's `error` is that code (else `null`). A run's `verdict` is `flaky` when it failed and passed when the cloud played it again; `rerun` is that second play (`{ "runId", "passed", "watch" }`, else `null`), `label` is `flaky` or `failing` (it failed again) on a run played again (else `null`), and `replayed` counts the stored simulator answers the run replayed (else `null`). The second play is never a run of its own in `runs` or `counts`. `counts.failed` leaves flaky runs out unless `--strict` (`strict: true`); `counts.flaky` counts them. `error` is `{ "message", "status", "type", "retryAfterSeconds" }` when the session did not finish (`type` is the cloud's code, such as `spend_cap`; the others are `null` when it did not say).

A scenario the cloud cannot play (a key it does not know, a value it cannot read) does not stop the others: its runs are `errored` with `error` `scenario_invalid` and `invalid` `{ "path", "reason" }` (the reason starts `unsupported:` when the cloud does not know a key), its line reads `INVALID` with the file and what is wrong, and the top-level `invalid` lists each such scenario once as `{ "scenario", "path", "reason" }`. When the cloud ends the whole session `scenario_invalid` (a tools or checks file it cannot read, or an older cloud), `sessionInvalid` is `{ "reason", "olderCloud", "sent" }`: what the cloud said after the code (else `null`), whether that suggests a cloud older than this client, and the scenarios sent as `{ "scenario", "path" }`; the same lines are printed.

`--only latte-correction,order-fails` runs only those scenarios (file names without `.yaml`); every tool file still goes. Once the session has opened, every exit (0, 1, 2, 3 or 130) writes `.flow/last-session.json` in the agent's folder and prints its path; `flow new` git-ignores `.flow/`. It holds what each run ended as and the judge's reasons, never the messages (a reason can quote one, which is why the file stays on your machine; the suite is synthetic by `--synthetic`):

```json
{
  "sessionId": "…", "agent": "agt_…", "dashboard": "https://…", "suiteHash": "…", "endedAt": "2026-10-16T09:12:03.000Z",
  "ended": "finished",
  "only": null,
  "runs": [
    { "scenario": "latte-correction", "channel": "whatsapp", "run": 1, "runId": "trn_…", "verdict": "failed",
      "failedChecks": [{ "kind": "judge", "text": "The agent asks Sam to confirm before placing the order.", "reason": "…" }] }
  ]
}
```

A run of a scenario the cloud could not play also has `invalid` (`{ "path", "reason" }`), and a session the cloud ended `scenario_invalid` has `sessionInvalid`, as in `--json`.

`ended` is `finished`, `stopped` (the session broke off or the cloud stopped it) or `interrupted`. `agent` is the cloud's id for the agent (a hosted cloud names it), which `flow show` reads. `only` is the scenarios the session was limited to, `null` for the whole suite. `verdict` is `passed`, `failed`, `flaky` (failed, then passed when the cloud played it again), `errored` (the cloud could not play or judge the run) or `not_played` (the session ended first; its `runId` is `null`).

`flow show <run-id>` prints one run's record from the cloud, read with `FLOW_FRAMEWORK_CLOUD_KEY`: the verdict, every check with the judge's reason, then the conversation in time order with each tool call the simulator played (its input, output and what it changed). `flow show last` picks the first run in `.flow/last-session.json` that did not pass (its first run when all passed) and names the others. `--json` prints the record exactly as the cloud answered it. It exits 0 when it printed; 1 for a wrong flag, no key or last session, no such run (404) or one past the 30 days runs are kept (410); 2 when the cloud did not answer or answered 5xx; 3 when it refused the key (401, 403) or is busy (429).

`--failed` runs again only the scenarios that did not pass in that file (failed, flaky, errored or not played), on every channel each plays: a scenario's channels are part of its file, so one channel cannot be picked alone. It goes with `--runs`; with `--only` it stops and says to pick one, since the two would each pick the scenarios. With nothing to run again it prints `Nothing failed in the last session (<id>).` and exits 0 (and says when that session ran only some scenarios); with no file it says to run `flow test` first and exits 1. The loop, for you or a coding agent:

```bash
npx @flow-engineer/flow test --synthetic           # the whole suite
# fix what failed
npx @flow-engineer/flow show last                  # why: the judge's reasons, the conversation and the tool calls
npx @flow-engineer/flow test --synthetic --failed  # only what did not pass; again until it exits 0
npx @flow-engineer/flow test --synthetic           # the whole suite once more before you finish
```

### Get a test cloud

The quick way: `npx @flow-engineer/flow login` (it opens the browser and waits up to 120 s; `npx @flow-engineer/flow login --wait` waits again for the same code, so a coding agent can run it), then `npx @flow-engineer/flow setup` in the agent's folder, which
writes `FLOW_FRAMEWORK_CLOUD_KEY` (and the traces and Flow Messaging keys, the join code and its
`FLOW_FRAMEWORK_TRY_URL`, and the shared Telegram, WhatsApp and iMessage senders that are open) into `.env`, filling names `.env` has with no value and setting it to mode 0600; `npx @flow-engineer/flow link` then prints that link to chat with the agent from a phone (and does the sign-in and setup itself when they have not been done). On WhatsApp and iMessage the agent replies only after you write first (WhatsApp: within 24 hours of your last message). The sign-in token is sent only to the server that issued it, over https.
Always name the package: `npx flow` on its own fetches another npm package. By hand:

1. Sign in at https://flow.engineer/observe (Google, GitHub or an email link).
2. Workspace → New agent.
3. On the agent's Developers page, "Make a CI key". It starts with `oci_` and is shown once.
4. Put it in the agent's `.env` as `FLOW_FRAMEWORK_CLOUD_KEY` (never on the command line).
5. `npx @flow-engineer/flow test --cloud https://flow.engineer/observe --synthetic` from the agent's folder (`--cloud` is that address by default).

Your agent runs on your machine with your own model key. The cloud's person simulator, tool simulator and judge are free within the workspace's limits: runs at once per session, sessions at once and a daily test budget. They depend on the workspace; `flow test` prints them on one line when a session opens (`--json` reports them as `limits`); test data only (`--synthetic`), and records are deleted after 30 days.

`--cloud` (or `FLOW_FRAMEWORK_CLOUD`) points at another test cloud. A hosted cloud takes its key in `FLOW_FRAMEWORK_CLOUD_KEY` and `--synthetic`, your attestation that the test files hold no real customer data; without the key the command stops and says where to make one.

### Test an agent you already have

An agent built on any framework is tested through an HTTP endpoint, with no rewrite. It needs a test cloud like any run (see [Get a test cloud](#get-a-test-cloud)): `FLOW_FRAMEWORK_CLOUD_KEY` and `--synthetic` for the hosted one, the default, or `--cloud` for another. From a folder with `tests/scenarios/*.yaml`, with your agent running:

```bash
npx @flow-engineer/flow test --agent-url http://localhost:3000/flow --cloud https://flow.engineer/observe --synthetic
```

Before the session opens, the command sends one `HEAD` request to the URL (never a message), and stops with "Could not reach your agent at <url>" if nothing answers; any HTTP status counts as an answer.

`flow test` runs on your machine and POSTs each of the person's messages to that URL from there, so your agent never has to be reachable from the internet (`http://localhost` is fine). The request is JSON, with `authorization: Bearer <FLOW_FRAMEWORK_AGENT_TOKEN>` when that variable is set:

```json
{
  "conversationId": "whatsapp:ses_8f2a.opening-hours.whatsapp.1",
  "messageId": "m1",
  "channel": "whatsapp",
  "message": { "text": "hi, what time are you open today?", "attachments": [{ "kind": "image", "mime": "image/jpeg", "name": "receipt.jpg", "data": "<base64>" }] }
}
```

Keep the conversation's history by `conversationId`, as you would per phone number. `channel` is the platform the run plays (`whatsapp`, `sms`, `imessage`, `telegram`, `web`), or the name you give with `--channel`. `message.text` is `""` when the person only sent a file; a tapped button or list row also comes as `message.choice` (`{ id, title }`, the button's or row's id), a quoted message as `message.replyTo`. Answer `200` with the replies to send, in order, in the shape a Flow Framework agent sends (`{ "type": "message", "text", "buttons"? (labels, or `{ id, label }`), "list"?, "link"?, "image"?, "replyTo"? }`, `{ "type": "reaction", "emoji", "messageId" }`, `{ "type": "template", ... }`, ...); `[]` sends nothing:

```json
{ "replies": [{ "type": "message", "text": "We're open 8am to 6pm today.", "buttons": ["Order ahead"] }] }
```

A minimal server, with no dependencies (the whole file is [`examples/http-agent/server.mjs`](https://github.com/flow-engineer/flow/blob/main/examples/http-agent/server.mjs), with a test scenario beside it; it also ships in the package, in `node_modules/@flow-engineer/flow/examples/http-agent`):

```js
import { createServer } from "node:http";

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { conversationId, channel, message } = JSON.parse(body);
  const text = await myAgent.reply(conversationId, message.text); // your framework here
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ replies: [{ type: "message", text }] }));
}).listen(3000);
```

Each reply is checked against what the run's platform can show, as a Flow Framework agent's is: one that does not fit (buttons on SMS, text over the limit) is not sent, and the run says why. A status other than 200, a body that is not `{ "replies": [...] }` or no answer within 60 seconds (`--agent-timeout <s>`) fails that message's turn, with the reason in the run; the session goes on. A conversation's messages are sent one at a time: the next waits for the last one's answer.

Your agent's own tools run on its side, for real, so `tests/tools/*.yaml` are not used, and outcome, `calls` and `never` checks (which read simulated tool calls) see none: write what must be true as `judge` items. The agent's model cost shows as $0, since Flow Framework does not see its model calls. Not yet supported: agents that answer later through a callback instead of in the response, and the person's reactions to the agent's messages.

### Any language

The endpoint's contract is written down in [`spec/`](spec/): [`agent-endpoint.openapi.yaml`](spec/agent-endpoint.openapi.yaml) (OpenAPI 3.1: the request, the answer, statuses, timeouts, the token, and what each platform shows) with JSON Schemas for the [request](spec/request.schema.json) and the [answer](spec/response.schema.json). A coding agent can implement it in any language from those files alone.

Check an endpoint against the contract before a test run, with no cloud, no key and no model call on Flow Framework's side:

```bash
npx @flow-engineer/flow check-endpoint http://localhost:3000/flow [--token-env NAME] [--json]
```

It sends a fixed set of synthetic messages (a typed message, a double text, a photo, a tapped button quoting the agent, a message that may need no answer) and checks each answer: status 200, `{ "replies": [...] }`, every reply against the schema and what WhatsApp can show, and every id a reply names (`replyTo`, a reaction's `messageId`) one of the person's messages. One line per case; exit 0 when all pass, else 1. The token is the value of `NAME` (default `FLOW_FRAMEWORK_AGENT_TOKEN`).

The café's agent as an HTTP endpoint, with its two tools and one model through any OpenAI-compatible API (the same key variables as `openAICompatible`, `MODEL` for the model; `FAKE_MODEL=1` for a fixed reply and no model call): [`examples/http-agent-python`](examples/http-agent-python) (standard library only) and [`examples/http-agent-go`](examples/http-agent-go) (standard library only).

## The same tools in Claude, ChatGPT and a CLI

The tools and skills you write for the chat agent are also an MCP server, so people use them from
Claude, ChatGPT or any MCP host, and a command line for your organization. Each needs the official
MCP SDK, an optional peer installed only when you use it.

```ts
import { mcpServer } from "@flow-engineer/flow/mcp";            // npm i @modelcontextprotocol/server@2.3.1

const mcp = mcpServer({ name: "cafe", version: "1.0.0", tools, dir: "agent" });
createServer((req, res) => void mcp.node(req, res)).listen(8790);   // Streamable HTTP at /mcp
```

- Every tool becomes an MCP tool with every field filled from the tool: `title`, `output` (sent as
  structured content), `status` lines, and `hints` (`readOnly`, `destructive`, `idempotent`,
  `openWorld`) as MCP annotations. Chat ignores all of these. Skills go as the server's
  instructions and a `read_skill` tool.
- Sign-in is the host's OAuth against your own authorization server: `auth: { issuer, scopes,
  verify }`, with `signIn: "required" | "optional" | "none"` per tool. A call that needs sign-in gets
  HTTP 401 and the host's sign-in prompt; the person is `context.key` in the tool.
- No OAuth server of your own: `oauthBridge` from `@flow-engineer/flow/oauth` (optional peer
  `oidc-provider`) is one, served beside `/mcp` by `mcpServer({ auth: bridge.auth })`. It sends
  people to your existing login page and your functions issue and check every token; it keeps none.
  See `coding-agents/oauth-bridge-skill.md`.
- Backend access stays in tool code: supply the same `credentials` provider to `createAgent` and
  `mcpServer`, then use `context.credentials.get("backend")` for that verified account. `resolve`
  receives a normalized `phone` only on verified phone channels; phone-first brands need no extra
  login or permissions screen there. See `coding-agents/auth-skill.md`.
- Another MCP server's tools become your agent's with `mcpTools({ name, url })`, pinned to
  `mcp.lock.json` (`npx flow mcp update`), so a change on that server never reaches your
  customers before your tests do.
- `@flow-engineer/flow/cli` makes your organization's command line from the same server, on Stricli (the
  framework Sentry's CLI uses): every tool is a command, a `defineCli` file adds command groups
  (`acme order -h` lists `place`, `status`), arguments and columns, and every command takes `--json`,
  `--fields`, `--dry-run` and `--yes`. `npx flow cli --server <url> -h` works for any MCP server.
- `npx flow check` checks it all by rule before you ship: tools that cannot be described
  exactly, a CLI file that no longer matches the tools, skills that name chat-only tools.
- Every generated piece can be replaced: the instructions, any tool's descriptor, your own MCP
  handlers (`extend`), your own commands.

The coding-agent skills in [`coding-agents/`](https://github.com/flow-engineer/flow/tree/main/coding-agents)
cover it end to end: `context-skill.md` builds the context the tools are written from (OpenAPI,
workflows, business rules, access) out of your existing codebase, and `auth-skill.md` sets up
sign-in for your stack (an OAuth provider, Firebase, Supabase, your own login page).

## Models

Any OpenAI-compatible API. With no `apiKey` or `baseURL`, `openAICompatible` uses the first key that has a value: `OPENROUTER_API_KEY` (OpenRouter), `OPENAI_API_KEY` (OpenAI), `ANTHROPIC_API_KEY` (Anthropic), `GEMINI_API_KEY` (Gemini), then `FLOW_KEY` (Flow); with none it stops at once and names them.

A provider key is optional: `npx @flow-engineer/flow setup` writes `FLOW_KEY`, the agent's one Flow key (shown only as its prefix and last 4 characters), which calls models through Flow on $2 of Flow trial credit per account (`npx @flow-engineer/flow status` shows what is left). A provider key in `.env` wins over it for the model; `setup --rotate key` replaces a leaked `FLOW_KEY` (the old one works 24 h more, `--now` ends it at once). `flowModel({ model })` uses Flow explicitly (default `anthropic/claude-haiku-5.5`; Flow offers a short list of models, `GET /models`); `FLOW_MODEL_URL` points it at another Flow server. When the credit is used up, a call fails with code `trial_credit_used` and the next step. `flowTranscribe(audio, { language })` turns a voice note into text through Flow with the same key and address (a Blob, File, Buffer, Uint8Array or ArrayBuffer of at most 15 MB; `filename` and `mimeType` name its format, default `audio.ogg`; `language` is a code such as `en` or `pt-BR`, detected when omitted) and resolves to `{ text }`; Flow's errors (`file_too_large`, `trial_credit_used`, ...) reject with the message, next step, `code` and `status`. `MODEL` sets the model id; each key has its own default. Pass `baseURL` and `apiKey` for any other address; a local server that needs no key needs only `baseURL`. Give `contextTokens` (the model's window) and a long chat's history is kept within it: the latest messages go to every call, older ones are left out (the agent is told).

For agents with tools we recommend **Claude Haiku 5.5** (`anthropic/claude-haiku-5.5`) or **GPT-6.1 Sol** (`openai/gpt-6.1-sol`, about 3x the cost). In our tests, GPT Luna repeated tool calls and answered twice.

## `createAgent` options

| Option | What it does |
|---|---|
| `dir` | The folder with `AGENTS.md` and `skills/` |
| `files` | `AGENTS.md` and skills as text, instead of `dir`, where there is no folder to read |
| `model` | Any `Model`; `openAICompatible({ model })` for most |
| `tools` | Your tools |
| `channels` | `whatsapp()`, `sms()`, `customUI()` definitions |
| `resolve` | Your key for a person from a channel identity, to join channels |
| `database` | Where state lives (`sqlite()` in memory by default) |
| `store` | Instead of `database`: a store of your own that keeps the state elsewhere |
| `testPeople` | Who the playground may play: `[{ name, phone }]` |
| `fallbackTemplate` | The declared template sent when a nudge meets a closed WhatsApp window and no other fits; the nudge then waits for their reply (see [WhatsApp's 24-hour window](#whatsapps-24-hour-window)) |
| `templates` | The WhatsApp templates you set up with Meta (header, body, footer, buttons): each send is checked against its declaration, and the playground shows it as WhatsApp does |
| `transcribe` | Speech to text for voice notes, with the provider you choose |
| `beforeSend` | `(message, { channel, address, info, origin }) => ...` checks, changes or refuses every message, carousel and template before it goes, on every channel: return nothing to send it, another message to send that, or `{ refuse: "why" }` (the agent is told why and sends again). It runs before the platform's content rules and before anything is recorded, so the transcript, the judge and the history hold what went |
| `context` | Small facts added to the system prompt at every turn; it runs before every reply, so keep lookups out of it (see [What the agent knows about the person](#what-the-agent-knows-about-the-person)) |
| `profile` | What your business knows about the person, as the built-in tool `get_user_profile`, called only when the agent needs it |
| `intercept` | Answer some messages without the model; `message.channel` is the channel it came in on, and it sees STOP, START and HELP first, marked in `message.keyword` (they are built in on SMS and WhatsApp). The message and the reply are kept in the history (the agent reads them at its next turn) and the transcript, and are `message.in` and `message.out` events marked `answered: true` |
| `quietHours` | Each person's quiet hours in their own time (22:00–07:00 by default; `false` for none): what the business starts waits for them (see [Quiet hours](#quiet-hours)) |
| `timeZone` | The business's time zone: the time the agent is told when a person's is not known (never taken as theirs; see [Time zones](#time-zones)) |
| `deadlineMs` | The longest a reply waits for a tool (60,000); a tool can set its own |
| `partialAfterMs` | How long a finished tool's result waits for the others (5,000) |
| `debounceMs` | Quiet time after a message before the reply starts (300) |
| `maxSteps` | Model steps per turn (8) |
| `history` | How much of a long chat each model call carries: `{ maxTokens, toolResultChars }` (60% of the model's `contextTokens`, else 50,000 tokens; tool results cut at 12,000 characters) |
| `inlineSkills` | Put every skill in the prompt instead of loading on demand |
| `shareUpdates` | Live status lines on web and app UIs (on); a string replaces the guidance |
| `traces` | Where traces go (from the environment by default, see above) |
| `events` | Where events go |

## With a coding agent

`flow new` and `flow init` put the skills in your agent's `.claude/skills/`; [docs/agents.md](docs/agents.md) is the short guide from `init` to the phone. They are also in [`coding-agents/`](https://github.com/flow-engineer/flow/tree/main/coding-agents): `skill.md` builds an agent, `tools-skill.md` writes tools and their test files, `test-skill.md` writes scenarios. The café in [`examples/cafe`](https://github.com/flow-engineer/flow/tree/main/examples/cafe) is a complete agent with tests to copy from.

## Roadmap

- **Several copies of one agent.** Each conversation is already worked on by one copy at a time (its lease, taken over when a copy stops), which keeps a deploy's overlap safe; what is left is to prove the rest under steady load on several instances. Until then, run one copy (see [State, restarts and hosting](#state-restarts-and-hosting)).

## Contributing

| Folder | What it is |
|---|---|
| `src/` | The runtime (`@flow-engineer/flow`) |
| `simulators/` | The playground (`@flow-engineer/flow/simulators`): SMS, WhatsApp, iMessage, Telegram and web, with each platform's rules |
| `flow-messaging/` | Channels on Flow Messaging (`@flow-engineer/flow/flow-messaging`): WhatsApp, Telegram and SMS through one API |
| `testing/` | Test file formats and the `flow` command (`@flow-engineer/flow/testing`) |
| `mcp/` | Tools and skills as an MCP server, and other MCP servers' tools (`@flow-engineer/flow/mcp`) |
| `cli/` | An organization's command line over its MCP server (`@flow-engineer/flow/cli`) |
| `examples/cafe/` | Pip, an ordering assistant, with tests |
| `coding-agents/` | Skills for coding agents |

To work on Flow Framework itself, start an agent inside a clone; it imports `src/` and `simulators/src/` by path, so your changes show at once:

```bash
git clone https://github.com/flow-engineer/flow
cd flow && npm ci
npm run new -- my-agent
echo "OPENROUTER_API_KEY=sk-or-..." > agents/my-agent/.env
cd agents/my-agent && npm start
```

`agents/` is git-ignored, so `git pull` never touches your agents. `npm test` runs the runtime's tests `cd simulators && npm test` the simulators' and `cd flow-messaging && npm test` the Flow Messaging channels'. Unit tests never call a real model. Read [AGENTS.md](https://github.com/flow-engineer/flow/blob/main/AGENTS.md) before contributing.

## FAQ

**Who is it for?** Anyone putting an agent in front of people in a chat: a booking assistant, a shop's order bot, a support agent. If your agent mostly talks to a person and calls tools, it is for you. If it works alone for an hour on a codebase, use a general agent SDK.

**How is it different from general agent frameworks?** Those give you an agent loop, and a chat is one more thing you build on top. Flow Framework is opinionated about chat: one actor per conversation, double texts folded into one turn, tools that never stall the chat, acknowledgements, channel rules, one person across channels, and schedules built in.

**Which channels are real?** WhatsApp, SMS and your own UI (`customUI`) have production definitions today; you plug in any provider by writing `sendMessage`. Telegram and iMessage are real through Flow Messaging (`fm.telegram()`, `fm.imessage()`, [flow-messaging/README.md](flow-messaging/README.md)); in core they are in the playground for now.

**Does it host my agent?** The framework runs in your Node process, on your machine or servers, and you pay your model and messaging providers directly. Flow's hosting can run it instead, from the same `buildAgent` that `flow test` loads: `npx @flow-engineer/flow deploy`.

**Is the data mine?** Yes. State lives in your database, and events go wherever you send them.

**What does a double text do mid-reply?** While the agent is thinking, its step restarts with everything they said, so they get one reply. While a tool runs, the agent reads the new message at once and the tool carries on in the background.

## Moving from chinwag

Flow Framework was published as `chinwag` up to 0.1.13; from 0.2.0 it is `@flow-engineer/flow`, and its command is `flow`, with no change in behaviour.

1. `npm uninstall chinwag && npm i @flow-engineer/flow`
2. Imports: `chinwag` becomes `@flow-engineer/flow`, `chinwag/simulators` becomes `@flow-engineer/flow/simulators`, `chinwag/testing` becomes `@flow-engineer/flow/testing`. The type `ChinwagEvent` is now `FlowEvent` (the old name still works, deprecated).
3. The command: `npx chinwag ...` becomes `npx @flow-engineer/flow ...`, and `chinwag ...` in `package.json` scripts becomes `flow ...`. `chinwag` still runs for this release and says it was renamed.
4. Environment: `CHINWAG_CLOUD`, `CHINWAG_CLOUD_KEY`, `CHINWAG_AGENT_TOKEN`, `CHINWAG_TRACES_KEY`, `CHINWAG_TRACES_URL` and `CHINWAG_TRACES_CONTENT` are now `FLOW_FRAMEWORK_CLOUD`, `FLOW_FRAMEWORK_CLOUD_KEY`, and so on. The old names still work; a new name wins when both are set.
5. Test results now go to `.flow/last-session.json`; `--failed` and `show last` still read `.chinwag/last-session.json` until the first run writes the new one. Add `.flow/` to `.gitignore`. Files the command keeps on this machine (such as a sign-in) go to `~/.config/flow-framework/`; `~/.config/chinwag/` is still read until then.
6. Coding-agent skills are now `flow-framework`, `flow-framework-tools` and `flow-framework-tests`: copy them again from `node_modules/@flow-engineer/flow/coding-agents/`.
7. Flow Messaging channels are in the package as `@flow-engineer/flow/flow-messaging` ([its README](flow-messaging/README.md)).

The test cloud, its address and its API are unchanged, and traces keep their `chinwag.*` attribute names.

## License

[Apache-2.0](https://github.com/flow-engineer/flow/blob/main/LICENSE)

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

A local playground can run the team's actual CLI, including custom commands, OAuth, interactive
chat, confirmations, stdout/stderr and exit codes. Opt in on the server that runs on your computer:

```ts
import { cli } from "./cli.ts"; // the team's defineCli configuration
await play.listen(agent, 8790, { localCli: { channel: "terminal", config: cli } });
// For a local agent mounting its playground under /playground:
const handler = play.handler(agent, { token, base: "/playground", localCli: { channel: "terminal", config: cli } });
```

The named channel must be declared on the agent. Its tab opens the runner instead of simulated
chat. Each browser gets an independent temporary sign-in and conversation directory; the test
person picker does not grant it an account. Run `auth login`, open the sign-in link, then return
to the runner. `chat` keeps reading input until `/exit`; reload reconnects to that session.
**Clear output** clears the viewport; **New CLI session** ends the session and removes its local
credentials, without clearing the account's agent history. Sessions expire after 30 minutes
without browser activity, and a server restart starts fresh. Ending a session does not undo
work already accepted by the agent.

This runner accepts only direct loopback connections with a loopback Host and same-origin API
requests, even if explicitly configured on a mounted handler. It is absent by default and is
not enabled in the hosted test cloud. It invokes `runCli` in-process: no shell, arbitrary program
execution, expansion or pipelines. Quoted arguments work. Its configured endpoints stay fixed;
use the installed CLI for `--server`, `--token` or `skill --write`.

- [ ] **TODO: Hosted CLI runner — deferred until a security review is complete.** Review execution
  isolation, custom-command filesystem/network access, credentials, OAuth callbacks, session cleanup
  and abuse controls before implementing or deploying cloud support. Keep the current runner local-only.

Embedded clients can set `CliConfig.directory` to isolate credential/conversation files and
`CliIO.env` to avoid inheriting process tokens; `CliIO.signal` cancels sign-in and terminal HTTP
requests. Defaults retain the installed CLI's existing environment and config directory.

### Terminal conversations

`chat` talks directly to the agent, using the same bearer as MCP; it is not an MCP tool. `defineCli({ name: "acme", server, agent: "https://agent.example.com/agent/terminal" })`
overrides the terminal URL; the default is the MCP server's origin plus `/agent/terminal`.
`acme chat "Which orders are ready?" --json` prints one response; `acme chat` reads a TTY until
Ctrl-D or `/exit`. Without a TTY pass a message to `chat` (an interactive chat exits 2); sign-in failures exit 3.
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
