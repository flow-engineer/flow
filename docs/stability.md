# Stability and what freezes at 1.0

## Until 1.0

Flow Framework is 0.x. Until 1.0, anything on this page may change between releases. Every release's
notes ([CHANGELOG.md](../CHANGELOG.md)) have a **Migration notes** section that calls out each
breaking change and says what to change (or says "None."). Pin the exact version in `package.json`
for production, and read the notes before you move it. How a release is made: [releasing.md](releasing.md).

## At 1.0

At 1.0 the API freezes: everything below keeps working, with the same meaning, for every 1.x
release. New exports, options, fields, commands, flags, events and codes may be added; none listed
here is renamed, removed or changes meaning before 2.0. Anything not listed (files under `src/` not
exported from an entry point, `dist/` paths, log wording, the playground's look) is not part of the
API.

This list is taken from the entry points as they are today; it is what 1.0 would freeze, not a
freeze yet.

### Exports, by entry point

| Entry point | Values | Types |
|---|---|---|
| `@flow-engineer/flow` | `createAgent`, `Agent`, `Conversation`, `Store`, `tool`, `toSpec`; channels `whatsapp`, `sms`, `customUI`, `webChat`, `webChatIdentity`, `WEB_CHAT`, `carouselMessages`, `fitMessage`, `replyButton`, `contentRefusal`, `fillTemplate`, `declaredTemplate`, `CONTENT_LIMITS`, `WHATSAPP`, `WHATSAPP_CAROUSELS`, `SMS`, `SMS_KEYWORDS`, `US_CARRIER_KEYWORDS`, `WHATSAPP_KEYWORDS`; storage `sqlite`, `postgres`; records `RECORD_LIMITS`; wake-ups `WAKE_UP_LIMITS`; models `openAICompatible`, `flowModel`, `flowModelURL`, `flowTranscribe`; HTTP `nudgeHandler`, `peopleHandler`; events `jsonlSink`; local `choosePort`, `markRunning`, `runningAgent`; `z` (zod); everything from `src/business-events` | `AgentOptions`, `HostOptions`, `AgentStatus`, `Contact`, `HeldItem`, `ScheduledItem`, `NudgeInput`, `NudgeResult`, `NudgeState`, `NudgeStatus`, `PlaygroundSink`, `ReceiveOptions`, `TestPerson`, `Channel`, `ChannelAgent`, `ChannelKind`, `ChannelSummary`, `ChannelInfo`, `Carousel`, `CarouselCard`, `ContentLimits`, `ContentRefusal`, `CustomUIProvider`, `SmsProvider`, `WhatsAppProvider`, `WhatsAppFeature`, `Keywords`, `Message`, `FilledTemplate`, `Template`, `TemplateButton`, `TemplateDefinition`, `Profile`, `TranscriptEntry`, `Database`, `PostgresPool`, `EventSink`, `FlowEvent` (`ChinwagEvent`, deprecated), `StoreApi`, `Records`, `RecordCollection`, `RecordEntry`, `RecordCursor`, `RecordValue`, `RecordScalar`, `ExportedRecord`, `WakeUp`, `WakeUpInput`, `WakeUpResult`, `WakeUps`, `AgentFiles`, `TracesOptions`, `Tool`, `ToolContext`, `ToolHints`, `ChatAuth`, `ChatAuthContext`, `CredentialProvider`, `Credentials`, `McpClientKind`, `SignIn`, `Attachment`, `BeforeSend`, `SendContext`, `ChatMessage`, `Deliver`, `Incoming`, `ListRow`, `Media`, `Model`, `ModelRequest`, `ModelResponse`, `Outbound`, `OutboundMessage`, `PageContext`, `PersonMessage`, `Photo`, `ReplyButton`, `ToolCall`, `ToolSpec`, `Transcribe`, `OpenAICompatibleOptions`, `FlowTranscribeOptions`, `NudgeHandlerOptions`, `PeopleHandlerOptions`, `WebChat`, `WebChatEvent`, `WebChatLimits`, `WebChatOptions`, `WebEventRow` |
| `@flow-engineer/flow/web-chat` (for your backend) | `webChatIdentity`, `webChat`, `WEB_CHAT` | `WebChat`, `WebChatEvent`, `WebChatLimits`, `WebChatOptions` |
| `@flow-engineer/flow/simulators` | `simulators`, `playgroundClock`, `PLATFORMS`, `platform`, `channelOf`, `smsSegments` | `SimulatorsOptions`, `Playground`, `PlaygroundAgent`, `PlaygroundClock`, `AgentConnection`, `Line`, `LinkCard`, `LocalCliOptions`, `TestCloudSimulators`, `Platform` |
| `@flow-engineer/flow/flow-messaging` | `flowMessaging` (and what it returns: `whatsapp`, `telegram`, `imessage`, `sms`, `channels`, `webhook`, `receive`, `stream`, `start`), `TELEGRAM`, `IMESSAGE`, `API_VERSION`, `FlowMessagingError`, `verifySignature` | `FlowMessagingOptions`, `FlowChannelOptions`, `WebhookAgent`, `StreamOptions`, `StreamStop`, `StreamHandle` |
| `@flow-engineer/flow/testing` | `runInCloud`, `loadSuite`, `parseScenario`, `parseToolFile`, `suiteHash`, `hashOf`, `isBusiness`, `waitMs` | `CloudSummary`, `ConnectOptions`, `OpeningStep`, `Scenario`, `SentItem`, `SuiteFile`, `ToolFile`, and the protocol's types (`Command`, `Check`, `RunSummary`, `SessionSummary`, ...) |
| `@flow-engineer/flow/mcp` | `mcpServer`, `mcpTools`, `fingerprint`, `describe`, `titleOf`, `toolProblems`, `toolsProblems`, `terminalServer` | `McpServerOptions`, `McpServerHandle`, `McpAuth`, `McpIdentity`, `McpDescriptor`, `McpLock`, `McpToolsOptions`, `McpToolDescriptor`, `Scopes`, `TerminalServerOptions` |
| `@flow-engineer/flow/cli` | `defineCli`, `runCli`, `processIO`, `commandTable`, `cliProblems`, `derivedName`, `skillFile`, `EXIT` | `CliConfig`, `CliContext`, `CommandConfig`, `CustomCommand`, `ToolCommand`, `ToolInfo`, `CliIO` |
| `@flow-engineer/flow/oauth` | `oauthBridge`, `databaseStorage` | `OAuthBridge`, `OAuthBridgeOptions`, `BrandTokens`, `OAuthRecord`, `OAuthStorage` |

With each export: its options and fields (such as `createAgent`'s, in the
[README](../README.md#createagent-options), and each channel's, in [channels.md](channels.md)),
their defaults, and what `buildAgent` is passed by `flow test` and Flow's hosting.

### Files and formats

- An agent's folder: `AGENTS.md`, `skills/`, `src/agent.ts` exporting `buildAgent` and `tools`, and
  the starter files `flow new` and `flow init` write.
- Test files: `tests/scenarios/*.yaml` and `tests/tools/*`, as `testing/src/suite.ts` reads them.
- `mcp.lock.json`, the CLI file, `.flow/last-session.json`.
- The Store's tables and migrations (`parley_migrations`), which a store service such as Flow's
  hosting runs, and `flow records export`'s JSON Lines (`collection`, `id`, `value`, `createdAt`,
  `updatedAt`).
- The HTTP agent contract `flow check-endpoint` checks, and the business events envelope and answers
  ([events.md](events.md)).
- The web chat's HTTP contract under `/v1/web-chat` (sessions, history, events over SSE or
  long-polling, messages, the identity token's claims, error codes) and the chat box's script tag:
  its `data-` attributes, the `FlowChat` API, the `flowchat:open` and `flowchat:message` events and
  the `--flow-chat-*` CSS properties ([channels.md](channels.md#webchatoptions)).

### The `flow` command

- Commands: `new`, `init`, `chat`, `records export`, `test`, `show`, `check`, `check-endpoint`, `mcp update`, `cli`,
  `plugin`, `login`, `logout`, `whoami`, `setup`, `link`, `status`, `projects list`, `projects delete`, `deploy` (and `deploy promote`,
  `deploy status`), `logs`, `--version`; their flags as `--help` prints them.
- `--json` fields, and the `next` lines ([agents.md](agents.md)).
- Exit codes: `flow test` 0 passed, 1 failed (the pass rate under `--min-pass`) or invalid, 2 errored
  or not reachable, 3 refused, 130 interrupted; `login`, `setup`, `link` as in [agents.md](agents.md#exit-codes-login-setup-link);
  `deploy` as in [agents.md](agents.md#host-it); a `defineCli` command line `EXIT` (0 ok, 1 failed,
  2 usage, 3 sign-in, 4 approval, 5 unreachable).

### Environment names

What an agent's `.env` or its host sets: `FLOW_KEY`, `MODEL`, the model providers' keys
(`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), `FAKE_MODEL`,
`FLOW_MODEL_URL`, `FLOW_FRAMEWORK_CLOUD`, `FLOW_FRAMEWORK_CLOUD_KEY`, `FLOW_FRAMEWORK_AGENT_TOKEN`, `FLOW_TEST_MIN_PASS`,
`FLOW_FRAMEWORK_WORKSPACE`, `FLOW_FRAMEWORK_TRACES_URL`, `FLOW_FRAMEWORK_TRACES_KEY`,
`FLOW_FRAMEWORK_TRACES_CONTENT`, `FLOW_FRAMEWORK_TRY_URL`, `FLOW_FRAMEWORK_JOIN_CODE`,
`FLOW_FRAMEWORK_LOGIN_URL`, `FLOW_MESSAGING_KEY`, `FLOW_MESSAGING_WEBHOOK_SECRET`,
`FLOW_MESSAGING_BASE_URL`, `FLOW_MESSAGING_<CHANNEL>_SENDER`, `FLOW_WEB_CHAT_ORIGINS`,
`FLOW_WEB_CHAT_IDENTITY_KEY`, `FLOW_WEB_CHAT_SESSION_KEY`, `FLOW_TRUST_PROXY` (the last two set by
Flow's hosting itself), and the older names they replace
(`CHINWAG_*`, `FLOW_MESSAGING_API_KEY`, `FLOW_MESSAGING_API_URL`). Names Flow's test cloud and hosting
set for themselves are not part of the API.

### Events and codes

- Event types an `EventSink` gets: `turn.start`, `turn.context`, `turn.end`, `message.arrived`,
  `message.in`, `message.out`, `message.duplicate`, `message.refused`, `message.undelivered`,
  `message.edited`, `message.unsent`,
  `reaction.in`, `model.call`, `model.error`, `model.restarted`, `tool.start`, `tool.end`,
  `tool.detached`, `tool.repeated`, `task.done`, `skill.loaded`, `history.trimmed`, `ack.required`,
  `auth.required`, `attachment.failed`, `template.missing`, `text.hidden`, and their fields.
- Codes an agent or a coding agent acts on: `outside_window`, `no_model_key`, `trial_credit_used`,
  the Flow error codes the CLI prints (`timeout`, `slow_down`, `server_unsupported`,
  `sandbox_allowance_used`, ...), and a refusal's error text from `contentRefusal`.
- Trace attribute names (`chinwag.*`).
