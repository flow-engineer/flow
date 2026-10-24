// covers: oauth/src/bridge.ts oauth/src/store.ts cli/src/auth.ts mcp/src/server.ts
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
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

/** A brand with its own login page and its own tokens, as the skill asks it to build them. */
function brand(user: string) {
  const codes = new Map<string, { nonce: string; returnTo: string }>();
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
    codes.set(code, { nonce: url.searchParams.get("nonce")!, returnTo: url.searchParams.get("return_to")! });
    const back = new URL(url.searchParams.get("return_to")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("nonce")!);
    res.writeHead(303, { location: back.href }).end();
  };
  return {
    page, calls, access,
    login: {
      async exchange({ code, nonce, redirectUri }: { code: string; nonce: string; redirectUri: string }) {
        calls.exchange++;
        const saved = codes.get(code);
        codes.delete(code);
        if (!saved || saved.nonce !== nonce || saved.returnTo !== redirectUri) throw new Error("invalid code");
        const authorization = randomBytes(16).toString("hex");
        proofs.add(authorization);
        return { key: user, authorization };
      },
      active: async (key: string) => key === user,
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
}

/** A browser: follows redirects and keeps each origin's cookies, as a person's browser would. */
async function browse(start: string): Promise<void> {
  const jar = new Map<string, string[]>();
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
// refresh through the brand, and no client token kept by the bridge.
test("the CLI signs in through the bridge on the brand's own login, and the tool sees the brand's user id", async () => {
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
  const login = io();
  assert.equal(await runCli(cli, ["auth", "login"], login), 0, login.err);
  const signedIn = io();
  assert.equal(await runCli(cli, ["whoami", "--json"], signedIn), 0, signedIn.err);
  assert.deepEqual(JSON.parse(signedIn.out), { key: "customer-7" });
  assert.deepEqual(acme.calls, { exchange: 1, issue: 1, refresh: 0 });

  for (const saved of acme.access.values()) saved.live = false; // the brand's access token expires
  const refreshed = io();
  assert.equal(await runCli(cli, ["whoami", "--json"], refreshed), 0, refreshed.err);
  assert.deepEqual(JSON.parse(refreshed.out), { key: "customer-7" });
  assert.equal(acme.calls.refresh, 1);

  const stored = JSON.stringify(await database.query("SELECT * FROM flow_oauth_artifacts"));
  assert.doesNotMatch(stored, /brand-(at|rt)-/, "the bridge keeps none of the brand's tokens");

  assert.equal(await runCli(cli, ["auth", "logout"], io()), 0);
  assert.equal(await runCli(cli, ["whoami"], io()), 3);
});
