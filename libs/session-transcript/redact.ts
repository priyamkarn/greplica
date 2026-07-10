/**
 * Best-effort redaction of secret-shaped strings from transcript text before it is
 * written into a durable bundle file. This is a defense-in-depth control, not a
 * guarantee: regex-based detection will miss bespoke or unusually-shaped credentials.
 * It exists to stop the common cases (cloud provider keys, tokens pasted while
 * debugging, .env dumps, private key blocks) from silently ending up in plaintext
 * on disk.
 */

export interface RedactionMatch {
  /** Human-readable label for the kind of secret detected, used in the placeholder and summary. */
  type: string;
  count: number;
}

export interface RedactSecretsResult {
  text: string;
  matches: RedactionMatch[];
}

interface RedactionRule {
  type: string;
  pattern: RegExp;
  /**
   * Builds the replacement string for a given match. Defaults to a fixed
   * "[REDACTED:<type>]" placeholder. Rules that need to preserve a prefix
   * (e.g. "KEY=" in a .env-style line) can return a custom replacement.
   */
  replace?: (match: RegExpMatchArray) => string;
}

function placeholder(type: string): string {
  return `[REDACTED:${type}]`;
}

const RULES: RedactionRule[] = [
  {
    type: "private-key-block",
    pattern: /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY-----/g,
  },
  {
    type: "aws-access-key-id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    type: "aws-secret-access-key",
    pattern: /\b(aws_secret_access_key\s*[:=]\s*)['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    replace: (match) => `${match[1]}${placeholder("aws-secret-access-key")}`,
  },
  {
    type: "github-token",
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    type: "github-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  },
  {
    type: "slack-token",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    type: "stripe-key",
    pattern: /\b(sk|rk)_(live|test)_[0-9A-Za-z]{16,}\b/g,
  },
  {
    type: "anthropic-api-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    type: "openai-api-key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    type: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },
  {
    type: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    type: "bearer-token",
    pattern: /\b(Bearer\s+)[A-Za-z0-9\-_.=]{12,}/g,
    replace: (match) => `${match[1]}${placeholder("bearer-token")}`,
  },
  {
    type: "basic-auth-url",
    pattern: /(:\/\/)([^\s:/@]+):([^\s:/@]+)@/g,
    replace: (match) => `${match[1]}${match[2]}:${placeholder("password")}@`,
  },
  {
    // .env-style assignments: KEY=value or KEY: value, where KEY looks secret-shaped.
    // The negative lookahead skips values an earlier, more specific rule already redacted.
    type: "env-assignment",
    pattern:
      /^([ \t]*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[:=]\s*)(['"]?)(?!\[REDACTED:)(\S+)\2/gim,
    replace: (match) => `${match[1]}${match[2]}${placeholder("env-assignment")}${match[2]}`,
  },
  {
    // Generic inline "key: value" / "key = value" secret assignments outside of .env files
    // (e.g. spoken in prose or JSON-ish debug output). Same guard against double-redaction.
    type: "inline-secret-assignment",
    pattern:
      /\b((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key)\s*[:=]\s*)(['"]?)(?!\[REDACTED:)([^\s'",}]{6,})\2/gi,
    replace: (match) => `${match[1]}${match[2]}${placeholder("inline-secret-assignment")}${match[2]}`,
  },
];

export function redactSecrets(text: string): RedactSecretsResult {
  let result = text;
  const matches: RedactionMatch[] = [];

  for (const rule of RULES) {
    let count = 0;
    result = result.replace(rule.pattern, (...args) => {
      count += 1;
      const match = args.slice(0, -2) as unknown as RegExpMatchArray;
      return rule.replace ? rule.replace(match) : placeholder(rule.type);
    });
    if (count > 0) matches.push({ type: rule.type, count });
  }

  return { text: result, matches };
}
