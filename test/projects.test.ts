// covers: testing/src/projects.ts testing/src/flow-login.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { confirmByName } from "../testing/src/projects.ts";
import type { Project } from "../testing/src/flow-login.ts";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const TOKEN = "fcli_projects_token_5678";

const PROJECTS: Project[] = [
  { id: "agt_cafe1", name: "cafe", workspace: { id: "acc_team", name: "Team" }, created_at: "2026-10-01T09:30:00Z", owner: true },
  { id: "agt_shop1", name: "shop", workspace: { id: "acc_team", name: "Team" }, created_at: "2026-10-12T15:00:00Z", owner: false },
  { id: "agt_twin1", name: "twin", workspace: { id: "acc_team", name: "Team" }, created_at: "2026-10-20T08:00:00Z", owner: true },
  { id: "agt_twin2", name: "twin", workspace: { id: "acc_home", name: "Home" }, created_at: "2026-10-21T08:00:00Z", owner: true },
];

interface Seen { method: string; path: string; auth?: string }

/** flow.engineer's /cli/projects routes; `deleteError` is what DELETE answers instead of the deletion. */
async function flowServer(options: { deleteError?: { status: number; code: string }; listError?: { status: number; code: string } } = {}) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization });
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const error = (e: { status: number; code: string }) => send(e.status, { error: { code: e.code, message: `It is ${e.code}.`, hint: "Ask the server." } });
    const path = new URL(req.url!, "http://x");
    if (req.method === "GET" && path.pathname === "/cli/projects") {
      if (options.listError) return error(options.listError);
      const workspace = path.searchParams.get("workspace");
      return send(200, { projects: PROJECTS.filter((p) => !workspace || p.workspace.id === workspace) });
    }
    const id = /^\/cli\/projects\/([^/]+)$/.exec(path.pathname)?.[1];
    if (req.method === "DELETE" && id) {
      if (options.deleteError) return error(options.deleteError);
      const p = PROJECTS.find((p) => p.id === id)!;
      return send(200, { project: { id: p.id, name: p.name, deleted_at: "2026-10-29T10:00:00Z", restore_until: "2026-11-28T10:00:00Z" } });
    }
    send(404, {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, deletes: () => seen.filter((r) => r.method === "DELETE"), close: () => { server.closeAllConnections(); server.close(); } };
}

/** Runs the CLI with no terminal (stdin a pipe never written), signed in by FLOW_FRAMEWORK_TOKEN unless `token` is null. */
function run(args: string[], url: string, token: string | null = TOKEN) {
  const config = mkdtempSync(join(tmpdir(), "flow-projects-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: config, XDG_CONFIG_HOME: config, FLOW_FRAMEWORK_LOGIN_URL: url, ...(token ? { FLOW_FRAMEWORK_TOKEN: token } : {}) };
  const child = spawn(process.execPath, [cli, "projects", ...args], { cwd: config, env });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  return new Promise<{ code: number | null; out: string; err: string; json: any }>((done) =>
    child.on("close", (code) => done({ code, out, err, json: args.includes("--json") && out ? JSON.parse(out) : undefined })),
  );
}

test("list shows each project's name, workspace, id, date made and whether you can delete it; --workspace is sent, and --json gives the list", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const all = await run(["list"], flow.url);
  assert.equal(all.code, 0, all.err);
  assert.equal(all.out, [
    "NAME  WORKSPACE  ID         CREATED     CAN DELETE",
    "cafe  Team       agt_cafe1  2026-10-01  yes",
    "shop  Team       agt_shop1  2026-10-12  no (owner only)",
    "twin  Team       agt_twin1  2026-10-20  yes",
    "twin  Home       agt_twin2  2026-10-21  yes",
    "",
  ].join("\n"));
  assert.deepEqual(flow.seen[0], { method: "GET", path: "/cli/projects", auth: `Bearer ${TOKEN}` });
  const home = await run(["list", "--workspace", "acc_home", "--json"], flow.url);
  assert.equal(home.code, 0, home.err);
  assert.equal(flow.seen[1]!.path, "/cli/projects?workspace=acc_home");
  assert.deepEqual(home.json, { projects: [PROJECTS[3]] });
});

test("delete --yes takes an exact name or an id, deletes that project by its id and prints until when it can be brought back", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const byName = await run(["delete", "cafe", "--yes"], flow.url);
  assert.equal(byName.code, 0, byName.err);
  assert.equal(byName.out, "Deleted cafe (agt_cafe1) in Team. Its keys stopped working; the Flow team can bring it back until 2026-11-28 10:00 UTC.\n");
  const byId = await run(["delete", "agt_twin2", "--yes", "--json"], flow.url);
  assert.equal(byId.code, 0, byId.err);
  assert.deepEqual(byId.json, { project: { id: "agt_twin2", name: "twin", deleted_at: "2026-10-29T10:00:00Z", restore_until: "2026-11-28T10:00:00Z" } });
  assert.deepEqual(flow.deletes().map((r) => [r.path, r.auth]), [["/cli/projects/agt_cafe1", `Bearer ${TOKEN}`], ["/cli/projects/agt_twin2", `Bearer ${TOKEN}`]]);
});

test("delete sends nothing for a name two projects share (it gives both ids), a name not matched exactly, a project you do not own, or no terminal without --yes", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const twin = await run(["delete", "twin", "--yes", "--json"], flow.url);
  assert.equal(twin.code, 1);
  assert.equal(twin.json.error.code, "ambiguous_name");
  assert.deepEqual(twin.json.error.matches, [{ id: "agt_twin1", workspace: { id: "acc_team", name: "Team" } }, { id: "agt_twin2", workspace: { id: "acc_home", name: "Home" } }]);
  assert.match(twin.err, /2 projects are named twin; pass the one you mean by its id:\n {2}agt_twin1 \(in Team\)\n {2}agt_twin2 \(in Home\)/);
  const cased = await run(["delete", "Cafe", "--yes"], flow.url);
  assert.equal(cased.code, 1);
  assert.match(cased.err, /No project named or with the id Cafe \(names are matched exactly\)\. Next: npx @flow-engineer\/flow projects list/);
  const notOwner = await run(["delete", "shop", "--yes"], flow.url);
  assert.equal(notOwner.code, 3);
  assert.equal(notOwner.err, "Only the organization's owner (Team) can delete shop.\n");
  const noTerminal = await run(["delete", "cafe"], flow.url);
  assert.equal(noTerminal.code, 1);
  assert.match(noTerminal.err, /there is no terminal here\. To delete cafe without asking, pass --yes\./);
  assert.equal(flow.deletes().length, 0);
});

test("not signed in says to run login; the server's refusals are said in plain words: signed out, owner only (exit 3), and its projects unreachable (exit 2)", async (t) => {
  const plain = await flowServer();
  t.after(plain.close);
  const signedOut = await run(["list", "--json"], plain.url, null);
  assert.equal(signedOut.code, 1);
  assert.deepEqual(signedOut.json, { error: { code: "not_signed_in", message: "Not signed in to flow.engineer.", next: "npx @flow-engineer/flow login" } });
  assert.equal(plain.seen.length, 0, "nothing is asked without a token");

  const ended = await flowServer({ listError: { status: 401, code: "signed_out" } });
  t.after(ended.close);
  const revoked = await run(["list"], ended.url);
  assert.equal(revoked.code, 3);
  assert.equal(revoked.err, "Your sign-in to flow.engineer has ended or was revoked. Next: npx @flow-engineer/flow login\n");

  const owner = await flowServer({ deleteError: { status: 403, code: "owner_only" } });
  t.after(owner.close);
  const refused = await run(["delete", "cafe", "--yes", "--json"], owner.url);
  assert.equal(refused.code, 3);
  assert.deepEqual(refused.json, { error: { code: "owner_only", message: "Only the organization's owner can delete this project.", next: null } });

  const down = await flowServer({ listError: { status: 502, code: "observe_unavailable" } });
  t.after(down.close);
  const unreachable = await run(["list"], down.url);
  assert.equal(unreachable.code, 2);
  assert.equal(unreachable.err, "flow.engineer could not reach its projects just now. Try again in a minute.\n");
});

test("in a terminal, delete goes ahead only when the project's name is typed exactly", async () => {
  const ask = async (typed: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (c) => { shown += c; });
    const answer = confirmByName(PROJECTS[0]!, input, output);
    input.end(typed);
    return { confirmed: await answer, shown };
  };
  const yes = await ask("cafe\n");
  assert.equal(yes.confirmed, true);
  assert.equal(yes.shown, "Delete cafe in Team? Its keys stop working at once; the Flow team can bring it back for 30 days. Type the name to confirm: ");
  assert.equal((await ask("Cafe\n")).confirmed, false);
  assert.equal((await ask("y\n")).confirmed, false);
  assert.equal((await ask("")).confirmed, false, "Ctrl-D, the input ending, is not a yes");
});
