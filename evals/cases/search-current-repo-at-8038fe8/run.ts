import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CommandResult,
  findRepoRoot,
  git,
  gitOptional,
  readJson,
  round,
  run,
  runOrThrow,
  timestamp,
  writeJson,
} from "../../lib/common.js";
import { loadRepoEnv } from "../../../libs/env/load-local-env.js";

const caseId = "search-current-repo-at-8038fe8";
const targetCommit = "8038fe8c82c3cf7c9175c188f503aa0df72d2fa2";
const allowedResultTypes = new Set(["component", "flow", "claim"]);

interface RunContext {
  repoRoot: string;
  runDir: string;
  targetRepoDir: string;
  targetRepoUrl: string;
  greplicaHomeDir: string;
  embeddingProvider: "local" | "openai" | undefined;
  embeddingModel: string | undefined;
  embeddingDimensions: number | undefined;
  embeddingBatchSize: number | undefined;
  proposalPath: string;
  rubricPath: string;
  greplicaCommand: string[];
}

interface SearchRubric {
  case_id: string;
  benchmark_version: string;
  k: number;
  score: {
    pass_threshold: number;
    weights: {
      packet_relevant_coverage: number;
      packet_noise_score: number;
      mrr_at_k: number;
      ndcg_at_k: number;
      grade_recall_at_k: number;
    };
    minimums: {
      packet_relevant_coverage: number;
      packet_noise_score: number;
      mrr_at_k: number;
      ndcg_at_k: number;
      grade_recall_at_k: number;
    };
  };
  queries: SearchQueryCase[];
}

interface SearchQueryCase {
  id: string;
  query: string;
  highly_relevant: string[];
  relevant: string[];
  weakly_relevant: string[];
}

interface QueryScore {
  id: string;
  query: string;
  returned_ids: string[];
  expected: {
    highly_relevant: string[];
    relevant: string[];
    weakly_relevant: string[];
  };
  command: CommandResult;
  packet_relevant_coverage: number;
  packet_noise_score: number;
  recall_at_k: number;
  mrr_at_k: number;
  ndcg_at_k: number;
  grade_recall_at_k: number;
  passed: boolean;
}

interface AggregateScore {
  packet_relevant_coverage: number;
  packet_noise_score: number;
  recall_at_k: number;
  mrr_at_k: number;
  ndcg_at_k: number;
  grade_recall_at_k: number;
  final_score: number;
  pass_threshold: number;
  passed: boolean;
}

interface EvalResult {
  case_id: string;
  benchmark_version: string;
  target_repo: {
    remote_url: string;
    commit: string;
    branch: string;
  };
  run_dir: string;
  target_repo_dir: string;
  greplica_home_dir: string;
  proposal_path: string;
  rubric_path: string;
  setup_commands: CommandResult[];
  query_scores: QueryScore[];
  score: AggregateScore;
  success: boolean;
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main(): void {
  const context = prepareRun();
  prepareTargetRepo(context);
  const rubric = readJson<SearchRubric>(context.rubricPath);
  validateRubric(rubric);

  const setupCommands = [
    runInitCommand(context),
    runProductCommand(context, "proposal", "validate", context.proposalPath),
    runProductCommand(context, "proposal", "apply", context.proposalPath),
  ];

  const queryScores = setupCommands.every((command) => command.exit_code === 0)
    ? rubric.queries.map((queryCase) => runQuery(context, rubric, queryCase))
    : [];
  const score = scoreRun(rubric, queryScores);
  const success = setupCommands.every((command) => command.exit_code === 0) && score.passed;

  writeResult(context, rubric, setupCommands, queryScores, score, success);

  console.log(success ? "Search eval passed." : "Search eval failed.");
  console.log(`Run directory: ${context.runDir}`);
  console.log(`Score: ${score.final_score.toFixed(2)} / 100`);
  console.log(
    `PacketCoverage: ${score.packet_relevant_coverage.toFixed(3)}  PacketNoiseScore: ${score.packet_noise_score.toFixed(3)}  R@${rubric.k}: ${score.recall_at_k.toFixed(3)}  MRR@${rubric.k}: ${score.mrr_at_k.toFixed(3)}  nDCG@${rubric.k}: ${score.ndcg_at_k.toFixed(3)}  GradeRecall@${rubric.k}: ${score.grade_recall_at_k.toFixed(3)}`,
  );
  process.exitCode = success ? 0 : 1;
}

function prepareRun(): RunContext {
  const repoRoot = findRepoRoot(import.meta.url);
  loadRepoEnv(repoRoot);
  const runDir = resolve(repoRoot, "eval-runs", timestamp(), caseId);
  const targetRepoDir = resolve(runDir, "target-repo");
  const targetRepoUrl = process.env.GREPLICA_EVAL_TARGET_REPO_URL ?? repoRoot;
  const greplicaHomeDir = resolve(runDir, "greplica-home");
  const embeddingProvider = parseEmbeddingProvider(process.env.GREPLICA_EVAL_EMBEDDING_PROVIDER);
  const embeddingModel = parseOptionalString(process.env.GREPLICA_EVAL_EMBEDDING_MODEL, "GREPLICA_EVAL_EMBEDDING_MODEL");
  const embeddingDimensions = parseOptionalPositiveInteger(process.env.GREPLICA_EVAL_EMBEDDING_DIMENSIONS, "GREPLICA_EVAL_EMBEDDING_DIMENSIONS");
  const embeddingBatchSize = parseOptionalPositiveInteger(process.env.GREPLICA_EVAL_EMBEDDING_BATCH_SIZE, "GREPLICA_EVAL_EMBEDDING_BATCH_SIZE");

  mkdirSync(runDir, { recursive: true });
  mkdirSync(greplicaHomeDir, { recursive: true });

  return {
    repoRoot,
    runDir,
    targetRepoDir,
    targetRepoUrl,
    greplicaHomeDir,
    embeddingProvider,
    embeddingModel,
    embeddingDimensions,
    embeddingBatchSize,
    proposalPath: resolve(repoRoot, "evals/cases/search-current-repo-at-8038fe8/proposal.json"),
    rubricPath: resolve(repoRoot, "evals/cases/search-current-repo-at-8038fe8/rubric.json"),
    greplicaCommand: ["node", resolve(repoRoot, "dist/apps/cli/main.js")],
  };
}

function parseEmbeddingProvider(value: string | undefined): "local" | "openai" | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (value === "local" || value === "openai") return value;
  throw new Error("GREPLICA_EVAL_EMBEDDING_PROVIDER must be local or openai.");
}

function parseOptionalString(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return trimmed;
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function prepareTargetRepo(context: RunContext): void {
  runOrThrow(["git", "clone", context.targetRepoUrl, context.targetRepoDir], context.repoRoot);
  runOrThrow(["git", "checkout", targetCommit], context.targetRepoDir);
}

function runQuery(context: RunContext, rubric: SearchRubric, queryCase: SearchQueryCase): QueryScore {
  const command = runProductCommand(context, "graph", "context", queryCase.query, "--debug");
  const returnedIds = command.exit_code === 0 ? parseReturnedIds(command.stdout ?? "") : [];
  const qrels = qrelsFor(queryCase);
  const metrics = scoreQuery(qrels, returnedIds, rubric.k);

  return {
    id: queryCase.id,
    query: queryCase.query,
    returned_ids: returnedIds,
    expected: {
      highly_relevant: queryCase.highly_relevant,
      relevant: queryCase.relevant,
      weakly_relevant: queryCase.weakly_relevant,
    },
    command,
    ...metrics,
    passed: command.exit_code === 0 && metrics.recall_at_k > 0 && metrics.mrr_at_k > 0,
  };
}

function scoreQuery(qrels: Map<string, number>, returnedIds: string[], k: number): Omit<QueryScore, "id" | "query" | "returned_ids" | "expected" | "command" | "passed"> {
  const topK = returnedIds.slice(0, k);
  const expectedIds = [...qrels.keys()];
  const seen = new Set<string>();
  const relevantInTopK: string[] = [];
  const packetSeen = new Set<string>();
  let relevantInPacket = 0;
  let irrelevantInPacket = 0;
  let retrievedGradeSum = 0;

  for (const id of returnedIds) {
    if (packetSeen.has(id)) continue;
    packetSeen.add(id);
    if ((qrels.get(id) ?? 0) > 0) {
      relevantInPacket += 1;
    } else {
      irrelevantInPacket += 1;
    }
  }

  for (const id of topK) {
    if (seen.has(id)) continue;
    seen.add(id);
    const grade = qrels.get(id) ?? 0;
    if (grade > 0) {
      relevantInTopK.push(id);
      retrievedGradeSum += grade;
    }
  }

  const firstRelevantIndex = topK.findIndex((id) => (qrels.get(id) ?? 0) > 0);
  const totalGrade = [...qrels.values()].reduce((sum, grade) => sum + grade, 0);

  return {
    packet_relevant_coverage: round(expectedIds.length === 0 ? 0 : relevantInPacket / expectedIds.length),
    packet_noise_score: round(packetSeen.size === 0 ? 0 : 1 - irrelevantInPacket / packetSeen.size),
    recall_at_k: round(relevantInTopK.length / expectedIds.length),
    mrr_at_k: round(firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1)),
    ndcg_at_k: round(dcg(topK.map((id) => qrels.get(id) ?? 0)) / idealDcg([...qrels.values()], k)),
    grade_recall_at_k: round(totalGrade === 0 ? 0 : retrievedGradeSum / totalGrade),
  };
}

function scoreRun(rubric: SearchRubric, queryScores: QueryScore[]): AggregateScore {
  const packetRelevantCoverage = average(queryScores.map((score) => score.packet_relevant_coverage));
  const packetNoiseScore = average(queryScores.map((score) => score.packet_noise_score));
  const recall = average(queryScores.map((score) => score.recall_at_k));
  const mrr = average(queryScores.map((score) => score.mrr_at_k));
  const ndcg = average(queryScores.map((score) => score.ndcg_at_k));
  const gradeRecall = average(queryScores.map((score) => score.grade_recall_at_k));
  const weights = rubric.score.weights;
  const finalScore = round(
    packetRelevantCoverage * weights.packet_relevant_coverage +
      packetNoiseScore * weights.packet_noise_score +
      mrr * weights.mrr_at_k +
      ndcg * weights.ndcg_at_k +
      gradeRecall * weights.grade_recall_at_k,
  );
  const minimums = rubric.score.minimums;
  const enoughQueriesRan = queryScores.length === rubric.queries.length;
  const passed =
    enoughQueriesRan &&
    finalScore >= rubric.score.pass_threshold &&
    packetRelevantCoverage >= minimums.packet_relevant_coverage &&
    packetNoiseScore >= minimums.packet_noise_score &&
    mrr >= minimums.mrr_at_k &&
    ndcg >= minimums.ndcg_at_k &&
    gradeRecall >= minimums.grade_recall_at_k;

  return {
    packet_relevant_coverage: packetRelevantCoverage,
    packet_noise_score: packetNoiseScore,
    recall_at_k: recall,
    mrr_at_k: mrr,
    ndcg_at_k: ndcg,
    grade_recall_at_k: gradeRecall,
    final_score: finalScore,
    pass_threshold: rubric.score.pass_threshold,
    passed,
  };
}

function qrelsFor(queryCase: SearchQueryCase): Map<string, number> {
  const qrels = new Map<string, number>();
  addQrels(qrels, queryCase.weakly_relevant, 1);
  addQrels(qrels, queryCase.relevant, 2);
  addQrels(qrels, queryCase.highly_relevant, 3);
  return qrels;
}

function addQrels(qrels: Map<string, number>, ids: string[], grade: number): void {
  for (const id of ids) qrels.set(id, Math.max(qrels.get(id) ?? 0, grade));
}

function parseReturnedIds(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Graph context JSON output must be an object.");
  }

  if (Array.isArray(parsed.ranked_results)) {
    return parseRankedResults(parsed.ranked_results);
  }

  return [
    ...parseTypedResults(parsed.claims, "claim"),
    ...parseTypedResults(parsed.components, "component"),
    ...parseTypedResults(parsed.flows, "flow"),
  ]
    .sort((a, b) => b.score - a.score || resultTypeOrder(a.type) - resultTypeOrder(b.type) || a.id.localeCompare(b.id))
    .map((result) => `${result.type}:${result.id}`);
}

function parseRankedResults(value: unknown[]): string[] {
  return value.map((result) => {
    if (!isRecord(result) || typeof result.type !== "string" || !allowedResultTypes.has(result.type) || !isRecord(result.object) || typeof result.object.id !== "string") {
      throw new Error("Each ranked result must include type and object.id.");
    }
    return `${result.type}:${result.object.id}`;
  });
}

function parseTypedResults(value: unknown, type: "claim" | "component" | "flow"): Array<{ type: "claim" | "component" | "flow"; id: string; score: number }> {
  if (!Array.isArray(value)) throw new Error(`Graph context JSON output must include a ${type}s array.`);
  return value.map((result) => {
    if (!isRecord(result) || !isRecord(result.object) || typeof result.object.id !== "string") {
      throw new Error(`Each ${type} result must include object.id.`);
    }
    return {
      type,
      id: result.object.id,
      score: typeof result.score === "number" ? result.score : 0,
    };
  });
}

function resultTypeOrder(type: "claim" | "component" | "flow"): number {
  switch (type) {
    case "component":
      return 0;
    case "flow":
      return 1;
    case "claim":
      return 2;
  }
}

function validateRubric(rubric: SearchRubric): void {
  if (rubric.queries.length !== 34) {
    throw new Error(`Expected exactly 34 search queries, found ${rubric.queries.length}.`);
  }
  for (const query of rubric.queries) {
    const ids = [...query.highly_relevant, ...query.relevant, ...query.weakly_relevant];
    if (ids.length === 0) throw new Error(`Query ${query.id} has no expected relevant IDs.`);
    for (const id of ids) {
      const [type] = id.split(":");
      if (!allowedResultTypes.has(type ?? "")) {
        throw new Error(`Query ${query.id} references unsupported result ID ${id}.`);
      }
    }
  }
}

function writeResult(
  context: RunContext,
  rubric: SearchRubric,
  setupCommands: CommandResult[],
  queryScores: QueryScore[],
  score: AggregateScore,
  success: boolean,
): void {
  const result: EvalResult = {
    case_id: rubric.case_id,
    benchmark_version: rubric.benchmark_version,
    target_repo: {
      remote_url: context.targetRepoUrl,
      commit: git(context.targetRepoDir, ["rev-parse", "HEAD"]),
      branch: gitOptional(context.targetRepoDir, ["branch", "--show-current"]) ?? "",
    },
    run_dir: context.runDir,
    target_repo_dir: context.targetRepoDir,
    greplica_home_dir: context.greplicaHomeDir,
    proposal_path: context.proposalPath,
    rubric_path: context.rubricPath,
    setup_commands: setupCommands,
    query_scores: queryScores,
    score,
    success,
  };

  writeJson(resolve(context.runDir, "result.json"), result);
}

function runProductCommand(context: RunContext, ...args: string[]): CommandResult {
  return run([...context.greplicaCommand, ...args], context.targetRepoDir, {
    ...process.env,
    GREPLICA_HOME: context.greplicaHomeDir,
  });
}

function runInitCommand(context: RunContext): CommandResult {
  const result = context.embeddingProvider === undefined
    ? runProductCommand(context, "init")
    : runProductCommand(context, "init", `--${context.embeddingProvider}`);
  if (result.exit_code === 0) writeEvalEmbeddingOverride(context);
  return result;
}

function writeEvalEmbeddingOverride(context: RunContext): void {
  if (
    context.embeddingModel === undefined &&
    context.embeddingDimensions === undefined &&
    context.embeddingBatchSize === undefined
  ) {
    return;
  }

  const configPath = resolve(context.greplicaHomeDir, "config.json");
  const config = readJson<Record<string, unknown>>(configPath);
  const embedding = isRecord(config.embedding) ? config.embedding : {};

  writeJson(configPath, {
    ...config,
    embedding: {
      ...embedding,
      ...(context.embeddingModel === undefined ? {} : { model: context.embeddingModel }),
      ...(context.embeddingDimensions === undefined ? {} : { dimensions: context.embeddingDimensions }),
      ...(context.embeddingBatchSize === undefined ? {} : { batchSize: context.embeddingBatchSize }),
    },
  });
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, grade, index) => sum + ((2 ** grade - 1) / Math.log2(index + 2)), 0);
}

function idealDcg(grades: number[], k: number): number {
  const ideal = dcg([...grades].sort((a, b) => b - a).slice(0, k));
  return ideal === 0 ? 1 : ideal;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
