#!/usr/bin/env bun
// Create, list, and remove isolated jj workspaces for parallel agents.
//
//   bun scripts/agent-workspace.mjs create <name> [--base <revset>]
//   bun scripts/agent-workspace.mjs list
//   bun scripts/agent-workspace.mjs remove <name>
//
// `create` makes a colocated workspace at ../<repo>-<name> (so git/gh work
// inside it), based on main@origin by default, and prints its absolute path.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const USAGE = `usage:
  agent-workspace.mjs create <name> [--base <revset>]
  agent-workspace.mjs list
  agent-workspace.mjs remove <name>`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function jj(args, { capture = true } = {}) {
  const r = spawnSync("jj", args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (r.error) fail(`failed to run jj: ${r.error.message}`);
  if (r.status !== 0) {
    if (capture) process.stderr.write(r.stderr || "");
    process.exit(r.status ?? 1);
  }
  return capture ? r.stdout.trim() : "";
}

function workspacePath(name) {
  const root = jj(["root"]);
  return resolve(dirname(root), `${basename(root)}-${name}`);
}

function resolves(rev) {
  const r = spawnSync(
    "jj",
    ["log", "-r", rev, "--no-graph", "-T", "", "--limit", "1"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return r.status === 0;
}

function defaultBase() {
  for (const rev of ["main@origin", "main", "trunk()", "@"]) {
    if (resolves(rev)) return rev;
  }
  return "@";
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "create") {
  const name = rest[0];
  if (!name) fail(USAGE);
  const baseIdx = rest.indexOf("--base");
  const base = baseIdx !== -1 ? rest[baseIdx + 1] : defaultBase();
  const path = workspacePath(name);
  if (existsSync(path)) fail(`path already exists: ${path}`);
  jj(
    [
      "workspace",
      "add",
      "--colocate",
      path,
      "--name",
      name,
      "--revision",
      base,
      "-m",
      `wip: ${name}`,
    ],
    { capture: false },
  );
  console.log(path);
} else if (cmd === "list") {
  jj(["workspace", "list"], { capture: false });
} else if (cmd === "remove") {
  const name = rest[0];
  if (!name) fail(USAGE);
  jj(["workspace", "remove", name], { capture: false });
} else {
  fail(USAGE);
}
