const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:hch|sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /((?:api[_-]?key|secret|token|password)\s*[:=]\s*)([^\s,;]+)/gi,
];

export function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const suffix = "… [truncated]";
  if (maxChars <= suffix.length) return suffix.slice(0, maxChars);
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
}

export function redactSensitiveText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (result, pattern) =>
      result.replace(pattern, (_match, prefix?: string) =>
        prefix ? `${prefix}[REDACTED]` : "[REDACTED]",
      ),
    value,
  );
}

export function sanitizeText(
  value: string | null,
  maxChars: number,
): string | null {
  if (value === null) return null;
  return truncate(redactSensitiveText(value), maxChars);
}
