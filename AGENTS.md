# Working on Flow Framework

Flow Framework lets a product ship to every chat interface from one codebase: messaging agents on
WhatsApp, SMS, iMessage, Telegram and web or app chat; MCP servers for Claude, ChatGPT and other
assistants; native plugins; and CLIs for people and coding agents. Tools and skills are shared
across these surfaces. A project can start with any one of them.

## Keep it general
- Nothing specific to one business goes in this repository: no customer names, data, prompts
  or business rules. Agents built on Flow Framework live in their own repositories and depend on it;
  Flow Framework never imports from outside this repository.
- Internal decisions are kept privately, not in this repository.

## Be deliberate: nothing goes in that has not earned its place
- Every file, function, dependency and test must have a reason. No speculative code, helpers
  "for later", extra options, or files nobody asked for.
- Propose a design choice (behaviour, defaults, models, prompts, dependencies, file layout) with
  a recommendation before writing code that depends on it.
- A new dependency or a new file needs a maintainer's yes.
- Remove what stops being used (scripts, options, tests) in the same change.

## Until 1.0 the API may change; every release says how to move
- The API (exports, options, file formats, the starter files `flow new` copies, `.env` names, CLI
  commands, `--json` fields and exit codes, and what Flow's hosting passes to `buildAgent`) may change
  between 0.x releases. It freezes at 1.0.
- Every release has release notes with migration notes: each breaking change is called out, with
  what an agent must change to keep working. A change with no note keeps every agent working unchanged.
- Where it costs little, keep the old name working beside the new one (deprecated, saying what
  replaces it) for a release, as the move from chinwag did.

## Tests
- Each test protects one behaviour. Before adding one, say which behaviour, and why no existing
  test already covers it. Prefer fewer tests that matter; merge or delete tests that overlap or no
  longer protect anything.
- Unit tests never call a real model: they drive a scripted model. Wait on explicit gates
  (promises the test resolves), never on sleeps.
- While iterating, run only what a change affects: `npm run test:changed` picks the test files
  by rule and runs them in parallel.
- Every test file starts with `// covers: <src files>`, the source files whose behaviour it
  protects; `test:changed` reads it, so keep it accurate when tests move or code is split. Paths
  are relative to the repository root, also in the simulators and flow-messaging packages (`simulators/src/server.ts`).
- The full suite (`npm test`, at the root, in `simulators/` and in `flow-messaging/`) runs before a change is merged.
- Tests that call real models (a simulated person, a judge) run only when someone starts them,
  never in CI, and print what they cost.

## Documentation: update it with the code

- Public documentation is maintained in the private GitHub repository **flow-engineer/docs**.
  Do not create or maintain a separate documentation site in this repository or assume a local
  checkout location. Follow the docs repository's agent instructions and writing conventions.
- Every change to a public API, CLI command, configuration, authentication flow, default,
  limitation or user-visible behavior must include the corresponding update in the docs repository
  before release. New features need a working example and an expected result. Link the companion
  documentation change in the implementation PR; explain explicitly when no docs change is needed.
- Keep documentation concise, accurate and useful to people and coding agents. Check examples
  against current code, preserve safety rules and limitations, and run the docs repository's checks.
- Keep package- and service-embedded guidance consistent with the published guides. These runtime
  assets remain here for compatibility; they are not a second hand-written website.

## Coding-agent skills
- `coding-agents/` starts with project setup and routing (`skill.md`), then loads messaging runtime
  and operations (`build-agent-skill.md`) or MCP, CLI and plugins (`mcp-skill.md`) for the task. It also
  teaches agents to write tools and their test files (`tools-skill.md`), design a CLI's short forms
  (`cli-design-skill.md`), write tests (`test-skill.md`), build the
  context pack from an organization's codebase (`context-skill.md`), set up sign-in
  (`auth-skill.md`) and connect a brand's existing login to Flow's OAuth bridge (`oauth-bridge-skill.md`). A change to an API, a file format or a convention they describe updates them
  in the same change.

## Model-facing text
- Flow Framework's own text for the model lives in `src/talk.ts`, `src/conversation.ts`, `src/skills.ts`
  (also what an MCP host is told about the skills, and `read_skill`),
  and the built-in tools' descriptions and notes in `src/schedules.ts` and `src/nudges.ts`. Keep it
  short; every line costs every turn.
- `testing/` is the developer's side of testing: the test file formats (`suite.ts`), and the CLI
  and protocol that send an agent's tests to the test cloud. The cloud plays the person and the
  tools and judges the runs; that runtime is not in this repository.

## The surfaces Flow Framework generates stay the team's own (hard rule, never broken)
Flow Framework turns an agent's tools and skills into other surfaces: an MCP server, a CLI, and those
that follow. It sets a standard that is easy to reach, never a ceiling a team cannot pass. Teams
have their own requirements, and each one must stay possible.
- **Every generated piece can be overridden or replaced** by the team's own: a command's name,
  arguments, output and help; an MCP tool's name, description, schema and result; auth; routes;
  docs and skills. A default exists so a team writes nothing; it never stops a team writing
  something else.
- **Generated and hand-written live side by side.** A team can add commands, MCP tools or routes
  Flow Framework knows nothing about next to the generated ones, without leaving the framework.
- **Nothing is locked inside Flow Framework.** What a generated surface is built on (the protocol SDK, the
  HTTP handler, the command parser) stays reachable, so a team that outgrows the defaults keeps
  its agent and goes one level down.
- **Overrides are plain code in the team's repository,** reviewed like the rest of it, checked by
  `flow check` only for what is objectively wrong (a name a host refuses, a field that does not
  exist), never for taste.
- A change that removes a way to customize, or makes one harder, is refused, however much simpler
  it makes Flow Framework.
