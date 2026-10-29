// `flow projects list | delete`: the projects of the account signed in with `flow login`, in every
// workspace it is in, and deleting one. The calls to flow.engineer are in testing/src/flow-login.ts.
// delete takes a name (exact, case-sensitive) or an id; a name two projects share is refused with
// both ids. It asks for the project's name to be typed in a terminal; with no terminal it needs
// --yes. --json: one JSON object on stdout ({"projects": [...]}, {"project": {...}}, or
// {"error": {code, message, next}}, with `matches` for a shared name), every human line on stderr.
// Exit status: 0 done, 1 usage, not signed in, no such project, a name two share, or not confirmed,
// 2 network, or flow.engineer could not reach its projects, 3 the server refused (owner only, signed out).

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { RUN } from "../../src/names.ts";
import { asStop, EXIT, signedIn, Stop, writeAll } from "./account.ts";
import { deleteProject, listProjects, LoginRefused, type Project } from "./flow-login.ts";

export const PROJECTS_LINE = `  flow projects list [--workspace <acc_id>] [--json]
                            Your projects on flow.engineer: name, workspace, id, when made, and
                            whether you can delete it (the organization's owner can)
  flow projects delete <name|id> [--workspace <acc_id>] [--yes] [--json]
                            Delete a project: its keys stop working at once, and the Flow team can
                            bring it back for 30 days. Asks you to type its name; --yes does not ask`;

const USAGE = `Usage:\n${PROJECTS_LINE}

Sign in first with ${RUN} login. --workspace keeps to that workspace (its acc_ id). A name is
matched exactly; when two projects share it, pass the id (flow projects list shows it). Without a
terminal, delete asks nothing and needs --yes.

Exit status: 0 done, 1 usage, not signed in, no such project, a name two projects share, or not
confirmed, 2 flow.engineer could not be reached (or could not reach its projects: try again),
3 refused (only the organization's owner can delete a project, or the sign-in has ended).`;

const LOGIN_NEXT = `${RUN} login`;

/** Runs `flow projects`; resolves to the exit status. */
export async function projectsCli(args: string[]): Promise<number> {
  let values: { json?: boolean; help?: boolean; yes?: boolean; workspace?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        yes: { type: "boolean", default: false },
        workspace: { type: "string" },
      },
    }));
  } catch (error) {
    console.error(`flow projects: ${(error as Error).message.split(". ")[0]}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (values.help) return console.log(USAGE), EXIT.ok;
  const [sub, target, ...extra] = positionals;
  const usage = (problem: string) => (console.error(`flow projects: ${problem}\n\n${USAGE}`), EXIT.usage);
  if (sub !== "list" && sub !== "delete") return usage(sub === undefined ? "say list or delete" : `unknown command "${sub}"`);
  if (sub === "list" && target !== undefined) return usage("list takes no name");
  if (sub === "delete" && (target === undefined || extra.length)) return usage("delete takes one name or id");
  if (sub === "list" && values.yes) return usage("--yes goes with delete");
  const workspace = values.workspace?.trim();
  if (workspace !== undefined && (!workspace || workspace.length > 100 || /[\u0000-\u001f\u007f]/.test(workspace))) return usage("--workspace takes a workspace's acc_ id");

  const json = values.json === true;
  const out = (report: unknown) => writeAll(1, `${JSON.stringify(report)}\n`);
  const say = (line: string) => writeAll(json ? 2 : 1, `${line}\n`);
  try {
    const { token, url } = signedIn();
    const projects = await listProjects(url, token, workspace).catch(failed);
    if (sub === "list") {
      if (json) out({ projects });
      if (!projects.length) say(workspace ? `No projects in ${workspace}.` : "No projects yet.");
      else for (const line of table(projects)) say(line);
      return EXIT.ok;
    }
    const project = pick(projects, target!, workspace);
    if (!project.owner) throw ownerOnly(project);
    if (!values.yes) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Stop("confirm_needed", `Not deleted: flow projects delete asks you to type the project's name, and there is no terminal here. To delete ${project.name} without asking, pass --yes.`, undefined, EXIT.usage);
      }
      if (!(await confirmByName(project, process.stdin, process.stderr))) throw new Stop("not_confirmed", `Not deleted: ${project.name} was not typed.`, undefined, EXIT.usage);
    }
    const deleted = await deleteProject(url, token, project.id).catch(failed);
    if (json) out({ project: deleted });
    say(`Deleted ${deleted.name} (${deleted.id}) in ${project.workspace.name}. Its keys stopped working; the Flow team can bring it back until ${when(deleted.restore_until)}.`);
    return EXIT.ok;
  } catch (error) {
    const stop = asStop(error);
    writeAll(2, `${stop.next ? `${stop.message} Next: ${stop.next}` : stop.message}\n`);
    if (json) out({ error: { code: stop.code, message: stop.message, next: stop.next ?? null, ...(stop instanceof Ambiguous ? { matches: stop.matches } : {}) } });
    return stop.exit;
  }
}

/** The server's refusals in this command's words; anything else as the account commands say it. */
function failed(error: unknown): never {
  if (!(error instanceof LoginRefused)) throw error;
  if (error.status === 401) throw new Stop("signed_out", "Your sign-in to flow.engineer has ended or was revoked.", LOGIN_NEXT, EXIT.refused);
  if (error.code === "owner_only") throw new Stop("owner_only", "Only the organization's owner can delete this project.", undefined, EXIT.refused);
  if (error.code === "not_found") throw new Stop("not_found", "No such project: it may have been deleted already.", `${RUN} projects list`, EXIT.usage);
  if (error.status === 502) throw new Stop(error.code, "flow.engineer could not reach its projects just now. Try again in a minute.", undefined, EXIT.network);
  throw error;
}

const ownerOnly = (p: Project) => new Stop("owner_only", `Only the organization's owner (${p.workspace.name}) can delete ${p.name}.`, undefined, EXIT.refused);

/** The project an id or an exact name names; refuses a name two share, giving both ids. */
function pick(projects: Project[], target: string, workspace: string | undefined): Project {
  const byId = projects.find((p) => p.id === target);
  if (byId) return byId;
  const named = projects.filter((p) => p.name === target);
  if (named.length === 1) return named[0]!;
  if (!named.length) throw new Stop("not_found", `No project named or with the id ${target}${workspace ? ` in ${workspace}` : ""} (names are matched exactly).`, `${RUN} projects list`, EXIT.usage);
  throw new Ambiguous(target, named);
}

/** A name two or more projects share; --json gives each one's id and workspace as `matches`. */
class Ambiguous extends Stop {
  readonly matches: Array<{ id: string; workspace: Project["workspace"] }>;
  constructor(name: string, named: Project[]) {
    const ids = named.map((p) => `  ${p.id} (in ${p.workspace.name})`).join("\n");
    super("ambiguous_name", `${named.length} projects are named ${name}; pass the one you mean by its id:\n${ids}`, undefined, EXIT.usage);
    this.matches = named.map((p) => ({ id: p.id, workspace: p.workspace }));
  }
}

/** Asks for the project's name to be typed; true only when it is, exactly (Ctrl-C or Ctrl-D: false). */
export async function confirmByName(project: Project, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<boolean> {
  const rl = createInterface({ input, output });
  const stop = new AbortController();
  // Ctrl-C, or the input ending before a line (Ctrl-D): no answer, so no deletion.
  rl.on("SIGINT", () => stop.abort());
  rl.on("close", () => stop.abort());
  try {
    const typed = await rl.question(`Delete ${project.name} in ${project.workspace.name}? Its keys stop working at once; the Flow team can bring it back for 30 days. Type the name to confirm: `, { signal: stop.signal });
    return typed.trim() === project.name;
  } catch {
    output.write("\n");
    return false;
  } finally {
    rl.close();
  }
}

/** The list as aligned columns, a header first. */
function table(projects: Project[]): string[] {
  const rows = [["NAME", "WORKSPACE", "ID", "CREATED", "CAN DELETE"], ...projects.map((p) => [p.name, p.workspace.name, p.id, p.created_at.slice(0, 10), p.owner ? "yes" : "no (owner only)"])];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  "));
}

/** An RFC 3339 time as "2026-11-28 14:03 UTC", or as it came when it does not parse. */
function when(time: string): string {
  const at = new Date(time);
  return Number.isNaN(at.getTime()) ? time : `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
