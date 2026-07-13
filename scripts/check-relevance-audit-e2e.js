import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));
const { KnowledgeGraphService } = await import(new URL("dist/libs/knowledge-graph/service.js", root));

const tmp = mkdtempSync(join(tmpdir(), "greplica-relevance-audit-e2e-"));
const db = openDatabase(join(tmp, "relevance.db"));
const repository = new SqliteRepository(db);
const service = new KnowledgeGraphService(repository, undefined, {
  ensureForGraph: async () => ({ created: 0, reused: 0, provider: "local", model: "test", dimensions: 0 }),
});

const repo = { repo_root: join(tmp, "repo"), repo_name: "relevance-e2e", default_branch: "main" };
const initialized = service.initRepo(repo);

const applyResult = await service.applyProposal(repo, {
  title: "Seed two unresolved-but-unsubstantiated claims",
  creates: {
    claims: [
      { id: "claim.retrieved", kind: "task", text: "Follow up on retrieval tracking.", truth: "unknown", intent: "unknown" },
      { id: "claim.not_retrieved", kind: "task", text: "Follow up, never retrieved.", truth: "unknown", intent: "unknown" },
    ],
  },
});
assert.ok(applyResult.memory_commit_id, "proposal must apply cleanly");

// Backdate both claims' provenance so they clear the default 30-day min age.
db.prepare(
  `UPDATE memory_commits SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`,
).run(applyResult.memory_commit_id);

// Directly exercise the repository-level retrieval recording (this is what
// contextGraph() calls internally after a graph-context query returns claims).
repository.recordClaimRetrievals(initialized.repo_id, ["claim.retrieved"]);

const before = repository.readClaimRelevanceStats(initialized.repo_id, ["claim.retrieved", "claim.not_retrieved"]);
assert.equal(before.get("claim.retrieved").retrieval_count, 1, "retrieval_count must increment");
assert.ok(before.get("claim.retrieved").last_retrieved_at !== null, "last_retrieved_at must be set");
assert.equal(before.get("claim.not_retrieved").retrieval_count, 0, "unrelated claim must be untouched");

// Calling it again must increment further, not overwrite.
repository.recordClaimRetrievals(initialized.repo_id, ["claim.retrieved"]);
const after = repository.readClaimRelevanceStats(initialized.repo_id, ["claim.retrieved"]);
assert.equal(after.get("claim.retrieved").retrieval_count, 2, "retrieval_count must accumulate across calls");

const audit = service.auditRelevance(repo);
const flaggedIds = new Set([
  ...audit.unsubstantiated_never_retrieved.map((issue) => issue.claim_id),
  ...audit.substantiated_never_retrieved.map((issue) => issue.claim_id),
]);
assert.ok(!flaggedIds.has("claim.retrieved"), "a retrieved claim must not be flagged by the audit");
assert.ok(flaggedIds.has("claim.not_retrieved"), "an old, never-retrieved, unsubstantiated task claim must be flagged");

console.log("check-relevance-audit-e2e: ok");
