import type { Claim } from "../claim.js";
import { CodeAnchorResolver } from "./resolver.js";
import type { ClaimAnchorAuditIssue, ClaimAnchorAuditResult } from "./types.js";

export async function auditClaimCodeAnchors(
  repoRoot: string | undefined,
  claims: Claim[],
  resolver = new CodeAnchorResolver(),
): Promise<ClaimAnchorAuditResult> {
  const result: ClaimAnchorAuditResult = {
    missing_anchors: [],
    missing_files: [],
    missing_symbols: [],
    ambiguous_symbols: [],
    unsupported_languages: [],
    stale_content: [],
  };

  for (const claim of claims) {
    if (claim.code_anchors === undefined || claim.code_anchors.length === 0) {
      if (claim.truth !== "code_verified") continue;
      result.missing_anchors.push({ claim_id: claim.id, status: "missing_anchors" });
      continue;
    }

    const resolvedAnchors = await resolver.resolveMany(repoRoot, claim.code_anchors);
    for (const [index, anchor] of resolvedAnchors.entries()) {
      switch (anchor.status) {
        case "missing_file":
          result.missing_files.push({ claim_id: claim.id, anchor, status: "missing_file" });
          break;
        case "missing_symbol":
          result.missing_symbols.push({ claim_id: claim.id, anchor, status: "missing_symbol" });
          break;
        case "ambiguous_symbol":
          result.ambiguous_symbols.push({ claim_id: claim.id, anchor, status: "ambiguous_symbol" });
          break;
        case "unsupported_language":
          result.unsupported_languages.push({ claim_id: claim.id, anchor, status: "unsupported_language" });
          break;
        case "resolved": {
          // The symbol still resolves unambiguously, but compare its current
          // content hash against the one recorded when the claim was
          // written: same symbol name, possibly different implementation.
          const recordedHash = claim.code_anchors[index]?.content_hash;
          if (recordedHash !== undefined && anchor.content_hash !== undefined && anchor.content_hash !== recordedHash) {
            result.stale_content.push({ claim_id: claim.id, anchor, status: "stale_content" });
          }
          break;
        }
        case "file_only":
          break;
      }
    }
  }

  return result;
}
