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
  `FLOW_MESSAGING_KEY` in `.env`): it runs `login` (opens the owner's browser itself and prints
  the link and code at once), then `setup` (writes the keys into `.env`), then prints the link.
  `--channel telegram|whatsapp|imessage` picks the channel (Telegram by default).
- Give the owner `say_to_person` from `link --json`, and the sign-in link and code from the
  `pending` line while you wait.
- `npm start` connects to Flow Messaging by an outbound event stream. Messages sent while it was
  stopped arrive when it starts again (for as long as Flow keeps events, 30 days by default).

## Exit codes (login, setup, link)

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | Go on |
| 1 | Usage, or not signed in | Fix the command, or run `next` |
| 2 | flow.engineer could not be reached | Try again |
| 3 | Refused: denied, expired, a product failed, or a channel not open yet | Run `next` |
| 4 | Sign-in still waiting for the owner's approval | Ask the owner to approve, then run `next` (the same code is kept) |

`login` and `link` wait at most `--timeout` seconds (120 by default) before exit 4. `login --wait`
(or `link` again) goes on with the same code: no new code and no new browser tab.

## The `next` lines

Every error is `{"error":{"code","message","next"}}` on stdout with `--json`, and
`<message> Next: <next>` on stderr. A waiting sign-in is `{"status":"pending",...,"next":...}`.
`next` is the exact command or URL to run; when it came from flow.engineer it is the server's.
Run it, or give it to the owner when it needs them (a browser approval, a page to open).

## Keys

- Never ask the owner to paste a key into the chat, and never print, read aloud or commit `.env`.
  `setup` writes the keys itself and prints only their last 4 characters.
- The model key is the owner's: they type it into `.env` themselves.
- CI never signs in: `npx @flow-engineer/flow setup --ci` says how to give it the test cloud key.
