#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createLocalKnowledgeGraphService } from "../../libs/knowledge-graph/service.js";
import type { KnowledgeGraphService, RepoRef } from "../../libs/knowledge-graph/service.js";
import { envVarSource, loadRepoEnv, type LoadedRepoEnv } from "../../libs/env/load-local-env.js";
import {
  ensureGreplicaConfig,
  greplicaConfigPath,
  updateEmbeddingConfig,
  type EmbeddingConfig,
  type EmbeddingProvider,
  type GreplicaConfig,
} from "../../libs/config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "../../libs/knowledge-graph/graph-context/config.js";
import { createEmbedder } from "../../libs/knowledge-graph/graph-context/embedder.js";
import { renderGraphContextMarkdown } from "../../libs/knowledge-graph/graph-context/render.js";
import { buildGraphFolderExport } from "../../libs/knowledge-graph/folder-export.js";
import { installGreplica, platformDisplayName } from "../../libs/install/install.js";
import type { InstallEmbedding, InstallPlatform } from "../../libs/install/paths.js";
import { detectRepoContext } from "./repo-context.js";

interface CommandContext {
  repo: RepoRef;
  env: LoadedRepoEnv;
  config: GreplicaConfig;
  service: KnowledgeGraphService;
}

async function main(argv: string[]): Promise<void> {
  const [area, action, ...rest] = argv;

  if (area === "install") {
    const options = parseInstallArgs([action, ...rest].filter((arg): arg is string => arg !== undefined));
    const result = await installGreplica({
      ...options,
      repo: detectRepoContext(),
    });
    printInstallResult(result);
    return;
  }

  if (area === "init") {
    const initArgs = [action, ...rest].filter((arg): arg is string => arg !== undefined);
    const provider = parseOptionalEmbeddingSelection(initArgs);
    let configuredEmbedding: EmbeddingConfig | undefined;
    if (provider !== undefined) {
      const config = updateEmbeddingConfig({ provider });
      configuredEmbedding = config.embedding;
      console.log(`Config: ${displayConfigPath()}`);
      printEmbeddingConfig(config.embedding);
    }

    const { repo, service } = createCommandContext();
    const result = service.initRepo(repo);
    console.log(result.created ? "Initialized Greplica memory." : "Greplica memory already initialized.");
    console.log(`Repo: ${repo.repo_name}`);
    console.log(`Repo root: ${repo.repo_root ?? ""}`);
    console.log(`Remote: ${repo.remote_url ?? "none"}`);
    console.log(`Default branch: ${repo.default_branch}`);
    console.log(`Database: ${result.database_path}`);
    console.log(`Main scope: ${result.main_scope_id}`);
    console.log(`Working scope: ${result.working_scope_id}`);
    if (configuredEmbedding !== undefined) {
      if (!(await checkEmbeddings(configuredEmbedding))) process.exitCode = 1;
    }
    return;
  }

  if (area === "config") {
    runConfigCommand([action, ...rest].filter((arg): arg is string => arg !== undefined));
    return;
  }

  if (area === "doctor") {
    await runDoctor([action, ...rest].filter((arg): arg is string => arg !== undefined));
    return;
  }

  if (area === "graph" && action === "read") {
    const { repo, service } = createCommandContext();
    const graph = service.readGraph(repo);
    console.log("Current graph view: main + working");
    printSection("Components", graph.components, (item) => `${named(item)} ${anchor(item)}`.trim());
    printSection("Flows", graph.flows, named);
    printSection("Claims", graph.claims, (item) => `${field(item, "kind")}: ${field(item, "text")}`);
    printSection("Sources", graph.sources, (item) => `${field(item, "kind")}: ${field(item, "title") || field(item, "ref")}`);
    printSection("Edges", graph.edges, (item) => `${field(item, "from_type")}:${field(item, "from_id")} -[${field(item, "kind")}]-> ${field(item, "to_type")}:${field(item, "to_id")}`);
    return;
  }

  if (area === "graph" && action === "context") {
    const output = parseGraphContextOutput(rest);
    const query = rest.filter((arg) => arg !== "--debug").join(" ").trim();
    if (query.length === 0) throw new Error(`Usage: greplica graph ${action} <query>`);
    const { repo, service } = createCommandContext();
    const result = await service.contextGraph(repo, query);
    if (output === "debug") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderGraphContextMarkdown(result));
    }
    return;
  }

  if (area === "graph" && action === "export") {
    const outputDir = requireFile(rest[0], "Usage: greplica graph export <dir>");
    const { repo, service } = createCommandContext();
    const files = buildGraphFolderExport(service.readGraph(repo));
    writeGraphFolderExport(outputDir, files);
    console.log(`Exported current graph view to ${outputDir}`);
    console.log(`Files: ${files.length}`);
    return;
  }

  if (area === "proposal" && action === "validate") {
    const file = requireFile(rest[0], "Usage: greplica proposal validate <file>");
    const { repo, service } = createCommandContext();
    const proposal = readProposal(file);
    const result = service.validateProposal(repo, proposal);
    if (result.valid) {
      console.log("Proposal is valid.");
      return;
    }
    console.log("Proposal is invalid:");
    for (const error of result.errors) console.log(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  if (area === "proposal" && action === "apply") {
    const file = requireFile(rest[0], "Usage: greplica proposal apply <file>");
    const { repo, service } = createCommandContext();
    const proposal = readProposal(file);
    const result = await service.applyProposal(repo, proposal);
    console.log("Applied proposal to working memory.");
    console.log(`Memory commit: ${result.memory_commit_id}`);
    console.log(`Scope: ${result.scope_id}`);
    console.log(`Components: ${result.created.components}`);
    console.log(`Flows: ${result.created.flows}`);
    console.log(`Claims: ${result.created.claims}`);
    console.log(`Sources: ${result.created.sources}`);
    console.log(`Edges: ${result.created.edges}`);
    console.log(`Embeddings checked: ${result.embedding_status.checked_objects}`);
    console.log(`Embeddings created: ${result.embedding_status.created}`);
    console.log(`Embeddings reused: ${result.embedding_status.reused}`);
    return;
  }

  printHelp();
  process.exitCode = area === undefined ? 0 : 1;
}

function createCommandContext(): CommandContext {
  const repo = detectRepoContext();
  const env = loadRepoEnv(repo.repo_root ?? process.cwd());
  const config = ensureGreplicaConfig();
  const service = createLocalKnowledgeGraphService(graphContextConfigFromGreplicaConfig(config));
  return { repo, env, config, service };
}

async function runDoctor(args: string[]): Promise<void> {
  let context: CommandContext;
  try {
    context = createCommandContext();
  } catch (error: unknown) {
    console.log("Repo: not detected");
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let ready = true;
  console.log("Greplica doctor");
  console.log(`Repo: ${context.repo.repo_name}`);
  console.log(`Repo root: ${context.repo.repo_root ?? ""}`);
  console.log(`Remote: ${context.repo.remote_url ?? "none"}`);
  console.log(`Default branch: ${context.repo.default_branch}`);

  try {
    const result = context.service.initRepo(context.repo);
    console.log(`Database: ${result.database_path}`);
    console.log(`Memory state: ${result.created ? "initialized" : "ready"}`);
    console.log(`Main scope: ${result.main_scope_id}`);
    console.log(`Working scope: ${result.working_scope_id}`);
  } catch (error: unknown) {
    ready = false;
    console.log("Memory state: failed");
    console.log(error instanceof Error ? error.message : String(error));
  }

  console.log(`Config: ${displayConfigPath()}`);
  printEmbeddingConfig(context.config.embedding);

  if (context.config.embedding.provider === "openai") {
    const source = envVarSource("OPENAI_API_KEY", context.env);
    if (source === undefined) {
      ready = false;
      console.log("OPENAI_API_KEY: missing");
      console.log("Set OPENAI_API_KEY in the shell, target-root .env.local, or target-root .env.");
    } else if (source.kind === "environment") {
      console.log("OPENAI_API_KEY: found in environment");
    } else {
      console.log(`OPENAI_API_KEY: found in ${source.path}`);
    }
  }

  if (args.includes("--check-embeddings") || args.includes("--check-openai")) {
    ready = (await checkEmbeddings(context.config.embedding)) && ready;
  }

  process.exitCode = ready ? 0 : 1;
}

async function checkEmbeddings(config: EmbeddingConfig): Promise<boolean> {
  try {
    console.log(`Checking ${config.provider} embeddings...`);
    const embedder = createEmbedder(config);
    await embedder.embed("greplica embeddings check");
    console.log(`${config.provider} embeddings: ok`);
    return true;
  } catch (error: unknown) {
    console.log(`${config.provider} embeddings: failed`);
    console.log(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function runConfigCommand(args: string[]): void {
  if (args.length > 0) throw new Error("Usage: greplica config");

  const config = ensureGreplicaConfig();
  console.log("Greplica config");
  console.log(`Path: ${displayConfigPath()}`);
  console.log("");
  console.log("Edit this JSON to change Greplica defaults:");
  console.log(JSON.stringify(config, null, 2));
  console.log("");
  console.log("Allowed embedding.provider values:");
  console.log("- local");
  console.log("- openai");
  console.log("");
  console.log("Common embedding examples:");
  console.log("- local MPNet base: provider=local, model=all-mpnet-base-v2, dimensions=768, batchSize=16");
  console.log("- local MiniLM: provider=local, model=all-MiniLM-L6-v2, dimensions=384, batchSize=32");
  console.log("- OpenAI small: provider=openai, model=text-embedding-3-small, dimensions=1536, batchSize=100");
}

function parseOptionalEmbeddingSelection(args: string[]): EmbeddingProvider | undefined {
  const local = args.includes("--local");
  const openai = args.includes("--openai");
  if (local && openai) throw new Error("Use either --local or --openai, not both.");
  if (!local && !openai) {
    if (args.length === 0) return undefined;
    throw new Error("Usage: greplica init [--local|--openai]");
  }
  if (args.length !== 1) throw new Error("Usage: greplica init [--local|--openai]");
  return local ? "local" : "openai";
}

function parseInstallArgs(args: string[]): { platform: InstallPlatform; embedding: InstallEmbedding } {
  let platform: InstallPlatform | undefined;
  let embedding: InstallEmbedding | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") {
      if (platform !== undefined) throw new Error(`Specify --platform only once.\n${installUsage()}`);
      platform = parseInstallPlatform(requireFlagValue(args, index, "--platform"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      if (platform !== undefined) throw new Error(`Specify --platform only once.\n${installUsage()}`);
      platform = parseInstallPlatform(arg.slice("--platform=".length));
      continue;
    }
    if (arg === "--embedding") {
      if (embedding !== undefined) throw new Error(`Specify --embedding only once.\n${installUsage()}`);
      embedding = parseInstallEmbedding(requireFlagValue(args, index, "--embedding"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--embedding=")) {
      if (embedding !== undefined) throw new Error(`Specify --embedding only once.\n${installUsage()}`);
      embedding = parseInstallEmbedding(arg.slice("--embedding=".length));
      continue;
    }
    throw new Error(installUsage());
  }

  if (platform === undefined || embedding === undefined) throw new Error(installUsage());
  return { platform, embedding };
}

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.\n${installUsage()}`);
  return value;
}

function parseInstallPlatform(value: string): InstallPlatform {
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new Error(`Invalid --platform ${value}.\n${installUsage()}`);
}

function parseInstallEmbedding(value: string): InstallEmbedding {
  if (value === "local" || value === "openai") return value;
  throw new Error(`Invalid --embedding ${value}.\n${installUsage()}`);
}

function printInstallResult(result: Awaited<ReturnType<typeof installGreplica>>): void {
  console.log(`Installed Greplica for ${platformDisplayName(result.platform)}.`);
  console.log("");
  console.log("Skills:");
  for (const skill of result.skills) console.log(`- ${skill}`);
  console.log("");
  console.log("Embedding:");
  console.log(`- ${result.embedding}`);
  console.log(`- config: ${result.configFile}`);
  console.log(`- database: ${result.databasePath}`);
  console.log("");
  console.log("How to use Greplica:");
  console.log("- If this repo has not been initialized yet, ask your coding agent to run greplica-bootstrap for this repo. You only need to do this once per repo.");
  console.log("- After that, your coding agent can use greplica graph context \"<question>\" inside tasks to fetch relevant repo context, including prior working memory, before broad manual exploration.");
  console.log("- Near the end of a useful session, ask your coding agent to run greplica-update-working-memory so decisions, changed flows, constraints, and follow-up work are stored.");
  if (result.embedding === "local") {
    console.log(`- OpenAI embeddings are also available if you want better retrieval quality later: greplica install --platform ${result.platform} --embedding openai`);
  } else {
    console.log(`- Local embeddings are also available if you want to switch back later: greplica install --platform ${result.platform} --embedding local`);
  }
  for (const note of result.notes) console.log(`- ${note}`);
  console.log(`- IMPORTANT: add the Greplica guidance block to ${platformGuidanceFile(result.platform)} yourself if you want the agent to keep using Greplica automatically.`);
}

function platformGuidanceFile(platform: InstallPlatform): string {
  return platform === "claude" ? "CLAUDE.md" : "AGENTS.md";
}

function installUsage(): string {
  const cli = basename(process.argv[1] ?? "greplica");
  return `Usage: ${cli} install --platform codex|claude|opencode --embedding local|openai`;
}

function printEmbeddingConfig(config: EmbeddingConfig): void {
  console.log(`Embedding provider: ${config.provider}`);
  console.log(`Embedding model: ${config.model}`);
  console.log(`Embedding dimensions: ${config.dimensions}`);
  console.log(`Embedding batch size: ${config.batchSize}`);
}

function displayConfigPath(): string {
  return resolve(greplicaConfigPath());
}

function readProposal(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function requireFile(file: string | undefined, usage: string): string {
  if (file === undefined || file.trim().length === 0) throw new Error(usage);
  return file;
}

function parseGraphContextOutput(args: string[]): "markdown" | "debug" {
  if (args.includes("--json")) throw new Error("greplica graph context --json was removed; use Markdown output or --debug.");
  const debug = args.includes("--debug");
  if (debug) return "debug";
  return "markdown";
}

function writeGraphFolderExport(outputDir: string, files: Array<{ path: string; content: string }>): void {
  mkdirSync(outputDir, { recursive: true });
  for (const file of files) {
    const outputPath = join(outputDir, file.path);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, file.content, "utf8");
  }
}

function printSection<T extends { id: string }>(title: string, items: T[], format: (item: T) => string): void {
  console.log(`${title}: ${items.length}`);
  for (const item of items) {
    console.log(`- ${field(item, "id")} ${format(item)}`.trim());
  }
}

function named(item: { id: string; name?: string }): string {
  return item.name ?? item.id;
}

function anchor(item: object): string {
  const record = item as Record<string, unknown>;
  return typeof record.code_anchor === "string" ? `(${record.code_anchor})` : "";
}

function field(item: object, key: string): string {
  const value = (item as Record<string, unknown>)[key];
  return value === undefined || value === null ? "" : String(value);
}

function printHelp(): void {
  const cli = basename(process.argv[1] ?? "greplica");
  console.log(`Usage:
  ${cli} install --platform codex|claude|opencode --embedding local|openai
  ${cli} init [--local|--openai]
  ${cli} config
  ${cli} doctor [--check-embeddings]
  ${cli} graph read
  ${cli} graph context <query> [--debug]
  ${cli} graph export <dir>
  ${cli} proposal validate <file>
  ${cli} proposal apply <file>`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
