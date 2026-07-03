import type { ClaimCodeAnchor } from "../claim.js";
import type { ClaimId } from "../schema.js";

export type ResolvedCodeAnchorStatus =
  | "resolved"
  | "file_only"
  | "missing_file"
  | "missing_symbol"
  | "ambiguous_symbol"
  | "unsupported_language";

export interface ResolvedCodeAnchor extends ClaimCodeAnchor {
  start_line?: number;
  end_line?: number;
  status: ResolvedCodeAnchorStatus;
}

export interface ClaimAnchorAuditIssue {
  claim_id: ClaimId;
  anchor?: ClaimCodeAnchor;
  status: "missing_anchors" | "missing_file" | "missing_symbol" | "ambiguous_symbol" | "unsupported_language" | "stale_content";
}

export interface ClaimAnchorAuditResult {
  missing_anchors: ClaimAnchorAuditIssue[];
  missing_files: ClaimAnchorAuditIssue[];
  missing_symbols: ClaimAnchorAuditIssue[];
  ambiguous_symbols: ClaimAnchorAuditIssue[];
  unsupported_languages: ClaimAnchorAuditIssue[];
  /**
   * Anchors that still resolve to an existing, unambiguous symbol, but whose
   * source text no longer matches the content_hash recorded when the claim
   * was written — i.e. the symbol wasn't renamed or deleted, its
   * implementation changed underneath the claim.
   */
  stale_content: ClaimAnchorAuditIssue[];
}
