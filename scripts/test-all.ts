// The full suite: `npm test` at the root, in simulators/ and in flow-messaging/, at once, and failed
// when it all takes more than two minutes. A suite past the limit is stopped and its output so far is
// printed. Each package's output is printed whole when it ends, so the three never interleave.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const LIMIT_MS = 120_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const suites = [".", "simulators", "flow-messaging"];
const began = Date.now();
const seconds = () => Math.round((Date.now() - began) / 1000);

const runs = suites.map((dir) => {
  // Its own process group, so a suite past the limit is stopped with every process it started.
  const child = spawn("npm", ["test", "--prefix", dir], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { dir, child, done, output: () => out };
});

let over = false;
const limit = setTimeout(() => {
  over = true;
  for (const run of runs) if (run.child.exitCode === null) try { process.kill(-run.child.pid!, "SIGKILL"); } catch { /* already gone */ }
}, LIMIT_MS);

const failed: string[] = [];
for (const run of runs) {
  const code = await run.done;
  process.stdout.write(`\n==== npm test in ${run.dir} (${code === 0 ? "passed" : over && code === null ? "stopped at the limit" : "failed"}, ${seconds()}s in)\n${run.output()}`);
  if (code !== 0) failed.push(run.dir);
}
clearTimeout(limit);

if (over) {
  console.error(`\ntest:all: FAILED: the suite ran past ${LIMIT_MS / 1000} seconds, its limit. Make the slow tests faster or cut them; never raise the limit.`);
  process.exit(1);
}
if (failed.length) {
  console.error(`\ntest:all: FAILED in ${failed.join(", ")} (${seconds()}s)`);
  process.exit(1);
}
console.log(`\ntest:all: passed in ${seconds()}s (limit ${LIMIT_MS / 1000}s)`);
