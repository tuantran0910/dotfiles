/**
 * Reads the pattern list straight out of the rule markdown, so the rules and
 * any runtime check share one source of truth. A pattern added to
 * `rules/pr-wording-review.md` is picked up here without a second edit.
 */

/**
 * Extracts `  - '<regex>'` entries from a rule file's YAML frontmatter.
 * The rule files avoid literal apostrophes (they use `\x27`), so a simple
 * single-quoted scan is unambiguous.
 */
export function extractConditions(markdown: string): string[] {
  const conditions: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(/^\s*-\s+'(.*)'\s*$/);
    if (match?.[1]) conditions.push(match[1].replaceAll("''", "'"));
  }
  return conditions;
}

/**
 * Compiles rule patterns into RegExp objects.
 *
 * The rule engine understands inline `(?i)`; JavaScript does not, so the flag is
 * stripped and applied as a real flag instead. Case-insensitivity is universal in
 * these rules, so nothing is lost.
 */
export function compileConditions(conditions: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const condition of conditions) {
    const inlineFlag = condition.startsWith("(?i)");
    const body = inlineFlag ? condition.slice(4) : condition;
    try {
      compiled.push(new RegExp(body, inlineFlag ? "i" : ""));
    } catch {
      // A pattern the JS engine rejects must not disable the whole check.
    }
  }
  return compiled;
}

/** Returns the first pattern that matches the text, or null. */
export function firstMatch(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}
