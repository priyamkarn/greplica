import type { Claim } from "./claim.js";
import type { ClaimId } from "./schema.js";
import type { Edge } from "./edge.js";
import type { ClaimRelevanceStats } from "../storage/sqlite/repository.js";

export interface RelevanceAuditOptions {
  // A claim is only flagged once it has existed for at least this long
  // without being retrieved, so brand-new memory isn't flagged just because
  // no agent has queried it yet. Defaults to 30 days.
  minAgeDays?: number;
  now?: Date;
}

export interface RelevanceAuditIssue {
  claim_id: ClaimId;
  text: string;
  created_at: string | null;
  age_days: number | null;
  // Whether the claim has any structural backing (a code anchor or an
  // evidenced_by edge). Claims with neither are the highest-confidence
  // candidates for pruning: nothing ties them to a verifiable source, and
  // no future agent has ever needed them.
  has_anchor: boolean;
  has_evidence: boolean;
}

export interface RelevanceAuditResult {
  // Never retrieved, old enough to judge, and unsubstantiated. Highest
  // confidence candidates for pruning.
  unsubstantiated_never_retrieved: RelevanceAuditIssue[];
  // Never retrieved but backed by an anchor or evidence. Still worth a
  // human glance, but lower priority: it may simply be narrow/rare memory.
  substantiated_never_retrieved: RelevanceAuditIssue[];
}

const defaultMinAgeDays = 30;
const millisecondsPerDay = 24 * 60 * 60 * 1000;

export function auditClaimRelevance(
  claims: Claim[],
  edges: Edge[],
  stats: Map<ClaimId, ClaimRelevanceStats>,
  options: RelevanceAuditOptions = {},
): RelevanceAuditResult {
  const minAgeDays = options.minAgeDays ?? defaultMinAgeDays;
  const now = options.now ?? new Date();

  const evidencedClaimIds = new Set(
    edges
      .filter((edge) => edge.kind === "evidenced_by" && edge.from_type === "claim")
      .map((edge) => edge.from_id),
  );

  const unsubstantiated: RelevanceAuditIssue[] = [];
  const substantiated: RelevanceAuditIssue[] = [];

  for (const claim of claims) {
    const claimStats = stats.get(claim.id);
    if (claimStats !== undefined && claimStats.retrieval_count > 0) continue;

    const ageDays = ageInDays(claimStats?.created_at ?? null, now);
    if (ageDays !== null && ageDays < minAgeDays) continue;

    const hasAnchor = Array.isArray(claim.code_anchors) && claim.code_anchors.length > 0;
    const hasEvidence = evidencedClaimIds.has(claim.id);

    const issue: RelevanceAuditIssue = {
      claim_id: claim.id,
      text: claim.text,
      created_at: claimStats?.created_at ?? null,
      age_days: ageDays,
      has_anchor: hasAnchor,
      has_evidence: hasEvidence,
    };

    if (hasAnchor || hasEvidence) {
      substantiated.push(issue);
    } else {
      unsubstantiated.push(issue);
    }
  }

  return {
    unsubstantiated_never_retrieved: unsubstantiated,
    substantiated_never_retrieved: substantiated,
  };
}

function ageInDays(createdAt: string | null, now: Date): number | null {
  if (createdAt === null) return null;
  const createdAtMs = Date.parse(createdAt);
  if (Number.isNaN(createdAtMs)) return null;
  return (now.getTime() - createdAtMs) / millisecondsPerDay;
}
