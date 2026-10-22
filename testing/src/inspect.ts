// `flow inspect <url> <command>`: any MCP server driven from a shell as a host drives it, with the
// raw results, so the coding agent building an agent tests its tools and sign-in in the chat it is
// in (a server added to a coding agent only loads in a new chat). It is for testing: it is not the
// agent's CLI, and needs no CLI file. It needs only @modelcontextprotocol/client, an optional peer;
// an agent without it runs `npx -y -p @flow-engineer/flow -p @modelcontextprotocol/client@<version>
// flow inspect ...`, which installs nothing into the agent. Sign-in is the CLI's own (cli/src/auth.ts):
// the host's OAuth, tokens kept per server in ~/.config/flow-inspect/auth.json.

import { parseArgs } from "node:util";
import { Client, discoverOAuthServerInfo, InsufficientScopeError, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { isSignedIn, signIn, signOut, storedProvider } from "../../cli/src/auth.ts";
import type { CliConfig } from "../../cli/src/commands.ts";

const USAGE = `Usage: flow inspect <url> <command> [--token <token>]

Test an MCP server as a host such as Claude does: the same protocol and the same sign-in. Results
are the server's own JSON, on stdout.

Commands:
  tools                     tools/list: every tool, with its schemas and annotations
  call <tool> [json]        tools/call with these arguments (default {})
  resources                 resources/list
  read <uri>                resources/read
  prompts                   prompts/list
  prompt <name> [json]      prompts/get with these arguments (default {})
  auth                      Sign in as a host does: prints what the server advertises, the
                            link to open, then the client and the token's scope (never the
                            token). It waits for the browser to come back, so run it in the
                            background and give the person the link
  auth status               Whether a token is kept for this server
  auth logout               Forget this server's token

Options:
  --token <token>           Send this bearer token instead of signing in (an API key, a test token)
  -h, --help                Show this help

Exit status: 0 done, 1 the server answered with an error, 2 a wrong command, 3 sign in first,
5 the server could not be reached.`;

const CONFIG: CliConfig = { name: "flow-inspect" };
/** The agent CLI's exit codes (cli/src/run.ts, not imported: it needs @stricli/core). */
const EXIT = { ok: 0, failed: 1, usage: 2, signIn: 3, unreachable: 5 } as const;

export interface InspectIO {
  write(text: string): void;
  writeError(text: string): void;
  /** Where the sign-in link goes; omitted prints it on stderr. */
  openUrl?: (url: string) => void | Promise<void>;
}

const processIO: InspectIO = { write: (t) => void process.stdout.write(t), writeError: (t) => void process.stderr.write(t) };

/** Run one inspect command; resolves with its exit code. */
export async function inspectCli(argv: string[], io: InspectIO = processIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { token: { type: "string" }, help: { type: "boolean", short: "h", default: false } } });
  } catch (error) {
    io.writeError(`${(error as Error).message}\n${USAGE}\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  const [server, command, ...rest] = positionals;
  if (values.help || !server || !command) {
    (values.help ? io.write : io.writeError)(`${USAGE}\n`);
    return values.help ? EXIT.ok : EXIT.usage;
  }
  const config: CliConfig = { ...CONFIG, ...(io.openUrl ? { openUrl: io.openUrl } : {}) };
  const print = (value: unknown) => io.write(`${JSON.stringify(value, null, 2)}\n`);

  if (command === "auth") return auth(config, server, rest[0], print, io);

  let input: unknown = {};
  if ((command === "call" || command === "prompt") && rest[1] !== undefined) {
    try {
      input = JSON.parse(rest[1]);
    } catch { input = undefined; }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      io.writeError(`The arguments must be a JSON object, such as '{"order_id":"BL-1042"}'.\n`);
      return EXIT.usage;
    }
  }
  const [target] = rest;
  const requests: Record<string, ((client: Client) => Promise<unknown>) | undefined> = {
    tools: (client) => all((cursor) => client.listTools(cursor ? { cursor } : {}), "tools"),
    call: target ? (client) => client.callTool({ name: target, arguments: input as Record<string, unknown> }) : undefined,
    resources: (client) => all((cursor) => client.listResources(cursor ? { cursor } : {}), "resources"),
    read: target ? (client) => client.readResource({ uri: target }) : undefined,
    prompts: (client) => all((cursor) => client.listPrompts(cursor ? { cursor } : {}), "prompts"),
    prompt: target ? (client) => client.getPrompt({ name: target, arguments: input as Record<string, string> }) : undefined,
  };
  const request = requests[command];
  if (!request) {
    io.writeError(`${command in requests ? `"${command}" needs a name.` : `Unknown command "${command}".`}\n${USAGE}\n`);
    return EXIT.usage;
  }

  const client = new Client({ name: "flow-inspect", version: "1" });
  try {
    const authProvider = values.token ? { token: async () => values.token } : isSignedIn(config, server) ? storedProvider(config, server) : undefined;
    await client.connect(new StreamableHTTPClientTransport(new URL(server), authProvider ? { authProvider } : {}));
    const result = await request(client);
    print(result);
    return (result as { isError?: boolean }).isError ? EXIT.failed : EXIT.ok;
  } catch (error) {
    return failed(error, server, io);
  } finally {
    await client.close();
  }
}

async function auth(config: CliConfig, server: string, sub: string | undefined, print: (value: unknown) => void, io: InspectIO): Promise<number> {
  if (sub === "status") return print({ server, signedIn: isSignedIn(config, server) }), EXIT.ok;
  if (sub === "logout") return signOut(config, server), print({ server, signedIn: false }), EXIT.ok;
  if (sub !== undefined) {
    io.writeError(`${USAGE}\n`);
    return EXIT.usage;
  }
  try {
    // What a host reads before it signs in: the protected resource's metadata, then its authorization server's.
    const info = await discoverOAuthServerInfo(server);
    print({ resource: info.resourceMetadata ?? null, authorizationServer: info.authorizationServerMetadata ?? { url: String(info.authorizationServerUrl) } });
    signOut(config, server);
    await signIn(config, server);
    const provider = storedProvider(config, server);
    const tokens = await provider.tokens();
    const client = await provider.clientInformation();
    print({ signedIn: true, client_id: client?.client_id, scope: tokens?.scope ?? null, expires_in: tokens?.expires_in ?? null, refresh_token: Boolean(tokens?.refresh_token) });
    return EXIT.ok;
  } catch (error) {
    return failed(error, server, io);
  }
}

/** Every page of a list, as one result. */
async function all<K extends string>(page: (cursor?: string) => Promise<Record<string, unknown> & { nextCursor?: string }>, key: K): Promise<Record<K, unknown[]>> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    items.push(...(result[key] as unknown[]));
    cursor = result.nextCursor;
  } while (cursor);
  return { [key]: items } as Record<K, unknown[]>;
}

function failed(error: unknown, server: string, io: InspectIO): number {
  const status = error instanceof SdkHttpError ? (error.data as { status?: number } | undefined)?.status : undefined;
  if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError || status === 401) {
    io.writeError(`Sign in first: flow inspect ${server} auth (or pass --token).\n`);
    return EXIT.signIn;
  }
  const message = (error as Error).message.split("\n")[0];
  if (status !== undefined || error instanceof TypeError) {
    io.writeError(`Could not reach ${server}${status ? ` (it answered ${status})` : ""}: ${message}\n`);
    return EXIT.unreachable;
  }
  io.writeError(`${message}\n`);
  return EXIT.failed;
}
