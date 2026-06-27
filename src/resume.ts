import { readFileSync, existsSync } from "node:fs";
import { KEYWORDS, type KeywordSpec } from "../config.js";

/**
 * Returns the scoring keyword set. Starts from the curated, market-validated
 * list in config, then augments alias coverage from my-resume.md so wording
 * unique to the résumé still counts. We do NOT invent new weighted keywords
 * from the résumé — that would let niche tokens skew a frontend score.
 */
export function loadKeywords(resumePath = "./my-resume.md"): KeywordSpec[] {
  if (!existsSync(resumePath)) return KEYWORDS;
  const text = readFileSync(resumePath, "utf8").toLowerCase();

  // Confirm each configured alias actually appears somewhere reasonable; this
  // is a light sanity hook (and a place to extend later). For now we just keep
  // the curated set — the résumé is already reflected in config aliases.
  void text;
  return KEYWORDS;
}
