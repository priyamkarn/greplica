import type { Claim } from "../claim.js";
import type { GraphReadResult } from "../service.js";
import type { Component, Flow, Source } from "../schema.js";
import type { SqliteRepository } from "../../storage/sqlite/repository.js";
import { graphContextConfig, type GraphContextConfig } from "./config.js";
import {
  buildClaimDocuments,
  buildComponentDocuments,
  buildFlowDocuments,
  contextDocumentKey,
  type ContextDocument,
} from "./documents.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import { float32ArrayToBuffer, bufferToFloat32Array, cosineSimilarity } from "./vector.js";
import { scoreBm25 } from "./bm25.js";
import { applyGraphRanking } from "./graph-rank.js";
import { rankContextDocuments, roundScore, selectRankedDocuments, type RankedContextDocument, type SemanticScoreEntry } from "./rank.js";
import type { ClaimContextResult, ClaimEvidenceResult, ComponentContextResult, EmbeddingStatus, FlowContextResult, GraphContextResult, RankedContextDebugResult, RankedGraphContextResult } from "./types.js";

export interface BuildGraphContextOptions {
  warnOnCreatedEmbeddings?: boolean;
  config?: GraphContextConfig;
}

interface ExistingEmbedding {
  key: string;
  vector: Float32Array;
}

export class GraphContextBuilder {
  constructor(private readonly repository: SqliteRepository) {}

  async build(repoId: string, graph: GraphReadResult, query: string, options: BuildGraphContextOptions = {}): Promise<GraphContextResult> {
    const config = options.config ?? graphContextConfig;
    const claimDocuments = buildClaimDocuments(graph);
    const componentDocuments = buildComponentDocuments(graph);
    const flowDocuments = buildFlowDocuments(graph);
    const evidenceByClaim = buildEvidenceByClaim(graph);
    const documents = [...claimDocuments, ...componentDocuments, ...flowDocuments];
    const embedder = createEmbedder(config.embedding);
    const embeddingStatus = await this.ensureEmbeddings(repoId, documents, embedder, config);
    if (options.warnOnCreatedEmbeddings && embeddingStatus.created > 0) {
      console.warn(`graph context created ${embeddingStatus.created} missing embedding(s); proposal apply should normally pre-create them.`);
    }

    const queryEmbedding = await embedder.embed(query);
    const ranked = applyGraphRanking(
      {
        claims: this.rankDocuments(repoId, query, queryEmbedding, claimDocuments, config),
        components: this.rankDocuments(repoId, query, queryEmbedding, componentDocuments, config),
        flows: this.rankDocuments(repoId, query, queryEmbedding, flowDocuments, config),
      },
      graph,
      config,
    );
    const selectedClaims = selectClaims(
      ranked.claims,
      evidenceByClaim,
      config,
    );
    const selectedComponents = selectGraphObjects(
      ranked.components,
      selectedClaims,
      "component",
      config,
    ) as ComponentContextResult[];
    const selectedFlows = selectGraphObjects(
      ranked.flows,
      selectedClaims,
      "flow",
      config,
    ) as FlowContextResult[];
    const rankedResults = rankPacketResults(selectedClaims, selectedComponents, selectedFlows);

    return {
      query,
      search_config_version: config.version,
      embedding_status: embeddingStatus,
      claims: selectedClaims,
      components: selectedComponents,
      flows: selectedFlows,
      ranked_results: rankedResults,
      sources: selectedEvidenceSources(selectedClaims),
      debug: {
        ranked_results: rankedResults,
        ranked_claims: ranked.claims.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Claim>),
        ranked_components: ranked.components.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Component>),
        ranked_flows: ranked.flows.map((document, index) => toRankedDebugResult(document, index) as RankedContextDebugResult<Flow>),
      },
    };
  }

  async ensureForGraph(repoId: string, graph: GraphReadResult, config: GraphContextConfig = graphContextConfig): Promise<EmbeddingStatus> {
    const documents = [
      ...buildClaimDocuments(graph),
      ...buildComponentDocuments(graph),
      ...buildFlowDocuments(graph),
    ];
    const embedder = createEmbedder(config.embedding);
    return this.ensureEmbeddings(repoId, documents, embedder, config);
  }

  private async ensureEmbeddings(
    repoId: string,
    documents: ContextDocument[],
    embedder: Embedder,
    config: GraphContextConfig,
  ): Promise<EmbeddingStatus> {
    const existing = new Set(
      this.repository
        .listGraphObjectEmbeddings({
          repo_id: repoId,
          provider: config.embedding.provider,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
        })
        .map((record) => contextDocumentKey(record.object_type, record.object_id)),
    );
    const missing = documents.filter((document) => !existing.has(document.key));
    const vectors = await embedder.embedBatch(missing.map((document) => document.text));

    this.repository.insertGraphObjectEmbeddings(
      missing.map((document, index) => ({
        repo_id: repoId,
        object_type: document.type,
        object_id: document.id,
        provider: config.embedding.provider,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        embedding: float32ArrayToBuffer(vectors[index] ?? []),
      })),
    );

    return {
      checked_objects: documents.length,
      created: missing.length,
      reused: documents.length - missing.length,
    };
  }

  private rankDocuments(
    repoId: string,
    query: string,
    queryEmbedding: number[],
    documents: ContextDocument[],
    config: GraphContextConfig,
  ): RankedContextDocument[] {
    const semantic = this.scoreSemantic(repoId, documents, queryEmbedding, config);
    const bm25 = scoreBm25(query, documents, config);
    return rankContextDocuments(documents, semantic, bm25, config);
  }

  private scoreSemantic(
    repoId: string,
    documents: ContextDocument[],
    queryEmbedding: number[],
    config: GraphContextConfig,
  ): SemanticScoreEntry[] {
    const documentKeys = new Set(documents.map((document) => document.key));
    const embeddings = this.loadEmbeddings(repoId, config).filter((embedding) => documentKeys.has(embedding.key));
    const scored = embeddings
      .map((embedding) => ({
        id: embedding.key,
        score: cosineSimilarity(queryEmbedding, embedding.vector),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const maxScore = scored[0]?.score ?? 1;

    return scored.map((entry, index) => ({
      id: entry.id,
      score: maxScore === 0 ? 0 : entry.score / maxScore,
      raw_score: entry.score,
      rank: index + 1,
    }));
  }

  private loadEmbeddings(repoId: string, config: GraphContextConfig): ExistingEmbedding[] {
    return this.repository
      .listGraphObjectEmbeddings({
        repo_id: repoId,
        provider: config.embedding.provider,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
      })
      .map((record) => ({
        key: contextDocumentKey(record.object_type, record.object_id),
        vector: bufferToFloat32Array(record.embedding),
      }));
  }
}

function buildEvidenceByClaim(graph: GraphReadResult): Map<string, ClaimEvidenceResult[]> {
  const sources = new Map(graph.sources.map((source) => [source.id, source]));
  const evidenceByClaim = new Map<string, ClaimEvidenceResult[]>();

  for (const edge of graph.edges) {
    if (edge.kind !== "evidenced_by" || edge.from_type !== "claim" || edge.to_type !== "source") continue;
    const source = sources.get(edge.to_id);
    if (!source) continue;

    const existing = evidenceByClaim.get(edge.from_id) ?? [];
    existing.push({
      source,
      reason: evidenceReason(edge.metadata),
    });
    evidenceByClaim.set(edge.from_id, existing);
  }

  return evidenceByClaim;
}

function evidenceReason(metadata: Record<string, unknown> | undefined): string {
  return typeof metadata?.reason === "string" ? metadata.reason : "";
}

type ContextRelation = "primary" | "additional";

function selectClaims(
  ranked: RankedContextDocument[],
  evidenceByClaim: Map<string, ClaimEvidenceResult[]>,
  config: GraphContextConfig,
): ClaimContextResult[] {
  return selectRankedDocuments(ranked, config, { minimumSelected: config.ranking.minimumSelectedClaims })
    .sort((left, right) => right.score - left.score || left.document.key.localeCompare(right.document.key))
    .map((document, index) => toClaimResult(document, index, evidenceByClaim));
}

function toClaimResult(
  document: RankedContextDocument,
  index: number,
  evidenceByClaim: Map<string, ClaimEvidenceResult[]>,
): ClaimContextResult {
  return {
    rank: index + 1,
    score: roundScore(document.score),
    signals: roundSignals(document),
    object: document.document.object as Claim,
    about: document.document.about,
    evidence: evidenceByClaim.get(document.document.id) ?? [],
  };
}

function toRankedDebugResult(
  document: RankedContextDocument,
  index: number,
): RankedContextDebugResult<Claim | Component | Flow> {
  return {
    rank: index + 1,
    score: roundScore(document.score),
    signals: roundSignals(document),
    object: document.document.object,
    about: document.document.about,
  };
}

function relationSortValue(relation: ContextRelation): number {
  return relation === "primary" ? 0 : 1;
}

function packetTypeSortValue(type: RankedGraphContextResult["type"]): number {
  switch (type) {
    case "component":
      return 0;
    case "flow":
      return 1;
    case "claim":
      return 2;
  }
}

function rankPacketResults(
  claims: ClaimContextResult[],
  components: ComponentContextResult[],
  flows: FlowContextResult[],
): RankedGraphContextResult[] {
  const results: RankedGraphContextResult[] = [
    ...components.map((component) => ({ ...component, type: "component" as const })),
    ...flows.map((flow) => ({ ...flow, type: "flow" as const })),
    ...claims.map((claim) => ({ ...claim, type: "claim" as const })),
  ];

  return results
    .sort((a, b) =>
      b.score - a.score ||
      packetTypeSortValue(a.type) - packetTypeSortValue(b.type) ||
      a.object.id.localeCompare(b.object.id),
    )
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

function selectedEvidenceSources(claims: ClaimContextResult[]): Source[] {
  const sourcesById = new Map<string, Source>();
  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      sourcesById.set(evidence.source.id, evidence.source);
    }
  }
  return [...sourcesById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function selectGraphObjects(
  ranked: RankedContextDocument[],
  claims: ClaimContextResult[],
  type: "component" | "flow",
  config: GraphContextConfig,
): Array<ComponentContextResult | FlowContextResult> {
  const results: Array<ComponentContextResult | FlowContextResult> = [];
  for (const document of ranked) {
    const support = claimSupport(claims, type, document.document.id, config);
    const directScore = document.score * config.ranking.directObject.weight;
    const directRawScore = document.signals.weighted_raw_score * config.ranking.directObject.weight;
    const score = Math.max(directScore, support.score);
    const passesSelection =
      support.score >= config.ranking.selectionThreshold ||
      document.score >= config.ranking.selectionThreshold;
    if (!passesSelection) continue;
    const relation: ContextRelation = document.score >= config.ranking.selectionThreshold ? "primary" : "additional";
    if (type === "component") {
      results.push({
        rank: 0,
        score: roundScore(score),
        context_relation: relation,
        direct_score: roundScore(directScore),
        direct_raw_score: roundScore(directRawScore),
        claim_support_score: roundScore(support.score),
        claim_support_raw_score: roundScore(support.rawScore),
        signals: roundSignals(document),
        object: document.document.object as Component,
        matched_claim_ids: support.claimIds,
      });
    } else {
      results.push({
        rank: 0,
        score: roundScore(score),
        context_relation: relation,
        direct_score: roundScore(directScore),
        direct_raw_score: roundScore(directRawScore),
        claim_support_score: roundScore(support.score),
        claim_support_raw_score: roundScore(support.rawScore),
        signals: roundSignals(document),
        object: document.document.object as Flow,
        matched_claim_ids: support.claimIds,
      });
    }
  }

  return results
    .sort((a, b) =>
      relationSortValue(a.context_relation) - relationSortValue(b.context_relation) ||
      b.score - a.score ||
      b.matched_claim_ids.length - a.matched_claim_ids.length ||
      a.object.id.localeCompare(b.object.id),
    )
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

function claimSupport(
  claims: ClaimContextResult[],
  type: "component" | "flow",
  id: string,
  config: GraphContextConfig,
): { score: number; rawScore: number; claimIds: string[] } {
  const matched = claims.filter((claim) => claim.about.some((target) => target.type === type && target.id === id));
  const sorted = [...matched].sort((a, b) => b.score - a.score || a.object.id.localeCompare(b.object.id));
  const maxScore = Math.max(0, ...sorted.map((claim) => claim.score));
  const maxRawScore = Math.max(0, ...sorted.map((claim) => claim.signals.weighted_raw_score));
  return {
    score: Math.min(1, maxScore * config.ranking.claimSupport.weight + sorted.length * config.ranking.claimSupport.countBoost),
    rawScore: maxRawScore,
    claimIds: sorted.map((claim) => claim.object.id),
  };
}

function roundSignals(document: RankedContextDocument) {
  return {
    semantic_score: roundScore(document.signals.semantic_score),
    semantic_raw_score: roundScore(document.signals.semantic_raw_score),
    semantic_rank: document.signals.semantic_rank,
    bm25_score: roundScore(document.signals.bm25_score),
    bm25_raw_score: roundScore(document.signals.bm25_raw_score),
    bm25_rank: document.signals.bm25_rank,
    weighted_score: roundScore(document.signals.weighted_score),
    weighted_raw_score: roundScore(document.signals.weighted_raw_score),
    pre_coherence_score: roundScore(document.signals.pre_coherence_score),
    graph_score: roundScore(document.signals.graph_score),
    graph_raw_score: roundScore(document.signals.graph_raw_score),
    graph_sources: document.signals.graph_sources.map((source) => ({
      ...source,
      score: roundScore(source.score),
      raw_score: roundScore(source.raw_score),
    })),
    coherence_score: roundScore(document.signals.coherence_score),
    coherence_raw_score: roundScore(document.signals.coherence_raw_score),
    coherence_sources: document.signals.coherence_sources.map((source) => ({
      ...source,
      score: roundScore(source.score),
      raw_score: roundScore(source.raw_score),
    })),
  };
}
