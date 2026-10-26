// covers: oauth/src/bridge.ts oauth/src/store.ts cli/src/auth.ts cli/src/run.ts mcp/src/server.ts
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { auth, Client, StreamableHTTPClientTransport, type OAuthClientInformationMixed, type OAuthClientProvider, type OAuthTokens } from "@modelcontextprotocol/client";
import { z } from "zod";
import { runCli, type CliConfig, type CliIO } from "../cli/src/index.ts";
import { mcpServer } from "../mcp/src/index.ts";
import { databaseStorage, oauthBridge } from "../oauth/src/index.ts";
import { sqlite, tool } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function listen(handler: RequestListener): Promise<string> {
  const http = createServer((req, res) => handler(req, res));
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

function io(): CliIO & { out: string; err: string } {
  const channel: CliIO & { out: string; err: string } = {
    out: "", err: "", interactive: false, confirm: async () => false,
    write: (t) => void (channel.out += t),
    writeError: (t) => void (channel.err += t),
  };
  return channel;
}

/** A brand with its own login page and its own tokens, as the skill asks it to build them. `who` is the account its page signs in. */
function brand(...users: string[]) {
  const codes = new Map<string, { nonce: string; returnTo: string; key: string }>();
  const proofs = new Set<string>();
  const access = new Map<string, { key: string; resource: string; live: boolean }>();
  const refresh = new Map<string, { key: string; resource: string }>();
  const calls = { exchange: 0, issue: 0, refresh: 0 };
  const mint = (key: string, resource: string) => {
    const token = `brand-at-${randomBytes(16).toString("hex")}`, renew = `brand-rt-${randomBytes(16).toString("hex")}`;
    access.set(token, { key, resource, live: true });
    refresh.set(renew, { key, resource });
    return { access_token: token, refresh_token: renew, expires_in: 3600, token_type: "Bearer" as const };
  };
  // The person is already signed in to the brand's site: its login page hands a one-time code back.
  const page: RequestListener = (req, res) => {
    const url = new URL(req.url!, "http://brand");
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { nonce: url.searchParams.get("nonce")!, returnTo: url.searchParams.get("return_to")!, key: brand.who });
    brand.signingIn();
    const back = new URL(url.searchParams.get("return_to")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("nonce")!);
    res.writeHead(303, { location: back.href }).end();
  };
  const brand = {
    who: users[0]!,
    /** Called while the person is on the login page, before the code goes back. */
    signingIn: () => {},
    page, calls, access,
    login: {
      async exchange({ code, nonce, redirectUri }: { code: string; nonce: string; redirectUri: string }) {
        calls.exchange++;
        const saved = codes.get(code);
        codes.delete(code);
        if (!saved || saved.nonce !== nonce || saved.returnTo !== redirectUri) throw new Error("invalid code");
        const authorization = randomBytes(16).toString("hex");
        proofs.add(authorization);
        return { key: saved.key, authorization };
      },
      active: async (key: string) => users.includes(key),
    },
    tokens: {
      async issue({ key, resource, authorization }: { key: string; resource: string; authorization: string }) {
        calls.issue++;
        if (!proofs.delete(authorization)) throw new Error("no authorization");
        return mint(key, resource);
      },
      async refresh({ resource, refreshToken }: { resource: string; refreshToken: string }) {
        calls.refresh++;
        const saved = refresh.get(refreshToken);
        refresh.delete(refreshToken);
        if (!saved || saved.resource !== resource) throw new Error("invalid refresh token");
        return mint(saved.key, resource);
      },
      async revoke({ token }: { token: string }) { access.delete(token); refresh.delete(token); },
      async verify({ token, resource }: { token: string; resource: string }) {
        const saved = access.get(token);
        return saved?.live && saved.resource === resource ? { key: saved.key } : null;
      },
    },
  };
  return brand;
}

/** A browser: follows redirects and keeps each origin's cookies, as a person's browser would. */
async function browse(start: string, jar = new Map<string, string[]>()): Promise<void> {
  let url = start;
  for (let hop = 0; hop < 20; hop++) {
    const origin = new URL(url).origin;
    const answer = await fetch(url, { redirect: "manual", headers: { cookie: (jar.get(origin) ?? []).join("; ") } });
    const cookies = answer.headers.getSetCookie().map((c) => c.split(";")[0]!);
    if (cookies.length) jar.set(origin, [...(jar.get(origin) ?? []).filter((c) => !cookies.some((n) => n.split("=")[0] === c.split("=")[0])), ...cookies]);
    const next = answer.headers.get("location");
    if (answer.status < 300 || answer.status >= 400 || !next) return void (await answer.text());
    url = new URL(next, url).href;
  }
  throw new Error("too many redirects");
}

// The whole promise of the bridge, as a host such as Claude runs it: discovery, registration,
// PKCE and the brand's own login, the brand's token reaching the tool as the brand's user id,
// refresh through the brand, and no client token kept by the bridge. The printed sign-in link works
// from any browser, not only the one the CLI opened. The CLI keeps the issuer with its tokens, so the
// SDK never warns that its SEP-2352 check is off, also for tokens saved before it did.
test("the CLI signs in through the bridge on the brand's own login, and the tool sees the brand's user id", async (t) => {
  const warned = t.mock.method(console, "warn");
  const unstamped = () => warned.mock.calls.filter((call) => String(call.arguments[0]).includes("SEP-2352"));
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "flow-oauth-"));
  const acme = brand("customer-7");
  const loginPage = await listen(acme.page);
  let handle: (req: Parameters<RequestListener>[0], res: Parameters<RequestListener>[1]) => void = (_q, s) => void s.writeHead(503).end();
  const origin = await listen((req, res) => handle(req, res));
  const database = sqlite();
  const jwk = { ...generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  const bridge = await oauthBridge({
    issuer: origin,
    resources: [`${origin}/mcp`],
    storage: await databaseStorage(database, origin),
    encryptionKey: randomBytes(32),
    cookieKeys: [randomBytes(32).toString("hex")],
    jwks: { keys: [jwk as never] },
    login: { url: `${loginPage}/login`, ...acme.login },
    tokens: acme.tokens,
    development: true,
  });
  const whoami = tool({ name: "whoami", description: "Who is signed in.", input: z.object({}), hints: { readOnly: true }, run: (_i, ctx) => ({ key: ctx.key }) });
  const mcp = mcpServer({ name: "acme", version: "1", tools: [whoami], auth: bridge.auth });
  handle = (req, res) => void mcp.node(req, res);
  assert.ok(["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/auth", "/reg", "/token", "/interaction"].every((p) => mcp.paths?.includes(p)), "a host that mounts paths gets the bridge's too");
  const cli: CliConfig = { name: "acme", server: `${origin}/mcp`, openUrl: browse };

  const signedOut = io();
  assert.equal(await runCli(cli, ["whoami"], signedOut), 3);
  // The opener lands somewhere the person did not want; they paste the printed link into another browser.
  const login = io();
  login.writeError = (text) => {
    login.err += text;
    const link = /^  (http\S+)$/m.exec(text)?.[1];
    if (link) void browse(link);
  };
  assert.equal(await runCli({ ...cli, openUrl: () => {} }, ["auth", "login"], login), 0, login.err);
  assert.match(login.err, /paste this link into the one you want/);
  const signedIn = io();
  assert.equal(await runCli(cli, ["whoami", "--json"], signedIn), 0, signedIn.err);
  assert.deepEqual(JSON.parse(signedIn.out), { key: "customer-7" });
  assert.deepEqual(acme.calls, { exchange: 1, issue: 1, refresh: 0 });

  const file = join(process.env.XDG_CONFIG_HOME!, "acme", "auth.json");
  const server = `${origin}/mcp`;
  const issuerOf = () => JSON.parse(readFileSync(file, "utf8"))[server].tokens.issuer;
  assert.equal(issuerOf(), origin);
  // Tokens an older CLI saved have no issuer: they take it on their next refresh.
  const before = JSON.parse(readFileSync(file, "utf8"));
  delete before[server].tokens.issuer;
  writeFileSync(file, JSON.stringify(before));

  for (const saved of acme.access.values()) saved.live = false; // the brand's access token expires
  const refreshed = io();
  assert.equal(await runCli(cli, ["whoami", "--json"], refreshed), 0, refreshed.err);
  assert.deepEqual(JSON.parse(refreshed.out), { key: "customer-7" });
  assert.equal(acme.calls.refresh, 1);
  assert.equal(issuerOf(), origin);

  const stored = JSON.stringify(await database.query("SELECT * FROM flow_oauth_artifacts"));
  assert.doesNotMatch(stored, /brand-(at|rt)-/, "the bridge keeps none of the brand's tokens");

  assert.equal(await runCli(cli, ["auth", "logout"], io()), 0);
  assert.equal(await runCli(cli, ["whoami"], io()), 3);
  assert.equal(await runCli(cli, ["auth", "login"], io()), 0);
  assert.equal(await runCli(cli, ["whoami", "--json"], io()), 0);
  assert.deepEqual(unstamped(), []);
});

/** Signs in as a host such as Claude does: it registers itself (DCR), then the brand's login. */
async function hostSignIn(server: string, jar?: Map<string, string[]>): Promise<{ client: OAuthClientInformationMixed; tokens: OAuthTokens }> {
  let answer = new URLSearchParams();
  const redirect = `${await listen((req, res) => { answer = new URL(req.url!, "http://host").searchParams; res.end("ok"); })}/callback`;
  const saved: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string } = {};
  const provider: OAuthClientProvider = {
    redirectUrl: redirect,
    clientMetadata: { client_name: "A host", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    clientInformation: () => saved.client,
    saveClientInformation: (client) => void (saved.client = client),
    tokens: () => saved.tokens,
    saveTokens: (tokens) => void (saved.tokens = tokens),
    redirectToAuthorization: (url) => browse(url.href, jar),
    saveCodeVerifier: (verifier) => void (saved.verifier = verifier),
    codeVerifier: () => saved.verifier!,
  };
  assert.equal(await auth(provider, { serverUrl: server }), "REDIRECT");
  assert.ok(answer.get("code"), `the sign-in came back with a code: ${answer}`);
  assert.equal(await auth(provider, { serverUrl: server, authorizationCode: answer.get("code")!, iss: answer.get("iss") ?? undefined }), "AUTHORIZED");
  return { client: saved.client!, tokens: saved.tokens! };
}

// A tool kept to the CLI (mcp.clients) is told apart by the OAuth client the token went to, never by
// what a client says about itself: the CLI's own sign-in sees it, a host's (or an old CLI sign-in,
// which registered itself like a host) finds no trace of it.
test("a tool kept to the CLI is listed and called only for the CLI's own sign-in", async () => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "flow-oauth-"));
  const acme = brand("customer-7");
  const loginPage = await listen(acme.page);
  let handle: RequestListener = (_q, s) => void s.writeHead(503).end();
  const origin = await listen((req, res) => handle(req, res));
  const bridge = await oauthBridge({
    issuer: origin,
    resources: [`${origin}/mcp`],
    storage: await databaseStorage(sqlite(), origin),
    encryptionKey: randomBytes(32),
    cookieKeys: [randomBytes(32).toString("hex")],
    jwks: { keys: [{ ...generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" } as never] },
    login: { url: `${loginPage}/login`, ...acme.login },
    tokens: acme.tokens,
    development: true,
  });
  const whoami = tool({ name: "whoami", description: "Who is signed in.", input: z.object({}), hints: { readOnly: true }, run: (_i, ctx) => ({ key: ctx.key }) });
  const lookup = tool({ name: "invoice_lookup", description: "Look up an invoice.", input: z.object({ id: z.string() }), mcp: { deferred: true }, hints: { readOnly: true }, run: ({ id }) => ({ id }) });
  const reveal = tool({ name: "api_keys_reveal", description: "Show one API key's value.", input: z.object({ key_id: z.string() }), output: z.object({ key: z.string() }), mcp: { clients: ["cli"], deferred: true }, hints: { readOnly: true }, run: ({ key_id }) => ({ key: `secret-${key_id}` }) });
  const mcp = mcpServer({ name: "acme", version: "1", tools: [whoami, lookup, reveal], auth: bridge.auth });
  handle = (req, res) => void mcp.node(req, res);
  assert.deepEqual(mcp.descriptors.map((d) => d.name), ["whoami", "search_tools", "execute_tool"]);
  assert.throws(() => mcpServer({ name: "acme", version: "1", tools: [reveal] }), /api_keys_reveal is kept to some clients \(mcp.clients\), which needs auth/);
  const server = `${origin}/mcp`;

  const document = await (await fetch(`${origin}/.well-known/oauth-client/cli`)).json();
  assert.equal(document.client_id, `${origin}/.well-known/oauth-client/cli`);
  assert.equal(document.token_endpoint_auth_method, "none");
  assert.equal((await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()).flow_cli_client_id, document.client_id);

  // A host: no trace of the tool, and calling it answers as an unknown tool does.
  const host = await hostSignIn(server);
  const connect = async (token: string) => {
    const client = new Client({ name: "a-host", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server), { authProvider: { token: async () => token } }));
    return client;
  };
  const other = await connect(host.tokens.access_token);
  assert.deepEqual((await other.listTools()).tools.map((t) => t.name), ["whoami", "search_tools", "execute_tool"]);
  assert.deepEqual((await other.listTools({ _meta: { "flow.engineer/full-tool-catalog": true } })).tools.map((t) => t.name), ["whoami", "invoice_lookup"]);
  const found = await other.callTool({ name: "search_tools", arguments: { query: "api keys reveal invoice" } });
  assert.deepEqual((found.structuredContent as { tools: { name: string }[] }).tools.map((t) => t.name), ["invoice_lookup"]);
  const unknown = async (name: string) => (await other.callTool({ name, arguments: { key_id: "k1" } }).catch((error: Error) => error)) as Error;
  assert.equal((await unknown("api_keys_reveal")).message, (await unknown("no_such_tool")).message.replace("no_such_tool", "api_keys_reveal"));
  const executed = await other.callTool({ name: "execute_tool", arguments: { name: "api_keys_reveal", arguments: { key_id: "k1" } } }).catch((error: Error) => error);
  assert.match((executed as Error).message, /No tool named api_keys_reveal\./);
  await other.close();

  // An old CLI sign-in registered itself like the host: the command is not there, and the CLI says why.
  const file = join(process.env.XDG_CONFIG_HOME, "acme", "auth.json");
  const cli: CliConfig = { name: "acme", server, openUrl: browse };
  assert.equal(await runCli(cli, ["whoami"], io()), 3);
  writeFileSync(file, JSON.stringify({ [server]: { client: host.client, tokens: host.tokens, tokensSavedAt: Date.now() } }));
  const old = io();
  assert.equal(await runCli(cli, ["api-keys-reveal", "--key-id", "k1"], old), 2);
  assert.match(old.err, /Some commands need a new sign-in: run `acme auth login` to see them\./);
  const status = io();
  assert.equal(await runCli(cli, ["auth", "status", "--json"], status), 0);
  assert.deepEqual(JSON.parse(status.out), { server, signedIn: true, source: "login", renew: true });

  // A new sign-in is the CLI's own client: the command works, and no cached list from before is reused.
  const login = io();
  assert.equal(await runCli(cli, ["auth", "login"], login), 0, login.err);
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[server].client.client_id, document.client_id);
  const listed = io();
  assert.equal(await runCli(cli, ["tools", "--json"], listed), 0, listed.err);
  assert.ok((JSON.parse(listed.out) as { name: string }[]).some((t) => t.name === "api_keys_reveal"), listed.out);
  const revealed = io();
  assert.equal(await runCli(cli, ["api-keys-reveal", "--key-id", "k1", "--json"], revealed), 0, revealed.err);
  assert.deepEqual(JSON.parse(revealed.out), { key: "secret-k1" });
  const renewed = io();
  assert.equal(await runCli(cli, ["auth", "status", "--json"], renewed), 0);
  assert.equal(JSON.parse(renewed.out).renew, false);
});

/** The bridge and its MCP server for a brand, on a loopback origin of their own. */
async function served(acme: ReturnType<typeof brand>, login: { pendingTtlSeconds?: number } = {}): Promise<string> {
  const loginPage = await listen(acme.page);
  let handle: RequestListener = (_q, s) => void s.writeHead(503).end();
  const origin = await listen((req, res) => handle(req, res));
  const bridge = await oauthBridge({
    issuer: origin,
    resources: [`${origin}/mcp`],
    storage: await databaseStorage(sqlite(), origin),
    encryptionKey: randomBytes(32),
    cookieKeys: [randomBytes(32).toString("hex")],
    jwks: { keys: [{ ...generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" } as never] },
    login: { url: `${loginPage}/login`, ...acme.login, ...login },
    tokens: acme.tokens,
    development: true,
  });
  const mcp = mcpServer({ name: "acme", version: "1", tools: [tool({ name: "whoami", description: "Who is signed in.", input: z.object({}), hints: { readOnly: true }, run: (_i, ctx) => ({ key: ctx.key }) })], auth: bridge.auth });
  handle = (req, res) => void mcp.node(req, res);
  return `${origin}/mcp`;
}

async function keyOf(acme: ReturnType<typeof brand>, server: string, token: string) {
  return (await acme.tokens.verify({ token, resource: server }))?.key;
}

// The browser keeps the bridge's session from the first sign-in; a second one as another account
// replaces it instead of asking to confirm a logout on a page the bridge does not serve.
test("signing in as another account in the same browser replaces the bridge's session", async () => {
  const acme = brand("customer-7", "customer-8");
  const server = await served(acme);
  const jar = new Map<string, string[]>();
  const first = await hostSignIn(server, jar);
  assert.ok(jar.get(new URL(server).origin)?.some((c) => c.startsWith("_session=")), "the first sign-in left a session cookie");
  acme.who = "customer-8";
  const second = await hostSignIn(server, jar);
  assert.notEqual(first.client.client_id, second.client.client_id);
  assert.equal(await keyOf(acme, server, first.tokens.access_token), "customer-7");
  assert.equal(await keyOf(acme, server, second.tokens.access_token), "customer-8");
});

// A first sign-up with email verification can keep the person on the brand's pages longer than ten
// minutes; the bridge waits as long as the brand says its login page does.
test("a sign-in that comes back after ten minutes finishes within login.pendingTtlSeconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const acme = brand("customer-7");
  acme.signingIn = () => t.mock.timers.tick(30 * 60_000);
  const server = await served(acme, { pendingTtlSeconds: 3600 });
  assert.equal(await keyOf(acme, server, (await hostSignIn(server)).tokens.access_token), "customer-7");
  await assert.rejects(hostSignIn(await served(acme)), /came back with a code/);
  await assert.rejects(served(acme, { pendingTtlSeconds: 2 * 86400 }), /pendingTtlSeconds/);
});
