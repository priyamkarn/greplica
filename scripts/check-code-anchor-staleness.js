import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each greplica CLI invocation constructs its own CodeAnchorResolver, so a
// fresh resolver per "pass" here mirrors real usage. (The resolver caches
// parsed symbols per file path for its own lifetime as a performance
// optimization within a single command -- reusing one resolver instance
// across the file mutations below would read stale cached symbols, which is
// a test-harness concern, not something a real CLI invocation hits.)
const root = new URL("..", import.meta.url);
const { CodeAnchorResolver } = await import(new URL("dist/libs/knowledge-graph/code-anchors/resolver.js", root));
const { auditClaimCodeAnchors } = await import(new URL("dist/libs/knowledge-graph/code-anchors/audit.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-code-anchor-resolver-test-"));
mkdirSync(join(tmp, "src"), { recursive: true });
const targetFile = join(tmp, "src", "foo.js");

writeFileSync(
  targetFile,
  ["function computeTotal(items) {", "  return items.length;", "}", ""].join("\n"),
);

const anchor = { file: "src/foo.js", symbol: "computeTotal" };

const first = await new CodeAnchorResolver().resolve(tmp, anchor);
assert.equal(first.status, "resolved");
assert.equal(typeof first.content_hash, "string");
assert.ok(first.content_hash.length > 0);

const second = await new CodeAnchorResolver().resolve(tmp, anchor);
assert.equal(second.content_hash, first.content_hash, "hash must be deterministic for unchanged content");

// A brand-new claim with no recorded content_hash yet must not be reported
// stale (nothing to compare against).
const freshAudit = await auditClaimCodeAnchors(
  tmp,
  [{ id: "claim.fresh", kind: "fact", text: "t", truth: "code_verified", intent: "intended", code_anchors: [anchor] }],
  new CodeAnchorResolver(),
);
assert.equal(freshAudit.stale_content.length, 0, "a claim with no recorded hash must not be flagged stale");
assert.equal(freshAudit.missing_symbols.length, 0);

// A claim whose recorded hash matches current content must be healthy.
const healthyClaim = {
  id: "claim.healthy",
  kind: "fact",
  text: "computeTotal returns the number of items",
  truth: "code_verified",
  intent: "intended",
  code_anchors: [{ ...anchor, content_hash: first.content_hash }],
};
const healthyAudit = await auditClaimCodeAnchors(tmp, [healthyClaim], new CodeAnchorResolver());
assert.equal(healthyAudit.stale_content.length, 0, "matching content_hash must not be flagged stale");

// Change the implementation but keep the same symbol name and file: the
// symbol still resolves (so it's not missing_symbol), but the content
// hash now differs from what the claim recorded.
writeFileSync(
  targetFile,
  ["function computeTotal(items) {", "  return items.reduce((sum, item) => sum + item.price, 0);", "}", ""].join("\n"),
);

const staleAudit = await auditClaimCodeAnchors(tmp, [healthyClaim], new CodeAnchorResolver());
assert.equal(staleAudit.missing_symbols.length, 0, "symbol still exists, so it must not be reported missing");
assert.equal(staleAudit.stale_content.length, 1, "changed implementation must be reported stale");
assert.equal(staleAudit.stale_content[0].claim_id, "claim.healthy");

const driftedHash = await new CodeAnchorResolver().resolve(tmp, anchor);
assert.notEqual(driftedHash.content_hash, first.content_hash, "hash must change when implementation changes");

// Renaming/deleting the symbol should still surface as missing_symbol, not
// stale_content -- the two failure modes stay distinct.
writeFileSync(targetFile, ["function computeGrandTotal(items) {", "  return items.length;", "}", ""].join("\n"));
const missingAudit = await auditClaimCodeAnchors(tmp, [healthyClaim], new CodeAnchorResolver());
assert.equal(missingAudit.missing_symbols.length, 1);
assert.equal(missingAudit.stale_content.length, 0);

console.log("Code anchor resolver/staleness checks passed.");
