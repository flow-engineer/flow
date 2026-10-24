# MCP + CLI: work list

The open work on Chinwag's MCP server (`mcp/`), MCP client (`mcpTools`) and CLI (`cli/`).
One task per section; each says what is decided, where the code goes, and when it is done.

## 1. Plugins ship the skills; their MCP server leaves them out

**Decided (18 Oct 2026).** Skills reach a host exactly once, through what that host loads natively:

```
Plugin (Claude Code / ChatGPT / Codex / Cursor / Copilot)
├── skills/<name>/SKILL.md       ← skills come from here
└── MCP entry → <server>/mcp/plugin
                  └── tools only: no read_skill, no skills list in instructions

Standalone (someone adds the MCP server by hand, in any host)
└── <server>/mcp
      └── tools + read_skill + skills list in instructions   ← skills come from here (today's behaviour)
```

One server, one deploy, the same tools and sign-in on both paths; only how skills are delivered differs.

Why: Sentry's MCP server sends tools only and ships its skills as plugin files, so a standalone MCP
user gets no skills. Chinwag keeps skills for standalone users (`instructions` + `read_skill`) and
avoids doubling them for plugin users. Both ChatGPT/Codex plugins (since 9 Jul 2026, `.codex-plugin/`)
and Agent Plugins 1.0.0 (6 Aug 2026, `plugin.json` + `mcp.json` + `skills/`) allow a plugin with
skills plus an MCP entry, an MCP entry alone, or skills alone; Claude Code has its own `.claude-plugin/`.

### 1a. The plugin path on `mcpServer()`

- `mcp/src/server.ts`: serve a second path (default `${path}/plugin`, i.e. `/mcp/plugin`) with the same
  tools and auth, minus `read_skill` and minus the skills list in `instructions`. A team's own
  `instructions` override still applies to both paths.
- Protected-resource metadata per path: `/.well-known/oauth-protected-resource/mcp/plugin` answers
  with `resource` = the plugin path's URL; the 401's `WWW-Authenticate` points at the right one.
- `descriptors` (what `tools/list` returns) per path; events carry which path served the call.
- A path, not a query string: neither spec says anything about query strings in plugin MCP URLs.
- Decide before building: the option's name and whether the plugin path can be turned off.
- Tests (`test/mcp-server.test.ts`): `/mcp/plugin` lists no `read_skill` and has no skills in
  `instructions`; `/mcp` unchanged; both gate sign-in the same; metadata for both.

### 1b. Writing the plugin folders from the agent's skills

- The plugin's `skills/` is a copy of `agent/skills/` taken at publish time, so it is generated, never
  hand-edited (like Sentry's generated CLI skill): a `chinwag plugin` command (testing/src/cli.ts)
  writes, for a given server URL:
  - Claude Code: `.claude-plugin/plugin.json` with the MCP server pointing at `<url>/mcp/plugin`, plus `skills/`.
  - ChatGPT / Codex: `.codex-plugin/plugin.json`, `mcp.json` (Agent Plugins schema), `skills/`.
  - Agent Plugins 1.0.0 (Cursor, Copilot, VS Code, Kiro): `plugin.json`, `mcp.json`, `skills/`.
- Read each format's spec at build time and follow it exactly (agent-plugins.org/specification,
  developers.openai.com/plugins/build/plugins, Claude Code plugin docs); record the versions read.
- `chinwag check`: a skill shipped in a plugin may name only tools the MCP server serves (today it
  warns on chat-only tools; make it an error for plugin output), and a plugin folder older than
  `agent/skills/` is reported as stale.
- Tests: generated folders validate against each schema; skills copied byte for byte; the MCP URL ends
  in `/mcp/plugin`.

### 1c. Docs

- README's MCP section and `coding-agents/skill.md`: the two paths, which one a plugin uses, and
  regenerating plugins after a skill changes.

**Done when:** a Claude Code plugin and an Agent Plugins folder generated from the café install
locally, the host shows the allergens skill once, and `get_menu` works through `/mcp/plugin`.
