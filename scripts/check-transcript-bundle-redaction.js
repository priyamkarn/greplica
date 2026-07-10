import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const cliPath = fileURLToPath(new URL("dist/apps/cli/main.js", root));
const tmp = mkdtempSync(join(tmpdir(), "greplica-transcript-bundle-redaction-test-"));

const codexFile = join(tmp, "codex-secrets.jsonl");
const out = join(tmp, "codex-secrets-bundle.md");

writeFileSync(
  codexFile,
  [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "codex-secrets-session",
        timestamp: "2026-07-01T00:00:00.000Z",
        cwd: "/repo/example",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message:
          "Here is my .env for reference:\nAWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\nSTRIPE_SECRET_KEY=abcdefghijklmnopqrstuvwx\nNODE_ENV=production",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-01T00:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Debugged the request with curl -H 'Authorization: Bearer abc123DEF456ghi789JKL012mno'.",
      },
    }),
  ].join("\n"),
  "utf8",
);

const output = execFileSync(
  process.execPath,
  [cliPath, "transcript", "bundle", "--platform", "codex", "--file", codexFile, "--out", out],
  { encoding: "utf8" },
);
const bundle = readFileSync(out, "utf8");

// The bundle file on disk must not contain the raw secrets.
assert.doesNotMatch(bundle, /AKIAABCDEFGHIJKLMNOP/);
assert.doesNotMatch(bundle, /abcdefghijklmnopqrstuvwx/);
assert.doesNotMatch(bundle, /abc123DEF456ghi789JKL012mno/);

// Non-secret content and structure must be preserved.
assert.match(bundle, /NODE_ENV=production/);
assert.match(bundle, /Debugged the request with curl/);
assert.match(bundle, /\[REDACTED:aws-access-key-id\]/);
assert.match(bundle, /\[REDACTED:(env-assignment|stripe-key)\]/);
assert.match(bundle, /Bearer \[REDACTED:bearer-token\]/);

// The CLI must warn that it redacted something, so the user knows to still review the file.
assert.match(output, /Warning: redacted \d+ likely secret\(s\)/);
assert.match(output, /Review the bundle before sharing or committing it\./);

console.log("Transcript bundle redaction checks passed.");
