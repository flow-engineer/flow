---
name: flow-framework-contracts
description: Change an MCP server's tools without breaking the CLIs already published against it: when a change is breaking, how to bump the contract, write the adapter and snapshot, and how to drop an old contract. Load before renaming or removing a tool, changing a tool's input or output shape, or touching mcpServer's contracts.
---

# Changing tools without breaking published CLIs

A published CLI keeps calling the server it was built against, for months. Claude, ChatGPT and
other hosts read the tools fresh every time and adapt; a CLI does not. A **contract** is what a
CLI was built against: the tools' names, inputs and outputs. One server speaks several contracts:
it keeps only the current tools, and an older contract is served by a small **adapter** over them.

## Is the change breaking?

Breaking (bump the contract):
- a tool removed or renamed;
- an input removed, renamed, retyped, or newly required;
- an output reshaped: a field removed, renamed, retyped or moved (unwrapping an envelope counts).

Not breaking (no bump, no adapter, nothing else to do):
- a new tool; a new optional input; a new field in a result;
- a description, title, annotation or a tool's formatted text (`format`) changed.

When unsure, make the change and run the contract snapshot tests (below): they fail on a break and
pass on an addition.

## Bump the contract

1. Make the change to the tools as you want them now. Never keep a second copy of a tool.
2. Increase `current` by one, and add an adapter for the contract it replaces:

```ts
import { mcpServer, type McpContracts } from "@flow-engineer/flow/mcp";

const contracts: McpContracts = {
  current: 3,
  supported: {
    2: {
      tools: {
        // By the current tool's name: what contract 2 called it, took and answered.
        get_order: {
          name: "order_status",
          input: z.object({ id: z.string() }),
          mapInput: ({ id }) => ({ order_id: id }),
          output: z.object({ order: orderSchema, ok: z.boolean() }),
          mapOutput: (order, input) => ({ order, ok: true }),
        },
      },
      // A tool contract 2 had and the current one does not: a stand-in calling its replacement,
      // or, when nothing maps, a small legacy implementation (it replaces a current tool of its name).
      legacy: [tool({ name: "ping", /* ... */ run: () => "pong" })],
    },
    1: { /* the adapter you already had: it maps contract 1 onto the current tools too */ },
  },
  // CLIs published before they named a contract: from their clientInfo ("<name>-cli", version).
  pick: ({ name, version }) => name === "acme-cli" && version.startsWith("0.1.") ? 1 : undefined,
};

mcpServer({ name: "acme", version, tools, contracts });
```

   Every adapter maps from the **current** tools. When you bump, update each older adapter for the
   change too (usually one line in each); the snapshot tests show which ones.
3. Set the CLI file's `contract` to the new `current` (`defineCli({ contract: 3, ... })`). Keep the
   number in one module both files import, so they never disagree. The CLI names it on every
   request; the server answers in it.
4. Record the new contract's snapshot (below) and add it to the tests. Keep the old snapshots as
   they are: they are what the old CLIs need.
5. Release the server first, then the CLI. A CLI naming a contract the server does not know yet
   is refused.

How a request's contract is chosen: the one the client names (Flow's CLI sends defineCli's
`contract` in `_meta["flow.engineer/contract"]`), else `pick(clientInfo)`, else the current one.
MCP hosts name none, so they always get the current tools.

The adapter changes data, not words: an older contract's tool answers with the current tool's
formatted text and descriptions. Formats and descriptions can change freely.

## Snapshot every contract in the tests

One saved file per contract served: its tools (names and schemas) and a few sample calls with their
results, made against fixed backend answers. Choose calls that cover each result shape (a read, a
write, a preview, an error).

```ts
import { contractProblems, contractSnapshot } from "@flow-engineer/flow/mcp";

for (const n of [1, 2, 3]) test(`contract ${n} still holds`, async () => {
  const now = await contractSnapshot(server, { contract: n, token, calls });
  const file = new URL(`../contracts/${n}.json`, import.meta.url);
  if (process.env.UPDATE_CONTRACTS === String(n)) writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
  assert.deepEqual(contractProblems(JSON.parse(readFileSync(file, "utf8")), now), []);
});
```

For a contract that published CLIs reach through `pick`, take its snapshot with their `client`
(`{ name: "acme-cli", version: "0.1.4" }`) instead of `contract`, so the rule is tested too.
`contractProblems` lists what a change breaks and lets additions through. Never rewrite an old
contract's snapshot to make a test pass: fix the adapter. Write a snapshot only for a new contract,
before its first CLI release; record an existing contract's first snapshot from the server as it
was released (or check it against the released CLI) so it holds what CLIs really got.

## Drop an old contract

Only when no CLI that needs it is left in use: the traces' `tool.end` events carry `contract`, so
check that nothing has used it for a while (and that the CLI's update has been out longer). Then
remove its adapter, its snapshot and its test. A CLI still on it now gets one clear error: it is too
old, run `<name> update` (Flow's CLI shows that line; an older one shows the server's message).
