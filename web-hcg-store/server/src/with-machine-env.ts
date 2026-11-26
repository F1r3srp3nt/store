/**
 * Operator helper for `fly ssh console` sessions: runs a server CLI as the server's own user (node) with the Machine's
 * configuration (fly.toml [env] and secrets, read from the server process's environment), passing it through the
 * process environment, never on a command line, so nothing secret appears in a log or process list.
 *
 *   node server-dist/with-machine-env.mjs server-dist/release-import.mjs --dir … --request …
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const env: NodeJS.ProcessEnv = { ...process.env };
try {
  for (const kv of readFileSync("/proc/1/environ", "utf8").split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0 && env[kv.slice(0, i)] === undefined) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
} catch {
  /* not on the Machine (or not root): use this process's environment */
}
const args = process.argv.slice(2);
const asNode = process.getuid?.() === 0;
const r = spawnSync(asNode ? "runuser" : process.execPath, asNode ? ["-u", "node", "-p", "--", process.execPath, "--no-warnings", ...args] : ["--no-warnings", ...args], { env, stdio: "inherit" });
process.exit(r.status ?? 1);
