---
name: flow-framework-tests
description: Write or change tests for a Flow Framework agent (tests/scenarios/*.yaml), and compare variants of the agent (which prompt is better, should I switch models, is a setting cheaper or faster) with flow test compare. Load when adding a test scenario, deciding what a Flow Framework agent should be checked on, turning a bad conversation into a test, or answering whether one instruction wording, model or setting beats another.
---

# Writing tests for a Flow Framework agent

Read the `flow-framework` skill (`skill.md`) first if you haven't. Turn the situations in
`context/examples/` (the `flow-framework-context` skill) into scenarios, and run `npx @flow-engineer/flow check`
before the tests when the agent serves MCP or a CLI.

For `buildAgent` and playground setup, read `flow-framework-build-agent` (`build-agent-skill.md`). MCP and CLI
setup is in `flow-framework-mcp` (`mcp-skill.md`).

A test is a scenario: a situation to put the agent in, played through a platform simulator by a
model acting as the person, with the agent's tools played by a model from `tests/tools/*.yaml` and
the scenario's `world` (the `flow-framework-tools` skill, `tools-skill.md`). At the end, what
happened is checked against `expect`.

```yaml
id: latte-correction
title: Milk corrected to oat
about: Orders a large latte, corrects the milk mid-thought, then confirms.
theme: Ordering
channels: [whatsapp, sms]   # runs once on each, with a result for each; a custom UI by its name (app); web is the first custom UI

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

- `title`: a short name for the scenario, at most 45 characters, shown on one line in lists and
  reports. **A title is a name, not the test**: the situation, the steps and what must happen go in
  `about` (a sentence or two, shown under the title), `opening`, `world` and `expect`. A longer
  title fails the check before anything is sent, naming the file, the title's length and the fix.

  | Bad (the whole test) | Good (a name) |
  |---|---|
  | Orders a latte, corrects the milk mid-thought, then confirms the order | Milk corrected to oat |
  | Asks for a table for four at 8pm when the restaurant is fully booked | Table when fully booked |
  | Says the order never arrived, gets a refund offered only after the order is looked up | Missing order refund |
  | Writes in Spanish, asks for opening hours, the answer comes back in Spanish | Spanish opening hours |
  | Replies "2" to a numbered list of three sizes, and gets the medium | Size picked by number |

- `theme`: the area of the agent the scenario tests, in a word or two (at most 30 characters):
  Ordering, Bookings, Refunds, Menu questions. Group scenarios by theme: 3 to 10 themes per agent,
  each scenario in one, the same spelling every time. Flow's dashboard groups scenarios by it.

- `channels`: one or more of sms, whatsapp, imessage, telegram and web; each is a run of its own.
  The run uses that simulator's real rules (SMS has no buttons or reactions; WhatsApp has both).
- `person`: who the model playing the person is (`persona`), what they want (`goal`), and facts
  they only give if asked (`knows`). It sees only what a person would see. Three optional fields
  make it harder to serve; add one only when the scenario tests that:
  - `reveal: one_at_a_time`: one fact of `knows` per message, only the one asked for. Use it to test
    that the agent asks for each detail it needs and does not assume the rest.
  - `behaviours`: any of `impatient` (short, wants it fast: tests brevity), `tangents` (drifts off
    and back: tests getting back to the task), `half_messages` (a thought split over two messages:
    tests waiting for the rest), `pushes_rules` (argues a no, up to twice: tests a policy holds
    politely), `walks_away` (may leave when the agent is slow, repetitive or unhelpful; the run
    then ends `walked_away` and fails: tests the agent gets there before people give up).
  - `attack: { rule, tactics }`: tries over several turns to make the agent break one `rule` (a
    sentence, such as `Never gives a discount or a free item.`); `tactics`, in the order it
    escalates, from `ask`, `reason`, `authority`, `pressure`, `reframe`, `inject` (all six when left
    out). One scenario per rule that matters (prices, refunds, what it must not reveal); the run is
    judged on that rule in every reply. Never with `walks_away` (refused).
- `opening`: the first messages, sent exactly as written; `after_ms` sends one that long after
  the previous one (a double text). Then the person plays on until `goal` is met or `max_turns`
  (default 8). A run that uses every turn never passes.
  A step may send a file: `- { say: "here is my receipt", attach: { kind: image, file: fixtures/receipt.jpg } }`
  (`kind`: image, audio, video or document; `file` a path in `tests/`; `say` is its caption and may be
  left out). A video is `.mp4`, `.mov`, `.webm` or `.mpeg`; to check the agent looked at it again,
  `expect: { calls: [ask_about_video] }`. The file is read on your machine and never uploaded; the person and the judge see it
  by name only.
- `world`: everything true in this test, in plain words: stock, outages, slowness, the person's
  history. The person, the judge and the tool model read it. For a tool that is down or slow, say
  so here and give the tool file a response for it whose `when` fits ("The point of sale is
  down"): the tool model plays that response. An agent with a `profile` gets it played from here
  too (`get_user_profile`): say who the person is ("Sam, a member since 2024, on the monthly plan").
- `expect`:
  - `outcome`: what must have happened, checked against what the tools did ("exactly one
    order is placed", "no order is placed").
  - `judge`: what the conversation must show, one checkable sentence each; a judge model reads
    the transcript and marks each pass or fail with a reason.
  - `calls`: tools that must be called at least once (whatever the call returned); `never`: tools
    that must not be called. Checked by code from the recorded tool calls, not by a model. Each
    entry is a tool name, or `{ tool, args }`: the call matches when every field in `args` equals
    the call's input (nested objects match in part; arrays and strings must be equal). For what
    a write must have done (the order is for Sam), prefer it to an `outcome` sentence: code checks
    it the same way every run. A tool group's
    tools (the web app's `ui_*` views) are played and checked like the agent's own, on the channels of
    their group. On a channel that shows tool calls (`showsTools`), the person and the judge see each
    call (its name and input) in the transcript, so the person can answer a card as they would.
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
or time passing. Such a run (a business run) gets an agent of its own, built by `buildAgent` with
the run's clock and the agent's own channels (pass `options.channels` and `options.testing` on to
`createAgent`, `testing` spread as it is: `now`, `scheduleCheckMs: 0`, the run's own `database`),
so the agent runs on
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
- Cover the unhappy paths the tool files list (busy, down, unknown item) as their own scenarios,
  each with a `world` that says so plainly ("the point of sale is down for the whole
  conversation"), so the tool model plays that response on every run.
- When a real conversation went wrong, turn it into a scenario: its world is what was true then,
  its opening is what the person sent.

## Scenarios for collecting information

An agent that collects several facts from a person (a booking, an order, a sign-up; the
`flow-framework-collecting-information` skill) needs scenarios from messy people, judged on the
outcome. A suite written field by field (the person answers exactly the question asked, in order)
passes while a real person breaks the agent: it files "1 month" under the wrong field, asks again
for what it was told, or sends a form. Write one scenario for each:

- everything in the first message;
- one answer that fills two fields;
- facts scattered over double texts (`after_ms`), out of order;
- an answer given before it was asked;
- a correction at the summary;
- a vague answer ("a while back");
- a question back to the agent in the middle;
- "I'll send that later", and walking away (`never` the irreversible tool).

Checks: `calls` with `args` for the irreversible step, `never` where it must not happen, and `judge`
sentences: the summary lists the right values, nothing already given is asked again, every message holds
at most one question, the agent confirms before it submits. Give the person a `goal` that ends when
they have said yes to the summary, never "have it published": with `tools: { real: [...] }` (the tool's own
code runs, for a draft the agent keeps) the cloud does not see what the tool changed, and a person
whose goal needs a visible change drifts. Judge the data by the summary the person said yes to, since
`outcome` reads the cloud's own view. The test format cannot check "one message per turn" or "one
question per message" in code: they are `judge` sentences, so read the transcripts of the runs.

## Comparing variants: which prompt is better, should I switch models

When the question is "is this wording better", "should we move to another model", "does turning prompt caching
off cost less", or "did my change help", do not run `flow test` twice by hand and compare two pass rates: one run of
each says nothing, because every run is its own conversation with a simulated person. Run
`flow test compare`: the same scenarios on every variant at the same time, one table, and each difference marked
"within noise" unless it clears a rule.

```bash
npx @flow-engineer/flow test compare --no-customer-data --instructions agent/AGENTS.short.md      # your instructions against another file
npx @flow-engineer/flow test compare --no-customer-data --model anthropic/claude-sonnet-5 --model openai/gpt-6-luna   # models against the agent's own
npx @flow-engineer/flow test compare --no-customer-data --code-ref main                          # your working tree against another git ref
npx @flow-engineer/flow test compare --no-customer-data --variants variants.yaml --runs 8        # anything else, repeatable
```

The agent as it stands is always the first variant, `current`, the baseline. `--runs` defaults to 5 per scenario;
`--concurrency` is per variant (the default shares 12 runs at once among the variants: a provider's rate limit fails runs that have nothing to do with the variant, and the table leaves those out and names them); `--only` limits the scenarios. Each variant is its own cloud session (ref
`compare/<name>`), so the dashboard keeps them off your main line. A variants file changes more than one thing:

```yaml
judge:                                    # judged checks added to every scenario of every variant
  - The acknowledgement does not narrate internal steps.
variants:
  shorter-prompt:
    instructions: { file: agent/AGENTS.short.md }           # or edits: [{ find: "text", replace: "text" }]
  sonnet-low:
    model: { id: anthropic/claude-sonnet-5, reasoning: low }
  own-provider:
    model: { id: gpt-6-luna, baseUrl: https://api.openai.com/v1, apiKeyEnv: OPENAI_API_KEY }
  no-caching:
    model: { promptCaching: false }                         # also temperature, maxTokens
  last-release:
    code: { ref: v0.19.0 }                                  # or entry: src/agent-b.ts
```

A `model` variant gives the agent's `buildAgent` that model (`buildAgent({ model })`), through the same provider
keys the agent has (`openAICompatible`); an agent that builds its model another way, or ignores `options.model`,
cannot change model this way: use a `code` variant. An agent on another framework is compared with
`agentUrl: <endpoint>` per variant (its own model calls are not visible, so only pass rate and judged checks show).

**Read the table in this order.**

1. The pass rate row, with its interval and `flaky`. `↑` or `↓` beside a variant means its interval does not overlap
   the baseline's: that difference is more than run-to-run luck. `=` means **within noise**: say "no difference
   shown", never "B is slightly better". The conclusion lines under the table say the same and, for an inconclusive
   pass rate, how many runs per scenario would settle a gap of the size seen (`--runs <n>`). If that number is
   large, the variants are close, and picking on other grounds (cost, time) is fine.
2. The cost and time rows, and the counts below them (messages per turn, model calls per turn, time to first
   reply, tokens, turns where text went out beside a later round of tool calls, turns where the answer needed an
   extra model call). They are computed from the agent's events, not by a model. A row clearing the rule among this
   many rows can be chance: confirm one surprising row with more runs before acting on it.
3. Rows labelled `judged:` come from the cloud's judge model reading the transcripts; they are your own sentence
   from `judge:`, not a measurement. They never change the pass rate. A sentence that fails often makes the cloud play those runs again (flaky detection): write it to mostly pass, or add `--no-retry`.
4. Warnings: an edit that "matched no text" means the variant is the baseline in disguise (a stale `find`);
   unequal counted runs means some runs errored.

The simulated people are not seeded, so the variants do not see the same conversations, only the same scenarios;
that is what the intervals account for. Do not conclude from 1 or 2 runs per scenario, and do not run the suite
until one variant wins: decide the runs first (`--runs`), read the table once. `--save-events <folder>` keeps each
variant's events for a closer look. Only the files under `tests/` and the variants you named differ between
variants; `--json` prints the whole comparison (rows, intervals, `versus` the baseline, `runsNeeded`).

Working on Flow Framework itself: a variant's `builtIn: { edits: [...] }` changes Flow Framework's own lines to the
model (`src/talk.ts`, the notes in `src/conversation.ts`) for that session only, with no source edit. It is internal,
not public API: it works only inside `flow test compare` and refuses to turn on anywhere else.

## Running the tests

Tests run in the Flow Framework cloud: your agent stays on your machine with its own model and key and
connects out to the cloud, which plays the person and the tools and judges.

1. Have a test cloud: the hosted one at https://flow.engineer/observe, the default (see "Get a test
   cloud" below), or another with `--cloud <url>` or `FLOW_FRAMEWORK_CLOUD`.
2. From the agent's folder (it must export `buildAgent` and `tools` from `src/agent.ts`), which reads
   the agent's `.env` itself: `npx @flow-engineer/flow test --no-customer-data [--runs 3]` (`npm test -- --no-customer-data`
   in an agent `flow new` made).
3. It first reads every test file as the cloud does; a mistake stops it with
   `tests/scenarios/<file>.yaml:<line>: <field>: <what is wrong>`, one line each, and nothing is sent.
   A field 0.16.1 stopped playing (`given:`, `origin:`, `expect.state`, a `restart` step) or a leftover
   `tests/tools/*.fake.ts` is not an error: it is ignored, and one line names it with what to do
   instead (`flow check` prints the same lines). Do what each line says.
   Then it prints PASS or FAIL per run, with its run id, every failed check and the judge's reason,
   and a link to watch each conversation in the simulator. The cloud's dashboard, at its own
   address, shows every session over time and each scenario's history.
4. `--json` prints one JSON report on stdout at the end, whatever the exit (everything else goes to
   stderr): `outcome`, `exitCode`, `sessionId`, `agent`, `error`, `counts`, `costUsd` and per run
   `runId`, `scenario`, `channel`, `run`, `verdict`, `error` (the cloud's code when it could not play
   or judge the run, such as `judge_failed`; the run is then `errored` and its line reads `ERROR`,
   whatever it ended as), `ended`, `turns`, `watch`, `rerun`, `label` and `failedChecks` (`kind`, `text` and the judge's
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
   `--fail-on-flaky`; `counts.flaky` counts them, and `counts.failed` leaves them out unless `--fail-on-flaky`. Read
   a flaky run like a failure that is not certain: look at it with `flow show`, and fix the agent or
   the test when the failed play shows a real problem.
   Each run's `outcome` is `passed`, `failed`, `credit` (the workspace's test budget, `spend_cap`, or the
   agent's model refused for credit, `agent_credit`; its line reads `CREDIT`) or `infra` (the cloud
   could not play or judge it; `ERROR`). Credit and infra runs are never failures and are counted apart
   (`counts.credit`, `counts.infra`): on credit, say the agent needs a model key or more credit, and
   do not change the agent. With `--runs 3`, `scenarios` gives each scenario's pass rate per channel
   (`runs` passed or failed, `passedRuns`, `credit`, `infra`, `label: "flaky"` when some passed and some
   failed); a flaky scenario is a real problem that shows only sometimes. `sendPath` names a
   conversation whose messages did not all go through the agent's send (a channel wrapper or the app's
   own code sent one the agent never did): the session fails; send every message through the agent.
   Pass rate: the runs that passed (flaky ones too, unless `--fail-on-flaky`) over those that passed, failed
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
   `--changed` runs only the scenarios whose files changed since the last session, and every scenario (saying
   why) when the agent's code, prompt or a tool file changed; it prints what changed. `--quick` is the inner
   loop (no re-plays, scripted latency 0, the fast tool model, a run stops once it has failed): the summary,
   `--json` (`mode`) and `.flow/last-session.json` say `quick`, and a quick session never counts toward test
   health or CI, so it is never the final run: finish on a plain one (without `--quick`). The summary ends with
   where the time went (`--timing`: per run; `--json`: `timing`).

Work in this loop, and never finish on a partial run:

1. `npx @flow-engineer/flow test --no-customer-data`: the whole suite.
2. Fix what failed (the agent, or a test that asks for the wrong thing; say which).
3. `npx @flow-engineer/flow test --no-customer-data --failed`, again until every run in it passes (exit 0).
4. `npx @flow-engineer/flow test --no-customer-data`: the whole suite once more, since a fix can break another scenario.

### Run the tests in Flow's cloud (`--run-in-cloud`)

`npx @flow-engineer/flow test --no-customer-data --run-in-cloud [--runs 3] [--only a,b | --failed | --changed]`
runs the whole session on Flow's cloud instead of this machine. Use it when the run is long, when your
command has a short timeout, or when a CI job should not hold the agent's process; for the quick inner
loop on your own machine, plain `flow test --quick` is faster. It does not work with `--agent-url`.

1. The folder is listed and the cloud says which files it lacks; only those are uploaded (a one-line change
   sends one file). The run id is printed first and kept in `.flow/runs/`.
2. The run starts and its output is followed. The exit status is the run's, and its result lands in
   `.flow/last-session.json`, so `--failed`, `--changed` and `flow show` work as after a local run.
3. A run goes on without you: Ctrl-C stops following only (exit 130). `flow test attach [<run-id>]` prints what
   it printed so far and follows it (no id: the last run); `flow test stop [<run-id>]` ends it.

If your command runner kills commands after a few minutes, start with `--no-follow` (it returns once the run has
started), then call `flow test attach` again until it ends; each call exits with the run's status when the run is
done. A cancelled CI job (SIGTERM with no terminal) stops the run.

What is sent: every file except `node_modules`, `.git`, `.flow` and every `.env*` file other than `tests/.env.test`
(put the tests' non-secret settings there and commit it). Secrets and the agent's model key come from the agent's
hosted secrets; with none, a Flow key made for the run pays for the model. Limits: 50 MB of files, 60 minutes a run, 12
runner-hours a day per workspace; the message at a limit says so, and Flow support raises it on request. A
workspace hosted in another region still has its tests played by the one test cloud, in the US.

### When a run fails

1. `npx @flow-engineer/flow test --no-customer-data --json > report.json`, and read the runs whose `verdict` is not
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
     a sign), or a person who left the scenario; fix `tests/tools/*.yaml`, or the scenario's
     `world` and `person`.
4. `npx @flow-engineer/flow test --no-customer-data --failed` until it passes with nothing flaky. With the
   cloud's second plays, `--runs 3 --only <scenario>` is rarely needed.
5. The whole suite once more.

### Get a test cloud

The owner does these; never ask for the key in chat or print it:

1. Sign in at https://flow.engineer/observe (Google, GitHub or an email link).
2. Workspace → New agent.
3. On the agent's Developers page, "Make a CI key". It starts with `oci_` and is shown once.
4. Put it in the agent's `.env` as `FLOW_FRAMEWORK_CLOUD_KEY` (never on the command line).
5. `npx @flow-engineer/flow test --cloud https://flow.engineer/observe --no-customer-data` from the agent's folder (`--cloud` is that address by default).

Your agent runs on your machine with your own model key. When it reaches Flow's model gateway (FLOW_KEY), each model and transcription call carries the session's id, and on a Pro workspace Flow counts those calls as free test spend whatever the key's mode (test or live), once the test cloud confirms the session; an unconfirmed session is charged normally. An `--agent-url` agent makes its calls in its own process, without the id, so they are charged as usual. The cloud's person simulator, tool simulator and judge are free within the workspace's limits: runs at once per session, sessions at once and a daily test budget. They depend on the workspace; `flow test` prints them on one line when a session opens (`--json` reports them as `limits`); test data only (`--no-customer-data`), and records are deleted after 30 days. `--no-customer-data` is the promise that the test files hold no real customer or member data;
the CLI refuses a hosted cloud without it and the key. `--environment staging` or `production` is
kept with the session.

The open goes to the front door with the key; the session then plays at the tunnel the cloud
answers, with the session's own token. `--agent-version` (else the version the agent's traces
carry: `FLOW_AGENT_VERSION`, the CI's commit, the folder's git commit or `package.json`'s `version`) and
`--ref` (else the CI's branch: GitHub's, GitLab's, Buildkite's or CircleCI's, else the folder's git
branch; the repository's default branch goes beside it) are kept with the session; `flow test` prints the version, and keeps it
in `--json` and `.flow/last-session.json` as `agentVersion`. A CI step (GitHub Actions shown):

```yaml
- run: npx @flow-engineer/flow test --cloud https://flow.engineer/observe --no-customer-data --environment staging
  env:
    FLOW_FRAMEWORK_CLOUD_KEY: ${{ secrets.FLOW_FRAMEWORK_CLOUD_KEY }}
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Only the files in your `tests/` folder run; the cloud keeps each file by its hash and compares
runs only while the tests are the same. The session's version is the commit the CI checked out, the
same label the agent's traces carry; leave `--agent-version` unset unless the commit is not what
runs, and record deploys on the owner's own servers as `build-agent-skill.md` ("Deploy it") says. Every run calls real models, so it costs a little.

`tests/drafts/` holds test drafts: `npx @flow-engineer/flow test pull` writes there the scenarios Flow
made from the hosted agent's conversations that went wrong (the business kept, the people made up;
it lists whether Flow checked each one). Drafts never run or gate; `flow test` reads only
`tests/scenarios/` and `tests/tools/`. Read each draft against the agent, fix what is wrong in it, and
move it into `tests/scenarios/` to keep it; delete the ones that do not test a real problem.

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
