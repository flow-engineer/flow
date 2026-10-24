# Patterns that worked

What held up when agents built on Flow Framework met real people. Each pattern comes from a rule
that slipped, or a change that cost scenarios, in an agent's tests.

## Enforce what matters in code

A rule in the prompt is followed most of the time, not every time: prompt-only rules slipped in a
few percent of runs. If breaking a rule costs the business (a price it never quoted, a link that is
not yours, a promise about delivery, a message after the person opted out), check it in code, in
`beforeSend`. Every message, carousel and template passes through it on every channel before it is
sent and recorded, so the transcript, the judge and the history hold what actually went.

```ts
const agent = createAgent({
  // ...
  beforeSend: (message, { origin }) => {
    if (origin !== "agent" || message.type !== "message") return;
    const links = message.text.match(/https?:\/\/\S+/g) ?? [];
    const foreign = links.find((url) => !url.startsWith("https://shop.example.com/"));
    if (foreign) return { refuse: `Link ${foreign} is not one of ours. Use the link the order tool returned.` };
  },
});
```

Keep the check narrow and certain: a regular expression or a lookup, never a second model call that
can be wrong too.

## Keep prompts for judgement

The prompt is for what code cannot decide: tone, when to ask a question, how to read an unclear
message, what matters to this business. Everything a check can decide belongs in code (above), in a
tool's input schema, or in what a tool returns. Each line of `AGENTS.md` costs every turn, and
competes with every other line. Shortening a prompt is a change like any other: in one agent, a
shorter prompt failed 10 scenarios that had passed, so run the tests before and after.

## Render in code

Let tools return what the person should read, ready to send: prices with their currency, times in
the person's own zone, the exact link, a name as the business writes it. The model then copies it
instead of working it out. Choices the person taps are buttons or a list built from the tool's data,
and anything your app draws itself goes in a [`customUI` param](channels.md#customuiname-provider), not in text the
model formats. Flow Framework already fits each message to its channel (length, buttons, lists,
captions, formatting) and refuses what the platform would refuse, so there is no need to describe
those limits in the prompt.

## Refuse with a reason the model can act on

When `beforeSend` refuses (`{ refuse: "why" }`), or a tool fails, the reason goes back to the agent,
which sends again. Write it as an instruction for that next try: say what was wrong and what to do
instead.

| Hard to act on | Easy to act on |
|---|---|
| `invalid message` | `The total is $18.50, not $15. Quote the total the cart tool returned.` |
| `policy violation` | `Do not promise a delivery time. Say the courier will text them one.` |
| `error 422` | `That date is in the past. Ask which day next week suits them.` |

Never put secrets or internal details in a reason: the model reads it, and may repeat it.

## Test a long chat

Most scenarios end in a few turns, but real people come back for weeks. Once a conversation is longer
than `history.maxTokens`, older messages are left out of each model call (the agent is told), and a
rule that held for ten turns can slip at the fiftieth. Write at least one scenario that runs long
(`max_turns: 30` or more, a person who returns with a new question), and build the agent for it with
a small `history: { maxTokens }`, so the trimming happens inside a short test. Check what must
survive it: who they are, what they ordered, what they asked you never to do again.

## See also

- [`createAgent` options](../README.md#createagent-options): `beforeSend`, `history`, `intercept`.
- [Channels](channels.md): each channel's options and params.
- [Guarantees](guarantees.md): what Flow Framework promises about order, delivery and restarts.
- [Testing](../README.md#testing) and the test skill in [`coding-agents/test-skill.md`](../coding-agents/test-skill.md).
