// An agent starts from its AGENTS.md and the one-line description of each skill; a skill's full
// file is read only when the agent asks for it, so every prompt stays small.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tool, type Tool } from "./tools.ts";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

/** Structured skill discovery on the MCP read_skill descriptor, without loading skill bodies. */
export const SKILLS_META = "flow.engineer/skills";

function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { fields, body: match[2] };
}

/** An agent's folder as text: AGENTS.md and skills/<name>/SKILL.md, by their paths in it. */
export type AgentFiles = Record<string, string>;

/**
 * With `prompt` (createAgent), throws, naming the path, when the folder or its AGENTS.md can't be
 * read: the agent would otherwise run with no prompt. Readers that want only the skills (an MCP
 * server, `flow plugin`, `flow check`) take a folder without AGENTS.md as before.
 */
export function readAgentFolder(dir: string, { prompt = false }: { prompt?: boolean } = {}): AgentFiles {
  const files: AgentFiles = {};
  const agents = join(dir, "AGENTS.md");
  if (prompt) {
    try {
      files["AGENTS.md"] = readFileSync(agents, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const where = existsSync(dir) ? `${dir} has no AGENTS.md` : `${dir} does not exist`;
      throw new Error(`flow: can't read the agent's prompt: ${code === "ENOENT" ? where : `${agents}: ${code ?? (error as Error).message}`}. Check createAgent's dir; on a host with no file system (a bundle, an edge runtime), pass files instead.`, { cause: error });
    }
  } else if (existsSync(agents)) files["AGENTS.md"] = readFileSync(agents, "utf8");
  const root = join(dir, "skills");
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name, "SKILL.md");
    if (entry.isDirectory() && existsSync(file)) files[`skills/${entry.name}/SKILL.md`] = readFileSync(file, "utf8");
  }
  return files;
}

export function loadSkills(files: AgentFiles): Skill[] {
  const skills: Skill[] = [];
  for (const [path, text] of Object.entries(files)) {
    const folder = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1];
    if (!folder) continue;
    const { fields, body } = frontmatter(text);
    skills.push({ name: fields.name || folder, description: fields.description || "", body: body.trim() });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadInstructions(files: AgentFiles, skills: Skill[], inline = false): string {
  const base = (files["AGENTS.md"] ?? "").trim();
  if (!skills.length) return base;
  if (inline) return `${base}\n\n${skills.map((s) => `## Skill: ${s.name}\n${s.body}`).join("\n\n")}`;
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `${base}\n\n## Skills\nLoad a skill with load_skill before doing what it covers; call it together with the first other tool you need, not on its own.\n${list}`;
}

/** What an MCP server tells a host about its skills when it connects (chinwag/mcp). */
export function mcpInstructions(skills: Skill[]): string | undefined {
  if (!skills.length) return undefined;
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `This server's skills are rules for one kind of request each. Read a skill with read_skill before doing what it covers.\n${list}`;
}

/** The MCP server's way to read a skill: a tool, since every host calls tools. */
export function readSkillTool(skills: Skill[]): Tool {
  const names = skills.map((s) => s.name);
  return tool({
    name: "read_skill",
    title: "Read a skill",
    description: "Read one of this server's skills in full. Read it before doing what its description covers.",
    input: z.object({ name: z.enum(names as [string, ...string[]]) }),
    signIn: "none",
    hints: { readOnly: true, openWorld: false },
    run({ name }) {
      return skills.find((s) => s.name === name)?.body ?? `No skill named ${name}.`;
    },
  });
}

export function skillTool(skills: Skill[], onLoad: (conversationId: string, name: string) => void): Tool {
  const names = skills.map((s) => s.name);
  return tool({
    name: "load_skill",
    signIn: "none",
    description: "Read a skill's full instructions. Use it before doing what the skill covers.",
    input: z.object({ name: z.enum(names as [string, ...string[]]) }),
    deadlineMs: 60_000,
    run({ name }, context) {
      const skill = skills.find((s) => s.name === name);
      if (!skill) return `No skill named ${name}.`;
      onLoad(context.conversationId, name);
      return skill.body;
    },
  });
}
