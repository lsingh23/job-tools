import type { ScoredJob } from "./types.js";

/** Normalize a string for fuzzy comparison: lowercase, strip punctuation/extra ws. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(remote|work|100|hybrid|onsite|f|m|wfh)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dedup key: normalized title + company. Catches the same role reposted. */
export function dupKey(j: ScoredJob): string {
  return `${norm(j.title)}|${norm(j.company)}`;
}

/**
 * Collapse duplicate postings (same role across pages, locations, or reposts).
 * Keeps the record with the most information: highest score, then a real
 * description, then a salary. Returns deduped list still ranked by score.
 */
export function dedupe(jobs: ScoredJob[]): ScoredJob[] {
  const best = new Map<string, ScoredJob>();
  for (const j of jobs) {
    const key = dupKey(j);
    const cur = best.get(key);
    if (!cur || isRicher(j, cur)) best.set(key, j);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

function isRicher(a: ScoredJob, b: ScoredJob): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if ((a.description.length > 0) !== (b.description.length > 0)) return a.description.length > 0;
  if ((a.salary != null) !== (b.salary != null)) return a.salary != null;
  return a.description.length > b.description.length;
}
