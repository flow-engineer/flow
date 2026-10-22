// covers: testing/src/inspect.ts cli/src/auth.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { inspectCli, type InspectIO } from "../testing/src/inspect.ts";
import { mcpServer } from "../mcp/src/index.ts";
import { tool } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function listen(handler: RequestListener): Promise<string> {
  const http = createServer(handler);
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

// Protects the coding agent's way to test an agent in the chat it is in: the tools a host sees, a
// signed-in call, and the host's sign-in, without a CLI file.
test("inspect lists tools raw, signs in as a host does without printing the token, then calls a signed-in tool", async () => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "flow-inspect-"));
  let issuer = "";
  issuer = await listen(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const body = await new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => resolve(b));
    });
    const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    }
    if (url.pathname === "/register") return json(201, { ...JSON.parse(body), client_id: "inspect-1" });
    if (url.pathname === "/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "code-1");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("iss", issuer);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === "/token") return json(200, { access_token: "tok-1", token_type: "Bearer", expires_in: 3600, refresh_token: "ref-1", scope: "orders" });
    res.writeHead(404).end();
  });
  const mine = tool({ name: "my_orders", description: "Their orders.", input: z.object({ limit: z.number().optional() }), hints: { readOnly: true }, run: ({ limit }, ctx) => ({ for: ctx.key, limit }) });
  const handle = mcpServer({ name: "acme", version: "1", tools: [mine], auth: { issuer, verify: (t) => (t === "tok-1" ? { key: "user-7" } : null) } });
  const server = `${await listen((req, res) => void handle.node(req, res))}/mcp`;

  const run = async (...argv: string[]) => {
    let out = "", err = "";
    const io: InspectIO = {
      write: (t) => void (out += t),
      writeError: (t) => void (err += t),
      openUrl: async (link) => {
        const page = await fetch(link, { redirect: "manual" });
        await fetch(page.headers.get("location")!);
      },
    };
    return { code: await inspectCli([server, ...argv], io), out, err };
  };

  const tools = await run("tools");
  assert.equal(tools.code, 0);
  const listed = JSON.parse(tools.out) as { tools: Array<{ name: string; inputSchema: unknown }> };
  assert.deepEqual(listed.tools.map((t) => t.name), ["my_orders"]);

  const signedOut = await run("call", "my_orders");
  assert.equal(signedOut.code, 3);
  assert.match(signedOut.err, /auth/);

  const signIn = await run("auth");
  assert.equal(signIn.code, 0, signIn.err);
  assert.match(signIn.out, /"issuer"/, "prints what the server advertises");
  assert.match(signIn.out, /"scope": "orders"/);
  assert.doesNotMatch(signIn.out + signIn.err, /tok-1|ref-1/, "never prints a token");

  const called = await run("call", "my_orders", '{"limit":2}');
  assert.equal(called.code, 0, called.err);
  const result = JSON.parse(called.out) as { content: Array<{ text: string }> };
  assert.deepEqual(JSON.parse(result.content[0]!.text), { for: "user-7", limit: 2 }, "the raw tools/call result");
});
