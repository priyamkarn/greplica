import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);
const { auditClaimRelevance } = await import(new URL("dist/libs/knowledge-graph/relevance-audit.js", root));

const now = new Date("2026-07-14T00:00:00.000Z");
const oldCreatedAt = "2026-05-01T00:00:00.000Z"; // > 30 days before `now`
const recentCreatedAt = "2026-07-10T00:00:00.000Z"; // < 30 days before `now`

const claims = [
  { id: "claim.old_bare", kind: "fact", text: "Old, never retrieved, no anchor, no evidence.", truth: "unknown", intent: "unknown" },
  {
    id: "claim.old_anchored",
    kind: "fact",
    text: "Old, never retrieved, but has a code anchor.",
    truth: "code_verified",
    intent: "intended",
    code_anchors: [{ file: "libs/example.ts", symbol: "example" }],
  },
  { id: "claim.old_evidenced", kind: "decision", text: "Old, never retrieved, but has evidence.", truth: "source_verified", intent: "intended" },
  { id: "claim.recent_bare", kind: "fact", text: "Recent and never retrieved, but too young to flag.", truth: "unknown", intent: "unknown" },
  { id: "claim.old_retrieved", kind: "fact", text: "Old but has been retrieved.", truth: "unknown", intent: "unknown" },
];

const edges = [
  { id: "edge.1", from_id: "claim.old_evidenced", from_type: "claim", to_id: "source.1", to_type: "source", kind: "evidenced_by" },
];

const stats = new Map([
  ["claim.old_bare", { retrieval_count: 0, last_retrieved_at: null, created_at: oldCreatedAt }],
  ["claim.old_anchored", { retrieval_count: 0, last_retrieved_at: null, created_at: oldCreatedAt }],
  ["claim.old_evidenced", { retrieval_count: 0, last_retrieved_at: null, created_at: oldCreatedAt }],
  ["claim.recent_bare", { retrieval_count: 0, last_retrieved_at: null, created_at: recentCreatedAt }],
  ["claim.old_retrieved", { retrieval_count: 3, last_retrieved_at: "2026-07-12T00:00:00.000Z", created_at: oldCreatedAt }],
]);

const result = auditClaimRelevance(claims, edges, stats, { now });

assert.deepEqual(
  result.unsubstantiated_never_retrieved.map((issue) => issue.claim_id),
  ["claim.old_bare"],
  `expected only claim.old_bare to be unsubstantiated, got: ${JSON.stringify(result.unsubstantiated_never_retrieved)}`,
);

const substantiatedIds = result.substantiated_never_retrieved.map((issue) => issue.claim_id).sort();
assert.deepEqual(
  substantiatedIds,
  ["claim.old_anchored", "claim.old_evidenced"],
  `expected the anchored and evidenced claims to be substantiated-but-unretrieved, got: ${JSON.stringify(substantiatedIds)}`,
);

const flaggedIds = new Set([
  ...result.unsubstantiated_never_retrieved.map((issue) => issue.claim_id),
  ...result.substantiated_never_retrieved.map((issue) => issue.claim_id),
]);
assert.ok(!flaggedIds.has("claim.recent_bare"), "a claim younger than min-age-days must not be flagged");
assert.ok(!flaggedIds.has("claim.old_retrieved"), "a claim that has been retrieved must not be flagged");

// A claim with no known creation time (pre-migration data) still gets
// evaluated rather than silently skipped forever.
const unknownAgeResult = auditClaimRelevance(
  [{ id: "claim.unknown_age", kind: "fact", text: "No provenance row.", truth: "unknown", intent: "unknown" }],
  [],
  new Map([["claim.unknown_age", { retrieval_count: 0, last_retrieved_at: null, created_at: null }]]),
  { now },
);
assert.equal(unknownAgeResult.unsubstantiated_never_retrieved.length, 1, "claims with unknown age must still be audited, not skipped");
assert.equal(unknownAgeResult.unsubstantiated_never_retrieved[0].age_days, null);

console.log("check-relevance-audit: ok");
