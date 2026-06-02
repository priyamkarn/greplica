import type { Claim } from "../claim.js";
import type { Component, Flow, Source } from "../schema.js";

export interface EmbeddingStatus {
  checked_objects: number;
  created: number;
  reused: number;
}

export interface GraphContextSource {
  id: string;
  edge_kind: string;
  weight: number;
  score: number;
}

export interface ContextSignals {
  semantic_score: number;
  semantic_rank: number | null;
  bm25_score: number;
  bm25_rank: number | null;
  exact_score: number;
  exact_rank: number | null;
  graph_score: number;
  graph_sources: GraphContextSource[];
}

export interface ClaimEvidenceResult {
  source: Source;
  reason: string;
}

export interface ClaimContextResult {
  rank: number;
  score: number;
  signals: ContextSignals;
  object: Claim;
  about: Array<{ type: "component" | "flow"; id: string }>;
  evidence: ClaimEvidenceResult[];
}

export interface GraphObjectContextResult<TObject> {
  rank: number;
  score: number;
  direct_score: number;
  claim_support_score: number;
  signals: ContextSignals;
  object: TObject;
  matched_claim_ids: string[];
}

export type ComponentContextResult = GraphObjectContextResult<Component>;

export type FlowContextResult = GraphObjectContextResult<Flow>;

export interface GraphContextResult {
  query: string;
  search_config_version: string;
  embedding_status: EmbeddingStatus;
  claims: ClaimContextResult[];
  components: ComponentContextResult[];
  flows: FlowContextResult[];
  sources: Source[];
}
