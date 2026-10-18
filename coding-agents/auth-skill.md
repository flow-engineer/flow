---
name: chinwag-auth
description: Set up verified-phone sign-in, a brand’s OAuth server or its existing login, with one account across chat, MCP and the CLI and backend credentials kept in tool code.
---

# Sign-in for a Chinwag agent’s tools

Read `chinwag-context` first: `context/access.yaml` describes the brand’s accounts and how its users sign in. Keep that account system. Every interface resolves to the same stable brand user id; a phone number, provider login and CLI connection are ways to reach it, not separate accounts.

## Choose the entry point

1. **Phone is the brand’s primary identity.** A sender on a provider-verified phone channel (WhatsApp, phone-based iMessage, SMS) is signed in. Resolve that phone to the brand’s account, creating it only when the brand supports that. Give their normal full account access. Do not add an OTP, browser login, consent screen or permission picker on top of the verified channel.
2. **The brand already exposes an OAuth authorization server.** Use it for MCP and CLI connections. On chat channels that need account sign-in, send a connection link to its existing login. A Google sign-in button in an app is not by itself an OAuth authorization server for MCP clients.
3. **The brand has an ordinary login.** Use that login as the authentication step behind Flow’s OAuth layer (or a self-hosted OAuth server). Phone OTP, email, social login, company SSO and custom login can all finish the same connection. The brand confirms the signed-in account server-side; the OAuth layer handles client registration, one-time codes, PKCE and refresh. Do not add a Flow grant-selection screen by default. An existing provider can have its own required screens.

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

The default is full normal user access, not global administrator access. Existing business ownership checks still apply. Optional scoped connections remain available for brands that require them; do not invent a permissions UI or restrict the brand’s normal experience by default.

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

## Connecting an ordinary brand login

Keep the OAuth protocol layer reusable and the account authority in the brand. The brand integration must:

1. **Finish its existing login.** A small server-side function verifies its normal session and returns a signed, short-lived assertion identifying the account and the pending Flow connection. Bind it to that connection and make it single-use; never accept a user id merely posted by the browser.
2. **Provide account access.** Its backend validates a credential issued for that API, or supplies an authenticated execution path. Use separate resource credentials for MCP and downstream APIs; a UID alone never authorizes an API call.
3. **End access.** Account disable/deletion and connection revocation stop new requests and refresh. Signing out of one client need not disconnect the others.

For Firebase the app’s function can validate the signed-in user’s Firebase session, or the authenticated provider’s phone proof, and resolve its Firebase UID. A Firebase custom token and any long-lived backend refresh credential stay behind this brand-owned boundary; never give a general Admin SDK service-account key to an agent. The old local test-account bootstrap is test setup, not a production sign-in flow.

A custom login implements the same boundary. Do not make every brand adopt one identity provider or copy an OAuth server into its agent repository.
