// Security regression: the opencode agent runner must never pass the sensitive
// prompt (which embeds the full session transcript) as a literal command-line
// argument, since process arguments are visible to other local users via
// `ps`/`/proc/<pid>/cmdline` for as long as the process runs. It must instead
// write the prompt to a file inside the caller's private run directory and
// pass only a short, non-sensitive file reference on the command line.
//
// This verifies the argv actually built by injecting a fake spawn implementation
// instead of launching a real subprocess. That's deliberate: a real fake-binary
// stand-in hits unrelated, OS-specific subprocess quirks (e.g. Windows cannot
// spawn .cmd/.bat files via CreateProcess without going through cmd.exe, which
// has nothing to do with the property under test), so this checks the exact
// argument list handed to spawn() directly and platform-independently.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { runOpenCodeProcess } = await import(new URL("dist/libs/agent-runner/opencode.js", root));

const secretMarker = "SECRET_TRANSCRIPT_MARKER_do_not_leak_via_argv_12345";

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
    prompt: `Some task instructions.\n\nHere is sensitive session context: ${secretMarker}\n`,
    transcriptPath: join(runDir, "agent-events.jsonl"),
    finalMessagePath: join(runDir, "final-message.md"),
  };

  const capturedCalls = [];
  const transcript = new PassThrough();
  transcript.resume();

  await runOpenCodeProcess(input, transcript, fakeSpawn(capturedCalls));

  assert.equal(capturedCalls.length, 1, `expected exactly one spawn() call, got ${capturedCalls.length}`);
  const { command, args } = capturedCalls[0];
  assert.equal(command, "opencode");

  const argvJoined = args.join(" ");
  assert.ok(
    !argvJoined.includes(secretMarker),
    `sensitive prompt content must not appear in argv, got: ${argvJoined}`,
  );

  const promptFlagIndex = args.indexOf("-p");
  assert.ok(promptFlagIndex !== -1, `expected -p flag in argv, got: ${argvJoined}`);
  const wrapperPrompt = args[promptFlagIndex + 1];
  assert.ok(
    wrapperPrompt.includes("opencode-task-prompt.md"),
    `expected the -p value to reference the prompt file, got: ${wrapperPrompt}`,
  );

  // The real prompt (including the sensitive marker) must actually have been
  // written to the file the wrapper prompt points at.
  const promptFilePath = join(runDir, "opencode-task-prompt.md");
  const writtenPrompt = readFileSync(promptFilePath, "utf8");
  assert.ok(writtenPrompt.includes(secretMarker), "expected the full prompt to be written to the task-prompt file");

  console.log("OpenCode prompt-file (argv exposure) regression check passed.");
} finally {
  rmSync(runDir, { recursive: true, force: true });
}