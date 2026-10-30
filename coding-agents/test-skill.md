---
name: flow-framework-tests
description: Write or change tests for a Flow Framework agent (tests/scenarios/*.yaml). Load when adding a test scenario, deciding what a Flow Framework agent should be checked on, or turning a bad conversation into a test.
---

# Writing tests for a Flow Framework agent

Read the `flow-framework` skill (`skill.md`) first if you haven't. Turn the situations in
`context/examples/` (the `flow-framework-context` skill) into scenarios, and run `npx flow check`
before the tests when the agent serves MCP or a CLI.

For `buildAgent` and playground setup, read `flow-framework-build-agent` (`build-agent-skill.md`). MCP and CLI
setup is in `flow-framework-mcp` (`mcp-skill.md`).

A test is a scenario: a situation to put the agent in, played through a platform simulator by a
model acting as the person, with the agent's tools played by a model from `tests/tools/*.yaml`
(see the `flow-framework-tools` skill, `tools-skill.md`). At the end, what happened is checked against `expect`.

```yaml
id: latte-correction
title: Orders a latte, corrects the milk mid-thought, confirms
channels: [whatsapp, sms]   # runs once on each, with a result for each

person:
  persona: Sam, in a hurry on the way to work; types in short bursts, no capitals.
  goal: Get a large oat latte for pickup, under the name Sam.
  knows:
    - Their name is Sam.

opening:
  - say: "can i get a large latte"
  - say: "oat milk actually"
    after_ms: 1200

world: |
  The menu is as in tests/tools/get_menu.yaml. Oat milk is in stock. The café is busy this
  morning, so the point of sale is slow to take orders, but they go through.

max_turns: 8

expect:
  outcome:
    - Exactly one order is placed, for one large latte with oat milk, under the name Sam.
  judge:
    - The order read back to Sam uses oat milk, not whole milk.
    - The agent asks Sam to confirm before placing the order.
    - Sam is told the order number and when it will be ready.
```

## The parts

- `channels`: one or more of sms, whatsapp, imessage, telegram and web; each is a run of its own.
  The run uses that simulator's real rules (SMS has no buttons or reactions; WhatsApp has both).
- `person`: who the model playing the person is (`persona`), what they want (`goal`), and facts
  they only give if asked (`knows`). It sees only what a person would see.
- `opening`: the first messages, sent exactly as written; `after_ms` sends one that long after
  the previous one (a double text). Then the person plays on until `goal` is met or `max_turns`
  (default 8). A run that uses every turn never passes.
  A step may send a file: `- { say: "here is my receipt", attach: { kind: image, file: fixtures/receipt.jpg } }`
  (`kind`: image, audio or document; `file` a path in `tests/`; `say` is its caption and may be
  left out). The file is read on your machine and never uploaded; the person and the judge see it
  by name only.
- `world`: everything true in this test, in plain words. It is the only place the situation is
  set: stock, outages, slowness, the person's history. The tool simulator plays every tool from
  it, choosing among the responses in `tests/tools/*.yaml`. Never write tool responses or
  latencies in a scenario. An agent with a `profile` gets it played from here too
  (`get_user_profile`): say who the person is ("Sam, a member since 2024, on the monthly plan").
- `expect`:
  - `outcome`: what must have happened, checked against what the tools did ("exactly one
    order is placed", "no order is placed").
  - `judge`: what the conversation must show, one checkable sentence each; a judge model reads
    the transcript and marks each pass or fail with a reason.
  - `calls`: tools that must be called at least once (whatever the call returned); `never`: tools
    that must not be called. Checked by code from the recorded tool calls, not by a model. Each
    entry is a tool name, or `{ tool, args }`: the call matches when every field in `args` equals
    the call's input (nested objects match in part; arrays and strings must be equal).
- `timezone` (default UTC) and `now`: the test's clock. `now` is when each run starts,
  `YYYY-MM-DDTHH:MM[:SS]`, local to `timezone` unless it ends in `Z` or an offset (`-04:00`); left
  out, it is the real time. Placeholders are filled from it, and the simulated tools and the judge
  are told it; outside a business run (below) your agent's clock is not changed: the agent still reads the real time. So set `now` only when the agent takes
  its dates from its tools or its context; otherwise leave it out and placeholders follow the real
  date.

```yaml
timezone: America/New_York
now: 2026-10-16T09:00
world: Sam's class is on {{now + 6d @ 10:00}}. There is a free slot s-2 the day after.
expect:
  calls:
    - cancel_session
    - tool: move_session
      args: { slot_id: s-2 }
  never:
    - delete_account
```

Dates in test files are placeholders for the test's clock, never written out (a written date goes
stale): `{{now}}`, then shifts `+` or `-` a number with `m`, `h`, `d` or `w`, then `@ HH:MM` for the
time of day, then `| iso` (the default, with its offset), `| date` (2026-10-16), `| time` (09:00) or
`| weekday` (Thursday): `{{now + 7d | date}}`, `{{now - 2h + 30m | time}}`. They work in `world`,
`person`, `opening`, `expect` and the tool files' `responses`; the cloud fills them on each run. Any other
`{{...}}` is plain text.

### Scenarios the business starts

A scenario can start with the business instead of the person: an event its backend sends, a nudge,
time passing, or a restart of the agent. Such a run (a business run) gets an agent of its own, built by `buildAgent` with
the run's clock and the agent's own channels (pass `options.channels` and `options.testing` on to
`createAgent`, `testing` spread as it is: `now`, `scheduleCheckMs: 0`, the run's `database` and
`runner`), so the agent runs on
the test's clock: quiet hours, held sends, `expiresAt` and caps over days follow it.

```yaml
timezone: Asia/Kolkata
now: 2026-10-20T23:30
person:
  address: "+15550100001"        # who the events and nudges are for (a made-up number)
  persona: ...
  goal: ...
opening:
  - event: { type: buying.bid.outbid, delivery: critical, subject: "user:u1", data: { user: { phone: "+15550100001" } } }
  - wait: 8h30m                  # time passes; what came due runs, a minute at a time
  - say: "ok thanks"             # the person can still write
  - event: { id: evt_dup, type: ..., subject: ..., data: {...} }
    signature: bad               # or missing; answer: 401
    answer: 401                  # what the route must answer (default: any 2xx); { status: 400, field: data.user }
  - nudge: { prompt: "Tell them the listing ends soon." }   # or text, or template: { name, body: [...] }
    at: 2026-10-21T15:00         # moves the clock first: a date and time, HH:MM (the next one), or {{now ...}}
max_turns: 1                     # 1: no turns played after the opening
tools: { real: [keep_me_posted] }  # their own code runs (the very tool objects), for state the agent keeps itself
expect:
  sent:                          # what went out, in order (other sends may come between)
    - { at: "23:30", template: outbid }
    - { at: "08:00", phrased: true, text: "₹53,000" }
  not_sent:
    - { template: outbid_reminder }   # {} is anything at all
```

- An `event` is sent exactly as a business's backend sends a Flow event: one envelope
  `{ id, type, occurredAt, subject, delivery?, data }` (`id` and `occurredAt` default to one per
  step and the clock), as `POST /v1/events` (or the step's `path`) to the agent's `routes`, with
  `Content-Type: application/json`, `Idempotency-Key: <id>` and
  `Flow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.{t}.{body}">`, signed with the
  run's own test secret (`options.testing.eventsSecret`: check signatures with it in a business run).
  The same `id` twice is a duplicate, as it would be live.
- A `nudge` is `agent.nudge` to the run's person; `wait` and `at` move the clock (never back), and
  what comes due meanwhile runs: scheduled messages, held sends, and the agent's wake-ups.
- `expect.sent` items: `at` (HH:MM on any day, or a date and time; to the minute), `template`
  (its name), `phrased: true` (the agent's own words, not a template), `carousel: true` (a carousel,
  not a message or template), `text` (in the message, the template's values, or the carousel's text
  and cards). Checked by code, like `calls`.
- A business run where the agent sent nothing is not a failure by itself: `expect` decides.
- `restart: crash` or `restart: deploy` restarts the agent mid-conversation, on the same store, to
  catch double replies and lost turns across a crash or a deploy. Put it right after a `say` and it
  lands while that message's turn runs (the real case: a message comes in a second before the new
  revision is up). `crash`: the agent dies where it is (nothing more it does is sent or kept) and a
  new one starts; it waits out the dead one's lease (15 s on the test's clock), then runs the cut-off
  turn once. `deploy`: a new one starts beside the old one and takes every message from then on; the
  old one finishes what it holds, a message the new one took meanwhile included, and stops. Each has
  its own runner name (`runner-1`, `runner-2`, with createAgent's random suffix, on every event). The cloud checks that every message
  the person sent was answered, none twice, and that no turn was lost. `buildAgent` must pass
  `options.testing` on to `createAgent` as it is (it carries the run's `database` and `runner`), or
  the step fails saying so.

  ```yaml
  opening:
    - say: "when is my class?"
    - restart: deploy              # or crash
    - say: "and where is it?"      # reaches the new agent
  ```
- `history` (top level) starts a run from an earlier conversation, to test what happens late in a
  long chat (a correction about something said 40 messages ago, a history near the model's budget)
  without playing it: what each side said, oldest first, 1 to 200 items of up to 4,000 characters.
  It is written into the agent's store before the run, as if said (no model call, nothing sent);
  the person model and the judge see it as the conversation so far. Needs a client that says so
  (0.5.0); an older one's run ends `client_outdated`.

  ```yaml
  history:
    - person: "Book a table for four on Friday"
    - agent: "Done: Friday at 8 pm, for four."
  opening:
    - say: "can we make it 9?"
  ```
- Timers of your own (held sends, reminders timed from your data) go in `createAgent`'s `onTick`,
  which runs on the agent's clock, never in a `setInterval` of your own.

How fast the agent first replies to each message is measured on every run from timestamps, not
written in scenarios: the dashboard shows it for the whole run (average, p95, min and max).

## Choosing what to test

- One situation per scenario, named for it (`order-fails`, `latte-correction`).
- Test what would hurt a real person if it broke: wrong order, a claim the order was placed when
  it wasn't, a missed escalation, a slow or missing acknowledgement.
- One fact per check. "Called X" or "never called Z" is a `calls` or `never` entry, not an
  `outcome` or `judge` sentence: code checks it the same way every run.
- Write `judge` items as facts a reader can check from the transcript, not taste ("asks Sam to
  confirm before placing the order", not "is helpful").
- Cover the unhappy paths the tool files list (busy, down, unknown item) as their own scenarios.
- When a real conversation went wrong, turn it into a scenario: its world is what was true then,
  its opening is what the person sent.

## Running the tests

Tests run in the Flow Framework cloud: your agent stays on your machine with its own model and key and
connects out to the cloud, which plays the person and the tools and judges.

1. Have a test cloud: the hosted one at https://flow.engineer/observe, the default (see "Get a test
   cloud" below), or another with `--cloud <url>` or `FLOW_FRAMEWORK_CLOUD`.
2. From the agent's folder (it must export `buildAgent` and `tools` from `src/agent.ts`), which reads
   the agent's `.env` itself: `npx @flow-engineer/flow test --synthetic [--runs 3]` (`npm test -- --synthetic`
   in an agent `flow new` made).
3. It first reads every test file as the cloud does; a mistake stops it with
   `tests/scenarios/<file>.yaml:<line>: <field>: <what is wrong>`, one line each, and nothing is sent.
   Then it prints PASS or FAIL per run, with its run id, every failed check and the judge's reason,
   and a link to watch each conversation in the simulator. The cloud's dashboard, at its own
   address, shows every session over time and each scenario's history.
4. `--json` prints one JSON report on stdout at the end, whatever the exit (everything else goes to
   stderr): `outcome`, `exitCode`, `sessionId`, `agent`, `error`, `counts`, `costUsd` and per run
   `runId`, `scenario`, `channel`, `run`, `verdict`, `error` (the cloud's code when it could not play
   or judge the run, such as `judge_failed`; the run is then `errored` and its line reads `ERROR`,
   whatever it ended as), `ended`, `turns`, `watch`, `rerun`, `label`, `replayed` and `failedChecks` (`kind`, `text` and the judge's
   `reason`), and `invalid` (`{ path, reason }` for a scenario the cloud could not play, its error
   `scenario_invalid` and its line `INVALID`; else `null`); top-level `invalid` lists those scenarios
   once each (`scenario`, `path`, `reason`: fix the file; `unsupported: ...` means the cloud does not
   know that key), and `sessionInvalid` (`reason`, `olderCloud`, `sent`) is set when the cloud ended
   the whole session `scenario_invalid`. Each session that opened also leaves
   `.flow/last-session.json` in the agent's folder (its path is printed on every exit): `sessionId`,
   `agent`, `dashboard`, `suiteHash`, `endedAt`, `ended` (`finished`, `stopped` or `interrupted`),
   `only` (the scenarios it was limited to, else `null`) and per run `scenario` (file name without
   `.yaml`), `channel`, `run`, `runId`, `verdict` (`passed`, `failed`, `flaky`: it failed, then passed
   when the cloud played it again, `errored`: the cloud could not
   play or judge it, such as a failed tool simulator or person model, which is not a failure of your
   agent, or `not_played`: the session ended first), `failedChecks` (with reasons) and `invalid`
   when the cloud could not play the scenario, plus `sessionInvalid` as in `--json`.
   Read these instead of parsing the printed lines.
   Flaky runs: the cloud plays a failed run once more. When that passes the run is `flaky` (its line
   reads `FLAKY` with `played again: passed <watch>`, and the summary lists it in its own section with
   both watch links); `label` is `flaky` or `failing` (failed twice) and `rerun` is the second play
   (`runId`, `passed`, `watch`), never a run of its own. A flaky run counts as passed unless
   `--strict`; `counts.flaky` counts them, and `counts.failed` leaves them out unless `--strict`. Read
   a flaky run like a failure that is not certain: look at it with `flow show`, and fix the agent or
   the test when the failed play shows a real problem. The cloud also replays the person's, the tools'
   and the judge's stored answers for a scenario it has played unchanged (`replayed` counts them), so
   runs vary less; `--fresh` plays every simulator anew.
   Each run's `outcome` is `passed`, `failed`, `credit` (the workspace's test budget, `spend_cap`, or the
   agent's model refused for credit, `agent_credit`; its line reads `CREDIT`) or `infra` (the cloud
   could not play or judge it; `ERROR`). Credit and infra runs are never failures and are counted apart
   (`counts.credit`, `counts.infra`): on credit, say the agent needs a model key or more credit, and
   do not change the agent. With `--runs 3`, `scenarios` gives each scenario's pass rate per channel
   (`runs` passed or failed, `passedRuns`, `credit`, `infra`, `label: "flaky"` when some passed and some
   failed); a flaky scenario is a real problem that shows only sometimes. `sendPath` names a
   conversation whose messages did not all go through the agent's send (a channel wrapper or the app's
   own code sent one the agent never did): the session fails; send every message through the agent.
   Pass rate: the runs that passed (flaky ones too, unless `--strict`) over those that passed, failed
   or were flaky, as the dashboard counts it; errored and unplayed runs are left out. The summary
   prints it with the dashboard's word (`Pass rate 99.2% · Good: 141 of 142 counted runs passed.
   Passes at 98% or more (--min-pass).`), and `--json` has `passRate` (cut to one decimal, never
   rounded up; `null` when nothing counted), `level` (`excellent` 100, `good` 98+, `fair` 95+,
   `needs_work` 90+, `poor`) and `minPass`. The session passes at `--min-pass` (else
   `FLOW_TEST_MIN_PASS`, else 98); `--min-pass 100` fails it on any failed run. A pass under 100% still
   has failed runs: read them as below.
   Exit status: 0 the pass rate is at least `--min-pass` and no run errored or went unplayed; 1 the
   pass rate is under it, or nothing was sent (a wrong flag, a test file that does
   not parse, no key); 2 the connection or the cloud failed, or runs errored or were not played (the
   session ended early: one line says how many and why) and the rate is not under it; 3 the cloud refused (key,
   busy, spend cap, capacity); 130 Ctrl-C. On 2 or 3 the agent is not at fault:
   say what the cloud said (`error` in the report), do not change the agent for it.
5. `--only a,b` runs only those scenarios (file names without `.yaml`). `--failed` runs only the ones
   that did not pass in the last session (flaky ones too), on every channel each plays; it goes with `--runs`, never
   with `--only`. It prints `Nothing failed in the last session (<id>).` and exits 0 when there is
   nothing to run again, and exits 1 when there is no last session.

Work in this loop, and never finish on a partial run:

1. `npx @flow-engineer/flow test --synthetic`: the whole suite.
2. Fix what failed (the agent, or a test that asks for the wrong thing; say which).
3. `npx @flow-engineer/flow test --synthetic --failed`, again until every run in it passes (exit 0).
4. `npx @flow-engineer/flow test --synthetic`: the whole suite once more, since a fix can break another scenario.

### When a run fails

1. `npx @flow-engineer/flow test --synthetic --json > report.json`, and read the runs whose `verdict` is not
   `passed` (`jq '.runs[] | select(.verdict != "passed")' report.json`).
2. `npx @flow-engineer/flow show last` (the first run that did not pass; it names the others),
   `npx @flow-engineer/flow show last --scenario <id>` (that scenario's run; its id or file name) or
   `npx @flow-engineer/flow show <runId>`: the checks with the judge's reasons, then the conversation in time
   order with every tool call the simulator played, its input, output and what it changed, and
   `response: "<when>"`, the tool file's response it played (`response: custom` when none fit).
   `--json` gives the whole record.
3. Decide which is wrong, and say which:
   - the agent: it said or did the wrong thing; fix its prompt, tools or code;
   - the test: a check asks for the wrong thing, or the scenario cannot reach its goal; fix the YAML;
   - the simulator: a tool output that could not happen (a `response:` that does not fit the call is
     a sign), or a person who left the scenario; fix `tests/tools/*.yaml` or the scenario's `world` and `person`.
4. `npx @flow-engineer/flow test --synthetic --failed` until it passes with nothing flaky. With the
   cloud's replays and second plays, `--runs 3 --only <scenario>` is rarely needed; `--fresh` plays every
   simulator anew when you want a run with no stored answers.
5. The whole suite once more.

### Get a test cloud

The owner does these; never ask for the key in chat or print it:

1. Sign in at https://flow.engineer/observe (Google, GitHub or an email link).
2. Workspace → New agent.
3. On the agent's Developers page, "Make a CI key". It starts with `oci_` and is shown once.
4. Put it in the agent's `.env` as `FLOW_FRAMEWORK_CLOUD_KEY` (never on the command line).
5. `npx @flow-engineer/flow test --cloud https://flow.engineer/observe --synthetic` from the agent's folder (`--cloud` is that address by default).

Your agent runs on your machine with your own model key. The cloud's person simulator, tool simulator and judge are free within the workspace's limits: runs at once per session, sessions at once and a daily test budget. They depend on the workspace; `flow test` prints them on one line when a session opens (`--json` reports them as `limits`); test data only (`--synthetic`), and records are deleted after 30 days. `--synthetic` is the promise that the test files hold no real customer or member data;
the CLI refuses a hosted cloud without it and the key. `--environment staging` or `production` is
kept with the session.

The open goes to the front door with the key; the session then plays at the tunnel the cloud
answers, with the session's own token. `--agent-version` (else the version the agent's traces
carry: `FLOW_AGENT_VERSION`, the CI's commit, the folder's git commit or `package.json`'s `version`) and
`--ref` (else the CI's branch: GitHub's, GitLab's, Buildkite's or CircleCI's, else the folder's git
branch; the repository's default branch goes beside it) are kept with the session; `flow test` prints the version, and keeps it
in `--json` and `.flow/last-session.json` as `agentVersion`. A CI step (GitHub Actions shown):

```yaml
- run: npx @flow-engineer/flow test --cloud https://flow.engineer/observe --synthetic --environment staging
  env:
    FLOW_FRAMEWORK_CLOUD_KEY: ${{ secrets.FLOW_FRAMEWORK_CLOUD_KEY }}
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Only the files in your `tests/` folder run; the cloud keeps each file by its hash and compares
runs only while the tests are the same. The session's version is the commit the CI checked out, the
same label the agent's traces carry; leave `--agent-version` unset unless the commit is not what
runs, and record deploys on the owner's own servers as `build-agent-skill.md` ("Deploy it") says. Every run calls real models, so it costs a little.

## An agent on another framework, in any language

An agent not built on Flow Framework is tested through an HTTP endpoint: `npx @flow-engineer/flow test --agent-url <url>`.
To implement one:

1. Read the contract, `spec/agent-endpoint.openapi.yaml` (in the @flow-engineer/flow package or the repository),
   with `spec/request.schema.json` and `spec/response.schema.json`. Implement exactly that: one
   POST per message of the person's, answered in the same response with status 200 and
   `{ "replies": [...] }` (`[]` for no reply, never 204). Keep history by `conversationId`, ignore
   request fields you do not know, and check `authorization: Bearer` when `FLOW_FRAMEWORK_AGENT_TOKEN` is set.
2. Only send what the run's platform shows (`x-flow-platforms` in the spec): no buttons on SMS,
   text within `maxLength`. Name the person's messages by the `messageId` they came with.
3. Start the endpoint and run `npx @flow-engineer/flow check-endpoint <url>` (`--token-env NAME` when it needs
   a token). Fix every FAIL line; it must end "5 of 5 cases passed". Give the agent a mode with no
   model call (the examples' `FAKE_MODEL=1`) so the check costs nothing.
4. Then write scenarios as above, with one difference: the agent's own tools run for real, so there
   are no `tests/tools/*.yaml`, no `world` for tools and no `outcome`, `calls` or `never` checks
   (the cloud sees no tool calls); write what must be true as `judge` items. Run `npx @flow-engineer/flow test --agent-url <url>`.

`examples/http-agent-python` and `examples/http-agent-go` are the café's agent done this way.
