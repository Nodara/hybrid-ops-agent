/**
 * Independent guardrail: no autonomous action on legal/security keywords,
 * ever. Kept as a pure function (same spirit as
 * orchestrator/flows/risk-assessment.ts) so it can run in code BEFORE any
 * model call touches a ticket for a refund decision — it can't be reasoned
 * around because it never reaches the model in the first place.
 */
const LEGAL_SECURITY_KEYWORDS = [
  "lawsuit",
  "lawyer",
  "attorney",
  "legal action",
  "legal",
  "sue",
  "subpoena",
  "gdpr",
  "ccpa",
  "regulator",
  "regulatory",
  "class action",
  "data breach",
  "security breach",
  "hacked",
  "unauthorized access",
  "compromised",
  "law enforcement",
  "litigation",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary matching, not naive substring — e.g. "sue" must not match
// inside "issue" or "tissue".
const KEYWORD_PATTERNS = LEGAL_SECURITY_KEYWORDS.map(
  (kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i"),
);

/** Returns every matched keyword, [] if none. */
export function detectLegalOrSecurityKeywords(text: string): string[] {
  const normalized = text ?? "";
  return LEGAL_SECURITY_KEYWORDS.filter((_, i) => KEYWORD_PATTERNS[i].test(normalized));
}

export function containsLegalOrSecurityKeywords(text: string): boolean {
  return detectLegalOrSecurityKeywords(text).length > 0;
}
