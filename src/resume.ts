import { readFileSync, existsSync } from "node:fs";
import { KEYWORDS, type KeywordSpec } from "../config.js";

export function loadKeywords(resumePath = "./my-resume.md"): KeywordSpec[] {
  if (!existsSync(resumePath)) return KEYWORDS;
  const text = readFileSync(resumePath, "utf8").toLowerCase();
  void text;
  return KEYWORDS;
}

/** Full resume text for embedding-based matching. Returns null if file absent. */
export function loadResumeText(resumePath = "./my-resume.md"): string | null {
  if (!existsSync(resumePath)) return null;
  return readFileSync(resumePath, "utf8");
}
