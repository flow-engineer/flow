// An OAuth authorization server in front of a brand's existing login, so MCP hosts (Claude,
// ChatGPT) and the agent's CLI can sign people in where the brand has no OAuth server of its own.
// oidc-provider runs the protocol (discovery, dynamic registration, PKCE, codes); the brand keeps
// the rest: the bridge sends the person to the brand's own login page, redeems the one-time code
// that page returns with `login.exchange`, and every access and refresh token is minted, refreshed,
// verified and revoked by the brand's `tokens` functions. The bridge stores no token a client uses.
//
// Its routes are served by the agent's MCP server, on the same origin: mcpServer({ auth: bridge.auth }).

import { randomBytes } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import Provider, { errors, interactionPolicy, type ClientMetadata, type Configuration, type JWKS } from "oidc-provider";
import type { McpAuth, McpIdentity } from "../../mcp/src/server.ts";
import { oauthStore, type OAuthStorage } from "./store.ts";

export interface OAuthBridgeOptions {
  /** This server's public origin, the issuer clients see (https; http on loopback in development). */
  issuer: string;
  /** The exact MCP URLs tokens are for: the agent's /mcp, and /mcp/plugin when it serves one. */
  resources: string[];
  /** Where clients, grants and sign-ins in progress are kept, hashed and sealed: databaseStorage(db, issuer) when self-hosted, Flow's store when hosted. Durable outside development. */
  storage: OAuthStorage;
  /** 32 bytes that seal what the bridge stores. */
  encryptionKey: Uint8Array;
  /** Keys that sign the bridge's cookies, at least 32 characters each; the first signs. */
  cookieKeys: string[];
  /** The private keys the bridge signs with (a JWKS with private parts). */
  jwks: JWKS;
  login: {
    /** The brand's login page. It gets `nonce`, `return_to`, `client` and `resource`, and redirects to `return_to?code=<one-time code>&state=<nonce>`. */
    url: string;
    /** Redeem the login page's code once, bound to nonce and redirectUri. `key` is the brand's user id; `authorization` is a single-use proof `tokens.issue` requires. */
    exchange(input: { code: string; nonce: string; redirectUri: string; clientId: string; resource: string }): Promise<{ key: string; authorization: string }>;
    /** Whether the account may still sign in and use tokens. */
    active(key: string): Promise<boolean>;
  };
  /** The brand mints and owns every token clients hold. */
  tokens: {
    issue(input: { key: string; clientId: string; resource: string; connection: string; authorization: string }): Promise<BrandTokens>;
    refresh(input: { clientId: string; resource: string; refreshToken: string }): Promise<BrandTokens>;
    revoke(input: { clientId: string; token: string }): Promise<void>;
    /** `credentials`, when given, is this request's backend access for tools (the token's own API key, say), as McpIdentity's. */
    verify(input: { token: string; resource: string }): Promise<McpIdentity | null>;
  };
  /** Clients registered ahead (an MCP host that cannot register itself). Others register dynamically. */
  clients?: ClientMetadata[];
  /** Local development: http on loopback and a database that does not survive a restart are allowed. */
  development?: boolean;
}

export interface BrandTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: "Bearer";
  scope?: string;
}

export interface OAuthBridge {
  /** For mcpServer({ auth }): this issuer, each request's token checked by the brand, and the bridge's routes. */
  auth: McpAuth;
}

const ROUTES = { authorization: "/auth", token: "/token", registration: "/reg", revocation: "/token/revocation", jwks: "/jwks" };
const PATHS = ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/auth", "/reg", "/token", "/jwks", "/interaction"];
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

function secureURL(value: string, development: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(development && url.protocol === "http:" && LOOPBACK.includes(url.hostname)))) {
    throw new Error("@flow-engineer/flow/oauth: URLs must be https (http only on loopback in development)");
  }
  return url;
}

export async function oauthBridge(options: OAuthBridgeOptions): Promise<OAuthBridge> {
  const development = !!options.development;
  const issuerURL = secureURL(options.issuer, development);
  if (issuerURL.pathname !== "/" || issuerURL.search) throw new Error("@flow-engineer/flow/oauth: the issuer is an origin, with no path");
  const issuer = issuerURL.origin;
  const resources = new Set(options.resources.map((value) => secureURL(value, development).href));
  if (!resources.size) throw new Error("@flow-engineer/flow/oauth: give the MCP URLs as resources");
  if (!options.cookieKeys.length || options.cookieKeys.some((key) => key.length < 32)) throw new Error("@flow-engineer/flow/oauth: cookie keys must be at least 32 characters");
  if (!development && !options.storage.durable) throw new Error("@flow-engineer/flow/oauth: outside development the storage must be durable");
  secureURL(options.login.url, development);
  const store = oauthStore(options.storage, issuer, options.encryptionKey);
  const pending = store.adapter("BrandLogin");
  const authorizations = store.adapter("BrandAuthorization");
  const policy = interactionPolicy.base();
  // A provider session says who the person is; only a fresh brand decision lets a token be issued.
  policy.get("login")!.checks.add(new interactionPolicy.Check("brand_authorization", "Brand authorization is required", (ctx) => !ctx.oidc.result?.login));
  let provider: Provider;
  const configuration: Configuration = {
    adapter: (name) => store.adapter(name),
    jwks: options.jwks,
    clients: options.clients ?? [],
    clientDefaults: { grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    cookies: { keys: options.cookieKeys, long: { sameSite: "lax" }, short: { sameSite: "lax" } },
    pkce: { required: () => true },
    routes: ROUTES,
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: (_ctx, _client, oneOf) => (oneOf?.length === 1 ? oneOf[0] : [...resources][0]),
        getResourceServerInfo: (_ctx, resource) => {
          if (!resources.has(resource)) throw new errors.InvalidTarget();
          return { scope: "account", audience: resource, accessTokenFormat: "opaque", accessTokenTTL: 900 };
        },
      },
    },
    scopes: ["openid", "account"],
    // Refresh tokens are the brand's to mint and rotate.
    issueRefreshToken: () => false,
    ttl: { AccessToken: 900, AuthorizationCode: 60, Interaction: 600, Grant: 30 * 86400, Session: 86400 },
    interactions: { policy, url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, key) => (await options.login.active(key) ? { accountId: key, claims: async () => ({ sub: key }) } : undefined),
    // The brand's default is the account's normal access, with no separate permissions screen.
    async loadExistingGrant(ctx) {
      const key = ctx.oidc.result?.login?.accountId ?? ctx.oidc.session?.accountId;
      if (!key || !(await options.login.active(key))) return undefined;
      // Each connection gets a grant of its own, even when a browser session skips the login.
      const old = ctx.oidc.result?.consent?.grantId;
      const grant = (old ? await provider.Grant.find(old) : undefined) ?? new provider.Grant({ accountId: key, clientId: ctx.oidc.client!.clientId });
      grant.addOIDCScope("openid account");
      for (const resource of Object.keys(ctx.oidc.resourceServers ?? {})) if (resources.has(resource)) grant.addResourceScope(resource, "account");
      await grant.save();
      return grant;
    },
    renderError: (ctx, out) => { ctx.type = "application/json"; ctx.body = { error: out.error }; },
  };
  provider = new Provider(issuer, configuration);
  provider.proxy = !development;
  const checked = (value: BrandTokens) => {
    if (!value || typeof value.access_token !== "string" || !value.access_token || value.token_type !== "Bearer" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || (value.refresh_token !== undefined && typeof value.refresh_token !== "string")) {
      throw new errors.InvalidGrant("Brand credential exchange failed");
    }
    return { access_token: value.access_token, ...(value.refresh_token ? { refresh_token: value.refresh_token } : {}), token_type: "Bearer", expires_in: value.expires_in, scope: value.scope ?? "account" };
  };
  // oidc-provider still authenticates the client and checks parameters and resource first.
  provider.registerGrantType("refresh_token", async (ctx) => {
    const resource = ctx.oidc.params!.resource, refreshToken = ctx.oidc.params!.refresh_token;
    if (typeof resource !== "string" || !resources.has(resource) || typeof refreshToken !== "string") throw new errors.InvalidGrant();
    try { ctx.body = checked(await options.tokens.refresh({ clientId: ctx.oidc.client!.clientId, resource, refreshToken })); }
    catch { throw new errors.InvalidGrant(); }
  }, ["refresh_token", "resource", "scope"]);
  // The code exchange makes a short-lived internal token; the client gets the brand's token instead.
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.status !== 200) return;
    if (ctx.path === ROUTES.token && ctx.oidc.params?.grant_type === "authorization_code") {
      const response = ctx.body as { access_token?: string };
      const temporary = response.access_token ? await provider.AccessToken.find(response.access_token) : undefined;
      if (!temporary?.accountId || typeof temporary.aud !== "string" || !resources.has(temporary.aud)) throw new errors.InvalidGrant();
      try {
        const proof = await store.take("BrandAuthorization", temporary.grantId!);
        if (typeof proof?.authorization !== "string") throw new errors.InvalidGrant();
        ctx.body = checked(await options.tokens.issue({ key: temporary.accountId, clientId: temporary.clientId!, resource: temporary.aud, connection: temporary.grantId!, authorization: proof.authorization }));
      } finally { await temporary.destroy(); }
    }
    if (ctx.path === ROUTES.revocation && typeof ctx.oidc.params?.token === "string") {
      await options.tokens.revoke({ clientId: ctx.oidc.client!.clientId, token: ctx.oidc.params.token });
    }
  });
  const callback = provider.callback();

  async function verify(token: string, resource: string) {
    if (!resources.has(resource)) return null;
    const identity = await options.tokens.verify({ token, resource });
    return identity && (await options.login.active(identity.key)) ? identity : null;
  }

  function resourceOf(request: Request): string {
    const url = new URL(request.url);
    const exact = `${url.origin}${url.pathname}`;
    return resources.has(exact) ? exact : [...resources][0]!;
  }

  function requestedResource(params: Record<string, unknown>): string {
    const resource = params.resource ?? [...resources][0];
    if (typeof resource !== "string" || !resources.has(resource)) throw new errors.InvalidTarget();
    return resource;
  }

  async function fullAccountGrant(key: string, params: Record<string, unknown>) {
    const grant = new provider.Grant({ accountId: key, clientId: String(params.client_id) });
    grant.addOIDCScope("openid account");
    for (const resource of [params.resource ?? [...resources][0]].flat()) if (typeof resource === "string" && resources.has(resource)) grant.addResourceScope(resource, "account");
    return grant.save();
  }

  async function node(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", issuer);
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    if (req.headers.host !== issuerURL.host) return json(res, 400, { error: "invalid_host" });
    try {
      // MCP clients look for RFC 8414 metadata first; it is the same document.
      if (url.pathname === "/.well-known/oauth-authorization-server") req.url = `/.well-known/openid-configuration${url.search}`;
      // MCP clients often ask for no scope; that asks for the account's normal access.
      if (url.pathname === ROUTES.authorization && !url.searchParams.has("scope")) {
        url.searchParams.set("scope", "openid account");
        req.url = `${url.pathname}${url.search}`;
      }
      const interactionPath = /^\/interaction\/([A-Za-z0-9_-]+)(\/callback)?$/.exec(url.pathname);
      if (!interactionPath) return void callback(req, res);
      if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
      const interaction = await provider.interactionDetails(req, res);
      if (interaction.uid !== interactionPath[1]) return json(res, 400, { error: "invalid_interaction" });
      if (!interactionPath[2]) {
        if (interaction.prompt.name === "consent" && interaction.session?.accountId && (await options.login.active(interaction.session.accountId))) {
          const grantId = await fullAccountGrant(interaction.session.accountId, interaction.params);
          return void (await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true }));
        }
        const nonce = randomBytes(32).toString("base64url");
        await pending.upsert(interaction.uid, { nonce }, 600);
        const login = new URL(options.login.url);
        login.searchParams.set("nonce", nonce);
        login.searchParams.set("return_to", `${issuer}/interaction/${interaction.uid}/callback`);
        login.searchParams.set("client", String(interaction.params.client_id ?? ""));
        login.searchParams.set("resource", requestedResource(interaction.params));
        return void res.writeHead(303, { location: login.href }).end();
      }
      const saved = await pending.find(interaction.uid);
      const code = url.searchParams.get("code"), nonce = url.searchParams.get("state");
      if (!saved?.nonce || !code || code.length > 512 || nonce !== saved.nonce) return json(res, 400, { error: "invalid_login_response" });
      const redirectUri = `${issuer}/interaction/${interaction.uid}/callback`;
      const result = await options.login.exchange({ code, nonce, redirectUri, clientId: String(interaction.params.client_id), resource: requestedResource(interaction.params) });
      if (!result.key || !result.authorization || !(await options.login.active(result.key))) return json(res, 401, { error: "account_unavailable" });
      await pending.destroy(interaction.uid);
      const grantId = await fullAccountGrant(result.key, interaction.params);
      await authorizations.upsert(grantId, { authorization: result.authorization }, 600);
      await provider.interactionFinished(req, res, { login: { accountId: result.key, amr: ["brand-login"], remember: true }, consent: { grantId } }, { mergeWithLastSubmission: false });
    } catch {
      // Errors from the brand's functions may carry tokens or personal data: keep them out of answers.
      if (!res.headersSent) json(res, 400, { error: "authorization_failed" });
      else res.end();
    }
  }

  return {
    auth: {
      issuer,
      resource: [...resources][0]!,
      verify: (token, request) => verify(token, resourceOf(request)),
      routes: { paths: PATHS, fetch: (request) => served(node, request) },
    },
  };
}

/** A web-standard request through a node:http handler (oidc-provider is one), answered as a Response. */
async function served(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const req = new IncomingMessage(new Socket());
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  req.headers = Object.fromEntries(request.headers);
  req.headers.host ??= url.host;
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.from(await request.arrayBuffer());
  if (body) req.headers["content-length"] = String(body.length);
  if (body?.length) req.push(body);
  req.push(null);
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    res.writeHead = ((status: number, headers?: Record<string, string | string[]>) => {
      res.statusCode = status;
      for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
      return res;
    }) as typeof res.writeHead;
    res.write = ((chunk: string | Buffer) => { chunks.push(Buffer.from(chunk)); return true; }) as typeof res.write;
    res.end = ((chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve();
      return res;
    }) as typeof res.end;
  });
  await Promise.all([handler(req, res), done]);
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.getHeaders())) for (const one of [value].flat()) if (one !== undefined) headers.append(name, String(one));
  return new Response(chunks.length && res.statusCode !== 204 && res.statusCode !== 304 ? Buffer.concat(chunks) : null, { status: res.statusCode, headers });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
