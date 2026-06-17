import type { Source } from "../schema.js";
import type {
  ClaimContextResult,
  GraphContextResult,
  RankedGraphContextResult,
} from "./types.js";

export function renderGraphContextMarkdown(result: GraphContextResult): string {
  const claimById = new Map(result.claims.map((claim) => [claim.object.id, claim]));
  const shownClaimIds = new Set<string>();
  const rankedComponents = result.ranked_results.filter((item) => item.type === "component");
  const rankedFlows = result.ranked_results.filter((item) => item.type === "flow");
  const rankedClaims = result.ranked_results.filter((item) => item.type === "claim");
  const content = [
    "# Graph Context",
    "",
    `Query: ${result.query}`,
    "",
    "## Components",
    "",
    ...renderRankedComponents(rankedComponents, claimById, shownClaimIds),
    "",
    "## Flows",
    "",
    ...renderRankedFlows(rankedFlows, claimById, shownClaimIds),
  ];
  const remainingClaims = rankedClaims.filter((claim) => !shownClaimIds.has(claim.object.id));
  if (remainingClaims.length > 0) {
    content.push("", "## Other Relevant Claims", "", ...renderRankedClaims(remainingClaims));
  }
  if (result.sources.length > 0) {
    content.push("", "## Sources", "", ...renderSources(result.sources));
  }

  return lines(...content);
}

function renderRankedComponents(
  components: Array<Extract<RankedGraphContextResult, { type: "component" }>>,
  claimById: Map<string, ClaimContextResult>,
  shownClaimIds: Set<string>,
): string[] {
  if (components.length === 0) return ["- None."];
  return components.flatMap((component) => {
    const relation = component.context_relation === "additional" ? " additional" : "";
    const anchor = component.object.code_anchor === undefined ? "" : `\n  Anchor: \`${component.object.code_anchor}\``;
    const claims = claimsForGraphObject(component.matched_claim_ids, "component", component.object.id, claimById);
    for (const claim of claims) shownClaimIds.add(claim.object.id);
    return [
      `### ${component.rank}. ${component.object.name}${relation}`,
      "",
      `ID: \`${component.object.id}\`${anchor}`,
      "",
      "Supporting claims:",
      ...renderClaimItems(claims),
      "",
    ];
  });
}

function renderRankedFlows(
  flows: Array<Extract<RankedGraphContextResult, { type: "flow" }>>,
  claimById: Map<string, ClaimContextResult>,
  shownClaimIds: Set<string>,
): string[] {
  if (flows.length === 0) return ["- None."];
  return flows.flatMap((flow) => {
    const relation = flow.context_relation === "additional" ? " additional" : "";
    const claims = claimsForGraphObject(flow.matched_claim_ids, "flow", flow.object.id, claimById);
    for (const claim of claims) shownClaimIds.add(claim.object.id);
    return [
      `### ${flow.rank}. ${flow.object.name}${relation}`,
      "",
      `ID: \`${flow.object.id}\``,
      "",
      "Supporting claims:",
      ...renderClaimItems(claims),
      "",
    ];
  });
}

function renderRankedClaims(claims: Array<Extract<RankedGraphContextResult, { type: "claim" }>>): string[] {
  if (claims.length === 0) return ["- None."];
  return renderClaimItems(claims);
}

function claimsForGraphObject(
  matchedClaimIds: string[],
  type: "component" | "flow",
  id: string,
  claimById: Map<string, ClaimContextResult>,
): ClaimContextResult[] {
  const claims = new Map<string, ClaimContextResult>();
  for (const claimId of matchedClaimIds) {
    const claim = claimById.get(claimId);
    if (claim !== undefined) claims.set(claim.object.id, claim);
  }
  for (const claim of claimById.values()) {
    if (claim.about.some((subject) => subject.type === type && subject.id === id)) {
      claims.set(claim.object.id, claim);
    }
  }
  return [...claims.values()].sort((left, right) => left.rank - right.rank || left.object.id.localeCompare(right.object.id));
}

function renderClaimItems(claims: ClaimContextResult[]): string[] {
  if (claims.length === 0) return ["- None."];
  return claims.map((claim) => {
    const evidence = claim.evidence.length === 0 ? "" : ` Source: ${claim.evidence.map(evidenceLabel).join("; ")}.`;
    return `- ${claim.object.text}${evidence}`;
  });
}

function evidenceLabel(evidence: ClaimContextResult["evidence"][number]): string {
  return evidence.source.title ?? evidence.source.ref ?? evidence.source.id;
}

function renderSources(sources: Source[]): string[] {
  return sources.map((source) => `- \`${source.id}\` ${source.title ?? source.ref}`);
}

function lines(...values: string[]): string {
  return `${values.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
