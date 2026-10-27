---
name: flow-framework-cli-design
description: Design a Flow Framework CLI people and coding agents enjoy: which commands get short default access, positional arguments, short flags, defaults and groups, and the welcome screen and sign-in a newcomer sees first. Load before writing or reviewing a CLI file (defineCli, command(...)) or when a CLI feels long to type.
---

# Designing the CLI

Every tool is already a command (`place_order` → `acme place-order --order-id ...`). That works,
but it is long to type and reads like an API. Shape it so the most used actions are the shortest
to type. The mechanics are in `flow-framework-mcp` (`mcp-skill.md`, "A CLI for the organization");
this skill is what to choose.

## 1. Find the few commands that matter

Rank the tools by how often a person or agent runs them. Usually two or three carry most use
(scrape, search, check status). Those get the short forms below. The rest keep their generated
command; do not shorten everything, or nothing stands out and names collide.

## 2. Give each a group of nouns and verbs

Name commands as noun then verb: `scrape create`, `scrape get`, `keys list`, `keys revoke`. The
noun is a group; its help lists the verbs. Use the person's words, not the tool's
(`keys`, not `api-keys-management`).

## 3. Make the main verb the group's default

When one verb of a group is what people mean most of the time, make it the default, so the noun
alone does it:

```ts
defaultCommands: { scrape: "create", search: "query" },
```

`acme scrape https://example.com` then runs `scrape create`, while `acme scrape get <id>` still
runs `get` (a named subcommand wins). Bare `acme scrape` shows the group's help. Give a default
only to a verb that takes a positional argument: with none, the bare group is help, not the action.

## 4. Take the main input positionally

The one input a command is about goes without a flag: the URL to scrape, the id to get, the query
to search. Keep it to one or two, in the order people say them:

```ts
"scrape create": command("scrape_create").arg("url"),
"keys move": command("keys_move").arg("key_id", "project"),
```

A list input as the only argument takes every word (`acme scrape a.com b.com`). Everything else
stays a flag: positional order is easy to get wrong once there are more than two.

## 5. Shorten the flags people type often

- `.short("f", "format")` for a flag used in most calls (`-f html`). Letters are few: give them
  only to the common ones, the same letter for the same idea across commands (`-n` limit, `-f`
  format, `-o` output). `-h` and `-H` are help.
- `.flag("all", "include_revoked")` when the tool's field name is long or internal; the field's
  own flag still works.
- `.default("format", "markdown")` so the usual value needs no flag at all.
- `.hide("source").default("source", "cli")` for an input people should never set.
- `.help("format", "markdown, html or text")` when the tool's description does not say what to type.

## 6. Keep the output readable, and the data exact

People get `.columns()` for lists, `.view()` for one record, or `.print(result => ...)` for a
sentence ("3 pages scraped"). Agents always pass `--json`, which prints the data unchanged, so
never put information only in the human output.

## 7. Decide what a newcomer sees first

Run with no command at a terminal, the CLI shows a welcome: its name in block letters, the
version, a greeting, whether the person is signed in, and how to start. Coding agents, scripts and
pipes get the help instead, so the welcome costs them nothing. Make it the team's own:

```ts
version: "2.4.0",
description: "Scrape any page from your terminal.",  // the welcome's second line
brand: { name: "Acme", logo: "https://acme.com/logo.svg", accent: "#e8833a" },  // banner, chat and sign-in page
welcome: { title: "Welcome to Acme", tips: ["acme scrape <url>    Scrape a page", "acme keys list       Your API keys"] },
```

Set `brand` once: the banner, the chat and the page a browser sign-in ends on all read it.
Tips should be the two or three commands from step 1, as people will type them. `banner` takes the
team's own ASCII art (or `false` for none); `welcome: false` shows the help instead.

When nearly every tool needs an account, add `signInFirst: true`: a signed-out person is offered
Sign in or Exit before any command, then the command they typed runs; an agent gets exit 3 with
`acme auth login`. Leave it off when some commands work signed out (public search, docs), or list
those in `signInFirst: { except: ["docs"] }`. `auth`, `help` and `--help` never ask.

## 8. Check it

Run `npx @flow-engineer/flow check`: it refuses shorthands for inputs a tool lacks, flags that
clash with the CLI's own (`--json`, `--server`, `-h`), and defaults that are not a group's
command. Then try the three ways people will type the main action, for example:

```
acme scrape https://example.com
acme scrape create https://example.com -f html
acme scrape get scrape_123 --json
```

and read `acme --help`, `acme scrape --help` and `acme skill get acme-cli`: the short forms
should be what a newcomer sees first.

## A complete CLI file

```ts
import { fileURLToPath } from "node:url";
import { command, defineCli, runCli } from "@flow-engineer/flow/cli";

export const cli = defineCli({
  name: "acme",
  server: process.env.ACME_SERVER ?? "https://acme.example.com/mcp",
  version: "2.4.0",
  description: "Scrape any page from your terminal.",
  welcome: { tips: ["acme scrape <url>    Scrape a page", "acme keys list       Your API keys"] },
  signInFirst: true,
  groups: { scrape: "Scrape pages", keys: "API keys" },
  defaultCommands: { scrape: "create" },
  commands: {
    "scrape create": command("scrape_create")
      .arg("url")
      .short("f", "format")
      .default("format", "markdown")
      .print((r) => `Scraped ${(r as { url: string }).url}`),
    "scrape get": command("scrape_get").arg("scrape_id"),
    "keys list": command("api_keys_list").short("n", "limit").flag("all", "include_revoked").columns("id", "name", "created_at"),
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await runCli(cli, process.argv.slice(2)));
```

Keep these choices in the CLI file, or files it imports. Tools never carry them: the MCP server
and the messaging agent use the same tools unchanged.
