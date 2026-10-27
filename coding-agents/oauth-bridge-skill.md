---
name: flow-framework-oauth-bridge
description: Connect a brand's existing login (no OAuth server of its own) to the OAuth bridge in @flow-engineer/flow/oauth, so its users sign in from Claude, ChatGPT and the agent's CLI on the brand's own login page; then test it end to end on the laptop. Load when the brand has an ordinary login (Cognito or Firebase with a custom page, its own sessions) and the agent serves MCP or a CLI.
---

# Connecting a brand's existing login to the OAuth bridge

Read `flow-framework-auth` (`auth-skill.md`) first; it decides whether this skill applies. Use it
when the brand has an ordinary login and no OAuth authorization server MCP hosts can use. A brand
with a usable OAuth server (Auth0, Okta, Cognito's own OAuth with registered clients) passes that
server as `mcpServer({ auth: { issuer, verify } })` and does not need the bridge.

## What the bridge is

MCP hosts (Claude, ChatGPT, Cursor) and the agent's CLI need an OAuth authorization server:
discovery, dynamic client registration, PKCE, codes, refresh, revocation. `oauthBridge` from
`@flow-engineer/flow/oauth` is that server, served by the agent itself beside `/mcp`, on the same
origin. It has no login page: it sends the person to the brand's own login and back. The brand keeps
its accounts, its login and every token.

```
Claude / ChatGPT / <cli> auth login
        │ discovery, registration, PKCE         (the agent's origin: /.well-known/..., /reg, /auth, /token)
        ▼
oauthBridge ── 303 ─► brand login page ?nonce&return_to&client&resource ─► person signs in as usual
        │      ◄── 303 return_to?code=<one-time>&state=<nonce>
        │ login.exchange(code) → { key, authorization }      the brand's functions, in the agent's code
        │ tokens.issue(...)    → the brand's own access + refresh token, returned to the client
        ▼
/mcp: every request's token → tokens.verify → context.key = the brand's user id
```

**Token custody.** The brand mints, refreshes, verifies and revokes every access and refresh
token. The bridge passes them through. It stores client registrations, grants (user id and client
id) and sign-in state that lives minutes, by issuer, with ids hashed and payloads encrypted; it
stores no token a client holds.

**Leaving.** The agent only sees `issuer` and `verify`. Moving to the brand's own OAuth server is
replacing `bridge.auth` with that server's `{ issuer, verify }`.

## What the brand builds

### 1. The login page hand-off

The bridge opens the brand's login URL with:

| Parameter | Meaning |
| --- | --- |
| `nonce` | Random, single use. Return it unchanged as `state`. |
| `return_to` | The bridge's callback, `<agent origin>/interaction/<id>/callback`. Accept it only when its origin is the agent's own, never any other. |
| `client` | The OAuth client's id (for display or policy only). |
| `resource` | The MCP URL the token is for. |

After the person signs in (or already has a session), the brand's server makes a single-use `code`
(at most 512 characters, expiring within 5 minutes) for the account, `nonce` and `return_to`: either
random (at least 128 bits) and stored with them, or the three signed with a secret only the code's
maker and `exchange` share, with a random id `exchange` remembers so the code works once. Then it
redirects with 303 to `return_to?code=<code>&state=<nonce>`. Never put the account id, an email or a token in the
redirect. A page with its own sign-up keeps it: a new user signs up, then the same redirect happens.

What existing login pages are usually like, and what to do about it:

- **The page sends everyone to one place after sign-in** (`/dashboard`) and reads no return
  address; it may be a prebuilt bundle you cannot change. Do not edit it. Add a small hand-off page
  the bridge opens instead (`login.url`). Signed in: it gets the code and redirects at once.
  Signed out: it saves the bridge's query in the tab's `sessionStorage` with the time, sends the
  same tab to the login page, and the page it always lands on (`/dashboard`) sends the tab back to
  the hand-off page when one is saved and fresh (under 10 minutes; drop a stale one). Never open the
  login page in a new tab and wait for the first tab to notice: browsers and embedded views open
  `target="_blank"` in the same tab, and focus events are unreliable, so the sign-in is lost.
- **Guard the round trip.** Mark the tab when the landing page sends it back; if the hand-off page
  would send it to the login page a second time (the login page treats the person as signed in but
  the identity provider refuses their token), show an error instead of looping.
- **The session may live only in the browser** (localStorage tokens, no cookie), so no server code
  can see who is signed in. The hand-off page then reads the token in the browser and posts it to a
  server route that checks it with the identity provider itself (Cognito's `GetUser` with the
  access token, Firebase's `verifyIdToken`), and only then signs the code. Never trust a user id the
  browser sends. Refresh an expired token first, as the site's own pages do.
- **Bind and check the code.** It carries the user id, `nonce`, `return_to`, an expiry of minutes
  and a random id, signed with a secret only the code route and `exchange` share; `exchange` refuses
  it with any other `nonce` or `redirectUri`, when altered, expired or seen before. The code route
  signs only for a `return_to` on the agent's own origin.
- **Locally, the login must stay on localhost.** A login link to the production domain, or social
  sign-in whose redirect is fixed to production, puts the session on production, where localhost
  cannot read it: test with email and password on the local login page.
- **Test signed out, not only signed in.** Being signed in skips the login page, so a passing
  signed-in test says nothing about a new user. Run every case in Test it on the laptop below.

### 2. Six functions

They run in the agent's code and reach the brand's backend however it already allows.

```ts
import { databaseStorage, oauthBridge } from "@flow-engineer/flow/oauth";
import { mcpServer } from "@flow-engineer/flow/mcp";

const bridge = await oauthBridge({
  issuer: "https://agent.example.com",            // the agent's public origin
  resources: ["https://agent.example.com/mcp"],   // add /mcp/plugin when it is served
  storage: await databaseStorage(db, issuer),     // self-hosted: postgres(pool) or sqlite(file); Flow's hosting passes its store
  encryptionKey,                                  // 32 bytes, from a secret
  cookieKeys: [process.env.OAUTH_COOKIE_KEY!],    // 32+ characters
  jwks,                                           // the bridge's private signing keys
  login: {
    url: "https://example.com/login",
    // Redeem the page's code once, only with its own nonce and return_to.
    async exchange({ code, nonce, redirectUri, clientId, resource }) {
      const row = await brand.codes.take(code);                       // deletes it
      if (!row || row.nonce !== nonce || row.returnTo !== redirectUri) throw new Error("invalid");
      return { key: row.accountId, authorization: await brand.grants.create(row, clientId, resource) };
    },
    active: (key) => brand.accounts.isActive(key),                   // disabled or deleted → false
    pendingTtlSeconds: 3600,  // optional: as long as the login page keeps a sign-in (sign-up, email check); 600 by default
  },
  tokens: {
    async issue({ key, clientId, resource, connection, authorization }) {
      await brand.grants.consume(authorization, { key, clientId, resource });   // single use
      return brand.tokens.mint({ key, clientId, resource, connection });
    },
    refresh: ({ clientId, resource, refreshToken }) => brand.tokens.rotate(refreshToken, { clientId, resource }),
    verify: ({ token, resource }) => brand.tokens.check(token, resource),      // { key } | null
    revoke: ({ clientId, token }) => brand.tokens.revoke(token, clientId),
  },
});
const mcp = mcpServer({ name, version, tools, auth: bridge.auth });
// mcp.node / mcp.fetch serve /mcp and the bridge's routes; mcp.paths lists them for Flow's hosting.
```

The rules each function keeps:

- `exchange` accepts a code once. `key` is the brand's stable user id: the same id `resolve`
  returns on chat and every tool sees as `context.key`.
- `authorization` is a single-use proof `issue` requires; `issue` never mints from a user id alone.
- `issue` and `refresh` return `{ access_token, refresh_token?, expires_in, token_type: "Bearer",
  scope? }`. Access tokens are short-lived (an hour or less) and for that `resource` only; refresh
  rotates the refresh token.
- `verify` checks signature (or lookup), expiry, `resource` and revocation and returns `{ key,
  scopes? }` or null. It runs on every MCP request; keep it fast.
- `revoke` ends that token. `active` false makes every later `verify` and refresh fail.
- `verify` may also return `credentials` (`McpIdentity`'s): that request's backend access for the
  tools, so they call the brand's API as the person without decrypting the token a second time.
- The agent's own CLI signs in as one fixed public client, `<agent origin>/.well-known/oauth-client/cli`
  (its Client ID Metadata Document, served and advertised by the bridge); hosts register their own.
  `clientId` in `issue`, `refresh`, `revoke` and the login page's `client` is that URL for the CLI.
  The bridge notes which client each access token went to (hashed and sealed, never the token) and
  adds `client: { id, kind? }` to what `verify` returns, so tools kept to the CLI
  (`mcp: { clients: ["cli"] }`) reach only it. A `client` `verify` returns itself is kept as is.

**What the brand's backend must offer.** Check this before writing the functions, and tell the
owner on day one what is missing: each gap is a change to the brand's backend (the
`flow-framework-context` skill says how to propose and make it), not a placeholder in the agent.

| Function | The backend needs |
| --- | --- |
| code route, `exchange` | a server-side check of the site's session, and somewhere to keep a code's id until it is used |
| `active` | the account's status (disabled, deleted) by user id |
| `issue`, `refresh` | a way to mint the credential its API trusts for this user, or a signing secret for the brand's own tokens |
| `verify` | that credential checked on every request, fast |
| `revoke` | that credential ended (a key deleted, a token listed as revoked until it expires) |

Used code ids, single-use proofs and revoked token ids are the brand's: keep them in its database.
In memory is for the laptop only; a restart forgets them.

**A brand whose API takes per-user API keys.** The key is the credential its API trusts, so it is
minted per connection and ends with it. When a server can mint it for a user id, `issue` mints it
and returns a token that carries it (sealed with the brand's secret) or a reference to it;
`verify` returns `{ key, credentials }` with the API key, and `revoke` deletes it. When only the
person's browser session can mint it, the code route mints it and keeps it with the code in the
brand's store; with no store it may seal it into the code itself (AES-GCM under the code's secret,
with the code's expiry and id), the one case where the redirect carries a credential, encrypted.
`exchange` then passes it to `issue` as `authorization`.

For Cognito with a custom page, the page stores the Cognito `sub` with the code and tokens are the
brand's own (a signed JWT is enough); Cognito's tokens are never handed to MCP hosts. For Firebase,
the page's server verifies the Firebase ID token before creating the code, and the Admin SDK stays
in the brand's backend.

Make the signing key with `crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" })`,
add `kid`, `use: "sig"` and `alg: "RS256"`, and keep it, the encryption key and the cookie key as
secrets.

## Test it on the laptop

Everything runs on localhost. Claude and ChatGPT cannot reach localhost; `flow inspect` runs the
same OAuth they do (discovery, registration, PKCE, refresh), so it stands in for them. Below,
`inspect` is `npx -y -p @flow-engineer/flow -p @modelcontextprotocol/client@2.3.1 flow inspect
http://127.0.0.1:<port>/mcp` (the `flow-framework` skill says more). Run each step
and compare; stop at the first that differs and fix it before going on.

1. **Run the brand's app and the agent locally**, the bridge with `issuer: "http://127.0.0.1:<port>"`,
   `development: true` and `databaseStorage(sqlite(), issuer)` (in memory is fine). The bridge
   answers only on its issuer's own host: use that exact host everywhere (`127.0.0.1` and `localhost`
   are different hosts), and allow that origin for `return_to`. Pin the port (`MCP_PORT`): the issuer
   and the brand's allowed `return_to` follow it, so a moved port breaks sign-in. A sign-in left longer than
   `login.pendingTtlSeconds` (10 minutes by default) expires at the bridge; start it again. `curl
   http://127.0.0.1:<port>/.well-known/oauth-protected-resource/mcp` lists the issuer under
   `authorization_servers`, and `curl http://127.0.0.1:<port>/.well-known/oauth-authorization-server`
   answers with `registration_endpoint`.
2. **Signed out.** `inspect call <tool>` on a `signIn: "required"` tool. Expected: exit 3, "Sign in
   first".
3. **Sign in once, end to end.** `inspect auth` (in the background) prints the link; it opens the
   brand's own login page, then shows "You're all set" once the code is exchanged. Expected: exit 0, and the
   token's scope printed.
4. **The right person.** Call a required tool that returns `context.key` (add a `whoami` tool while
   testing). Expected: the brand's user id for the account just used.
5. **Refresh.** Expire the access token at the brand (or issue a short `expires_in`) and call the
   tool again. Expected: the same user id, one `refresh` call at the brand, no new sign-in.
6. **Sign-out.** `inspect auth logout`, then the tool. Expected: exit 3. `active` false, or a revoked
   token, gives the same.
7. **Every way a person arrives**, each from a fresh `inspect auth`:
   signed out on the site (the same tab goes to the login page, then back on its own after sign-in);
   already signed in (no page shown, straight to "Signed in"); signed in with an expired site token
   (refreshed, then through); a hand-off link with no parameters ("Invalid link"); a pending
   sign-in older than 10 minutes (the landing page ignores it). Expected: the tool's `context.key` is
   the same user id each time.
8. **The code's rules.** With one real code: refused with another `redirectUri`, another `nonce`,
   altered, or a second time; `issue` refuses the same `authorization` twice; the code route refuses
   a `return_to` on another origin.

`test/oauth.test.ts` in the framework runs steps 2 to 6 against a made-up brand and a simulated
browser; copy its `brand()` and `browse()` helpers to make the same check a test in the agent's
repository. Steps 7 and 8 need the brand's real login page in a browser.

Codex and Claude Code run the same OAuth as the CLI. `codex mcp add <name> --url
http://127.0.0.1:<port>/mcp` starts sign-in at once and waits for the browser: run it in the
background and give the owner the link. `codex mcp list` then shows the server with OAuth.

Then tell the user, in one short message: which account they signed in as (the user id), that the
CLI and MCP saw that id, and anything that failed with the step's output.

## Deploy

On Flow's hosting, `src/mcp.ts` exports a factory and the runtime passes the bridge's storage
(Flow's store, behind the agent's own token; the agent never gets a database login):

```ts
export async function mcp(agent, host) {
  const bridge = await oauthBridge({ ...options, storage: host.oauthStorage });
  return mcpServer({ name, version, tools, auth: bridge.auth, agent });   // its paths: the bridge's routes and /agent/terminal
}
```

Passing `agent` serves `<cli> chat` at `/agent/terminal` with the same sign-in as `/mcp`
(`mcp-skill.md`, "Terminal conversations"); leave it out for MCP and CLI commands only.

The signing key, encryption key and cookie key go in as secrets (`npx @flow-engineer/flow deploy
secrets`). Self-hosted, deploy with durable storage (`databaseStorage(postgres(pool), issuer)`).
Either way, `issuer` is the agent's public https origin and `resources` its MCP URLs, and the
brand's code route allows that origin for `return_to`. Repeat steps 2 to 6 against the deployed URL, then add the agent's MCP URL as a
connector in Claude (Settings → Connectors) and sign in once: Claude registers itself and comes back
through the brand's login page.

## Not in this version

- Chat sign-in links through the bridge (chat uses `createAgent({ auth })` and
  `signInCompleted`, as `auth-skill.md` describes).
- One shared bridge for many agents, and Cloudflare Workers.
- Poppy (Personal Agent Protocol) sign-in: client ID metadata documents, `private_key_jwt`, the
  JWT bearer grant with `session_id`, DPoP-bound tokens, `poppy_domains`, a consent page with
  scopes, device sign-in. The bridge grants the account's normal access with no consent screen.
- Scopes beyond being signed in.
