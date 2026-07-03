import type { ClaimId } from "./schema.js";

export type ClaimKind =
  | "fact"
  | "requirement"
  | "decision"
  | "task"
  | "question"
  | "risk";

export type ClaimTruth = "code_verified" | "source_verified" | "unknown";

export type ClaimIntent = "intended" | "accidental" | "unknown";

export interface ClaimCodeAnchor {
  file: string;
  symbol?: string;
  /**
   * SHA-256 hex digest of the anchored symbol's source text at the time the
   * claim was recorded (set automatically on proposal apply; absent for
   * file-only anchors or anchors that couldn't be resolved). Used by
   * `graph audit anchors` to detect when the underlying code has changed
   * since the claim was written, even though the symbol itself still exists.
   */
  content_hash?: string;
}

export interface Claim {
  id: ClaimId;
  kind: ClaimKind;
  text: string;
  truth: ClaimTruth;
  intent: ClaimIntent;
  code_anchors?: ClaimCodeAnchor[];
}
