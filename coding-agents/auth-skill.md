---
name: flow-framework-auth
description: Set up verified-phone sign-in, a brand’s OAuth server or its existing login, with one account across chat, MCP and the CLI and backend credentials kept in tool code.
---

# Sign-in for a Flow Framework agent’s tools

Read `flow-framework-context` first: `context/access.yaml` describes the brand’s accounts and how its users sign in. Keep that account system. Every interface resolves to the same stable brand user id; a phone number, provider login and CLI connection are ways to reach it, not separate accounts.

## Token authority and custody: the app mints, everyone else carries

The brand (or its identity provider) issues the credential its API trusts, controls its lifetime and refresh, and can revoke it. The end client, such as the CLI or an MCP host, receives and maintains its own connection credentials and sends them with requests. Flow is the protocol handoff, not a separate authority that turns a user id into access to the brand's API.

For a brand with ordinary login, its backend functions validate the existing session and mint or exchange the brand-authorized credential for the intended client and resource. Flow can coordinate OAuth registration, redirects, PKCE and one-time code exchange, retaining the short-lived protocol state needed for that exchange. It must not become a durable vault for the end client's brand access/refresh credentials or replace them with an independent Flow-owned permission to act as that user. Refresh and revocation stay under the brand's authority.

A messaging agent can itself be a server-side client: its channel connection credentials belong behind the brand's integration boundary, not in WhatsApp/iMessage messages or model context. Distinguish that client from the OAuth handoff service. Verified-phone sign-in can authorize an operation directly when that is the brand's account policy; it does not require an extra OAuth token or login screen.

## Choose the entry point

1. **Phone is the brand’s primary identity.** A sender on a provider-verified phone channel (WhatsApp, phone-based iMessage, SMS) is signed in. Resolve that phone to the brand’s account, creating it only when the brand supports that. Give their normal full account access. Do not add an OTP, browser login, consent screen or permission picker on top of the verified channel.
2. **The brand already exposes an OAuth authorization server.** Use it for MCP and CLI connections. On chat channels that need account sign-in, send a connection link to its existing login. A Google sign-in button in an app is not by itself an OAuth authorization server for MCP clients.
3. **The brand has an ordinary login.** Use that login as the authentication step behind Flow’s OAuth layer (or a self-hosted OAuth server). Phone OTP, email, social login, company SSO and custom login can all finish the same connection. The brand confirms the signed-in account server-side and owns credential issuance and refresh; the OAuth layer coordinates client registration, one-time codes, PKCE and the brand-authorized token exchange. Do not add a Flow grant-selection screen by default. An existing provider can have its own required screens.

A phone-first brand uses case 1 on WhatsApp and case 3 for its CLI: `auth login` opens the brand’s phone login in a browser, phone verification signs in, and OAuth returns to the CLI. The user never has to create an email account just to use another interface.

## Verified phone → account

`resolve` receives `phone` only when the channel verifies phone identities. It is normalized; `address` remains the provider’s original address. A custom web address that looks like a phone does not get this evidence. Only mark a channel `phone: true` when its provider verifies the sender and your webhook authenticates that provider.

```ts
const resolve = async ({ phone }) => phone ? accounts.forVerifiedPhone(phone) : null;
const agent = createAgent({ ...options, resolve });
```

Return the brand’s account id. MCP’s `auth.verify` returns that same id as `key`, so the terminal, web and phone channels share the person’s history. Without a brand resolver, phone channels still share one `phone:<E.164>` identity; `context.key` is null. Connect other login methods to an existing account only with verified account-linking proof, never a number or email supplied in model input.

## Tool code gets backend access

Supply the same `credentials` provider to `createAgent` and `mcpServer`. It runs lazily when tool code requests a named credential or backend client, with the framework’s verified identity. The brand decides how to obtain, refresh, authorize and revoke that access. This callback can support an API token, an authenticated client, a grant reference or the brand’s own authentication mechanism.

```ts
const credentials = async (name, context) => {
  if (name !== "backend" || !context.key) throw new Error("Sign in required");
  return backend.forAccount(context.key); // checks current account/session access
};

const tools = [tool({
  name: "my_orders", description: "Your orders.", input: z.object({}),
  run: async (_input, ctx) => {
    const api = await ctx.credentials.get("backend");
    return api.orders();
  },
})];

const agent = createAgent({ ...options, tools, resolve, credentials });
const mcp = mcpServer({ ...serverOptions, tools, auth, credentials });
```

In TypeScript use `ctx.credentials!.get<YourBackendClient>("backend")`. Never take an account id from tool input as authorization. The credential accessor is non-enumerable and the framework sends neither its provider nor resolved credentials to the model, history or events. Tool authors must also keep credentials out of their results, errors and logs. Do not cache a user’s access in a process-global variable. A request-local token workaround is not necessary when backend access is resolved by verified account.

When backend access depends on the caller's actual credential, `auth.verify` may return `{ key, credentials }`. That request's credential provider overrides the default for MCP and the authenticated terminal; close over the verified token there. A verified account id alone is not permission to mint or fetch a backend token. The provider is server-side and non-enumerable; it never enters model inputs or traces.

The default is full normal user access, not global administrator access. Existing business ownership checks still apply. Optional scoped connections remain available for brands that require them; do not invent a permissions UI or restrict the brand’s normal experience by default.

## Authentication at a chat tool boundary

Configure `createAgent({ auth: { verify?, signIn } })`. Public conversation remains available while signed out. Tools use the same `signIn` metadata as MCP: `"none"` is public, `"optional"` runs with a null key when unsigned, and `"required"` (default) cannot execute until authenticated. Agents without `auth` retain their existing behavior.

`verify(context)` can recheck revocation or the current channel connection. Without it, a non-null key from trusted `resolve` is enough, including a provider-verified phone mapped to a brand account. `signIn(context)` returns `{ message, url? }`: the framework delivers this as a real channel message with the login link, records it in the transcript, and does not run the protected tool. Parallel protected calls produce one challenge per channel per turn. A custom in-chat challenge may omit the URL. Login functions receive server-issued channel/address and tool identity, never model-supplied account ids. Errors fail closed and credentials stay outside model context.

After login, resolve that channel to the canonical account key; the user can resume the request. Do not automatically replay an irreversible operation merely because login succeeded.

## OAuth on MCP and the CLI

The MCP server is a resource server, not the user’s login page. Its auth adapter verifies a token on every request and returns the brand’s user id:

```ts
const auth = {
  issuer: "https://login.example.com",
  resource: "https://agent.example.com/mcp",
  async verify(token, request) {
    const session = await accounts.verifyAgentAccess(token, request);
    return session ? { key: session.accountId } : null;
  },
};
```

Verify signature (or introspect opaque tokens), issuer, expiry, intended resource and current revocation/account status. The token must be issued for this MCP resource. Native plugin endpoints advertise their own resource too: configure the authorization server and verifier for each enabled resource. Never accept an unrelated website session token and forward it unchanged to a downstream API. Backend access is separate and resolved through `credentials`, or tools run within the brand’s backend under its existing authorization.

- Missing sign-in on a required tool returns HTTP 401 with `WWW-Authenticate`; MCP hosts discover the authorization server from protected-resource metadata. Do not return “please sign in” as a tool result and expect a host to start OAuth.
- `signIn: "none"` tools are public, `"optional"` can run either way, and the default is `"required"`. With no scope mapping, being signed in is enough. Brands that need scopes may configure `auth.scopes` and return granted `scopes` from `verify`.
- The CLI already implements browser-based authorization-code sign-in with PKCE and a loopback redirect. It stores credentials per server and the SDK refreshes them. CI can supply `<NAME>_TOKEN`. Device authorization is a separate optional flow, not an existing CLI feature.
- The authorization server handles registered clients and redirect validation. A third-party client’s existing authorization requirements remain its own. Flow’s first-party experiences do not need an extra permissions picker.

## Hosting choices

| Deployment | Authorization server | Brand work |
| --- | --- | --- |
| Flow-hosted, existing OAuth/OIDC server | Existing provider (for example Cognito) | Register clients/redirects, authorize the agent resource, and configure token verification/backend access. Flow does not add a broker. |
| Flow-hosted, ordinary/custom login | Flow's protocol bridge | Keep normal login. Add brand-owned one-time login completion, credential issuance, refresh, verification and revocation functions. The bridge relays brand-issued client credentials. |
| Self-hosted | Existing provider or the team's own OAuth server | Publish OAuth discovery and resource metadata, configure PKCE and client/redirect validation, implement the same brand authority boundary. No Flow service is required. |

An existing OAuth server must authorize the actual agent resource and supported clients; a website's social sign-in token alone is insufficient. Discover its authorization and token endpoints rather than assuming `/auth` and `/token`. Providers without dynamic registration need registered client configuration. The CLI accepts a configured OAuth client ID, and custom surfaces remain replaceable.

## Connecting an ordinary brand login

Keep the OAuth protocol layer reusable and the account authority in the brand. The brand integration must:

1. **Finish its existing login.** A small server-side function verifies its normal session and returns a short-lived assertion or opaque one-time code identifying the account and the pending Flow connection. Bind it to the client, intended resource, callback and nonce; exchange it for a single-use brand authorization required by credential issuance; never accept a user id merely posted by the browser.
2. **Provide account access.** Its backend validates a credential issued for that API, or supplies an authenticated execution path. Use separate resource credentials for MCP and downstream APIs; a UID alone never authorizes an API call.
3. **End access.** Account disable/deletion and connection revocation stop new requests and refresh. Signing out of one client need not disconnect the others.

For Firebase the app’s function validates the signed-in user’s Firebase session, or the authenticated provider’s phone proof, and resolves its Firebase UID. Where its API uses Firebase credentials, the intended client can exchange a brand-minted custom token for its own agent session and maintain that session; Flow’s handoff service does not retain its refresh credential. Keep the Admin SDK and its service-account keys in the brand’s backend. The old local test-account bootstrap is test setup, not a production sign-in flow.

A custom login implements the same boundary. Do not make every brand adopt one identity provider or copy an OAuth server into its agent repository.

After a verified OAuth callback has saved the chat client's connection, call
`await agent.signInCompleted({ channel, address, key, idempotencyKey: "login:" + connectionId })`.
This links the verified identity and queues an internal prompt to the agent, not a fixed user-facing
reply. The agent continues a request blocked by sign-in, or acknowledges naturally if nothing is
waiting. It does not automatically replay executed tools or unrelated failures. An anonymous
request blocked at the auth boundary is carried forward as user text; anonymous history stays
separate. Pass the originating `conversationId` when the login challenge was created inside a
conversation; it must belong to that channel address. The prompt targets that address even if
another session on the same channel wrote later. Signing in preserves no-contact rules, including
STOP. Use a stable unique completion ID so retries and restarts do not queue another event.
For playground connections pass `via: "playground"`; replies stay in the simulator. Persist pending
completion events and retry queueing after restart instead of relying on the browser staying open.
`linkIdentity` and `recordNudge` remain available for custom completion behavior.

## Exercise sign-in in the playground

Pass `authentication` to `simulators` to add **New user · signed out** to the person picker. Existing declared test people retain their current identities. The hook receives the `channel` and an opaque `visitor` issued by the playground server, and returns `{ key?, address?, label?, signInUrl? }`. Resolve that visitor's connection with the application's normal auth adapter and return the canonical account `key` only after authentication. A phone-primary brand can resolve a simulated provider-verified phone immediately; other interfaces can return the application's OAuth connection URL. Never take the key or verified phone proof from request bodies, and keep credentials out of the result.

For a new user the playground checks this hook before history, messages, events and person-specific actions. While signed out, the visitor can chat and see only their own anonymous conversation; requesting a protected tool produces the normal login message. Signing in gives access to the verified account conversation. It calls `agent.simulateVisitor` with the server-verified identity, so the account's existing conversation is shared with other interfaces and replies stay in the simulator. A new user needs no declared phone or preassigned account. Each interface needs its own proof; signing in on web does not silently authorize another CLI session.

After login return to the mounted playground with `person=visitor`; its message draft stays available. **Clear history** resets the selected visitor or authenticated account's conversation and agent memory across channels, after confirmation, while keeping its sign-in connection. **New signed-out user** replaces the browser's connection identity without clearing account history or revoking other clients. An existing authorization-server session may still allow login without re-entering a password. The operator token remains required on a deployed playground, and declared people still use the developer identity shortcut. This is a developer simulator, not a customer-facing chat endpoint.
