// covers: testing/src/cli-install.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installScript } from "../testing/src/cli-install.ts";

// A sandbox: only these commands on PATH, a download that is a local file, and an npm that writes
// the command. Nothing reaches the network, a real npm, or the developer's PATH folders and rc files.
function fixture(download = "acme package") {
  const root = mkdtempSync(join(tmpdir(), "flow-install-"));
  const home = join(root, "home with spaces");
  const tools = join(root, "tools with spaces");
  mkdirSync(home);
  mkdirSync(tools);
  const executable = (name: string, source: string) => writeFileSync(join(tools, name), `#!/bin/sh\n${source}\n`, { mode: 0o755 });
  for (const name of ["mktemp", "rm", "mkdir", "grep", "dirname", "sed", "readlink", "chmod", "cat"]) {
    symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(), join(tools, name));
  }
  symlinkSync(process.execPath, join(tools, "node"));
  const realLn = execFileSync("/bin/sh", ["-c", "command -v ln"], { encoding: "utf8" }).trim();
  // FORCE_FALLBACK: no PATH folder takes the link, as when none is writable.
  executable("ln", `if [ "\${FORCE_FALLBACK:-}" = 1 ] && [ "$3" != "$HOME/.local/bin/acme" ]; then exit 1; fi\nexec '${realLn}' "$@"`);
  writeFileSync(join(root, "download"), download);
  executable("curl", `while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cat '${join(root, "download")}' > "$2"; fi; shift; done`);
  executable(
    "npm",
    `prefix=""
while [ "$#" -gt 0 ]; do if [ "$1" = --prefix ]; then prefix="$2"; fi; shift; done
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/acme"
printf '{"version":"1.2.0-production.abc1234"}' > "$prefix/lib/node_modules/acme/package.json"
printf '#!/bin/sh\\necho acme fixture\\n' > "$prefix/bin/acme"
chmod +x "$prefix/bin/acme"`,
  );
  const script = installScript({ name: "acme", displayName: "Acme", url: "https://cli.acme.test/cli/acme-1.2.0.tgz", sha256: createHash("sha256").update("acme package").digest("hex"), version: "1.2.0-production.abc1234", node: [22, 18] });
  const env: Record<string, string> = { HOME: home, PATH: tools, SHELL: "/bin/zsh", TMPDIR: root };
  return {
    root,
    home,
    tools,
    env,
    run: () => spawnSync("/bin/sh", [], { input: script, env, encoding: "utf8" }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("piped into sh, it installs into ~/.<name>, links into a writable PATH folder so the command works now, says the brand's name, and runs again", () => {
  const f = fixture();
  try {
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^Downloading the Acme CLI\.\.\./);
    assert.match(first.stdout, /Installed the Acme CLI 1\.2\.0-production\.abc1234 in .*\.acme\/bin/);
    assert.equal(readlinkSync(join(f.tools, "acme")), join(f.home, ".acme/bin/acme"));
    assert.equal(execFileSync("/bin/sh", ["-c", "acme"], { env: f.env, encoding: "utf8" }).trim(), "acme fixture");
    assert.equal(existsSync(join(f.home, ".zshrc")), false);
    assert.equal(f.run().status, 0, "running it again updates in place");
  } finally {
    f.cleanup();
  }
});

test("with no writable PATH folder it adds one marked rc line, once, quoted, for zsh, bash's login file, fish and a custom prefix", () => {
  const cases: Array<{ env: Record<string, string>; rc: (home: string, env: Record<string, string>) => string[] }> = [
    { env: { ZDOTDIR: "zsh config" }, rc: (_h, e) => [join(e.ZDOTDIR!, ".zshrc")] },
    { env: { SHELL: "/bin/bash" }, rc: (h) => [join(h, ".bashrc"), join(h, ".bash_profile")] },
    { env: { SHELL: "/usr/bin/fish", XDG_CONFIG_HOME: "config" }, rc: (_h, e) => [join(e.XDG_CONFIG_HOME!, "fish/conf.d/acme.fish")] },
    { env: { SHELL: "", ACME_HOME: "custom prefix" }, rc: (h) => [join(h, ".profile")] },
  ];
  for (const c of cases) {
    const f = fixture();
    try {
      const home = join(f.root, 'home $with `ticks` "quotes" \\slashes');
      mkdirSync(home);
      Object.assign(f.env, { HOME: home, FORCE_FALLBACK: "1" });
      for (const [k, v] of Object.entries(c.env)) f.env[k] = v && k !== "SHELL" ? join(home, v) : v;
      if (c.env.SHELL === "/bin/bash") writeFileSync(join(home, ".bash_profile"), "# existing settings\n");
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Open a new terminal, then run: acme/);
      assert.equal(f.run().status, 0);
      const prefix = f.env.ACME_HOME ?? join(home, ".acme");
      assert.equal(readlinkSync(join(home, ".local/bin/acme")), join(prefix, "bin/acme"));
      for (const rc of c.rc(home, f.env)) {
        assert.equal(readFileSync(rc, "utf8").split("# Acme CLI").length, 2, `${rc}: one marked line`);
        if (!rc.endsWith(".fish")) assert.equal(execFileSync("/bin/sh", ["-c", '. "$1"; acme', "sh", rc], { env: f.env, encoding: "utf8" }).trim(), "acme fixture");
      }
    } finally {
      f.cleanup();
    }
  }
});

test("it never replaces another installation: a different <name> on PATH, or anything at ~/.local/bin/<name>", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tools, "acme"), "#!/bin/sh\necho other-cli\n", { mode: 0o755 });
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Another acme is already on PATH at .*tools with spaces\/acme/);
    assert.match(readFileSync(join(f.tools, "acme"), "utf8"), /other-cli/);
    assert.equal(existsSync(join(f.home, ".acme")), false);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    g.env.FORCE_FALLBACK = "1";
    mkdirSync(join(g.home, ".local/bin/acme"), { recursive: true });
    const result = g.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /what is there was left untouched/);
  } finally {
    g.cleanup();
  }
});

test("a download that is not the published build is refused before anything is installed; <NAME>_CLI_URL takes another build unchecked", () => {
  const f = fixture("something else");
  try {
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not the published build \(its sha256 differs\)\. Nothing was installed\./);
    assert.equal(existsSync(join(f.home, ".acme")), false);
    f.env.ACME_CLI_URL = "https://staging.acme.test/acme.tgz";
    assert.equal(f.run().status, 0);
  } finally {
    f.cleanup();
  }
});
