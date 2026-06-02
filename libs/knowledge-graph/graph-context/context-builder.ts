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
import { OpenAIEmbedder } from "./openai-embedder.js";
import { float32ArrayToBuffer, bufferToFloat32Array, cosineSimilarity } from "./vector.js";
import { scoreBm25 } from "./bm25.js";
import { scoreExact } from "./exact.js";
import { rankContextDocuments, roundScore, selectRankedDocuments, type RankedContextDocument, type SemanticScoreEntry } from "./rank.js";
import type { ClaimContextResult, ClaimEvidenceResult, ComponentContextResult, EmbeddingStatus, FlowContextResult, GraphContextResult, GraphContextSource } from "./types.js";

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
    const embedder = new OpenAIEmbedder(config.embedding);
    const embeddingStatus = await this.ensureEmbeddings(repoId, documents, embedder, config);
    if (options.warnOnCreatedEmbeddings && embeddingStatus.created > 0) {
      console.warn(`graph context created ${embeddingStatus.created} missing embedding(s); proposal apply should normally pre-create them.`);
    }

    const queryEmbedding = await embedder.embed(query);
    const ranked = applyGraphBoost(
      {
        claims: this.rankDocuments(repoId, query, queryEmbedding, claimDocuments, config),
        components: this.rankDocuments(repoId, query, queryEmbedding, componentDocuments, config),
        flows: this.rankDocuments(repoId, query, queryEmbedding, flowDocuments, config),
      },
      graph,
      config,
    );
    const selectedClaims = selectRankedDocuments(
      ranked.claims,
      config,
      { minimumSelected: config.ranking.minimumSelectedClaims },
    ).map((document, index) => toClaimResult(document, index, evidenceByClaim));

    return {
      query,
      search_config_version: config.version,
      embedding_status: embeddingStatus,
      claims: selectedClaims,
      components: selectGraphObjects(
        ranked.components,
        selectedClaims,
        "component",
        config,
      ),
      flows: selectGraphObjects(
        ranked.flows,
        selectedClaims,
        "flow",
        config,
      ),
      sources: selectedEvidenceSources(selectedClaims),
    };
  }

  async ensureForGraph(repoId: string, graph: GraphReadResult, config: GraphContextConfig = graphContextConfig): Promise<EmbeddingStatus> {
    const documents = [
      ...buildClaimDocuments(graph),
      ...buildComponentDocuments(graph),
      ...buildFlowDocuments(graph),
    ];
    const embedder = new OpenAIEmbedder(config.embedding);
    return this.ensureEmbeddings(repoId, documents, embedder, config);
  }

  private async ensureEmbeddings(
    repoId: string,
    documents: ContextDocument[],
    embedder: OpenAIEmbedder,
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
    const exact = scoreExact(query, documents);
    return rankContextDocuments(documents, semantic, bm25, exact, config);
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
    const score = Math.max(directScore, support.score);
    if (Math.max(document.score, support.score) < config.ranking.selectionThreshold) continue;
    if (type === "component") {
      results.push({
        rank: 0,
        score: roundScore(score),
        direct_score: roundScore(directScore),
        claim_support_score: roundScore(support.score),
        signals: roundSignals(document),
        object: document.document.object as Component,
        matched_claim_ids: support.claimIds,
      });
    } else {
      results.push({
        rank: 0,
        score: roundScore(score),
        direct_score: roundScore(directScore),
        claim_support_score: roundScore(support.score),
        signals: roundSignals(document),
        object: document.document.object as Flow,
        matched_claim_ids: support.claimIds,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.matched_claim_ids.length - a.matched_claim_ids.length || a.object.id.localeCompare(b.object.id))
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

interface RankedContextGroups {
  claims: RankedContextDocument[];
  components: RankedContextDocument[];
  flows: RankedContextDocument[];
}

interface GraphBoostEdge {
  id: string;
  edge_kind: string;
  weight: number;
}

function applyGraphBoost(
  groups: RankedContextGroups,
  graph: GraphReadResult,
  config: GraphContextConfig,
): RankedContextGroups {
  const rankedByKey = new Map(
    [...groups.claims, ...groups.components, ...groups.flows].map((document) => [document.document.key, document]),
  );
  const adjacency = buildGraphBoostAdjacency(graph, config);

  return {
    claims: boostRankedDocuments(groups.claims, rankedByKey, adjacency, config),
    components: boostRankedDocuments(groups.components, rankedByKey, adjacency, config),
    flows: boostRankedDocuments(groups.flows, rankedByKey, adjacency, config),
  };
}

function boostRankedDocuments(
  ranked: RankedContextDocument[],
  rankedByKey: Map<string, RankedContextDocument>,
  adjacency: Map<string, GraphBoostEdge[]>,
  config: GraphContextConfig,
): RankedContextDocument[] {
  return ranked
    .map((document) => {
      const sources = (adjacency.get(document.document.key) ?? [])
        .flatMap((edge): GraphContextSource[] => {
          const neighbor = rankedByKey.get(edge.id);
          if (!neighbor) return [];
          return [{
            id: edge.id,
            edge_kind: edge.edge_kind,
            weight: edge.weight,
            score: neighbor.score * edge.weight,
          }];
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, config.ranking.graphBoost.maxSources);
      const graphScore = sources[0]?.score ?? 0;

      return {
        ...document,
        score: Math.max(document.score, graphScore),
        signals: {
          ...document.signals,
          graph_score: graphScore,
          graph_sources: sources,
        },
      };
    })
    .sort((a, b) => b.score - a.score || a.document.key.localeCompare(b.document.key));
}

function buildGraphBoostAdjacency(graph: GraphReadResult, config: GraphContextConfig): Map<string, GraphBoostEdge[]> {
  const adjacency = new Map<string, GraphBoostEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "about" && edge.from_type === "claim" && (edge.to_type === "component" || edge.to_type === "flow")) {
      addBoostEdge(adjacency, contextDocumentKey("claim", edge.from_id), contextDocumentKey(edge.to_type, edge.to_id), "about", config.ranking.graphBoost.aboutClaimToObject);
      addBoostEdge(adjacency, contextDocumentKey(edge.to_type, edge.to_id), contextDocumentKey("claim", edge.from_id), "about", config.ranking.graphBoost.aboutObjectToClaim);
    }

    if (edge.kind === "touches" && edge.from_type === "flow" && edge.to_type === "component") {
      addBoostEdge(adjacency, contextDocumentKey("flow", edge.from_id), contextDocumentKey("component", edge.to_id), "touches", config.ranking.graphBoost.touchesFlowToComponent);
      addBoostEdge(adjacency, contextDocumentKey("component", edge.to_id), contextDocumentKey("flow", edge.from_id), "touches", config.ranking.graphBoost.touchesComponentToFlow);
    }

    if (edge.kind === "contains" && edge.from_type === edge.to_type && (edge.from_type === "component" || edge.from_type === "flow")) {
      const type = edge.from_type;
      addBoostEdge(adjacency, contextDocumentKey(type, edge.from_id), contextDocumentKey(type, edge.to_id), "contains", config.ranking.graphBoost.containsParentToChild);
      addBoostEdge(adjacency, contextDocumentKey(type, edge.to_id), contextDocumentKey(type, edge.from_id), "contains", config.ranking.graphBoost.containsChildToParent);
    }
  }
  return adjacency;
}

function addBoostEdge(
  adjacency: Map<string, GraphBoostEdge[]>,
  from: string,
  to: string,
  edgeKind: string,
  weight: number,
): void {
  if (weight <= 0) return;
  const existing = adjacency.get(from) ?? [];
  existing.push({ id: to, edge_kind: edgeKind, weight });
  adjacency.set(from, existing);
}

function claimSupport(
  claims: ClaimContextResult[],
  type: "component" | "flow",
  id: string,
  config: GraphContextConfig,
): { score: number; claimIds: string[] } {
  const matched = claims.filter((claim) => claim.about.some((target) => target.type === type && target.id === id));
  const maxScore = Math.max(0, ...matched.map((claim) => claim.score));
  return {
    score: Math.min(1, maxScore * config.ranking.claimSupport.weight + matched.length * config.ranking.claimSupport.countBoost),
    claimIds: matched.map((claim) => claim.object.id),
  };
}

function roundSignals(document: RankedContextDocument) {
  return {
    semantic_score: roundScore(document.signals.semantic_score),
    semantic_rank: document.signals.semantic_rank,
    bm25_score: roundScore(document.signals.bm25_score),
    bm25_rank: document.signals.bm25_rank,
    exact_score: roundScore(document.signals.exact_score),
    exact_rank: document.signals.exact_rank,
    graph_score: roundScore(document.signals.graph_score),
    graph_sources: document.signals.graph_sources.map((source) => ({
      ...source,
      score: roundScore(source.score),
    })),
  };
}
