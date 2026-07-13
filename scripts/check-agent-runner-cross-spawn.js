// Regression test for the cross-spawn fix (Windows .cmd/.bat shim compatibility).
//
// On Windows, npm-installed global CLI tools (like a real `codex`, `opencode`,
// or `openhands`) are shimmed as .cmd files, not native .exe. node:child_process's
// spawn() cannot launch .cmd/.bat files at all without shell:true -- Windows'
// CreateProcess can't execute non-PE files, and .cmd requires cmd.exe as an
// intermediary. cross-spawn detects this and handles it transparently.
//
// This checks three things:
// 1. Each agent runner's source imports spawn from 'cross-spawn', not
//    node:child_process -- catches a future accidental revert, since
//    cross-spawn's win32-specific resolution logic is a no-op on POSIX and so
//    can't be observed behaviorally in this (Linux) test environment.
// 2. The *built* dist output for each runner also references cross-spawn --
//    catches a build/bundler misconfiguration that could silently drop it.
// 3. The opencode runner's injectable spawn seam still produces correct argv
//    when exercised end-to-end with a fake spawn implementation.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);

const runnerFiles = ["codex.ts", "opencode.ts", "openhands.ts"];
for (const file of runnerFiles) {
  const source = readFileSync(new URL(`../libs/agent-runner/${file}`, import.meta.url), "utf8");
  assert.ok(
    /from\s+["']cross-spawn["']/.test(source),
    `expected libs/agent-runner/${file} to import spawn from 'cross-spawn', not node:child_process ` +
      `(node:child_process's spawn cannot launch .cmd/.bat shims on Windows without shell:true)`,
  );
  assert.ok(
    !/from\s+["']node:child_process["']/.test(source),
    `expected libs/agent-runner/${file} to no longer import spawn from node:child_process`,
  );

  const builtFile = file.replace(/\.ts$/, ".js");
  const builtSource = readFileSync(new URL(`dist/libs/agent-runner/${builtFile}`, root), "utf8");
  assert.ok(
    builtSource.includes("cross-spawn"),
    `expected the built dist/libs/agent-runner/${builtFile} to reference cross-spawn ` +
      `(source check passed but the compiled output didn't carry it over -- build misconfiguration?)`,
  );
}

// Functional check: exercise the actual injectable seam end-to-end.
const { runOpenCodeProcess } = await import(new URL("dist/libs/agent-runner/opencode.js", root));

function fakeSpawn(capturedCalls) {
  return (command, args, options) => {
    capturedCalls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end();
      child.emit("close", 0, null);
    });
    return child;
  };
}

const runDir = mkdtempSync(join(tmpdir(), "greplica-opencode-runner-test-"));
try {
  const input = {
    cwd: runDir,
    env: process.env,
    prompt: "Some task instructions.",
    transcriptPath: join(runDir, "agent-events.jsonl"),
    finalMessagePath: join(runDir, "final-message.md"),
  };

  const capturedCalls = [];
  const transcript = new PassThrough();
  transcript.resume();

  await runOpenCodeProcess(input, transcript, fakeSpawn(capturedCalls));

  assert.equal(capturedCalls.length, 1, `expected exactly one spawn() call, got ${capturedCalls.length}`);
  assert.equal(capturedCalls[0].command, "opencode");
  assert.deepEqual(capturedCalls[0].args, ["-p", "Some task instructions.", "-f", "json", "-q"]);
} finally {
  rmSync(runDir, { recursive: true, force: true });
}

console.log("cross-spawn wiring checks passed for:", runnerFiles.join(", "));
