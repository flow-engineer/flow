---
name: flow-framework-collecting-information
description: Collect several pieces of information from a person in chat. Load any time the agent must gather more than one fact before acting (a booking, order, sign-up, listing, application, return, quote, repair visit or lead), before writing its tool or its prompt.
---

# Collecting information from a person in chat

Read `flow-framework-tools` (`tools-skill.md`) for the tool basics. Scenarios for this flow are in
`flow-framework-tests` (`test-skill.md`, "Scenarios for collecting information"). A complete
working example is `examples/listing/` (`src/draft.ts`, `src/tools.ts`, `tests/scenarios/`), in the repository
and at `node_modules/@flow-engineer/flow/examples/listing/`.

The model understands the conversation. Code checks, converts and keeps state. The person is
texting, not filling in a form: they give three facts in one message, answer something you have not asked
yet, and change their mind. Build for that.

## The two designs that look right and fail

1. **A tool that returns the next question, and a prompt that says "one question per message".** Each
   answer is filed in the field just asked. "A month ago", answering "what condition?" or
   "when did you buy it?", fills one field and the other stays empty, so it is asked again. Facts
   volunteered early are ignored. A field name the model guessed is refused and the person is
   told the form has no such field. It is a form in a chat window, and every fix is another rule.
2. **"Ask for everything that is missing, together."** The reply is a form pasted into the chat: a
   list of questions, option lists in brackets, an "Optional:" paragraph. People answer one thing and
   leave.

Asking and capturing are separate jobs: **ask one question per message, capture every fact from
every reply.** "One at a time" and "many answers at once" do not conflict, and an agent built from
only one half gets one of the two failures above.

## The pattern

1. **One tool takes everything the message holds.** Every field is optional. It merges into a draft stored in
   `context.records` (key it by `context.person`), a later statement replaces an earlier one, one answer may fill
   several fields, and `clear` forgets one. The tool's description says: only what they actually said, never a
   guess for a field they did not speak to (a model asked for "usage" will invent it).
2. **Their own words go to code.** The model passes "35k", "a month ago", "SW1A 1AA" as written; code converts
   them (an amount, a date against the clock and the person's time zone) and the draft marks derived values
   (`35000, from "35k"`). The model never does date or money arithmetic. Code that cannot read a value returns a
   problem, never a guess.
3. **Field names are resolved in code.** An unknown name returns the closest valid names and says to retry in the same
   turn. It is never a dead end the person hears about.
4. **The tool returns state, and ONE thing to ask**, chosen by code in priority order: the draft, what is
   missing, problems with suggestions, `ask`, and whether it is ready for a summary. The agent asks only `ask`.
5. **Optional questions are asked at most once, tracked in code** (`offered` in the draft). Ask only the one or two
   that pay for themselves; every other optional field is kept when volunteered and never asked.
6. **Corrections happen at the summary.** An uncertain reading ("about 4 years ago") is kept and shown there, not
   asked about. The person corrects what is wrong; the agent calls the tool again and shows the new summary.
7. **The irreversible step is checked in code.** The tool that returns "ready" also returns a hash of the draft
   (`confirm_token`) and stores it as the summary shown; any change clears it. The submit tool refuses unless the token
   equals the hash of the draft as it is now. The model still judges that the person said yes, so say in the prompt:
   publish only after a yes to the latest summary.
8. **Text the public will read** (a listing's description) is a short plain sentence the model writes. Raw phrasing
   only for fields code converts.

## The skeleton

```ts
// draft.ts: plain code, no framework. FIELDS says how each is read; apply() merges; nextAsk() picks one.
export const FIELDS: Field[] = [
  { name: "price", ask: "their asking price", required: true, aliases: ["cost", "asking price"], read: (raw) => readAmount(raw) },
  { name: "bought_on", ask: "when they bought it, roughly", required: true, aliases: ["bought", "age", "usage"], read: (raw, now) => readDate(raw, now) },
  { name: "faults", ask: "whether anything is wrong with it", required: false, aliases: ["issues", "wear"] },
  // ...
];
apply(draft, given, clear, now);   // resolves names, converts, merges; returns { unknown, problems }
nextAsk(draft);                    // first missing required field, then each worthwhile optional one once
hashOf(draft);                     // changes with any value

// tools.ts
tool({
  name: "update_listing",
  description: "Save every fact the person's last message holds, in their own words, in every field it covers, also ones not asked yet. Only what they said, never a guess. Returns the draft, what is missing, the ONE thing to ask, and problems.",
  input: z.object({ fields: z.record(z.string(), z.string()), clear: z.array(z.string()).optional() }),
  run: async ({ fields, clear }, { records, person }) => {
    const draft = (await records.get<Draft>("drafts", person)) ?? emptyDraft();
    const applied = apply(draft, fields, clear ?? [], Date.now());
    const ask = nextAsk(draft);
    if (ask && !isRequired(ask.field)) draft.offered.push(ask.field);          // asked once
    const confirm = missing(draft).length === 0 && !ask ? hashOf(draft) : null;
    draft.summarised = confirm;                                                // a change clears it
    await records.put("drafts", person, { ...draft, person });
    return { draft: show(draft), missing: missing(draft), ask: ask?.ask ?? null, problems: applied.problems,
             unknown_fields: applied.unknown, ready_for_summary: confirm !== null, confirm_token: confirm };
  },
});
tool({
  name: "publish_listing",                                                      // cannot be undone
  input: z.object({ confirm_token: z.string() }),
  run: async ({ confirm_token }, { records, person, idempotencyKey }) => {
    const draft = await records.get<Draft>("drafts", person);
    if (!draft || !draft.summarised || draft.summarised !== hashOf(draft) || confirm_token !== draft.summarised)
      throw new ToolError("not_confirmed", "The draft changed since the summary.", { next: "Call update_listing, show the new summary, ask again." });
    // ... pass idempotencyKey to the backend
  },
});
// createAgent({ records: { drafts: { people: ["person"] } }, timeZone })  // a forgotten person's draft goes with them
```

The prompt (`agent/AGENTS.md`) is short: call `update_listing` on every message that tells you anything, with
everything it says; ask only the `ask`, one plain question, never a list; if a field name is refused, retry with the
closest one and never tell the person; answer a question they ask, then go on; show the summary when ready and
publish only after a yes to the latest one; when they say they will send something later or want to stop, accept it
and do not push. Never write the draft's rules into the tools' descriptions twice.

## Messages per turn

Each message the agent sends is its own message on a chat channel, and the first thing the agent does after a
person writes must reach them (an acknowledgement in the same response as its tool calls). So a turn that calls a tool
can be two messages: the acknowledgement and the answer. Keep it to one:

- acknowledge by reacting (`react`) where the channel has reactions, then send one message after the tool result
  that holds a short reaction and the one question;
- otherwise one short line with the first tool call and nothing with later calls; never narrate steps
  ("checking the catalog", "looking that up"), the line is for the person;
- no text beside later tool calls, no "Preparing your summary now", no second message with the question.

There is no option that limits a turn to one message; guard it in the prompt and in a scenario judge sentence.

## Scenarios to write

One per line, from messy people, judged on the outcome (the test skill has the format): everything in the first
message; one answer filling two fields; facts scattered over double texts out of order; an answer given before it
was asked; a correction at the summary; a vague answer; a question back to the agent; "I'll send that later";
abandoning. Checks: the summary the person said yes to is right, nothing already given is asked again, one message per
turn, one question per message, at most N questions before the summary, the irreversible tool never runs without a
yes to the latest summary. A suite written field by field passes while a real person breaks the agent.
