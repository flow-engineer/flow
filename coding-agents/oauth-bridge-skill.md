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

For Cognito with a custom page, the page stores the Cognito `sub` with the code and tokens are the
brand's own (a signed JWT is enough); Cognito's tokens are never handed to MCP hosts. For Firebase,
the page's server verifies the Firebase ID token before creating the code, and the Admin SDK stays
in the brand's backend.

Make the signing key with `crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" })`,
add `kid`, `use: "sig"` and `alg: "RS256"`, and keep it, the encryption key and the cookie key as
secrets.

## Test it on the laptop

Everything runs on localhost. Claude and ChatGPT cannot reach localhost; the agent's CLI runs the
same OAuth they do (discovery, registration, PKCE, refresh), so it stands in for them. Run each step
and compare; stop at the first that differs and fix it before going on.

1. **Run the brand's app and the agent locally**, the bridge with `issuer: "http://127.0.0.1:<port>"`,
   `development: true` and `databaseStorage(sqlite(), issuer)` (in memory is fine). The bridge
   answers only on its issuer's own host: use that exact host everywhere (`127.0.0.1` and `localhost`
   are different hosts), and allow that origin for `return_to`. A sign-in left more than 10 minutes
   expires at the bridge; start it again. `curl
   http://127.0.0.1:<port>/.well-known/oauth-protected-resource/mcp` lists the issuer under
   `authorization_servers`, and `curl http://127.0.0.1:<port>/.well-known/oauth-authorization-server`
   answers with `registration_endpoint`.
2. **Signed out.** Call a `signIn: "required"` tool through the CLI. Expected: exit 3, "Sign in
   first".
3. **Sign in once, end to end.** `<cli> auth login --server http://127.0.0.1:<port>/mcp` opens the
   browser on the brand's own login page, then shows "Signed in. You can close this tab". Expected:
   exit 0, and `<cli> auth status --json` says `"signedIn": true, "source": "login"`.
4. **The right person.** Call a required tool that returns `context.key` (add a `whoami` tool while
   testing). Expected: the brand's user id for the account just used.
5. **Refresh.** Expire the access token at the brand (or issue a short `expires_in`) and call the
   tool again. Expected: the same user id, one `refresh` call at the brand, no new sign-in.
6. **Sign-out.** `<cli> auth logout`, then the tool. Expected: exit 3. `active` false, or a revoked
   token, gives the same.
7. **Every way a person arrives**, each from a fresh `<cli> auth logout` then `auth login`:
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

Then tell the user, in one short message: which account they signed in as (the user id), that the
CLI and MCP saw that id, and anything that failed with the step's output.

## Deploy

On Flow's hosting, `src/mcp.ts` exports a factory and the runtime passes the bridge's storage
(Flow's store, behind the agent's own token; the agent never gets a database login):

```ts
export async function mcp(agent, host) {
  const bridge = await oauthBridge({ ...options, storage: host.oauthStorage });
  return mcpServer({ name, version, tools, auth: bridge.auth });   // its paths include the bridge's routes
}
```

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
