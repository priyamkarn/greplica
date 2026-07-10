import { redactSecrets, type RedactionMatch } from "./redact.js";

export type { RedactionMatch } from "./redact.js";

export interface SessionTranscriptProjection {
  metadata: Record<string, string>;
  messages: SessionTranscriptMessage[];
}

export interface SessionTranscriptMessage {
  timestamp: string | undefined;
  role: "human" | "agent";
  phase: string | undefined;
  message: string;
}

export function renderSessionTranscriptMarkdown(projection: SessionTranscriptProjection): string {
  const sections = ["# Filtered Session Transcript", ""];

  sections.push("## Metadata", "");
  for (const [key, value] of Object.entries(projection.metadata)) {
    sections.push(`- ${key}: ${value}`);
  }
  sections.push("", "## Messages", "");

  for (const message of projection.messages) {
    const details = [message.timestamp, message.phase].filter((item): item is string => item !== undefined);
    const suffix = details.length === 0 ? "" : ` (${details.join(", ")})`;
    sections.push(`### ${message.role}${suffix}`, "", message.message.trim(), "");
  }

  return `${sections.join("\n").trimEnd()}\n`;
}

export interface SanitizeTranscriptMessageResult {
  message: string;
  redactions: RedactionMatch[];
}

/**
 * Strips fake instruction tags (prompt-injection defense: historical transcript text
 * must never be obeyed as live instructions) and then redacts secret-shaped strings
 * (data-loss-prevention: the sanitized message is what gets written verbatim into a
 * bundle .md file on disk, so anything secret-shaped must not survive this step).
 */
export function sanitizeTranscriptMessage(message: string): string {
  return sanitizeTranscriptMessageWithReport(message).message;
}

export function sanitizeTranscriptMessageWithReport(message: string): SanitizeTranscriptMessageResult {
  const withoutInjectedInstructions = message
    .replace(/<system_instruction>[\s\S]*?<\/system_instruction>\s*/g, "")
    .replace(/<developer_instruction>[\s\S]*?<\/developer_instruction>\s*/g, "")
    .trim();

  const { text, matches } = redactSecrets(withoutInjectedInstructions);
  return { message: text, redactions: matches };
}

export function copyStringField(
  target: Record<string, string>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  const value = source[sourceKey];
  if (typeof value === "string" && value.trim().length > 0) {
    target[targetKey] = value;
  }
}

export function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
