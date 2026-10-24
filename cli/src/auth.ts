// The CLI's sign-in: the same OAuth a host such as Claude runs against the organization's MCP
// server, as a native app with a loopback redirect, so people sign in on the organization's own
// pages. Tokens are kept per server in ~/.config/<name>/auth.json (XDG_CONFIG_HOME), mode 600, and
// refreshed by the SDK. A token in <NAME>_TOKEN (CI, agents) is used as is and never stored.

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

/** An OAuth client provider whose state lives in the CLI's auth file, for one server. */
export function storedProvider(config: CliConfig, server: string, redirectUrl?: string, signal?: AbortSignal): OAuthClientProvider {
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
    clientInformation: () => config.clientId ? { client_id: config.clientId } : read().client,
    saveClientInformation: (client) => write({ client }),
    tokens: () => read().tokens,
    saveTokens: (tokens) => write({ tokens, tokensSavedAt: Date.now() }),
    state: () => { const state = randomBytes(32).toString("base64url"); write({ state }); return state; },
    discoveryState: () => read().discovery,
    saveDiscoveryState: (discovery) => write({ discovery }),
    redirectToAuthorization: async (url) => {
      if (config.openUrl) await config.openUrl(url.toString());
      else console.error(`Open this link to sign in:\n  ${url}`);
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
  const { tokens } = saved;
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

/** Sign in: the browser goes to the organization's own login, and comes back to a loopback port. */
export async function signIn(config: CliConfig, server: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const callback = createServer();
  await new Promise<void>((resolve, reject) => { callback.once("error", reject); callback.listen(config.redirectPort ?? 0, "127.0.0.1", resolve); });
  const { port } = callback.address() as { port: number };
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  let cancel: (() => void) | undefined;
  try {
    const provider = storedProvider(config, server, redirectUrl, signal);
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
