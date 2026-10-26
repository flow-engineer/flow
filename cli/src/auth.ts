// The CLI's sign-in: the same OAuth a host such as Claude runs against the organization's MCP
// server, as a native app with a loopback redirect, so people sign in on the organization's own
// pages. Tokens are kept per server in ~/.config/<name>/auth.json (XDG_CONFIG_HOME), mode 600, and
// refreshed by the SDK. A token in <NAME>_TOKEN (CI, agents) is used as is and never stored.
//
// When the server's authorization server advertises the CLI's own client (the OAuth bridge's
// flow_cli_client_id), the CLI signs in as that client instead of registering itself, so the server
// knows the caller is this CLI and lists the tools kept to it (Tool.mcp.clients).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import type { CliConfig } from "./commands.ts";

interface Saved {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  verifier?: string;
  state?: string;
  discovery?: OAuthDiscoveryState;
  tokensSavedAt?: number;
}

export function configDir(config: CliConfig): string {
  return config.directory ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), config.name);
}

function authFile(config: CliConfig): string {
  return join(configDir(config), "auth.json");
}

function readAll(config: CliConfig): Record<string, Saved> {
  const file = authFile(config);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Saved>) : {};
}

function writeAll(config: CliConfig, all: Record<string, Saved>): void {
  mkdirSync(configDir(config), { recursive: true, mode: 0o700 });
  const file = authFile(config);
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The authorization server a sign-in was made with, as discovery recorded it beside its tokens. */
function issuerOf(saved: Saved): string | undefined {
  return saved.discovery?.authorizationServerMetadata?.issuer ?? saved.discovery?.authorizationServerUrl;
}

/**
 * Tokens and client kept with the issuer they came from (SEP-2352), so the SDK checks it on every
 * read; a value saved before the CLI kept it takes the issuer discovery recorded with it.
 */
function stamped<T extends { issuer?: string }>(value: T | undefined, issuer: string | undefined): T | undefined {
  return value && value.issuer === undefined && issuer ? { ...value, issuer } : value;
}

/** An OAuth client provider whose state lives in the CLI's auth file, for one server. */
export function storedProvider(config: CliConfig, server: string, redirectUrl?: string, signal?: AbortSignal, say: (text: string) => void = (text) => void process.stderr.write(text)): OAuthClientProvider {
  const read = (): Saved => readAll(config)[server] ?? {};
  const write = (change: Partial<Saved>) => {
    signal?.throwIfAborted();
    const all = readAll(config);
    all[server] = { ...all[server], ...change };
    writeAll(config, all);
  };
  const metadata: OAuthClientMetadata = {
    client_name: `${config.name} CLI`,
    application_type: "native",
    redirect_uris: redirectUrl ? [redirectUrl] : [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return metadata;
    },
    ...(config.clientMetadataUrl ? { clientMetadataUrl: config.clientMetadataUrl } : {}),
    clientInformation: () => { const saved = read(); return stamped(config.clientId ? { client_id: config.clientId } : saved.client, issuerOf(saved)); },
    saveClientInformation: (client, ctx) => write({ client: stamped(client, ctx?.issuer ?? issuerOf(read())) }),
    tokens: () => { const saved = read(); return stamped(saved.tokens, issuerOf(saved)); },
    saveTokens: (tokens, ctx) => write({ tokens: stamped(tokens, ctx?.issuer ?? issuerOf(read())), tokensSavedAt: Date.now() }),
    state: () => { const state = randomBytes(32).toString("base64url"); write({ state }); return state; },
    discoveryState: () => read().discovery,
    saveDiscoveryState: (discovery) => write({ discovery }),
    // The link is always printed: an opener may pick the wrong browser or profile, and the link
    // works pasted anywhere on this computer (the state is in the auth file, not the tab).
    redirectToAuthorization: async (url) => {
      say(config.openUrl ? `Opening the sign-in page. If it opens in the wrong browser, paste this link into the one you want:\n  ${url}\n` : `Open this link to sign in:\n  ${url}\n`);
      if (config.openUrl) await Promise.resolve(config.openUrl(url.toString())).catch(() => {});
    },
    saveCodeVerifier: (verifier) => write({ verifier }),
    codeVerifier: () => {
      const verifier = read().verifier;
      if (!verifier) throw new Error("No sign-in in progress.");
      return verifier;
    },
    // Commands connect with no redirect, which the SDK treats as a non-interactive grant: an
    // expired token is then renewed with the stored refresh token, never by a new sign-in.
    ...(redirectUrl ? {} : {
      prepareTokenRequest: () => {
        const refreshToken = read().tokens?.refresh_token;
        return refreshToken ? new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }) : undefined;
      },
    }),
  };
}

/** Terminal HTTP uses the same stored OAuth session as MCP, including refresh and issuer binding. */
export async function storedAccessToken(config: CliConfig, server: string, forceRefresh = false, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  const saved = readAll(config)[server];
  if (!saved?.tokens) return undefined;
  const tokens = stamped(saved.tokens, issuerOf(saved))!;
  const expired = saved.tokensSavedAt !== undefined && tokens.expires_in !== undefined && saved.tokensSavedAt + tokens.expires_in * 1000 <= Date.now() + 30_000;
  if (!expired && !forceRefresh) return tokens.access_token;
  if (!tokens.refresh_token || (!saved.client && !config.clientId)) return undefined;
  const info = await discoverOAuthServerInfo(server);
  const issuer = info.authorizationServerMetadata?.issuer ?? String(info.authorizationServerUrl);
  if (tokens.issuer && tokens.issuer !== issuer) throw new Error("The authorization server changed; sign in again.");
  const fresh = await refreshAuthorization(info.authorizationServerUrl, { metadata: info.authorizationServerMetadata, clientInformation: config.clientId ? { client_id: config.clientId } : saved.client!, refreshToken: tokens.refresh_token, resource: info.resourceMetadata?.resource });
  await storedProvider(config, server, undefined, signal).saveTokens({ ...fresh, issuer });
  return fresh.access_token;
}

export function isSignedIn(config: CliConfig, server: string): boolean {
  return Boolean(readAll(config)[server]?.tokens);
}

export function signOut(config: CliConfig, server: string): void {
  const all = readAll(config);
  delete all[server];
  writeAll(config, all);
}

/** The CLI's own client_id, when the server's authorization server advertises one on its own origin. */
async function advertisedClient(server: string): Promise<string | undefined> {
  const { authorizationServerMetadata: metadata } = await discoverOAuthServerInfo(server);
  const id = (metadata as Record<string, unknown> | undefined)?.flow_cli_client_id;
  if (typeof id !== "string" || !metadata?.issuer || !URL.canParse(id) || !URL.canParse(metadata.issuer)) return undefined;
  return new URL(id).origin === new URL(metadata.issuer).origin ? id : undefined;
}

/**
 * Whether this computer's sign-in predates the server's CLI client (it registered itself, as any
 * host does), so the tools kept to the CLI stay hidden until `auth login`. False when unsure.
 */
export async function signedInAsOtherClient(config: CliConfig, server: string): Promise<boolean> {
  const saved = readAll(config)[server];
  if (!saved?.tokens || config.clientId || config.clientMetadataUrl) return false;
  try {
    const id = await advertisedClient(server);
    return id !== undefined && saved.client?.client_id !== id;
  } catch { return false; }
}

/** Sign in: the browser goes to the organization's own login, and comes back to a loopback port. */
export async function signIn(config: CliConfig, server: string, signal?: AbortSignal, say?: (text: string) => void): Promise<void> {
  signal?.throwIfAborted();
  if (!config.clientId && !config.clientMetadataUrl) {
    // Discovery that fails here fails again in auth(), which says why.
    const id = await advertisedClient(server).catch(() => undefined);
    const saved = readAll(config)[server];
    // A sign-in made as another client is replaced, not refreshed: its tokens belong to that client.
    if (id && saved?.client?.client_id !== id) {
      const all = readAll(config);
      all[server] = { client: { client_id: id } };
      writeAll(config, all);
    }
  }
  const callback = createServer();
  await new Promise<void>((resolve, reject) => { callback.once("error", reject); callback.listen(config.redirectPort ?? 0, "127.0.0.1", resolve); });
  const { port } = callback.address() as { port: number };
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  let cancel: (() => void) | undefined;
  try {
    const provider = storedProvider(config, server, redirectUrl, signal, say);
    const code = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
      cancel = () => reject(new Error("Sign-in cancelled."));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      callback.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUrl);
        if (url.pathname !== "/callback") return void res.writeHead(404).end();
        const error = url.searchParams.get("error");
        const got = url.searchParams.get("code");
        if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}` || !readAll(config)[server]?.state || url.searchParams.get("state") !== readAll(config)[server]?.state) {
          res.writeHead(400, { "content-type": "text/plain" }).end("Invalid sign-in response.");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(got ? `Signed in. You can close this tab and go back to ${config.name}.` : `Sign-in failed: ${error ?? "no code"}.`);
        if (got) resolve({ code: got, iss: url.searchParams.get("iss") ?? undefined });
        else reject(new Error(`Sign-in failed: ${error ?? "no code came back"}.`));
      });
    });
    // Cancellation may arrive while discovery or the authorization request is still in flight.
    void code.catch(() => {});
    const first = await auth(provider, { serverUrl: server });
    if (first === "AUTHORIZED") return;
    const answer = await code;
    await auth(provider, { serverUrl: server, authorizationCode: answer.code, iss: answer.iss });
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
    callback.close();
  }
}
