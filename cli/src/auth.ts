// The CLI's sign-in: the same OAuth a host such as Claude runs against the organization's MCP
// server, as a native app with a loopback redirect, so people sign in on the organization's own
// pages. Tokens are kept per server in ~/.config/<name>/auth.json (XDG_CONFIG_HOME), mode 600, and
// refreshed by the SDK. A token in <NAME>_TOKEN (CI, agents) is used as is and never stored.
//
// When the server's authorization server advertises the CLI's own client (the OAuth bridge's
// flow_cli_client_id), the CLI signs in as that client instead of registering itself, so the server
// knows the caller is this CLI and lists the tools kept to it (Tool.mcp.clients).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
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
import { brandOf, HEX, logoProblem, signInCommand, type CliConfig, type SignInPage } from "./commands.ts";

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
    client_name: `${brandOf(config).name} CLI`,
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
      // Not awaited: the page the opener loads is answered only once this sign-in finishes.
      if (config.openUrl) void Promise.resolve().then(() => config.openUrl!(url.toString())).catch(() => {});
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
 * host does), so the tools kept to the CLI stay hidden until the next sign-in. False when unsure.
 */
export async function signedInAsOtherClient(config: CliConfig, server: string): Promise<boolean> {
  const saved = readAll(config)[server];
  if (!saved?.tokens || config.clientId || config.clientMetadataUrl) return false;
  try {
    const id = await advertisedClient(server);
    return id !== undefined && saved.client?.client_id !== id;
  } catch { return false; }
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Black or white, whichever reads better on the accent. */
function onAccent(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.18 ? "#111111" : "#ffffff";
}

/** Flow's sign-in page: the brand's logo (else its initial and name) and accent, the outcome, and the terminal it hands back to. */
export function signInPageHtml(page: SignInPage, nonce: string): string {
  const { brand, status } = page;
  const accent = brand.accent && HEX.test(brand.accent) ? brand.accent : "#4f5bd5";
  const ok = status === "signed-in";
  const name = escape(brand.name);
  const cli = escape(page.cli);
  const command = escape(page.command);
  const logo = brand.logo && !logoProblem(brand.logo)
    ? `<img class="logo" src="${escape(brand.logo)}" alt="${name}">`
    : `<div class="wordmark"><span class="initial" aria-hidden="true">${escape([...brand.name.trim()][0]?.toUpperCase() ?? "")}</span>${name}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${ok ? `Signed in to ${name}` : `${name}: sign-in didn't finish`}</title>
<style nonce="${nonce}">
:root { --accent: ${accent}; --on-accent: ${onAccent(accent)}; --bg: #fbfbfa; --text: #18181b; --muted: #5f5f66; --faint: #8b8b93; --wash: 16%; --ok: #1f9d55; --bad: #d4382c; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #0e0e10; --text: #f1f1f3; --muted: #a6a6ae; --faint: #7c7c85; --wash: 22%; --ok: #3ecf7a; --bad: #ff6b5e; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 48px 16px; color: var(--text); font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased;
  background: radial-gradient(1100px 520px at 50% -140px, color-mix(in srgb, var(--accent) var(--wash), transparent), transparent 70%), var(--bg); }
main { width: 100%; max-width: 540px; }
.logo { display: block; height: 40px; max-width: 220px; object-fit: contain; object-position: left; }
.wordmark { display: flex; align-items: center; gap: 12px; font-size: 24px; font-weight: 650; letter-spacing: -0.02em; line-height: 1; overflow-wrap: anywhere; }
.initial { flex: none; width: 40px; height: 40px; border-radius: 11px; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; font-size: 21px; font-weight: 700; }
.state { display: inline-flex; align-items: center; gap: 8px; margin: 56px 0 18px; padding: 5px 12px 5px 10px; border-radius: 999px; font-size: 14px; font-weight: 600; color: var(--mark); background: color-mix(in srgb, var(--mark) 12%, transparent); }
.state::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--mark); }
.ok { --mark: var(--ok); } .bad { --mark: var(--bad); }
h1 { margin: 0 0 12px; font-size: 40px; line-height: 1.12; font-weight: 650; letter-spacing: -0.03em; }
.message { margin: 0; font-size: 18px; color: var(--muted); }
.terminal { margin-top: 36px; border-radius: 14px; overflow: hidden; background: #141417; color: #e7e7ea; box-shadow: 0 1px 0 rgb(255 255 255 / 6%) inset, 0 24px 48px -20px color-mix(in srgb, var(--accent) 45%, rgb(0 0 0 / 40%)); font: 14.5px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.bar { display: flex; align-items: center; gap: 7px; padding: 11px 14px; background: #1c1c20; border-bottom: 1px solid #26262b; color: #8b8b93; font-size: 12.5px; }
.bar i { width: 11px; height: 11px; border-radius: 50%; background: #3a3a40; }
.bar span { margin-left: 8px; }
.lines { padding: 16px 18px 18px; overflow-wrap: anywhere; }
.lines div { white-space: pre-wrap; }
.prompt { color: var(--accent); filter: brightness(1.35) saturate(1.1); }
.good { color: #3ecf7a; } .fail { color: #ff7a6e; } .dim { color: #8b8b93; }
.cursor { display: inline-block; width: 9px; height: 1.15em; vertical-align: -0.2em; background: #e7e7ea; animation: blink 1.1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .cursor { animation: none; } }
.close { margin: 22px 0 0; font-size: 14px; color: var(--faint); }
@media (max-width: 480px) { h1 { font-size: 32px; } .state { margin-top: 40px; } .message { font-size: 17px; } }
</style>
</head>
<body>
<main>
${logo}
<div class="state ${ok ? "ok" : "bad"}">${ok ? "Signed in" : "Not signed in"}</div>
<h1>${ok ? "Head back to your terminal." : "Sign-in didn't finish."}</h1>
<p class="message">${escape(page.message)}</p>
<div class="terminal" aria-hidden="true">
<div class="bar"><i></i><i></i><i></i><span>${cli}</span></div>
<div class="lines">
<div><span class="prompt">$</span> ${command}</div>
${ok ? `<div class="good">✓ Signed in to ${name}</div>` : `<div class="fail">✕ Sign-in didn't finish</div><div class="dim"># run it again to try once more</div>`}
<div><span class="prompt">$</span> ${ok ? "" : command}<span class="cursor"></span></div>
</div>
</div>
<p class="close">${ok ? "You can close this tab." : `Run <strong>${command}</strong> in your terminal to try again.`}</p>
</main>
<script nonce="${nonce}">
history.replaceState(null, "", location.pathname);
${ok ? "setTimeout(function () { window.close(); }, 1500);" : ""}
</script>
</body>
</html>
`;
}

/** The page a sign-in ends on: the team's own when it has one (else, or if it throws, Flow's), never cached. */
function sendPage(config: CliConfig, res: ServerResponse, code: number, status: SignInPage["status"], message: string): void {
  const page: SignInPage = { status, brand: brandOf(config), cli: config.name, command: signInCommand(config), message };
  const nonce = randomBytes(16).toString("base64");
  let html: string | undefined;
  try { html = config.signInPage?.(page); } catch {}
  const own = typeof html === "string";
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...(own ? {} : { "content-security-policy": `default-src 'none'; img-src https: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` }),
  }).end(own ? html : signInPageHtml(page, nonce));
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
  // The browser waits on the code's page until the code is exchanged and the tokens are saved.
  let finish!: (outcome: { ok: boolean; message: string }) => void;
  const outcome = new Promise<{ ok: boolean; message: string }>((resolve) => (finish = resolve));
  const answered: Promise<void>[] = [];
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
        // A stray or stale request is answered and never ends the sign-in in progress.
        if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}` || !readAll(config)[server]?.state || url.searchParams.get("state") !== readAll(config)[server]?.state) {
          return sendPage(config, res, 400, "failed", "This sign-in link has expired or was already used.");
        }
        answered.push(new Promise((done) => res.once("close", done)));
        if (!got) {
          reject(new Error(`Sign-in failed: ${error ?? "no code came back"}.`));
          return sendPage(config, res, 200, "failed", error === "access_denied" ? "The sign-in was cancelled." : "The sign-in page did not approve it.");
        }
        resolve({ code: got, iss: url.searchParams.get("iss") ?? undefined });
        void outcome.then(({ ok, message }) => sendPage(config, res, 200, ok ? "signed-in" : "failed", message));
      });
    });
    // Cancellation may arrive while discovery or the authorization request is still in flight.
    void code.catch(() => {});
    const first = await auth(provider, { serverUrl: server });
    if (first === "AUTHORIZED") return;
    const answer = await code;
    try {
      await auth(provider, { serverUrl: server, authorizationCode: answer.code, iss: answer.iss });
    } catch (error) {
      finish({ ok: false, message: "The sign-in came back but could not be completed. Your terminal says why." });
      throw error;
    }
    finish({ ok: true, message: `${brandOf(config).name} is ready. Pick up where you left off.` });
  } finally {
    finish({ ok: false, message: "The sign-in was stopped in the terminal." });
    // The page reaches the browser before the CLI exits.
    await Promise.all(answered);
    if (cancel) signal?.removeEventListener("abort", cancel);
    callback.close();
  }
}
