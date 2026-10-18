# Flow Framework for coding agents

You are building or changing a chat agent for a person (the owner) so they can text it from their
phone while it runs on their laptop. No tunnel, no public URL, and no key the owner copies by hand
except their model key. Every command here runs without a terminal and never reads stdin, except
`chat`, which reads the messages you pipe to it.

Always name the package: `npx @flow-engineer/flow ...`. `npx flow` on its own fetches another npm
package.

## The flow

```sh
npx @flow-engineer/flow init                        # the starter agent in this (empty) folder; flow new <name> makes a folder
npm install
# the owner puts one model key in .env (OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY)
printf 'hi\nA latte please\n' | npx @flow-engineer/flow chat   # talk to it locally: no account, one message per line
npx @flow-engineer/flow link --json                 # signs in and sets up if needed, then prints the phone link
npm start                                           # keep it running; the owner texts it from the phone
```

- `chat` builds the agent from `src/agent.ts` and writes as its first test person. Each reply is
  printed (`agent: ...`) once the turn is over; `--json` gives one JSON line per thing it sends.
- `link` does the rest when the folder is not set up (no `FLOW_FRAMEWORK_JOIN_CODE` or
  `FLOW_MESSAGING_KEY` in `.env`, or no sender for the WhatsApp or iMessage link asked for): it
  runs `login` (opens the owner's browser itself and prints the link and code at once), then
  `setup` (writes the keys and each open channel's sender into `.env`), then prints the link.
  `--channel telegram|whatsapp|imessage` picks the channel (Telegram by default). Run it in the
  agent's folder: `setup` and `link` refuse a folder with no `package.json` (`not_an_agent_folder`).
- On WhatsApp and iMessage the agent can only reply after the owner writes first (WhatsApp: within
  24 hours of their last message); it cannot message them first. `link --json` says so
  (`reply_only: true`, and in `say_to_person`): tell the owner.
- The starter's `npm start` is on Telegram, plus WhatsApp and iMessage when `.env` has their senders
  (`FLOW_MESSAGING_WHATSAPP_SENDER`, `FLOW_MESSAGING_IMESSAGE_SENDER`). If it was running when
  `link` added one, restart it.
- Give the owner `say_to_person` from `link --json`, and the sign-in link and code from the
  `pending` line while you wait.
- `npm start` connects to Flow Messaging by an outbound event stream. Messages sent while it was
  stopped arrive when it starts again (for as long as Flow keeps events, 30 days by default).

## Exit codes (login, setup, link)

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | Go on |
| 1 | Usage, not signed in, not an agent's folder, or a login URL that is not https | Fix the command, or run `next` |
| 2 | flow.engineer could not be reached, or did not answer in time (`timeout`) | Try again |
| 3 | Refused: denied, expired, a product failed, a channel not open yet, a server with no CLI sign-in (`server_unsupported`), or a free-trial limit (`sandbox_allowance_used`, the iMessage people cap; HTTP 403) | Run `next`; for a trial limit `next` is a sentence: give it to the owner as it is |
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
Run it, or give it to the owner when it needs them (a browser approval, a page to open). A
`slow_down` error also has `retry_after` (seconds, or `null` when the server gave none). A
trial limit's `next` is a sentence, not a command: it is printed on its own line as it came; pass
it on to the owner unchanged.

flow.engineer may add `warnings` (up to 20 lines) to any setup answer. Each is printed on its own
line on stderr; with `--json` setup's line has `warnings` (an empty list when there are none), and
an error line has it when there were any. Pass them on to the owner.

`setup` also shows the free trial: messages used per channel, and on iMessage the people it may
reach (`iMessage: 1 of 2 people`; `trial.imessage.contacts` `{limit, used}` in `--json`).

## Keys

- Never ask the owner to paste a key into the chat, and never print, read aloud or commit `.env`.
  `setup` writes the keys itself and prints only their last 4 characters.
- The model key is the owner's: they type it into `.env` themselves.
- `setup` keeps every value already in `.env` (`--replace` takes the new ones), but a name there
  with no value (`cp .env.example .env`) counts as missing and is filled on its own line. Keys
  flow.engineer made are written even when the rest of setup fails, since they are shown only once.
  `.env` is set to mode 0600.
- The sign-in token goes only to the server that issued it, over https (http only to localhost):
  with `FLOW_FRAMEWORK_LOGIN_URL` naming another server, commands stop with `signed_in_elsewhere`.
- CI never signs in: `npx @flow-engineer/flow setup --ci` says how to give it the test cloud key.
